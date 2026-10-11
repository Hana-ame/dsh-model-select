import { test } from 'node:test'
import assert from 'node:assert/strict'

import { CODE, SelectError } from '../src/errors.js'
import { AvailabilityCache, OPEN_CACHE } from '../src/availability.js'
import { parseModelSpec, parseItem, resolveCandidates, candidatesLabel } from '../src/spec.js'
import { isSseContent, inspectContent } from '../src/stream.js'
import { select, describe } from '../src/select.js'
import {
  makeConfig,
  stubDispatch,
  okJson,
  emptyJson,
  okSseResult,
  emptySseResult,
  toStream,
  httpError,
  codeError,
  readStream,
} from './helpers.js'

const CANDIDATES = [
  { channel: 'kilo', model: 'kilo-flash', type: 'chat', key: 'kilo/kilo-flash' },
  { channel: 'bunny', model: 'bunny-free', type: 'chat', key: 'bunny/bunny-free' },
  { channel: 'sense', model: 'sense-lite', type: 'chat', key: 'sense/sense-lite' },
]

const REQUEST = { model: 'a,b', messages: [{ role: 'user', content: 'ping' }] }

// ── candidate resolution ──────────────────────────────────────────────────────

test('parseModelSpec: a comma list keeps order and trims', () => {
  assert.deepEqual(
    parseModelSpec('kilo , bunny ,sense'),
    [{ channel: 'kilo' }, { channel: 'bunny' }, { channel: 'sense' }],
  )
})

test('parseModelSpec: a pool reference is a single item', () => {
  assert.deepEqual(parseModelSpec('__pool__:fast-free'), [{ pool: 'fast-free' }])
})

test('parseModelSpec: a blank spec is empty, an empty pool name is an error', () => {
  assert.deepEqual(parseModelSpec('   '), [])
  assert.throws(() => parseModelSpec('__pool__:   '), SelectError)
})

test('parseItem: channel/model pins a model, a bare token is ambiguous by design', () => {
  assert.deepEqual(parseItem('kilo/kilo-mini'), { channel: 'kilo', model: 'kilo-mini' })
  assert.deepEqual(parseItem('kilo'), { channel: 'kilo' })
  assert.deepEqual(parseItem('__pool__:all'), { pool: 'all' })
})

test('resolveCandidates: a single channel uses its default model', () => {
  const config = makeConfig()
  assert.deepEqual(resolveCandidates('kilo', { config }), [
    { channel: 'kilo', model: 'kilo-flash', type: 'chat', key: 'kilo/kilo-flash' },
  ])
})

test('resolveCandidates: channel/model pins the model instead of the default', () => {
  const config = makeConfig()
  assert.deepEqual(resolveCandidates('kilo/kilo-mini', { config }), [
    { channel: 'kilo', model: 'kilo-mini', type: 'chat', key: 'kilo/kilo-mini' },
  ])
})

test('resolveCandidates: a comma list resolves in the order given', () => {
  const config = makeConfig()
  assert.deepEqual(resolveCandidates('bunny,kilo/kilo-mini,sense', { config }), [
    { channel: 'bunny', model: 'bunny-free', type: 'chat', key: 'bunny/bunny-free' },
    { channel: 'kilo', model: 'kilo-mini', type: 'chat', key: 'kilo/kilo-mini' },
    { channel: 'sense', model: 'sense-lite', type: 'chat', key: 'sense/sense-lite' },
  ])
})

test('resolveCandidates: a bare model id fans out to every channel that serves it', () => {
  const config = makeConfig()
  assert.deepEqual(resolveCandidates('sense-lite', { config }), [
    { channel: 'sense', model: 'sense-lite', type: 'chat', key: 'sense/sense-lite' },
  ])
})

test('resolveCandidates: a pool expands from the table and keeps its order', () => {
  const config = makeConfig()
  assert.deepEqual(candidatesLabel(resolveCandidates('__pool__:fast-free', { config })), 'kilo/kilo-flash,bunny/bunny-free')
})

