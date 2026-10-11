/**
 * The phone menu.
 *
 * A menu is a preference the caller made by hand, so it outranks the fallback
 * order. These tests check three things the layer has to get right: the number
 * is parsed strictly (no silent coercion of a bad index), an out-of-range
 * number is reported against the menu the caller could actually have dialed, and
 * a pick on top of a normal candidate list walks exactly one lane.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { CHOICE_FIELDS, readChoice, pickCandidate } from '../src/selection.js'
import { validateConfig } from '../src/channels.js'
import { CODE } from '../src/errors.js'
import { createModelSelect } from '../index.js'
import { BASE_TABLE, makeConfig, stubDispatch, okJson } from './helpers.js'

// ── parsing ────────────────────────────────────────────────────────────────────

test('a request without a number is not a pick', () => {
  assert.deepEqual(readChoice({ model: 'kilo', messages: [] }), { present: false })
  assert.deepEqual(readChoice({}), { present: false })
  assert.deepEqual(readChoice(undefined), { present: false })
})

test('the two spellings are both accepted, 1-based', () => {
  assert.equal(CHOICE_FIELDS.join(','), 'choice,selection')
  assert.deepEqual(readChoice({ choice: 3 }), { present: true, field: 'choice', value: 3 })
  assert.deepEqual(readChoice({ selection: 1 }), { present: true, field: 'selection', value: 1 })
})

test('a string of digits is accepted, because a JSON body from a form is not JSON numbers', () => {
  assert.deepEqual(readChoice({ choice: '2' }), { present: true, field: 'choice', value: 2 })
  assert.deepEqual(readChoice({ selection: ' 10 ' }), { present: true, field: 'selection', value: 10 })
})

function caught(fn) {
  try {
    fn()
  } catch (error) {
    return error
  }
  throw new Error('expected a throw')
}

for (const [label, value] of [
  ['zero', 0],
  ['a negative', -1],
  ['a fraction', 1.5],
  ['a boolean', true],
  ['an object', {}],
  ['an array', [2]],
  ['a letter', 'two'],
  ['a plus sign', '+2'],
  ['a huge number', Number.MAX_SAFE_INTEGER + 2],
]) {
  test(`a ${label} is refused rather than coerced`, () => {
    const out = readChoice({ choice: value })
    assert.equal(out.present, true)
    assert.equal(out.error?.code, CODE.config)
    assert.match(out.error.message, /1-based whole number/)
    assert.match(out.error.message, /\`choice\`/)
  })
}

test('an empty string is an absence, not a bad index', () => {
  assert.deepEqual(readChoice({ choice: '', selection: null }), { present: false })
})

test('two fields that agree are redundant but harmless', () => {
  assert.deepEqual(readChoice({ choice: 2, selection: 2 }), { present: true, field: 'choice', value: 2 })
  assert.deepEqual(readChoice({ choice: '2', selection: '2' }), { present: true, field: 'choice', value: 2 })
})

test('two fields that disagree is a caller bug, not an ambiguity', () => {
  const out = readChoice({ choice: 1, selection: 2 })
  assert.equal(out.present, true)
  assert.equal(out.error?.code, CODE.config)
  assert.match(out.error.message, /disagree/)
})

// ── picking ────────────────────────────────────────────────────────────────────

const CANDIDATES = [
  { channel: 'kilo', model: 'kilo-flash', type: 'chat', key: 'kilo/kilo-flash' },
  { channel: 'bunny', model: 'bunny-free', type: 'chat', key: 'bunny/bunny-free' },
  { channel: 'sense', model: 'sense-lite', type: 'chat', key: 'sense/sense-lite' },
]

test('without a number the list is returned unchanged and nothing is picked', () => {
  const { candidates, picked } = pickCandidate(CANDIDATES, {})
  assert.equal(candidates, CANDIDATES)
  assert.equal(picked, null)
})

test('a number locks that one lane and nothing else', () => {
  for (const index of [1, 2, 3]) {
    const { candidates, picked } = pickCandidate(CANDIDATES, { choice: index })
    assert.equal(candidates.length, 1)
    assert.equal(candidates[0], CANDIDATES[index - 1])
    assert.deepEqual(picked, {
      field: 'choice',
      index,
      total: 3,
      channel: candidates[0].channel,
      model: candidates[0].model,
      type: 'chat',
      key: candidates[0].key,
    })
  }
})

test('a 1-based index counts from the caller left, and zero is refused', () => {
  assert.equal(pickCandidate(CANDIDATES, { choice: 1 }).candidates[0].channel, 'kilo')
  assert.equal(pickCandidate(CANDIDATES, { selection: 3 }).candidates[0].channel, 'sense')
})

test('an out-of-range number reports the menu, so the caller sees what it could have dialed', () => {
  const error = caught(() => pickCandidate(CANDIDATES, { choice: 4 }))
  assert.equal(error.code, CODE.config)
  assert.match(error.message, /`choice` 4 is out of range: 3 candidates in order/)
  assert.match(error.message, /kilo\/kilo-flash,\s*bunny\/bunny-free,\s*sense\/sense-lite/)
})

test('a menu of one is pickable at 1 and out of range at 2', () => {
  const one = CANDIDATES.slice(0, 1)
  assert.equal(pickCandidate(one, { choice: 1 }).candidates[0].channel, 'kilo')
  assert.match(caught(() => pickCandidate(one, { choice: 2 })).message, /1 candidate in order/)
})

test('a non-list resolves to an empty menu, and any number is then out of range', () => {
  assert.deepEqual(pickCandidate(null, {}).candidates, [])
  const error = caught(() => pickCandidate(null, { choice: 1 }))
  assert.match(error.message, /0 candidates/)
})

// ── a pick on top of a normal candidate list ───────────────────────────────────

function table(extraChannels = {}, extraDefaults = {}) {
  return validateConfig({
    ...BASE_TABLE,
    defaults: { ...BASE_TABLE.defaults, ...extraDefaults },
    channels: { ...BASE_TABLE.channels, ...extraChannels },
  }, [], '<test>')
}

test('a picked lane is the only one dialed: no fallback, no retry', async () => {
  const { fn, calls } = stubDispatch([
    okJson('kilo-flash', 'kilo'),
    okJson('bunny-free', 'bunny'),
  ])
  const api = createModelSelect({ config: makeConfig(), dispatch: fn })

  const turn = await api.routeTurn({ model: '__pool__:all', messages: [{ role: 'user', content: 'hello' }], choice: 2 })

  assert.deepEqual(turn.picked, {
    field: 'choice',
    index: 2,
    total: 3,
    channel: 'bunny',
    model: 'bunny-free',
    type: 'chat',
    key: 'bunny/bunny-free',
  })
  // The menu is the whole pool; the walk is one lane.
  assert.equal(turn.menu.length, 3)
  assert.equal(turn.candidates.length, 1)
  assert.equal(turn.outcome.retries, 0)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].candidate.channel, 'bunny')
})

test('a pick beats the router: choice 2 on a decision skips JEV entirely', async () => {
  const { fn, calls } = stubDispatch([
    okJson('jev-1.13-free', 'never reached'),
    okJson('kilo-flash', 'dialed straight'),
  ])
  const api = createModelSelect({ config: makeConfig(), dispatch: fn })

  const turn = await api.routeTurn({
    model: '__pool__:all',
    messages: [{ role: 'user', content: 'route me' }],
    decision: { options: ['a', 'b'], criteria: 'pick one' },
    choice: 2,
  })

  // decide intent puts JEV first; the number says no, and it is not dialed.
  assert.deepEqual(turn.menu.map(c => c.channel), ['jev', 'kilo', 'bunny', 'sense'])
  assert.equal(turn.picked.channel, 'kilo')
  assert.equal(turn.routed, null)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].candidate.channel, 'kilo')
  assert.equal(turn.outcome.type, 'chat')
})

test('a pick that lands on the router still goes to its executor', async () => {
  const config = makeConfig({
    channels: {
      ...BASE_TABLE.channels,
      'merge-runner': {
        type: 'dispatch',
        baseUrl: 'http://127.0.0.1:9',
        path: 'chat/completions',
        defaultModel: 'mr-1',
        models: ['mr-1'],
        session: 'merge-runner',
        operations: ['merge'],
        dispatchBody: { stream: false },
      },
    },
  })
  const script = [
    {
      statusCode: 200,
      headers: {},
      stream: false,
      json: {
        id: 'd',
        model: 'jev-1.13-free',
        choices: [{ message: { role: 'assistant', content: 'merge #42' }, finish_reason: 'stop' }],
        decision: { choice: 'merge', task: 'merge #42' },
      },
    },
    okJson('mr-1', 'merged #42'),
  ]
  const { fn, calls } = stubDispatch(script)
  const api = createModelSelect({ config, dispatch: fn })

  const turn = await api.routeTurn({
    model: '__pool__:all',
    messages: [{ role: 'user', content: 'route me' }],
    decision: { options: ['a', 'b'] },
    choice: 1,
  })

  assert.equal(turn.picked.channel, 'jev')
  assert.equal(turn.routed?.kind, 'dispatched')
  assert.equal(turn.routed.operation, 'merge')
  assert.equal(turn.routed.executor.name, 'merge-runner')
  assert.equal(calls.length, 2)
  assert.equal(calls[0].candidate.channel, 'jev')
  assert.equal(calls[1].candidate.channel, 'merge-runner')
})

test('an out-of-range number is a caller error the layer reports, not a silent fallback', async () => {
  const { fn, calls } = stubDispatch([okJson('kilo-flash', 'x')])
  const api = createModelSelect({ config: makeConfig(), dispatch: fn })

  await assert.rejects(
    api.routeTurn({ model: '__pool__:all', messages: [{ role: 'user', content: 'hi' }], choice: 9 }),
    error => error.code === CODE.config && error.message.includes('9 is out of range'),
  )
  assert.equal(calls.length, 0)
})

test('a pick failure on the locked lane is a refusal, not a retry on the next lane', async () => {
  const { fn, calls } = stubDispatch([
    { throw: new Error('kilo is down') },
    okJson('bunny-free', 'bunny'),
  ])
  const api = createModelSelect({ config: makeConfig(), dispatch: fn })

  const turn = await api.routeTurn({ model: '__pool__:all', messages: [{ role: 'user', content: 'hi' }], choice: 1 })

  assert.equal(turn.outcome.ok, false)
  // One lane was dialed. Dialling a second one is a walk the caller did not ask for.
  assert.equal(calls.length, 1)
  assert.equal(calls[0].candidate.channel, 'kilo')
  assert.equal(turn.outcome.attempts.length, 1)
})

// ── the two doors ──────────────────────────────────────────────────────────────

test('the adapter door gets the same pick, through the same routeTurn', async () => {
  const { fn, calls } = stubDispatch([okJson('sense-lite', 'sense')])
  const api = createModelSelect({ config: makeConfig(), dispatch: fn })
  const { ModelSelectAdapter } = await import('../src/adapter.js')

  const adapter = new ModelSelectAdapter({ api, log: () => {} })
  const chunks = []
  for await (const chunk of adapter.stream({
    model: '__pool__:all',
    messages: [{ role: 'user', content: 'pick the last' }],
    choice: 3,
  }, {})) {
    chunks.push(chunk)
  }

  assert.equal(calls.length, 1)
  assert.equal(calls[0].candidate.channel, 'sense')
  assert.ok(chunks.some(c => c.type === 'text-delta'))
})

test('api.menu lists the lanes with their numbers, api.choice previews a pick', () => {
  const api = createModelSelect({ config: makeConfig() })
  const menu = api.menu('__pool__:all')
  assert.deepEqual(menu.map(item => [item.index, item.channel]), [
    [1, 'kilo'],
    [2, 'bunny'],
    [3, 'sense'],
  ])
  assert.deepEqual(Object.keys(menu[0]).sort(), ['channel', 'index', 'key', 'model', 'type'])

  const byChoice = api.choice({ choice: 2, model: '__pool__:all' })
  const bySelection = api.choice({ selection: 2, model: '__pool__:all' })
  assert.equal(byChoice.field, 'choice')
  assert.equal(bySelection.field, 'selection')
  assert.equal(byChoice.channel, bySelection.channel)
  assert.equal(byChoice.index, bySelection.index)
  assert.deepEqual(api.choice({}, '__pool__:all'), { present: false })

  assert.equal(caught(() => api.choice({ choice: 5, model: '__pool__:all' })).code, CODE.config)
})

// ── the HTTP door ─────────────────────────────────────────────────────────────

test('the HTTP door reports the pick and the menu it came from', async t => {
  const { startServer, createCompatHandler } = await import('../src/forward.js')
  const { request } = await import('./helpers.js')
  const { fn } = stubDispatch([okJson('bunny-free', 'from bunny')])
  const server = await startServer({
    config: makeConfig(),
    dispatch: fn,
    port: 0,
    log: () => {},
  })
  t.after(() => server.close())

  const res = await request(server.port, {
    method: 'POST',
    path: '/v1/chat/completions',
    headers: { 'content-type': 'application/json' },
    body: {
      model: '__pool__:all',
      messages: [{ role: 'user', content: 'second one please' }],
      choice: 2,
    },
  })

  assert.equal(res.status, 200)
  assert.equal(res.headers['x-selected-channel'], 'bunny')
  assert.equal(res.headers['x-selected-model'], 'bunny-free')
  assert.equal(res.headers['x-select-retries'], '0')
  // What was walked, and what the caller could have dialed instead.
  assert.equal(res.headers['x-select-candidates'], 'bunny/bunny-free')
  assert.equal(res.headers['x-select-choice'], '2/3')
  assert.match(res.headers['x-select-menu'], /kilo/)
  assert.match(res.headers['x-select-menu'], /sense/)
})

test('the HTTP door rejects an out-of-range pick with the menu in the body', async t => {
  const { startServer } = await import('../src/forward.js')
  const { request } = await import('./helpers.js')
  const { fn, calls } = stubDispatch([okJson('kilo-flash', 'x')])
  const server = await startServer({ config: makeConfig(), dispatch: fn, port: 0, log: () => {} })
  t.after(() => server.close())

  const res = await request(server.port, {
    method: 'POST',
    path: '/v1/chat/completions',
    headers: { 'content-type': 'application/json' },
    body: { model: '__pool__:all', messages: [{ role: 'user', content: 'hi' }], choice: 42 },
  })

  assert.equal(res.status, 400)
  assert.match(res.text, /42 is out of range/)
  assert.match(res.text, /3 candidates in order/)
  assert.equal(calls.length, 0)
})

test('a decision carries a pick the way it carries everything else', async t => {
  const { startServer } = await import('../src/forward.js')
  const { request } = await import('./helpers.js')
  const { fn } = stubDispatch([okJson('kilo-flash', 'picked by hand')])
  const server = await startServer({ config: makeConfig(), dispatch: fn, port: 0, log: () => {} })
  t.after(() => server.close())

  const res = await request(server.port, {
    method: 'POST',
    path: '/v1/chat/completions',
    headers: { 'content-type': 'application/json' },
    body: {
      model: '__pool__:all',
      messages: [{ role: 'user', content: 'route me' }],
      decision: { options: ['a', 'b'] },
      selection: 2,
    },
  })

  assert.equal(res.status, 200)
  assert.equal(res.headers['x-selected-channel'], 'kilo')
  assert.equal(res.headers['x-select-choice'], '2/4')
  assert.match(res.headers['x-select-menu'], /jev/)
})
