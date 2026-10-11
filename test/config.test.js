import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { CODE } from '../src/errors.js'
import {
  loadConfig,
  validateConfig,
  expandEnv,
  expandEnvDeep,
  listModels,
  modelServingChannels,
  DEFAULTS,
} from '../src/channels.js'
import { executorIndex } from '../src/operations.js'

test('expandEnv: ${VAR} wins when set, ${VAR:-default} only when unset', () => {
  const warnings = []
  const env = { KILO_API_TOKEN: 'secret', EMPTY_VAR: '' }
  assert.equal(expandEnv('Bearer ${KILO_API_TOKEN}', env, warnings), 'Bearer secret')
  assert.equal(expandEnv('${EMPTY_VAR}', env, warnings), '')
  assert.equal(expandEnv('${NOPE:-fallback}', env, warnings), 'fallback')
  assert.equal(expandEnv('${NOPE}', env, warnings), '')
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /NOPE/)
  assert.equal(expandEnv('no variables here', env, warnings), 'no variables here')
})

test('expandEnvDeep: nested values are expanded, other types pass through', () => {
  assert.deepEqual(
    expandEnvDeep({ a: '${X:-1}', b: [{ c: '${X:-2}' }], d: 3, e: null, f: true }, {}, []),
    { a: '1', b: [{ c: '2' }], d: 3, e: null, f: true },
  )
})

test('validateConfig: a minimal table gets the documented defaults', () => {
  const config = validateConfig({
    channels: { solo: { baseUrl: 'http://127.0.0.1', defaultModel: 'm1' } },
  }, [])
  assert.equal(config.channels.solo.path, 'chat/completions')
  assert.deepEqual(config.channels.solo.models, [])
  assert.equal(config.channels.solo.auth, null)
  assert.equal(config.defaults.timeoutMs, DEFAULTS.timeoutMs)
  assert.equal(config.defaults.availabilityTtlMs, DEFAULTS.availabilityTtlMs)
  assert.deepEqual(config.pools, {})
})

test('validateConfig: the first model becomes the default when none is named', () => {
  const config = validateConfig({
    channels: { solo: { baseUrl: 'http://x', models: ['a', 'b'] } },
  }, [])
  assert.equal(config.channels.solo.defaultModel, 'a')
})

test('validateConfig: a baseUrl is required to be http(s) and is normalised', () => {
  assert.throws(() => validateConfig({ channels: { c: {} } }, []), /needs an http\(s\) baseUrl/)
  assert.throws(() => validateConfig({ channels: { c: { baseUrl: 'ftp://x' } } }, []), /needs an http\(s\) baseUrl/)
  const config = validateConfig({ channels: { c: { baseUrl: 'http://x/api/v1///', defaultModel: 'm' } } }, [])
  assert.equal(config.channels.c.baseUrl, 'http://x/api/v1')
  assert.throws(() => validateConfig({ channels: { c: { baseUrl: 'http://x' } } }, []), /no model/)
})

test('validateConfig: missing channels, an empty table, and bad keys all refuse', () => {
  assert.throws(() => validateConfig({}, []), /no "channels" object/)
  assert.throws(() => validateConfig({ channels: [] }, []), /no "channels" object/)
  assert.throws(() => validateConfig({ channels: {} }, []), /no channels/)
  assert.throws(() => validateConfig({ channels: { 'bad key': { baseUrl: 'http://x', defaultModel: 'm' } } }, []), /unusable key/)
})

test('validateConfig: a pool must be a non-empty array of strings', () => {
  assert.throws(
    () => validateConfig({ channels: { c: { baseUrl: 'http://x', defaultModel: 'm' } }, pools: { p: [] } }, []),
    /non-empty array/,
  )
  assert.throws(
    () => validateConfig({ channels: { c: { baseUrl: 'http://x', defaultModel: 'm' } }, pools: { p: ['c', 1] } }, []),
    /non-empty array/,
  )
  const config = validateConfig({
    channels: { c: { baseUrl: 'http://x', defaultModel: 'm' } },
    pools: { p: ['c'] },
  }, [])
  assert.deepEqual(config.pools.p, ['c'])
})

