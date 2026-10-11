/**
 * The handover: from a router verdict to an execution unit, and the discipline
 * plus the current state that every generation answer carries.
 *
 * Three concerns, all of which used to be missing from the skeleton:
 *
 *   a verdict names an operation      →  which execution unit claims it
 *   an executor that will not take it  →  the generation tail takes over
 *   a generation answer without the discipline and the current state re-stated in
 *     it                                →  the forgetting this layer exists to stop
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { CODE, SelectError } from '../src/errors.js'
import { AvailabilityCache } from '../src/availability.js'
import { validateConfig, CHANNEL_TYPE_DISPATCH } from '../src/channels.js'
import { resolveCandidates, candidatesLabel } from '../src/spec.js'
import { INTENT_DECIDE, INTENT_CHAT } from '../src/intent.js'
import {
  DEFAULT_PRESET,
  toLines,
  presetLines,
  statusLines,
  cacheLines,
  composePreamble,
  applyContext,
} from '../src/context.js'
import { executorIndex, operationFromVerdict, taskFrom, sessionRequest } from '../src/operations.js'
import { createDispatch } from '../src/upstream.js'
import { startServer } from '../src/forward.js'
import { makeConfig, retarget, startUpstream, nodeHttpFetch, request, RESP_HELPERS } from './helpers.js'

const PRESET = ['有 merge 就 merge', '不确定就说「不确定」']

// ── the discipline and the current state ──────────────────────────────────────

test('toLines: a string, a list, an object, and nothing', () => {
  assert.deepEqual(toLines('a\nb\n\n  c  '), ['a', 'b', 'c'])
  assert.deepEqual(toLines(['a', '']), ['a'])
  assert.deepEqual(toLines({ a: 1, b: ['x'] }), ['a: 1', 'b: ["x"]'])
  for (const value of [undefined, null, '', []]) assert.deepEqual(toLines(value), [])
})

test('composePreamble: two headed sections, and nothing at all', () => {
  assert.equal(composePreamble([], []), undefined)
  assert.equal(composePreamble(undefined, undefined), undefined)

  const both = composePreamble(PRESET, ['通道 kilo：down（30s，RATE_LIMIT）'])
  assert.match(both, /^【预设 · 行为纪律】\n1\. 有 merge 就 merge\n2\. 不确定就说「不确定」/)
  assert.match(both, /\n\n【近况说明 · 当前状态】\n- 通道 kilo：down（30s，RATE_LIMIT）$/)

  assert.equal(composePreamble(PRESET, []).includes('近况说明'), false)
  assert.equal(composePreamble([], ['状态一行']).trim(), '【近况说明 · 当前状态】\n- 状态一行')
})

test('presetLines: the caller wins, then the table, then the built-in default', () => {
  assert.deepEqual(presetLines({ preset: ['临时纪律'] }, { defaults: { preset: PRESET } }), ['临时纪律'])
  assert.deepEqual(presetLines({}, { defaults: { preset: PRESET } }), PRESET)
  assert.deepEqual(presetLines({}), DEFAULT_PRESET)
  assert.equal(presetLines(undefined).length, DEFAULT_PRESET.length)
  assert.match(presetLines({}).join(''), /merge/)
})

test('statusLines: the caller wins, then whatever the layer itself knows', () => {
  assert.deepEqual(statusLines({ status: '近况' }, undefined), ['近况'])

  const cache = new AvailabilityCache()
  cache.report('kilo', false, { note: 'RATE_LIMIT' })
  cache.report('bunny', true, { note: 'ok' })
  const lines = cacheLines(cache)
  assert.deepEqual(lines, ['通道 kilo：down（0s，RATE_LIMIT）', '通道 bunny：up'])
  assert.deepEqual(statusLines({}, cache), lines)

  // A cache with nothing in it is no situation, not a lie.
  assert.deepEqual(cacheLines(new AvailabilityCache()), [])
  assert.deepEqual(cacheLines(undefined), [])
})

test('applyContext: the preamble becomes the first message and the fields are gone', () => {
  const request = {
    model: 'kilo',
    messages: [{ role: 'user', content: 'hi' }],
    preset: PRESET,
    status: '当前只有一个通道可用',
  }
  const out = applyContext(request)

  assert.equal(out.messages.length, 2)
  assert.equal(out.messages[0].role, 'system')
  assert.match(out.messages[0].content, /1\. 有 merge 就 merge/)
  assert.match(out.messages[0].content, /当前只有一个通道可用/)
  assert.deepEqual(out.messages[1], { role: 'user', content: 'hi' })
  assert.equal(out.preset, undefined)
  assert.equal(out.status, undefined)
  assert.equal(out.model, 'kilo')
  // The caller's request is not touched.
  assert.deepEqual(request.preset, PRESET)
  assert.equal(request.messages.length, 1)
})

test('applyContext: an existing system message is extended, not duplicated', () => {
  const request = {
    messages: [{ role: 'system', content: '你是一台路由器' }, { role: 'user', content: 'hi' }],
    preset: ['纪律一行'],
  }
  const out = applyContext(request)
  assert.equal(out.messages.length, 2)
  assert.match(out.messages[0].content, /^你是一台路由器\n\n【预设/)
  assert.equal(out.messages[0].role, 'system')
})

test('applyContext: no messages is still invalid, and composition does not fix it', () => {
  const out = applyContext({ model: 'kilo', preset: ['纪律一行'] })
  assert.equal(out.messages, undefined, 'composition must not manufacture a conversation')
  // An empty conversation is left as it was: still empty, still invalid.
  const empty = applyContext({ model: 'kilo', messages: [], preset: ['纪律一行'] })
  assert.deepEqual(empty.messages, [])
})

// ── the executor registry ──────────────────────────────────────────────────────

const EXECUTOR_TABLE = {
  channels: {
    router: { type: 'decide', baseUrl: 'http://a', defaultModel: 'r', models: ['r'] },
    tail: { type: 'chat', baseUrl: 'http://b', defaultModel: 't', models: ['t'] },
    merger: { type: 'dispatch', baseUrl: 'http://c', defaultModel: 'm', models: ['m'], operations: ['merge'] },
    auditor: { type: 'dispatch', baseUrl: 'http://d', defaultModel: 'a', models: ['a'], session: 'audit-queue', operations: ['audit', 'ingest'] },
    shadow: { type: 'dispatch', baseUrl: 'http://e', defaultModel: 's', models: ['s'], operations: ['merge'], disabled: true },
    first: { type: 'dispatch', baseUrl: 'http://f', defaultModel: 'f', models: ['f'], operations: ['merge'] },
  },
}

test('executorIndex: first claim wins, and a disabled executor is unreachable', () => {
  const index = executorIndex(validateConfig(EXECUTOR_TABLE))
  assert.deepEqual(Object.keys(index), ['merge', 'audit', 'ingest'])
  // merger is declared before first, so it keeps "merge".
  assert.equal(index.merge.name, 'merger')
  assert.equal(index.audit.name, 'auditor')
  assert.equal(index.audit.session, 'audit-queue')
  assert.equal(index.ingest.name, 'auditor')
  assert.equal(index.shadow, undefined)
  // A decide channel that claims nothing is not an executor.
  assert.equal(index.router, undefined)
})

test('validateConfig: a dispatch channel that claims nothing cannot ship', () => {
  assert.throws(
    () => validateConfig({ channels: { x: { type: 'dispatch', baseUrl: 'http://a', defaultModel: 'm' } } }),
    /is a dispatch channel that claims no operation/,
  )
  // Everything else a dispatch channel needs is derived, not required.
  const config = validateConfig({
    channels: { x: { type: 'dispatch', baseUrl: 'http://a', defaultModel: 'm', operations: ['merge'] } },
  })
  assert.equal(config.channels.x.type, CHANNEL_TYPE_DISPATCH)
  assert.equal(config.channels.x.session, 'x')
  assert.equal(config.channels.x.path, 'chat/completions')
  assert.deepEqual(config.channels.x.operations, ['merge'])
})

test('validateConfig: a pool that lists an execution unit cannot ship', () => {
  assert.throws(
    () => validateConfig({
      channels: EXECUTOR_TABLE.channels,
      pools: { all: ['router', 'tail', 'merger'] },
    }),
    /an execution unit is a destination, not a fallback candidate/,
  )
})

/** Expand a pool the same way `resolveCandidates` does, so the test can see the filtering. */
function expandPool(config, pool, intent) {
  return resolveCandidates(`__pool__:${pool}`, { config, intent })
}

