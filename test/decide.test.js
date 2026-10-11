/**
 * The decide path: a request that asks to *choose* is answered by a decide
 * channel and degrades to the chat tail.
 *
 * These tests exercise three layers at once, because the degradation is only
 * meaningful end to end: intent detection decides which kind of channel is first,
 * dispatch decides what goes on the wire, and projection decides what the caller
 * sees back.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { CODE } from '../src/errors.js'
import {
  detectIntent,
  decisionSpec,
  decisionLabel,
  INTENT_DECIDE,
  INTENT_CHAT,
} from '../src/intent.js'
import { resolveCandidates, candidatesLabel } from '../src/spec.js'
import { createDispatch, projectDecision } from '../src/upstream.js'
import { startServer } from '../src/forward.js'
import { select } from '../src/select.js'
import {
  BASE_TABLE,
  makeConfig,
  retarget,
  startUpstream,
  nodeHttpFetch,
  request,
  stubDispatch,
  okJson,
  httpError,
} from './helpers.js'

const DECISION = { options: ['merge', 'audit', 'idle'], criteria: 'cheapest safe thing' }
const MESSAGES = [{ role: 'user', content: 'what do we do now' }]

// ── intent detection ───────────────────────────────────────────────────────────

test('detectIntent: a well-formed decision is the whole negotiation', () => {
  assert.equal(detectIntent({ model: 'a', messages: MESSAGES }), INTENT_CHAT)
  assert.equal(detectIntent(null), INTENT_CHAT)
  assert.equal(detectIntent({ model: 'a', messages: MESSAGES, decision: DECISION }), INTENT_DECIDE)
  assert.equal(detectIntent({ model: 'a', messages: MESSAGES, decision: null }), INTENT_CHAT)
})

test('detectIntent: a malformed decision stays chat, and the handler says why', () => {
  for (const decision of [
    'merge',
    ['merge'],
    {},
    { options: [] },
    { options: [''] },
    { options: ['merge', 3] },
    { options: ['merge'], top_k: 0 },
    { options: ['merge'], criteria: 3 },
  ]) {
    assert.equal(detectIntent({ model: 'a', messages: MESSAGES, decision }), INTENT_CHAT, JSON.stringify(decision))
    const spec = decisionSpec({ model: 'a', messages: MESSAGES, decision })
    assert.equal(spec.present, true, JSON.stringify(decision))
    assert.equal(spec.ok, false, JSON.stringify(decision))
    assert.equal(spec.status, 400)
    assert.match(spec.message, /decision/)
  }
})

test('decisionSpec: absent is a third state, not an error', () => {
  const spec = decisionSpec({ model: 'a', messages: MESSAGES })
  assert.equal(spec.present, false)
  assert.equal(spec.ok, false)
  assert.equal(spec.status, undefined)
})

test('decisionSpec: aliases are accepted, top_k is normalised, extras pass through', () => {
  const spec = decisionSpec({
    model: 'a',
    messages: MESSAGES,
    decision: { choices: ['merge', 'audit'], topK: '2', task: 'pick', label: 'route-1' },
  })
  assert.equal(spec.ok, true)
  assert.deepEqual(spec.decision.options, ['merge', 'audit'])
  assert.equal(spec.decision.top_k, 2)
  assert.equal(spec.decision.task, 'pick')
  assert.equal(spec.decision.label, 'route-1')
  assert.equal(spec.decision.choices, undefined)
})

test('decisionLabel: a count a caller can read back off a header', () => {
  assert.equal(decisionLabel({ decision: DECISION }), '3 options')
  assert.equal(decisionLabel({}), 'none')
})

// ── intent-aware candidate ordering ────────────────────────────────────────────

test('resolveCandidates: decide intent puts the router first and the tail last', () => {
  const config = makeConfig()
  // The caller asked for bunny and kilo; the router still goes first, and the
  // caller's own order is preserved inside each half.
  const out = resolveCandidates('bunny,kilo', { config, intent: INTENT_DECIDE })
  assert.deepEqual(out.map(c => c.key), ['jev/jev-1.13-free', 'bunny/bunny-free', 'kilo/kilo-flash'])
  assert.deepEqual(out.map(c => c.type), ['decide', 'chat', 'chat'])
})

test('resolveCandidates: naming a decide channel fills the fallback tail', () => {
  const config = makeConfig()
  const out = resolveCandidates('jev', { config, intent: INTENT_DECIDE })
  assert.deepEqual(out.map(c => c.key), ['jev/jev-1.13-free', 'kilo/kilo-flash', 'bunny/bunny-free'])
})

test('resolveCandidates: a table with no decide pool degrades without comment', () => {
  const config = makeConfig({ defaults: { ...BASE_TABLE.defaults, decidePool: undefined } })
  const out = resolveCandidates('kilo', { config, intent: INTENT_DECIDE })
  assert.deepEqual(out.map(c => c.key), ['kilo/kilo-flash'])
})

test('resolveCandidates: chat intent never reaches a decide channel', () => {
  const config = makeConfig()
  const out = resolveCandidates('jev,bunny', { config, intent: INTENT_CHAT })
  assert.deepEqual(out.map(c => c.key), ['bunny/bunny-free'])
  assert.equal(out.some(c => c.type === 'decide'), false)
})

test('resolveCandidates: naming only decide channels without intent is a config error', () => {
  const config = makeConfig()
  try {
    resolveCandidates('jev', { config, intent: INTENT_CHAT })
    assert.fail('a decide-only candidate list must be refused for a chat intent')
  } catch (error) {
    assert.equal(error.code, CODE.config)
    assert.match(error.message, /decision/)
  }
})

test('resolveCandidates: a mixed pool keeps only the chat half for a chat intent', () => {
  const config = makeConfig({ pools: { ...BASE_TABLE.pools, mixed: ['jev', 'bunny'] } })
  assert.deepEqual(
    candidatesLabel(resolveCandidates('__pool__:mixed', { config, intent: INTENT_CHAT })),
    'bunny/bunny-free',
  )
  assert.deepEqual(
    candidatesLabel(resolveCandidates('__pool__:mixed', { config, intent: INTENT_DECIDE })),
    '!jev/jev-1.13-free,bunny/bunny-free',
  )
})

test('candidatesLabel: decide candidates carry a marker', () => {
  const config = makeConfig()
  assert.equal(
    candidatesLabel(resolveCandidates('jev,kilo', { config, intent: INTENT_DECIDE })),
    '!jev/jev-1.13-free,kilo/kilo-flash',
  )
})

test('a disabled decide channel is documentation, not a router', () => {
  const config = makeConfig({
    channels: { ...BASE_TABLE.channels, jev: { ...BASE_TABLE.channels.jev, disabled: true } },
  })
  // Naming it directly is a request, so it is refused.
  assert.throws(() => resolveCandidates('jev', { config }), /is disabled in the table/)
  // A pool quietly skips it, so decide intent degrades straight to the chat tail.
  const out = resolveCandidates('bunny', { config, intent: INTENT_DECIDE })
  assert.deepEqual(out.map(c => c.key), ['bunny/bunny-free'])
  assert.equal(out.some(c => c.type === 'decide'), false)
})

// ── the verdict projection ─────────────────────────────────────────────────────

test('projectDecision: the verdict becomes the assistant content as JSON', () => {
  const out = projectDecision({
    id: 'd1',
    object: 'decision',
    created: 7,
    model: 'jev-1.13-free',
    choice: { action: 'merge', score: 0.91 },
    scores: { merge: 0.91, audit: 0.05, idle: 0.04 },
    usage: { prompt_tokens: 40, completion_tokens: 3 },
  }, 'jev-1.13-free')

  assert.equal(out.object, 'chat.completion')
  assert.equal(out.model, 'jev-1.13-free')
  assert.equal(out.id, 'd1')
  assert.equal(out.created, 7)
  assert.deepEqual(out.usage.prompt_tokens, 40)
  assert.deepEqual(out.decision, {
    choice: { action: 'merge', score: 0.91 },
    scores: { merge: 0.91, audit: 0.05, idle: 0.04 },
  })
  assert.deepEqual(JSON.parse(out.choices[0].message.content), out.decision)
  assert.equal(out.choices[0].finish_reason, 'stop')
})

test('projectDecision: frame keys never leak into the verdict', () => {
  const out = projectDecision({
    id: 'd2', object: 'decision', created: 1, model: 'm', request_id: 'r1',
    usage: { total_tokens: 2 }, logprobs: null, service_tier: 'free',
    decision: 'ignored',
    choice: 'merge',
  }, 'm')
  assert.deepEqual(out.decision, { choice: 'merge' })
  assert.ok(!('request_id' in out.decision))
  assert.ok(!('usage' in out.decision))
})

test('projectDecision: an envelope with nothing inside it is an empty answer', () => {
  for (const body of [{}, { id: 'd', object: 'decision' }, null, 'not an object']) {
    const out = projectDecision(body, 'm')
    assert.equal(out.choices[0].message.content, '', JSON.stringify(body))
    assert.deepEqual(out.decision, {}, JSON.stringify(body))
  }
})

// ── end to end ─────────────────────────────────────────────────────────────────

// `option` picks one of the caller's own options, which is what a decision is.
// `action` would name one of this layer's operations and hand the turn to an
// execution unit instead of returning the verdict — see operations.test.js.
const DECIDE_RESPONSE = {
  kind: 'json',
  status: 200,
  body: {
    id: 'd1',
    object: 'decision',
    model: 'jev-1.13-free',
    choice: { option: 'merge', score: 0.91 },
    scores: { merge: 0.91, audit: 0.05, idle: 0.04 },
    usage: { prompt_tokens: 40, completion_tokens: 3 },
  },
}

async function decideServer({
  decideResponse = DECIDE_RESPONSE,
  chatResponse,
  port = 0,
} = {}) {
  const decide = await startUpstream(decideResponse)
  const chat = await startUpstream(chatResponse ?? (hit => ({
    kind: 'json',
    status: 200,
    body: {
      id: 'c1',
      object: 'chat.completion',
      model: hit.body.model,
      choices: [{ index: 0, message: { role: 'assistant', content: `answered by ${hit.body.model}` }, finish_reason: 'stop' }],
    },
  })))
  const config = retarget(retarget(makeConfig(), 'jev', decide.base), 'bunny', chat.base)
  const server = await startServer({
    config,
    dispatch: createDispatch({ channels: config.channels, fetchImpl: nodeHttpFetch, timeoutMs: 5000 }),
    port,
    log: () => {},
  })
  return {
    port: server.port,
    decide,
    chat,
    close: async () => { await server.close(); await decide.close(); await chat.close() },
  }
}

test('end to end: a decision is answered by the decide channel in the chat envelope', async () => {
  const { port, decide, chat, close } = await decideServer()
  try {
    const res = await request(port, {
      path: '/v1/chat/completions',
      body: { model: 'bunny', messages: MESSAGES, decision: DECISION },
    })
    assert.equal(res.status, 200)
    assert.equal(res.headers['x-select-intent'], 'decide')
    assert.equal(res.headers['x-select-channel-type'], 'decide')
    assert.equal(res.headers['x-selected-channel'], 'jev')
    assert.equal(res.headers['x-select-retries'], '0')
    assert.ok(res.headers['x-select-candidates'].includes('!jev/jev-1.13-free'))

    // A verdict, not prose, in a shape an OpenAI client can read.
    assert.equal(res.json.object, 'chat.completion')
    assert.equal(res.json.model, 'jev/jev-1.13-free')
    assert.deepEqual(JSON.parse(res.json.choices[0].message.content).choice, { option: 'merge', score: 0.91 })

    // The router was asked for the choices and the context, never for a completion.
    assert.equal(decide.hits.length, 1)
    assert.equal(chat.hits.length, 0)
    const sent = decide.hits[0]
    assert.equal(sent.url, '/decide')
    assert.deepEqual(sent.body.options, DECISION.options)
    assert.equal(sent.body.criteria, DECISION.criteria)
    // The router sees the caller's messages, with the discipline and the current
    // state composed in front of them — the same context a fallback model gets.
    assert.deepEqual(sent.body.context.at(-1), MESSAGES[0])
    assert.equal(sent.body.context[0].role, 'system')
    assert.match(sent.body.context[0].content, /预设/)
    assert.equal(sent.body.model, 'jev-1.13-free')
    assert.ok(!('messages' in sent.body), 'a router is not sent a completion prompt')
  } finally {
    await close()
  }
})


test('end to end: a decide failure degrades to the generation tail', async () => {
  const { port, decide, chat, close } = await decideServer({
    decideResponse: { kind: 'json', status: 429, body: { error: { message: 'quota', type: 'rate_limit_error' } } },
  })
  try {
    const res = await request(port, {
      path: '/v1/chat/completions',
      body: { model: 'bunny', messages: MESSAGES, decision: DECISION },
    })
    assert.equal(res.status, 200)
    assert.equal(res.headers['x-select-channel-type'], 'chat')
    assert.equal(res.headers['x-selected-channel'], 'bunny')
    assert.equal(res.headers['x-select-retries'], '1')
    assert.equal(res.json.model, 'bunny/bunny-free')
    assert.equal(res.json.choices[0].message.content, 'answered by bunny-free')
    assert.equal(decide.hits.length, 1)
    assert.equal(chat.hits.length, 1)
  } finally {
    await close()
  }
})

test('end to end: a verdict with nothing in it also degrades', async () => {
  const { port, decide, chat, close } = await decideServer({
    decideResponse: { kind: 'json', status: 200, body: { id: 'd2', object: 'decision' } },
  })
  try {
    const res = await request(port, {
      path: '/v1/chat/completions',
      body: { model: 'bunny', messages: MESSAGES, decision: DECISION },
    })
    assert.equal(res.status, 200)
    assert.equal(res.headers['x-select-channel-type'], 'chat')
    assert.equal(res.headers['x-select-retries'], '1')
    assert.equal(decide.hits.length, 1)
    assert.equal(chat.hits.length, 1)
  } finally {
    await close()
  }
})

test('end to end: no dialable decide channel means a plain completion', async () => {
  const decide = await startUpstream(DECIDE_RESPONSE)
  const chat = await startUpstream({
    kind: 'json', status: 200,
    body: { id: 'c2', object: 'chat.completion', model: 'bunny-free', choices: [{ index: 0, message: { role: 'assistant', content: 'prose' }, finish_reason: 'stop' }] },
  })
  const config = retarget(makeConfig(), 'bunny', chat.base)
  const server = await startServer({
    config,
    dispatch: createDispatch({ channels: config.channels, fetchImpl: nodeHttpFetch, timeoutMs: 5000 }),
    port: 0,
    log: () => {},
  })
  try {
    const res = await request(server.port, {
      path: '/v1/chat/completions',
      body: { model: 'bunny', messages: MESSAGES, decision: DECISION },
    })
    assert.equal(res.status, 200)
    assert.equal(res.headers['x-select-intent'], 'decide')
    assert.equal(res.headers['x-select-channel-type'], 'chat')
    assert.equal(decide.hits.length, 0, 'a channel that is not in the table is not dialed')
  } finally {
    await server.close(); await decide.close(); await chat.close()
  }
})

test('end to end: a chat intent never dials the decide channel', async () => {
  const { port, decide, chat, close } = await decideServer()
  try {
    const res = await request(port, {
      path: '/v1/chat/completions',
      body: { model: '__pool__:decide', messages: MESSAGES },
    })
    assert.equal(res.status, 400)
    assert.match(res.json.error.message, /decision/)
    assert.equal(decide.hits.length, 0)
    assert.equal(chat.hits.length, 0)
  } finally {
    await close()
  }
})

test('end to end: a malformed decision is a 400, not a rewritten completion', async () => {
  const { port, decide, chat, close } = await decideServer()
  try {
    const res = await request(port, {
      path: '/v1/chat/completions',
      body: { model: 'bunny', messages: MESSAGES, decision: { options: [] } },
    })
    assert.equal(res.status, 400)
    assert.match(res.json.error.message, /decision\.options/)
    assert.equal(decide.hits.length, 0)
    assert.equal(chat.hits.length, 0)
  } finally {
    await close()
  }
})

test('end to end: a decide answer to a streamed request arrives as SSE', async () => {
  const { port, close } = await decideServer()
  try {
    const res = await request(port, {
      path: '/v1/chat/completions',
      body: { model: 'bunny', messages: MESSAGES, decision: DECISION, stream: true },
    })
    assert.equal(res.status, 200)
    assert.match(res.headers['content-type'], /text\/event-stream/)
    assert.equal(res.headers['x-select-channel-type'], 'decide')
    assert.equal((res.text.match(/\[DONE\]/g) ?? []).length, 1)
    // The verdict travels inside the content string, so its keys are escaped.
    assert.match(res.text, /\\\"choice\\\"/)
    assert.ok(res.text.includes('chat.completion.chunk'))
  } finally {
    await close()
  }
})

// ── the whole thing behind one dispatch, no sockets ────────────────────────────

test('select: a decide candidate that answers is reported as a decide channel', async () => {
  const config = makeConfig()
  const candidates = resolveCandidates('bunny', { config, intent: INTENT_DECIDE })
  const { fn } = stubDispatch([okJson('jev-1.13-free', '{"choice":"merge"}')])
  const outcome = await select(candidates, { model: 'x', messages: MESSAGES, decision: DECISION }, { dispatch: fn })
  assert.equal(outcome.ok, true)
  assert.equal(outcome.channel, 'jev')
  assert.equal(outcome.type, 'decide')
  assert.equal(outcome.modelField, 'jev/jev-1.13-free')
})