test('resolveCandidates: pools may nest, and a cycle is refused', () => {
  const config = makeConfig({
    pools: {
      'fast-free': ['kilo', 'bunny'],
      decide: ['jev'],
      outer: ['__pool__:fast-free'],
      inner: ['__pool__:inner'],
    },
  })
  assert.deepEqual(candidatesLabel(resolveCandidates('__pool__:outer', { config })), 'kilo/kilo-flash,bunny/bunny-free')
  assert.throws(() => resolveCandidates('__pool__:inner', { config }), /refers to itself/)
})

test('resolveCandidates: duplicates collapse to the first occurrence', () => {
  const config = makeConfig()
  const out = resolveCandidates('kilo,kilo/kilo-flash,bunny', { config })
  assert.deepEqual(candidatesLabel(out), 'kilo/kilo-flash,bunny/bunny-free')
})

test('resolveCandidates: every unresolved shape fails with CONFIG, not with a silent guess', () => {
  const config = makeConfig()
  for (const spec of ['nosuch', '__pool__:nope', 'nosuch/nosuch']) {
    try {
      resolveCandidates(spec, { config })
      assert.fail(`"${spec}" must be refused`)
    } catch (error) {
      assert.equal(error.code, CODE.config, `"${spec}"`)
    }
  }
})

test('resolveCandidates: an explicit channel/model pin is not checked against the models list', () => {
  // The models list is a discovery hint, not an allowlist: a caller that names a
  // model the table has not advertised still gets a request out, and the
  // upstream's own refusal is what settles the question.
  const config = makeConfig()
  assert.deepEqual(resolveCandidates('kilo/unlisted-model', { config }), [
    { channel: 'kilo', model: 'unlisted-model', type: 'chat', key: 'kilo/unlisted-model' },
  ])
})

test('resolveCandidates: availability drops a channel and says so when it drops all of them', () => {
  const config = makeConfig()
  const cache = new AvailabilityCache({ now: () => 1000 })
  cache.report('kilo', false, { note: 'TIMEOUT' })

  assert.deepEqual(candidatesLabel(resolveCandidates('kilo,bunny', { config, availability: cache })), 'bunny/bunny-free')
  assert.throws(() => resolveCandidates('kilo', { config, availability: cache }), /marked unavailable/)
})

// ── the fallback loop ─────────────────────────────────────────────────────────

test('select: the first candidate answering means no fallback and no attempts', async () => {
  const { fn, calls } = stubDispatch([okJson('kilo-flash', 'pong')])
  const outcome = await select(CANDIDATES, REQUEST, { dispatch: fn })

  assert.equal(outcome.ok, true)
  assert.equal(outcome.channel, 'kilo')
  assert.equal(outcome.model, 'kilo-flash')
  assert.equal(outcome.modelField, 'kilo/kilo-flash')
  assert.equal(outcome.retries, 0)
  assert.deepEqual(outcome.attempts, [])
  assert.equal(calls.length, 1)
  assert.equal(outcome.response.json.model, 'kilo-flash')
})

test('select: a 429 falls through to the next channel, in order', async () => {
  const { fn, calls } = stubDispatch([httpError(429, 'quota spent'), okJson('bunny-free', 'pong')])
  const outcome = await select(CANDIDATES, REQUEST, { dispatch: fn })

  assert.equal(outcome.ok, true)
  assert.equal(outcome.channel, 'bunny')
  assert.equal(outcome.modelField, 'bunny/bunny-free')
  assert.equal(outcome.retries, 1)
  assert.deepEqual(calls.map(call => call.candidate.channel), ['kilo', 'bunny'])
  assert.equal(outcome.attempts[0].error.code, CODE.rateLimit)
  assert.equal(outcome.attempts[0].error.statusCode, 429)
})

test('select: a timeout falls through to the next channel', async () => {
  const { fn, calls } = stubDispatch([codeError(CODE.timeout, 'silent past its deadline'), okJson('bunny-free', 'pong')])
  const outcome = await select(CANDIDATES, REQUEST, { dispatch: fn })

  assert.equal(outcome.ok, true)
  assert.equal(outcome.channel, 'bunny')
  assert.equal(outcome.retries, 1)
  assert.deepEqual(calls.map(call => call.candidate.channel), ['kilo', 'bunny'])
  assert.equal(outcome.attempts[0].error.code, CODE.timeout)
})