test('candidatesLabel: a dispatch candidate is marked like a decide one', () => {
  const config = validateConfig({ channels: { x: { type: 'dispatch', baseUrl: 'http://a', defaultModel: 'm', models: ['m'], operations: ['merge'] } } })
  const out = resolveCandidates('x', { config, intent: INTENT_CHAT })
  assert.deepEqual(out.map(c => c.channel), ['x'])
  assert.equal(candidatesLabel(out), '@x/m')
})

test('a dispatch channel named by the caller is dialed as an executor', () => {
  const config = validateConfig({
    channels: { x: { type: 'dispatch', baseUrl: 'http://a', defaultModel: 'm', models: ['m'], operations: ['merge'] } },
  })
  const out = resolveCandidates('x', { config, intent: INTENT_DECIDE })
  assert.deepEqual(out.map(c => c.channel), ['x'])
  assert.equal(out[0].type, CHANNEL_TYPE_DISPATCH)
})

// ── verdict → operation → session body ─────────────────────────────────────────

test('operationFromVerdict: the shapes a router is likely to answer with', () => {
  assert.equal(operationFromVerdict({ choice: 'merge' }), 'merge')
  assert.equal(operationFromVerdict({ choice: { action: 'audit' } }), 'audit')
  assert.equal(operationFromVerdict({ selection: { name: 'ingest' } }), 'ingest')
  assert.equal(operationFromVerdict({ action: 'triage' }), 'triage')
  assert.equal(operationFromVerdict({ choices: [{ choice: 'audit' }] }), 'audit')
  // A one-entry confidence map is readable; two entries is a guess.
  assert.equal(operationFromVerdict({ merge: 0.91 }), 'merge')
  assert.equal(operationFromVerdict({ merge: 0.9, audit: 0.1 }), undefined)
})

