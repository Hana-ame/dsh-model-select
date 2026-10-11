import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

import { CODE, SelectError } from '../src/errors.js'
import { AvailabilityCache } from '../src/availability.js'
import { createDispatch } from '../src/upstream.js'
import { createCompatHandler, startServer } from '../src/forward.js'
import {
  makeConfig,
  retarget,
  startUpstream,
  RESP_HELPERS as RESP,
  nodeHttpFetch,
  request,
} from './helpers.js'

const CHAT = { messages: [{ role: 'user', content: 'ping' }] }

// ── Group A: the handler's wiring, with a stubbed dispatch ────────────────────

test('handler: /health lists channels, pools and the live availability verdicts', async t => {
  const cache = new AvailabilityCache()
  cache.report('kilo', false, { note: 'RATE_LIMIT' })
  const server = await startServer({
    config: makeConfig(),
    availability: cache,
    dispatch: () => Promise.resolve({}),
    port: 0,
    log: () => {},
  })
  t.after(() => server.close())

  const res = await request(server.port, { method: 'GET', path: '/health' })
  assert.equal(res.status, 200)
  assert.equal(res.json.ok, true)
  assert.deepEqual(res.json.channels, ['kilo', 'bunny', 'sense', 'jev'])
  assert.deepEqual(res.json.pools, ['fast-free', 'all', 'decide'])
  // jev is declared as a decide channel, so it is advertised too.
  assert.equal(res.json.models, 5)
  assert.equal(res.json.types.jev, 'decide')
  assert.equal(res.json.types.kilo, 'chat')
  assert.deepEqual(res.json.disabled, [])
  assert.equal(res.json.availability.entries[0].key, 'kilo')
  assert.equal(res.json.availability.entries[0].state, 'down')
})

test('handler: /v1/models returns one row per channel/model pair', async t => {
  const server = await startServer({
    config: makeConfig(),
    dispatch: () => Promise.resolve({}),
    port: 0,
    log: () => {},
  })
  t.after(() => server.close())

  const res = await request(server.port, { method: 'GET', path: '/v1/models' })
  assert.equal(res.status, 200)
  assert.equal(res.json.object, 'list')
  const ids = res.json.data.map(row => row.id)
  assert.deepEqual(
    ids,
    ['kilo/kilo-flash', 'kilo/kilo-mini', 'bunny/bunny-free', 'sense/sense-lite', 'jev/jev-1.13-free'],
  )
  assert.equal(res.json.data[0].owned_by, 'kilo')
})

test('handler: a request without a model is refused before anything is dispatched', async t => {
  let calls = 0
  const server = await startServer({
    config: makeConfig(),
    dispatch: () => { calls += 1; return Promise.resolve({}) },
    port: 0,
    log: () => {},
  })
  t.after(() => server.close())

  const missing = await request(server.port, { path: '/v1/chat/completions', body: { ...CHAT } })
  assert.equal(missing.status, 400)
  assert.match(missing.json.error.message, /model/)
  assert.equal(missing.json.error.type, 'invalid_request_error')

  const noMessages = await request(server.port, { path: '/v1/chat/completions', body: { model: 'kilo' } })
  assert.equal(noMessages.status, 400)
  assert.match(noMessages.json.error.message, /messages/)

  const notJson = await request(server.port, { path: '/v1/chat/completions', body: '{not json' })
  assert.equal(notJson.status, 400)
  assert.match(notJson.json.error.message, /not valid JSON/)

  assert.equal(calls, 0)
})

test('handler: an unknown channel is a 400, not a silent fallback', async t => {
  const server = await startServer({
    config: makeConfig(),
    dispatch: () => Promise.resolve({}),
    port: 0,
    log: () => {},
  })
  t.after(() => server.close())

  const res = await request(server.port, { path: '/v1/chat/completions', body: { ...CHAT, model: 'nosuch' } })
  assert.equal(res.status, 400)
  assert.equal(res.json.error.code, CODE.config)
  assert.match(res.json.error.message, /nosuch/)
})