test('validateConfig: a bad timeoutMs is a config error, not a silent fallback', () => {
  assert.throws(
    () => validateConfig({ channels: { c: { baseUrl: 'http://x', defaultModel: 'm' } }, defaults: { timeoutMs: -5 } }, []),
    /positive integer/,
  )
})

test('validateConfig: a channel with no model is a config error, not a warning', () => {
  // A channel that can never name a model can never answer a request, so the
  // table refuses it at load time instead of failing the first request.
  assert.throws(
    () => validateConfig({ channels: { c: { baseUrl: 'http://x' } } }, []),
    /declares no model/,
  )
  try {
    validateConfig({ channels: { c: { baseUrl: 'http://x' } } }, [])
    assert.fail('a channel with no model must be refused')
  } catch (error) {
    assert.equal(error.code, CODE.config)
  }
})

test('loadConfig: reads, expands and validates the shipped table', () => {
  // The operator's config/channels.json is gitignored; the committed example is
  // the hermetic fixture, so this test is reproducible on a fresh clone.
  const config = loadConfig(new URL('../config/channels.example.json', import.meta.url), { env: {} })
  // Eight channels are declared: three chat, one decide (disabled), four dispatch.
  assert.equal(Object.keys(config.channels).length, 8)
  assert.deepEqual(Object.keys(config.pools), ['fast-free', 'all', 'decide'])
  assert.equal(config.defaults.decidePool, 'decide')
  assert.equal(config.defaults.fallbackPool, 'fast-free')
  assert.equal(config.channels.jev.type, 'decide')
  assert.equal(config.channels.jev.disabled, true)
  assert.equal(config.channels.jev.path, 'decide')
  assert.equal(config.channels.kilo.disabled, false)
  // The disabled router does not advertise models, and the four executors do, so
  // the roster is 3 + 1 + 1 + 4 = 9 rows.
  assert.equal(listModels(config).length, 9)
  assert.ok(!listModels(config).some(row => row.channel === 'jev'))
  assert.deepEqual(listModels(config).filter(row => row.type === 'dispatch').map(row => row.channel),
    ['merge-runner', 'triage-runner', 'audit-runner', 'ingest-runner'])
  assert.equal(config.channels.kilo.baseUrl, 'https://REPLACE-ME/api/v2/kilo/v1')
  assert.equal(config.channels.kilo.auth.type, 'bearer')
  // With no environment at all, a token placeholder expands to empty and a
  // baseUrl placeholder falls back to its documented default.
  assert.equal(config.channels.kilo.auth.token, '')
  assert.equal(config.channels['space-bunny'].baseUrl, 'https://api.spacebunny.ai/v1')
  assert.equal(config.channels.sensenova.defaultModel, 'sensenova-6.8-flash-lite')
  // Three channel tokens, the router token, and the four executors share one.
  assert.equal(config.warnings.length, 8)
  for (const warning of config.warnings) assert.match(warning, /is not set/)

  // The executors claim four operations, one each, and none is in a pool.
  const index = executorIndex(config)
  assert.deepEqual(Object.keys(index), ['merge', 'triage', 'audit', 'ingest'])
  assert.equal(index.merge.name, 'merge-runner')
  assert.equal(index.merge.type, 'dispatch')
  assert.deepEqual(config.pools['fast-free'], ['kilo', 'space-bunny'])
  assert.ok(!Object.values(config.pools).flat().some(name => config.channels[name].type === 'dispatch'))

  // The discipline ships in the table, so a generation body always carries it.
  assert.equal(Array.isArray(config.defaults.preset), true)
  assert.match(config.defaults.preset.join(''), /merge/)
})


test('loadConfig: a set but empty value wins over the default and does not warn', () => {
  const warnings = []
  assert.equal(expandEnv('${X:-default}', { X: '' }, warnings), '')
  assert.equal(warnings.length, 0)
})

test('loadConfig: a missing file throws CONFIG with the path in it', () => {
  assert.throws(() => loadConfig('/no/such/channels.json'), /could not read the channel table/)
})