test('operationFromVerdict: an empty verdict is not a hidden operation', () => {
  for (const verdict of [undefined, null, {}, { choice: undefined }, { choice: '' }, { choice: {} }, 'merge', 3]) {
    assert.equal(operationFromVerdict(verdict), undefined, JSON.stringify(verdict))
  }
})

test('taskFrom: explicit task, the decision task, the last user message, nothing', () => {
  assert.equal(taskFrom({ task: '  合并 PR 12  ' }), '  合并 PR 12  ')
  assert.equal(taskFrom({ task: '  ', decision: { task: '审计知识库' } }), '审计知识库')
  assert.equal(
    taskFrom({ messages: [{ role: 'user', content: '第一句' }, { role: 'assistant', content: '好' }, { role: 'user', content: '最后一句' }] }),
    '最后一句',
  )
  assert.throws(() => taskFrom({}), /no task to dispatch/, SelectError)
  assert.throws(() => taskFrom({ messages: [] }), /no task to dispatch/)
})

test('sessionRequest: task in messages, context alongside, and the table can override', () => {
  const executor = {
    name: 'merger',
    defaultModel: 'm',
    session: 'merge-queue',
    dispatchBody: { stream: false, response_format: { type: 'json_object' } },
  }
  const request = {
    task: '合并 PR 12',
    messages: [{ role: 'user', content: '合并 PR 12' }],
    temperature: 0.2,
    output: 'decision',
  }
  assert.deepEqual(sessionRequest(executor, request), {
    model: 'm',
    session: 'merge-queue',
    messages: [{ role: 'user', content: '合并 PR 12' }],
    context: [{ role: 'user', content: '合并 PR 12' }],
    stream: false,
    response_format: { type: 'json_object' },
    temperature: 0.2,
  })
  assert.equal(sessionRequest(executor, request).output, undefined, 'a router parameter does not cross into a session')
})

// ── end to end: verdict → execution unit, and the tail when it refuses ─────────