test('handler: the model field is rewritten to the channel that answered', async t => {
  const upstream = { statusCode: 200, headers: {}, stream: false, json: { model: 'upstream-id', choices: [{ message: { content: 'pong' } }] } }
  const server = await startServer({
    config: makeConfig(),
    dispatch: () => Promise.resolve(upstream),
    port: 0,
    log: () => {},
  })
  t.after(() => server.close())

  const res = await request(server.port, { path: '/v1/chat/completions', body: { ...CHAT, model: 'kilo/kilo-mini' } })
  assert.equal(res.status, 200)
  assert.equal(res.json.model, 'kilo/kilo-mini')
  assert.equal(res.json.choices[0].message.content, 'pong')
  assert.equal(res.headers['x-selected-channel'], 'kilo')
  assert.equal(res.headers['x-selected-model'], 'kilo-mini')
  assert.equal(res.headers['x-select-retries'], '0')
  assert.equal(res.headers['x-select-candidates'], 'kilo/kilo-mini')
  assert.match(res.headers['x-select-elapsed-ms'], /^\d+$/)
})

test('handler: a 429 on the first channel never reaches the caller', async t => {
  const config = makeConfig()
  const seen = []
  const server = await startServer({
    config,
    dispatch: async candidate => {
      seen.push(candidate.key)
      if (candidate.channel === 'kilo') throw new SelectError('quota spent', CODE.rateLimit, { statusCode: 429 })
      return { statusCode: 200, headers: {}, stream: false, json: { model: 'bunny-free', choices: [{ message: { content: 'pong' } }] } }
    },
    port: 0,
    log: () => {},
  })
  t.after(() => server.close())

  const res = await request(server.port, { path: '/v1/chat/completions', body: { ...CHAT, model: 'kilo,bunny' } })
  assert.equal(res.status, 200)
  assert.equal(res.json.model, 'bunny/bunny-free')
  assert.equal(res.headers['x-selected-channel'], 'bunny')
  assert.equal(res.headers['x-select-retries'], '1')
  assert.deepEqual(seen, ['kilo/kilo-flash', 'bunny/bunny-free'])
})

test('handler: every channel failing answers 503 with the whole trail', async t => {
  const server = await startServer({
    config: makeConfig(),
    dispatch: async () => {
      throw new SelectError('no capacity', CODE.server, { statusCode: 503 })
    },
    port: 0,
    log: () => {},
  })
  t.after(() => server.close())

  const res = await request(server.port, { path: '/v1/chat/completions', body: { ...CHAT, model: '__pool__:fast-free' } })
  assert.equal(res.status, 503)
  assert.equal(res.json.error.code, 'all_channels_failed')
  assert.equal(res.json.error.attempts.length, 2)
  assert.equal(res.json.error.attempts[1].channel, 'bunny')
  assert.equal(res.json.error.last.statusCode, 503)
  assert.match(res.json.error.message, /every candidate failed/)
})

test('handler: a pool reference expands and falls back inside the handler', async t => {
  const order = []
  const server = await startServer({
    config: makeConfig(),
    dispatch: async candidate => {
      order.push(candidate.key)
      return { statusCode: 200, headers: {}, stream: false, json: { model: candidate.model, choices: [{ message: { content: 'pong' } }] } }
    },
    port: 0,
    log: () => {},
  })
  t.after(() => server.close())

  const res = await request(server.port, { path: '/v1/chat/completions', body: { ...CHAT, model: '__pool__:fast-free' } })
  assert.equal(res.status, 200)
  assert.equal(res.json.model, 'kilo/kilo-flash')
  assert.deepEqual(order, ['kilo/kilo-flash'])
})

test('handler: a streamed answer passes through byte for byte, with [DONE] guaranteed', async t => {
  const frames = [
    'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":""}}]}\n\n',
    'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"pong"}}]}\n\n',
  ]
  const server = await startServer({
    config: makeConfig(),
    dispatch: () => Promise.resolve({
      statusCode: 200,
      headers: {},
      stream: true,
      body: toUpstreamStream(frames),
    }),
    port: 0,
    log: () => {},
  })
  t.after(() => server.close())

  const res = await request(server.port, { path: '/v1/chat/completions', body: { ...CHAT, model: 'kilo', stream: true } })
  assert.equal(res.status, 200)
  assert.match(res.headers['content-type'], /text\/event-stream/)
  assert.equal(res.headers['x-selected-channel'], 'kilo')
  // Neither frame was dropped by the peek, and [DONE] is appended when missing.
  assert.match(res.text, /"content":"pong"/)
  assert.ok(res.text.includes('data: [DONE]'))
  assert.equal(res.text.split('data: [DONE]').length - 1, 1)
})