test('loadConfig: invalid JSON throws CONFIG, and env is injected, not read from the process', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-config-'))
  try {
    fs.writeFileSync(path.join(dir, 'bad.json'), '{ not json')
    assert.throws(() => loadConfig(path.join(dir, 'bad.json')), /not valid JSON/)

    fs.writeFileSync(path.join(dir, 'good.json'), JSON.stringify({
      channels: { c: { baseUrl: 'http://x', defaultModel: 'm', auth: { type: 'bearer', token: '${TOK}' } } },
    }))
    const warnings = []
    const config = validateConfig(expandEnvDeep({
      channels: { c: { baseUrl: 'http://x', defaultModel: 'm', auth: { type: 'bearer', token: '${TOK}' } } },
    }, { TOK: 'from-test' }, warnings))
    assert.equal(config.channels.c.auth.token, 'from-test')
    assert.equal(warnings.length, 0)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('modelServingChannels: the default model wins the ordering tie', () => {
  const config = validateConfig({
    channels: {
      a: { baseUrl: 'http://a', defaultModel: 'm1', models: ['m2'] },
      b: { baseUrl: 'http://b', defaultModel: 'm1', models: ['m1'] },
    },
  }, [])
  assert.deepEqual(modelServingChannels(config, 'm1'), ['a', 'b'])
  assert.deepEqual(modelServingChannels(config, 'm2'), ['a'])
  assert.deepEqual(modelServingChannels(config, 'nope'), [])
  assert.deepEqual(modelServingChannels(config, ''), [])
})

test('listModels: one row per channel/model pair, deduped and ordered', () => {
  const config = validateConfig({
    channels: {
      a: { baseUrl: 'http://a', defaultModel: 'm1', models: ['m1', 'm2'] },
      b: { baseUrl: 'http://b', defaultModel: 'm3' },
    },
  }, [])
  assert.deepEqual(
    listModels(config).map(row => row.key),
    ['a/m1', 'a/m2', 'b/m3'],
  )
})

test('validateConfig: type is chat by default and decide gets its own endpoint', () => {
  const config = validateConfig({
    channels: {
      talk: { baseUrl: 'http://a', defaultModel: 'm' },
      judge: { baseUrl: 'http://b', defaultModel: 'm', type: 'decide' },
    },
  }, [])
  assert.equal(config.channels.talk.type, 'chat')
  assert.equal(config.channels.talk.path, 'chat/completions')
  assert.equal(config.channels.judge.type, 'decide')
  // A decide channel is not told where /chat/completions lives.
  assert.equal(config.channels.judge.path, 'v1/decide')
  assert.deepEqual(listModels(config).map(row => [row.key, row.type]), [
    ['talk/m', 'chat'],
    ['judge/m', 'decide'],
  ])
})

test('validateConfig: an unknown type and a missing default pool are refused', () => {
  assert.throws(
    () => validateConfig({ channels: { c: { baseUrl: 'http://x', defaultModel: 'm', type: 'route' } } }, []),
    /unusable type/,
  )
  assert.throws(
    () => validateConfig({
      channels: { c: { baseUrl: 'http://x', defaultModel: 'm' } },
      defaults: { decidePool: 'nope' },
    }, []),
    /names unknown pool/,
  )
  assert.throws(
    () => validateConfig({
      channels: { c: { baseUrl: 'http://x', defaultModel: 'm' } },
      defaults: { fallbackPool: 3 },
    }, []),
    /must be a pool name/,
  )
  assert.throws(
    () => validateConfig({
      channels: { c: { baseUrl: 'http://x', defaultModel: 'm' } },
      defaults: { decidePool: 3 },
    }, []),
    /must be a pool name/,
  )
})

test('modelServingChannels and listModels ignore a disabled channel', () => {
  const config = validateConfig({
    channels: {
      a: { baseUrl: 'http://a', defaultModel: 'm1' },
      b: { baseUrl: 'http://b', defaultModel: 'm2', models: ['m1'], disabled: true },
    },
  }, [])
  // b also serves m1, but a disabled channel is a preference nobody asked for.
  assert.deepEqual(modelServingChannels(config, 'm1'), ['a'])
  assert.deepEqual(modelServingChannels(config, 'm2'), [])
  assert.deepEqual(listModels(config).map(row => row.key), ['a/m1'])
})