const ROUTED_TABLE = {
  version: 1,
  defaults: {
    timeoutMs: 5000,
    availabilityTtlMs: 60000,
    maxAttempts: 4,
    decidePool: 'decide',
    fallbackPool: 'chat',
    preset: ['有 merge 就 merge', '有事做就做，没事做就审计'],
  },
  channels: {
    jev: { type: 'decide', baseUrl: 'http://127.0.0.1:1', path: 'decide', defaultModel: 'jev-1.13-free', models: ['jev-1.13-free'] },
    bunny: { type: 'chat', baseUrl: 'http://127.0.0.1:2', path: 'chat/completions', defaultModel: 'bunny-free', models: ['bunny-free'] },
    'merge-runner': {
      type: 'dispatch',
      baseUrl: 'http://127.0.0.1:3',
      path: 'chat/completions',
      defaultModel: 'merge-model',
      models: ['merge-model'],
      session: 'merge-queue',
      operations: ['merge'],
    },
  },
  pools: { decide: ['jev'], chat: ['bunny'] },
}

const ROUTER_DECISION = {
  kind: 'json',
  status: 200,
  body: {
    id: 'd1',
    object: 'decision',
    model: 'jev-1.13-free',
    choice: { action: 'merge', score: 0.91 },
    usage: { prompt_tokens: 9, completion_tokens: 2 },
  },
}

async function routedServer({ router = ROUTER_DECISION, executor = null, tail = null } = {}) {
  const decide = await startUpstream(router)
  const exec = await startUpstream(executor ?? (hit => ({
    kind: 'json',
    status: 200,
    body: {
      id: 'chatcmpl_exec',
      object: 'chat.completion',
      created: 1,
      model: hit.body.model,
      choices: [{ index: 0, message: { role: 'assistant', content: `合并完成：${hit.body.session}` }, finish_reason: 'stop' }],
    },
  })))
  const chat = await startUpstream(tail ?? (hit => RESP_HELPERS.json(hit.body.model)))

  const config = retarget(retarget(retarget(makeConfigFrom(ROUTED_TABLE), 'jev', decide.base), 'bunny', chat.base), 'merge-runner', exec.base)
  const server = await startServer({
    config,
    dispatch: createDispatch({ channels: config.channels, fetchImpl: nodeHttpFetch, timeoutMs: 5000 }),
    port: 0,
    log: () => {},
  })
  return {
    port: server.port,
    decide,
    exec,
    chat,
    close: async () => { await server.close(); await decide.close(); await exec.close(); await chat.close() },
  }
}

function makeConfigFrom(table) {
  return validateConfig(table)
}

test('end to end: a verdict is handed to the execution unit, not answered in prose', async () => {
  const { port, decide, exec, chat, close } = await routedServer()
  try {
    const res = await request(port, {
      path: '/v1/chat/completions',
      body: { model: 'bunny', messages: [{ role: 'user', content: '看看 PR 12' }], decision: { options: ['merge', 'audit', 'idle'] } },
    })
    assert.equal(res.status, 200)
    assert.equal(res.headers['x-select-intent'], 'decide')
    assert.equal(res.headers['x-select-channel-type'], 'dispatch')
    assert.equal(res.headers['x-select-operation'], 'merge')
    assert.equal(res.headers['x-select-routed'], 'true')
    assert.equal(res.headers['x-selected-channel'], 'merge-runner')
    assert.equal(res.headers['x-selected-model'], 'merge-model')
    assert.ok(res.headers['x-select-candidates'].includes('!jev/jev-1.13-free'))

    // The executor's answer, passed through, with the verdict and the handover.
    assert.equal(res.json.object, 'chat.completion')
    assert.equal(res.json.model, 'merge-runner/merge-model')
    assert.match(res.json.choices[0].message.content, /合并完成：merge-queue/)
    assert.deepEqual(res.json.decision.choice, { action: 'merge', score: 0.91 })
    assert.deepEqual(res.json.dispatch, {
      operation: 'merge',
      session: 'merge-queue',
      channel: 'merge-runner',
      elapsedMs: res.json.dispatch.elapsedMs,
    })
    assert.equal(typeof res.json.dispatch.elapsedMs, 'number')

    // Two upstreams were touched: the router, then the executor. Not the tail.
    assert.equal(decide.hits.length, 1)
    assert.equal(exec.hits.length, 1)
    assert.equal(chat.hits.length, 0)

    const sent = exec.hits[0]
    assert.equal(sent.url, '/chat/completions')
    assert.equal(sent.body.session, 'merge-queue')
    assert.equal(sent.body.model, 'merge-model')
    assert.deepEqual(sent.body.messages, [{ role: 'user', content: '看看 PR 12' }])
    // Context carries the conversation, with the discipline composed in front.
    assert.equal(sent.body.context.at(-1).content, '看看 PR 12')
    assert.match(sent.body.context[0].content, /【预设 · 行为纪律】/)
    assert.equal(sent.headers['x-select-channel-type'], undefined)
  } finally {
    await close()
  }
})