test('handler: an auth key is enforced on every route but not on /health', async t => {
  const server = await startServer({
    config: makeConfig(),
    apiKey: 'sk-test',
    dispatch: () => Promise.resolve({ statusCode: 200, headers: {}, stream: false, json: { choices: [{ message: { content: 'pong' } }] } }),
    port: 0,
    log: () => {},
  })
  t.after(() => server.close())

  const health = await request(server.port, { method: 'GET', path: '/health' })
  assert.equal(health.status, 200)

  const denied = await request(server.port, { path: '/v1/chat/completions', body: { ...CHAT, model: 'kilo' } })
  assert.equal(denied.status, 401)

  const bearer = await request(server.port, {
    path: '/v1/chat/completions',
    body: { ...CHAT, model: 'kilo' },
    headers: { authorization: 'Bearer sk-test' },
  })
  assert.equal(bearer.status, 200)

  const header = await request(server.port, {
    path: '/v1/chat/completions',
    body: { ...CHAT, model: 'kilo' },
    headers: { 'x-api-key': 'sk-test' },
  })
  assert.equal(header.status, 200)
})

test('handler: unknown routes answer 404 and CORS preflights get 204', async t => {
  const server = await startServer({
    config: makeConfig(),
    dispatch: () => Promise.resolve({}),
    port: 0,
    log: () => {},
  })
  t.after(() => server.close())

  const missing = await request(server.port, { method: 'GET', path: '/v1/nope' })
  assert.equal(missing.status, 404)

  const preflight = await request(server.port, { method: 'OPTIONS', path: '/v1/chat/completions' })
  assert.equal(preflight.status, 204)
  assert.equal(preflight.headers['access-control-allow-methods'], 'GET, POST, OPTIONS')
})

// ── Group B: end to end, through the real dispatch ────────────────────────────

test('end to end: createDispatch + node:http serves a real completion over loopback', async t => {
  // Echo back the model it was asked for, so the pin is asserted twice: once
  // in the upstream's request body and once in the answer the client receives.
  const upstream = await startUpstream(hit => RESP.json(hit.body.model))
  t.after(() => upstream.close())

  const config = retarget(makeConfig(), 'kilo', upstream.base)
  const server = await startServer({
    config,
    dispatch: createDispatch({ channels: config.channels, fetchImpl: nodeHttpFetch, timeoutMs: 5000 }),
    port: 0,
    log: () => {},
  })
  t.after(() => server.close())

  const res = await request(server.port, { path: '/v1/chat/completions', body: { ...CHAT, model: 'kilo/kilo-mini' } })
  assert.equal(res.status, 200)
  assert.equal(res.json.model, 'kilo/kilo-mini')
  assert.equal(res.json.choices[0].message.content, 'answer from kilo-mini')
  // The dispatch sent the candidate's model, not the caller's original spelling.
  assert.equal(upstream.hits.length, 1)
  assert.equal(upstream.hits[0].body.model, 'kilo-mini')
  assert.equal(upstream.hits[0].url, '/chat/completions')
})

test('end to end: a 429 on the first upstream falls back to the second', async t => {
  const first = await startUpstream([RESP.rateLimit(), RESP.json()])
  const second = await startUpstream([RESP.json('bunny-free')])
  t.after(async () => {
    await first.close()
    await second.close()
  })

  const config = retarget(retarget(makeConfig(), 'kilo', first.base), 'bunny', second.base)
  const server = await startServer({
    config,
    dispatch: createDispatch({ channels: config.channels, fetchImpl: nodeHttpFetch, timeoutMs: 5000 }),
    port: 0,
    log: () => {},
  })
  t.after(() => server.close())

  const res = await request(server.port, { path: '/v1/chat/completions', body: { ...CHAT, model: 'kilo,bunny' } })
  assert.equal(res.status, 200)
  assert.equal(res.json.model, 'bunny/bunny-free')
  assert.equal(res.headers['x-selected-channel'], 'bunny')
  assert.equal(res.headers['x-select-retries'], '1')
  assert.equal(first.hits.length, 1)
  assert.equal(second.hits.length, 1)
})