test('select: an empty answer falls through to the next channel', async () => {
  const { fn } = stubDispatch([emptyJson(), okJson('bunny-free', 'pong')])
  const outcome = await select(CANDIDATES, REQUEST, { dispatch: fn })

  assert.equal(outcome.ok, true)
  assert.equal(outcome.channel, 'bunny')
  assert.equal(outcome.attempts[0].error.code, CODE.empty)
})

test('select: a request defect stops the loop instead of burning the pool', async () => {
  const { fn, calls } = stubDispatch([httpError(400, 'bad request')])
  const outcome = await select(CANDIDATES, REQUEST, { dispatch: fn })

  assert.equal(outcome.ok, false)
  assert.equal(calls.length, 1)
  assert.equal(outcome.error.code, CODE.client)
  assert.equal(outcome.error.statusCode, 400)
  assert.equal(outcome.retries, 0)
})

test('select: a caller cancel stops the loop and is not a channel failure', async () => {
  const { fn, calls } = stubDispatch([codeError(CODE.aborted, 'the caller cancelled')])
  const outcome = await select(CANDIDATES, REQUEST, { dispatch: fn })

  assert.equal(outcome.ok, false)
  assert.equal(calls.length, 1)
  assert.equal(outcome.error.code, CODE.aborted)
  assert.equal(outcome.error.retryable, false)
})

test('select: an unknown error from dispatch is classified as a transport failure', async () => {
  const { fn } = stubDispatch([new Error('socket reset')])
  const outcome = await select(CANDIDATES, REQUEST, { dispatch: fn })

  assert.equal(outcome.ok, false)
  assert.equal(outcome.error.code, CODE.transport)
  assert.equal(outcome.attempts.length, CANDIDATES.length)
})

test('select: every candidate failing returns the LAST error, with the whole trail', async () => {
  const { fn, calls } = stubDispatch([
    httpError(429, 'first is rate limited'),
    codeError(CODE.timeout, 'second is silent'),
    httpError(503, 'third has no capacity'),
  ])
  const outcome = await select(CANDIDATES, REQUEST, { dispatch: fn })

  assert.equal(outcome.ok, false)
  assert.equal(outcome.channel, null)
  assert.equal(outcome.modelField, null)
  assert.equal(calls.length, 3)
  assert.equal(outcome.attempts.length, 3)
  assert.deepEqual(outcome.attempts.map(a => a.error.code), [CODE.rateLimit, CODE.timeout, CODE.server])
  assert.equal(outcome.error.message, 'third has no capacity')
  assert.equal(outcome.error.statusCode, 503)
  assert.equal(outcome.retries, 2)
  // The live error object is alongside the JSON-safe one, for callers that need to branch.
  assert.equal(outcome.errorObj.code, CODE.server)
})

test('select: 5xx is retryable, because a different channel may have capacity', async () => {
  const { fn } = stubDispatch([httpError(503, 'no capacity'), okJson('bunny-free', 'pong')])
  const outcome = await select(CANDIDATES, REQUEST, { dispatch: fn })

  assert.equal(outcome.ok, true)
  assert.equal(outcome.channel, 'bunny')
})

test('select: a credential refusal is not retryable and does not mark the channel down', async () => {
  const cache = new AvailabilityCache()
  const { fn, calls } = stubDispatch([httpError(401, 'bad key')])
  const outcome = await select(CANDIDATES, REQUEST, { dispatch: fn, availability: cache })

  assert.equal(outcome.ok, false)
  assert.equal(outcome.error.code, CODE.credential)
  assert.equal(outcome.error.retryable, false)
  assert.equal(calls.length, 1)
  assert.equal(cache.isEnabled('kilo'), true)
  assert.equal(cache.isEnabled('bunny'), true)
})