test('end to end: an executor that will not take the work degrades to the tail', async () => {
  const { port, decide, exec, chat, close } = await routedServer({
    executor: () => RESP_HELPERS.rateLimit(),
  })
  try {
    const res = await request(port, {
      path: '/v1/chat/completions',
      body: { model: 'bunny', messages: [{ role: 'user', content: '看看 PR 12' }], decision: { options: ['merge', 'audit'] } },
    })
    assert.equal(res.status, 200)
    assert.equal(res.headers['x-select-channel-type'], 'chat')
    assert.equal(res.headers['x-selected-channel'], 'bunny')
    assert.equal(res.json.model, 'bunny/bunny-free')
    assert.equal(res.json.dispatch, undefined, 'a degraded answer is not a handover')

    assert.equal(decide.hits.length, 1)
    assert.equal(exec.hits.length, 1)
    assert.equal(chat.hits.length, 1)

    // The tail still gets the discipline: it is the same answer, from a different mouth.
    assert.equal(chat.hits[0].body.messages[0].role, 'system')
    assert.match(chat.hits[0].body.messages[0].content, /有 merge 就 merge/)
    assert.equal(chat.hits[0].body.messages.at(-1).content, '看看 PR 12')
  } finally {
    await close()
  }
})

test('end to end: an executor that answers with nothing also degrades', async () => {
  const { port, exec, chat, close } = await routedServer({ executor: () => RESP_HELPERS.empty() })
  try {
    const res = await request(port, {
      path: '/v1/chat/completions',
      body: { model: 'bunny', messages: [{ role: 'user', content: '看看 PR 12' }], decision: { options: ['merge'] } },
    })
    assert.equal(res.status, 200)
    assert.equal(res.headers['x-select-channel-type'], 'chat')
    assert.equal(exec.hits.length, 1)
    assert.equal(chat.hits.length, 1)
  } finally {
    await close()
  }
})

test('end to end: an operation nobody claims degrades to the tail with the choice kept', async () => {
  const { port, decide, exec, chat, close } = await routedServer({
    router: { kind: 'json', status: 200, body: { id: 'd2', object: 'decision', choice: { action: 'refactor' } } },
  })
  try {
    const res = await request(port, {
      path: '/v1/chat/completions',
      body: { model: 'bunny', messages: [{ role: 'user', content: '重构一下' }], decision: { options: ['refactor', 'audit'] } },
    })
    // The caller asked for work to be done and nothing can do it, so the tail
    // takes the turn — and the choice stays in the body as the reason why.
    assert.equal(res.status, 200)
    assert.equal(res.headers['x-select-channel-type'], 'chat')
    assert.equal(res.headers['x-selected-channel'], 'bunny')
    assert.equal(res.headers['x-select-operation'], 'refactor')
    assert.equal(res.headers['x-select-degraded'], 'no_executor')
    assert.equal(res.headers['x-select-routed'], undefined)
    assert.deepEqual(res.json.decision.choice, { action: 'refactor' })
    assert.equal(res.json.dispatch, undefined)

    assert.equal(decide.hits.length, 1)
    assert.equal(exec.hits.length, 0)
    assert.equal(chat.hits.length, 1)
  } finally {
    await close()
  }
})