test('end to end: a stream is delivered and the pinned model reaches the upstream', async t => {
  const upstream = await startUpstream([RESP.sse('kilo-flash', 'streamed answer')])
  t.after(() => upstream.close())

  const config = retarget(makeConfig(), 'kilo', upstream.base)
  const server = await startServer({
    config,
    dispatch: createDispatch({ channels: config.channels, fetchImpl: nodeHttpFetch, timeoutMs: 5000 }),
    port: 0,
    log: () => {},
  })
  t.after(() => server.close())

  const res = await request(server.port, { path: '/v1/chat/completions', body: { ...CHAT, model: 'kilo', stream: true } })
  assert.equal(res.status, 200)
  assert.match(res.headers['content-type'], /text\/event-stream/)
  assert.match(res.text, /streamed answer/)
  assert.ok(res.text.includes('data: [DONE]'))
  assert.equal(upstream.hits[0].body.model, 'kilo-flash')
  assert.equal(upstream.hits[0].headers.accept, 'text/event-stream')
})

test('end to end: an empty upstream answer falls back instead of reaching the caller', async t => {
  const first = await startUpstream([RESP.empty()])
  const second = await startUpstream([RESP.json('bunny-free')])
  t.after(async () => {
    await first.close()
    await second.close()
  })

  const config = retarget(retarget(makeConfig(), 'kilo', first.base), 'bunny', second.base)
  const server = await startServer({
    config,
    dispatch: createDispatch({ channels: config.channels, fetchImpl: nodeHttpFetch, timeoutMs: 5000 }),
    port: 0,
    log: () => {},
  })
  t.after(() => server.close())

  const res = await request(server.port, { path: '/v1/chat/completions', body: { ...CHAT, model: 'kilo,bunny' } })
  assert.equal(res.status, 200)
  assert.equal(res.headers['x-selected-channel'], 'bunny')
  assert.equal(res.headers['x-select-retries'], '1')
})

test('end to end: an unresponsive upstream times out and the next channel answers', async t => {
  const first = await startUpstream([RESP.hang()])
  const second = await startUpstream([RESP.json('bunny-free')])
  t.after(async () => {
    await first.close()
    await second.close()
  })

  const config = retarget(retarget(makeConfig(), 'kilo', first.base), 'bunny', second.base)
  const server = await startServer({
    config,
    dispatch: createDispatch({ channels: config.channels, fetchImpl: nodeHttpFetch, timeoutMs: 300 }),
    port: 0,
    log: () => {},
  })
  t.after(() => server.close())

  const res = await request(server.port, { path: '/v1/chat/completions', body: { ...CHAT, model: 'kilo,bunny' } })
  assert.equal(res.status, 200)
  assert.equal(res.headers['x-selected-channel'], 'bunny')
  assert.equal(res.headers['x-select-retries'], '1')
})

test('end to end: the availability cache remembers a 429 across requests', async t => {
  const first = await startUpstream([RESP.rateLimit()])
  const second = await startUpstream([RESP.json('bunny-free')])
  t.after(async () => {
    await first.close()
    await second.close()
  })

  const config = retarget(retarget(makeConfig(), 'kilo', first.base), 'bunny', second.base)
  const cache = new AvailabilityCache()
  const dispatch = createDispatch({ channels: config.channels, fetchImpl: nodeHttpFetch, timeoutMs: 5000 })
  const server = await startServer({ config, availability: cache, dispatch, port: 0, log: () => {} })
  t.after(() => server.close())

  await request(server.port, { path: '/v1/chat/completions', body: { ...CHAT, model: 'kilo,bunny' } })
  assert.equal(cache.isEnabled('kilo'), false)

  // The cached verdict skips the dead channel: the second request never touches it.
  await request(server.port, { path: '/v1/chat/completions', body: { ...CHAT, model: 'kilo,bunny' } })
  assert.equal(first.hits.length, 1)
  assert.equal(second.hits.length, 2)
  assert.equal(cache.snapshot().entries[0].state, 'down')
})

// ── a stream body for the stub-dispatch tests ─────────────────────────────────

function toUpstreamStream(parts) {
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(Buffer.from(part))
      controller.close()
    },
  })
}