test('select: a retryable failure marks the channel down, a success marks it up', async () => {
  const cache = new AvailabilityCache({ now: () => 1000 })
  const { fn } = stubDispatch([httpError(429, 'quota spent'), okJson('bunny-free', 'pong')])
  await select(CANDIDATES, REQUEST, { dispatch: fn, availability: cache })

  assert.equal(cache.isEnabled('kilo'), false)
  assert.equal(cache.isEnabled('bunny'), true)
  const kilo = cache.liveEntries().find(entry => entry.key === 'kilo')
  assert.equal(kilo.note, CODE.rateLimit)
})

test('select: maxAttempts caps the walk, and the cap is honoured', async () => {
  const { fn, calls } = stubDispatch([httpError(429, 'no'), httpError(429, 'no')])
  const outcome = await select(CANDIDATES, REQUEST, { dispatch: fn, maxAttempts: 1 })

  assert.equal(calls.length, 1)
  assert.equal(outcome.ok, false)
  assert.equal(outcome.attempts.length, 1)
})

test('select: refuses to run with no candidates or no dispatch', async () => {
  await assert.rejects(() => select([], REQUEST, { dispatch: () => {} }), SelectError)
  await assert.rejects(() => select(CANDIDATES, REQUEST, {}), SelectError)
})

test('select: the model field is echoed from the channel that answered', async () => {
  const { fn } = stubDispatch([httpError(429, 'no'), okJson('bunny-free', 'pong')])
  const outcome = await select(CANDIDATES, { model: 'kilo,bunny', messages: [] }, { dispatch: fn })

  assert.equal(outcome.modelField, 'bunny/bunny-free')
  assert.equal(outcome.response.json.model, 'bunny-free')
})

// ── streaming ──────────────────────────────────────────────────────────────────

test('select: a stream that ends empty falls back, and the replay loses no frames', async () => {
  const { fn } = stubDispatch([emptySseResult(), okSseResult('pong')])
  const request = { ...REQUEST, stream: true }
  const outcome = await select(CANDIDATES, request, { dispatch: fn })

  assert.equal(outcome.ok, true)
  assert.equal(outcome.channel, 'bunny')
  assert.equal(outcome.attempts[0].error.code, CODE.empty)
  assert.match(await readStream(outcome.response.body), /pong/)
})

test('select: the frames buffered by the peek are replayed in front of the live reader', async () => {
  const { fn } = stubDispatch([okSseResult('pong')])
  const outcome = await select(CANDIDATES, { ...REQUEST, stream: true }, { dispatch: fn })

  const text = await readStream(outcome.response.body)
  // All four frames survive: the role prefix, the content, the finish, and [DONE].
  assert.match(text, /"role":"assistant"/)
  assert.match(text, /"content":"pong"/)
  assert.match(text, /"finish_reason":"stop"/)
  assert.match(text, /\[DONE\]/)
  assert.equal(outcome.retries, 0)
})

test('select: a stream that only thinks, and then ends, is treated as empty', async () => {
  const thinkOnly = 'data: {"choices":[{"index":0,"delta":{"reasoning":"hmm"}}]}\n\ndata: [DONE]\n\n'
  const { toStream } = await import('./helpers.js')
  const { fn, calls } = stubDispatch([
    { statusCode: 200, headers: {}, stream: true, body: toStream([thinkOnly]) },
    okSseResult('pong'),
  ])
  const outcome = await select(CANDIDATES, { ...REQUEST, stream: true }, { dispatch: fn })

  assert.equal(outcome.ok, true)
  assert.equal(outcome.channel, 'bunny')
  assert.equal(outcome.attempts[0].error.code, CODE.empty)
  assert.equal(calls.length, 2)
})

// ── the content predicate ─────────────────────────────────────────────────────