test('end to end: a verdict with no operation goes back to the caller untouched', async () => {
  const { port, exec, chat, close } = await routedServer({
    router: { kind: 'json', status: 200, body: { id: 'd3', object: 'decision', reason: '没有可执行项' } },
  })
  try {
    const res = await request(port, {
      path: '/v1/chat/completions',
      body: { model: 'bunny', messages: [{ role: 'user', content: '随便看看' }], decision: { options: ['a', 'b'] } },
    })
    assert.equal(res.status, 200)
    assert.equal(res.headers['x-select-channel-type'], 'decide')
    assert.equal(res.headers['x-select-routed'], undefined)
    assert.equal(res.json.model, 'jev/jev-1.13-free')
    assert.equal(res.json.decision.reason, '没有可执行项')
    assert.equal(exec.hits.length, 0)
    assert.equal(chat.hits.length, 0)
  } finally {
    await close()
  }
})

test('end to end: an executor that refuses with a 4xx also degrades, and the tail still answers', async () => {
  const { port, exec, chat, close } = await routedServer({ executor: () => RESP_HELPERS.badRequest() })
  try {
    const res = await request(port, {
      path: '/v1/chat/completions',
      body: { model: 'bunny', messages: [{ role: 'user', content: '合并' }], decision: { options: ['merge'] } },
    })
    assert.equal(res.status, 200)
    assert.equal(res.headers['x-selected-channel'], 'bunny')
    assert.equal(exec.hits.length, 1)
    assert.equal(chat.hits.length, 1)
  } finally {
    await close()
  }
})

test('end to end: /health lists the operations and their execution units', async () => {
  const { port, close } = await routedServer()
  try {
    const res = await request(port, { method: 'GET', path: '/health' })
    assert.equal(res.status, 200)
    assert.deepEqual(res.json.executors, { merge: 'merge-runner' })
    assert.equal(res.json.types['merge-runner'], 'dispatch')
    assert.equal(res.json.types.jev, 'decide')
    assert.deepEqual(res.json.pools, ['decide', 'chat'])
  } finally {
    await close()
  }
})

test('end to end: /v1/models lists an executor as a channel/model pair', async () => {
  const { port, close } = await routedServer()
  try {
    const res = await request(port, { method: 'GET', path: '/v1/models' })
    const ids = res.json.data.map(row => row.id)
    assert.ok(ids.includes('merge-runner/merge-model'))
    assert.ok(ids.includes('jev/jev-1.13-free'))
  } finally {
    await close()
  }
})

test('end to end: the router still gets a decision, never a completion prompt', async () => {
  const { port, decide, exec, close } = await routedServer()
  try {
    await request(port, {
      path: '/v1/chat/completions',
      body: { model: 'bunny', messages: [{ role: 'user', content: '看看 PR 12' }], decision: { options: ['merge', 'audit'], criteria: '最便宜的' } },
    })
    const sent = decide.hits[0]
    assert.equal(sent.url, '/decide')
    assert.deepEqual(sent.body.options, ['merge', 'audit'])
    assert.equal(sent.body.criteria, '最便宜的')
    assert.equal(sent.body.model, 'jev-1.13-free')
    assert.ok(!('messages' in sent.body))
    assert.ok(exec.hits.length === 1)
  } finally {
    await close()
  }
})

test('end to end: an explicit task field is what the executor runs, not the prompt', async () => {
  const { port, exec, close } = await routedServer()
  try {
    const res = await request(port, {
      path: '/v1/chat/completions',
      body: {
        model: 'bunny',
        task: '合并 PR 12 和 PR 13',
        messages: [{ role: 'user', content: '帮我看看现在要干嘛' }],
        decision: { options: ['merge'] },
      },
    })
    assert.equal(res.status, 200)
    assert.equal(res.headers['x-select-operation'], 'merge')
    assert.deepEqual(exec.hits[0].body.messages, [{ role: 'user', content: '合并 PR 12 和 PR 13' }])
    assert.equal(exec.hits[0].body.context.at(-1).content, '帮我看看现在要干嘛')
  } finally {
    await close()
  }
})