test('inspectContent: text, tool calls, and an empty answer', () => {
  assert.deepEqual(inspectContent({ choices: [{ message: { content: 'hi' } }] }), { ok: true })
  assert.deepEqual(inspectContent({ choices: [{ message: { content: '', tool_calls: [{ id: 'a' }] } }] }), { ok: true })
  assert.equal(inspectContent({ choices: [{ message: { content: '   ' } }] }).ok, false)
  assert.equal(inspectContent({ choices: [{ message: { content: null } }] }).code, CODE.empty)
  assert.equal(inspectContent({ choices: [] }).code, CODE.empty)
  assert.equal(inspectContent({}).code, CODE.empty)
})

test('isSseContent: a content delta, a tool-call delta, and nothing else', () => {
  assert.equal(isSseContent('{"choices":[{"delta":{"content":"hi"}}]}'), true)
  assert.equal(isSseContent('{"choices":[{"delta":{"tool_calls":[{"index":0}]}}]}'), true)
  assert.equal(isSseContent('{"choices":[{"delta":{}}]}'), false)
  assert.equal(isSseContent('{"choices":[{"delta":{"reasoning":"hmm"}}]}'), false)
  assert.equal(isSseContent('{"choices":[{"delta":{"content":"   "}}]}'), false)
  assert.equal(isSseContent('{"error":{"message":"nope"}}'), false)
  assert.equal(isSseContent('not json'), false)
})

// ── the availability cache ────────────────────────────────────────────────────

test('availability: a verdict expires after its TTL and the channel comes back', () => {
  let now = 1000
  const cache = new AvailabilityCache({ ttlMs: 60000, now: () => now })
  cache.report('kilo', false, { note: 'RATE_LIMIT' })

  assert.equal(cache.isEnabled('kilo'), false)
  assert.equal(cache.isEnabled('bunny'), true)

  now = 1000 + 59_999
  assert.equal(cache.isEnabled('kilo'), false)

  now = 1000 + 60_001
  assert.equal(cache.isEnabled('kilo'), true)
  assert.equal(cache.size, 0)
})

test('availability: a success clears a stale down verdict immediately', () => {
  let now = 1000
  const cache = new AvailabilityCache({ ttlMs: 60000, now: () => now })
  cache.report('kilo', false, { note: 'TIMEOUT' })
  now = 1000 + 1000
  cache.report('kilo', true)
  assert.equal(cache.isEnabled('kilo'), true)
})

test('availability: forget and clear reset the cache', () => {
  const cache = new AvailabilityCache()
  cache.report('kilo', false)
  cache.report('bunny', false)
  cache.forget('kilo')
  assert.equal(cache.isEnabled('kilo'), true)
  assert.equal(cache.isEnabled('bunny'), false)
  cache.clear()
  assert.equal(cache.size, 0)
})

test('availability: an expired entry is dropped on read, not kept', () => {
  let now = 1000
  const cache = new AvailabilityCache({ ttlMs: 60000, now: () => now })
  cache.report('kilo', false)
  now = 1000 + 120_000
  assert.deepEqual(cache.snapshot().entries, [])
})

test('availability: the open cache never filters, which is the disabled mode', () => {
  assert.equal(OPEN_CACHE.isEnabled('anything'), true)
  OPEN_CACHE.report('anything', false)
  assert.equal(OPEN_CACHE.snapshot().entries.length, 0)
})

// ── describe ──────────────────────────────────────────────────────────────────

test('describe: a JSON-safe projection of a failure, with no undefined keys', () => {
  assert.deepEqual(describe(httpError(429, 'quota')), {
    code: CODE.rateLimit,
    message: 'quota',
    retryable: true,
    statusCode: 429,
  })
  assert.equal(describe(null), null)
  const full = describe(new SelectError('boom', CODE.transport, { statusCode: 502, channel: 'kilo', model: 'kilo-flash' }))
  assert.deepEqual(full, {
    code: CODE.transport,
    message: 'boom',
    retryable: true,
    statusCode: 502,
    channel: 'kilo',
    model: 'kilo-flash',
  })
})

test('candidatesLabel: the order a caller can read back off a response header', () => {
  assert.equal(candidatesLabel(CANDIDATES), 'kilo/kilo-flash,bunny/bunny-free,sense/sense-lite')
  assert.equal(candidatesLabel([]), '')
})
