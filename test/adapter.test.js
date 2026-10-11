/**
 * Adapter tests: the DSH provider surface.
 *
 * Two halves, and both are offline.
 *
 *   - the translation units, which are pure and need no network at all
 *   - the contract and the end-to-end path, which use the same loopback
 *     upstream and proxy-free fetch the handler suite already uses
 *
 * The harness itself is faked: a `registerAdapter` that records its arguments.
 * The plugin is not registered into a DSH profile in this step, so no profile
 * restart is needed and nothing here reaches a real LLM runtime.
 *
 * @module test/adapter.test.js
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createModelSelect, apply, inject, name } from '../index.js'
import {
  ModelSelectAdapter,
  ROUTE,
  PROVIDER_NAME,
  RETRY_POLICY,
  catalogRows,
  toChatMessages,
  toToolDefs,
  toLayerRequest,
  isPoolSpec,
} from '../src/adapter.js'
import { validateConfig } from '../src/channels.js'
import { BASE_TABLE, makeConfig, retarget, startUpstream, RESP_HELPERS, nodeHttpFetch } from './helpers.js'

const RESP = RESP_HELPERS

// ── translation units ──────────────────────────────────────────────────────────

test('toChatMessages: a system prompt leads the conversation', () => {
  assert.deepEqual(toChatMessages([{ role: 'user', content: 'hi' }], 'be brief'), [
    { role: 'system', content: 'be brief' },
    { role: 'user', content: 'hi' },
  ])
})

test('toChatMessages: a blank system prompt is not sent', () => {
  assert.deepEqual(toChatMessages([{ role: 'user', content: 'hi' }], '   '), [{ role: 'user', content: 'hi' }])
})

test('toChatMessages: string content passes through unchanged', () => {
  assert.deepEqual(toChatMessages([{ role: 'user', content: 'hi' }]), [{ role: 'user', content: 'hi' }])
})

test('toChatMessages: text and reasoning blocks fold into one string', () => {
  const rows = toChatMessages([{
    role: 'user',
    content: [
      { type: 'text', text: 'look ' },
      { type: 'reasoning', text: 'maybe it is 7' },
      { type: 'text', text: 'at this' },
    ],
  }])
  assert.deepEqual(rows, [{ role: 'user', content: 'look \n[thinking] maybe it is 7\nat this' }])
})

test('toChatMessages: a developer message joins the system role', () => {
  assert.deepEqual(toChatMessages([{ role: 'developer', content: 'discipline' }]), [{ role: 'system', content: 'discipline' }])
})

test('toChatMessages: tool calls become OpenAI tool_calls on the assistant message', () => {
  const rows = toChatMessages([{
    role: 'assistant',
    content: [
      { type: 'text', text: 'let me check' },
      { type: 'tool-call', id: 'call_1', name: 'read_file', arguments: { path: 'a.txt' } },
    ],
  }])
  assert.equal(rows.length, 1)
  assert.equal(rows[0].role, 'assistant')
  assert.equal(rows[0].content, 'let me check')
  assert.deepEqual(rows[0].tool_calls, [{
    id: 'call_1',
    type: 'function',
    function: { name: 'read_file', arguments: '{"path":"a.txt"}' },
  }])
})

test('toChatMessages: a tool result keeps its call id', () => {
  const rows = toChatMessages([{
    role: 'tool',
    toolCallId: 'call_1',
    content: [{ type: 'text', text: 'the file says 7' }],
  }])
  assert.deepEqual(rows, [{ role: 'tool', tool_call_id: 'call_1', name: undefined, content: 'the file says 7' }])
})

test('toChatMessages: an image becomes a text handle, never bytes', () => {
  const rows = toChatMessages([{
    role: 'user',
    content: [{ type: 'image', attachment: { name: 'pic.png', bytes: 4096, path: '/tmp/pic.png' } }],
  }])
  assert.deepEqual(rows, [{ role: 'user', content: '[image] pic.png (4096 bytes) — /tmp/pic.png' }])
  assert.equal(rows[0].image_url, undefined)
})

test('toChatMessages: blocks that cannot be projected are dropped, not faked', () => {
  const rows = toChatMessages([{
    role: 'assistant',
    content: [{ type: 'tool-addition', toolName: 'read_file' }, { type: 'text', text: 'still here' }],
  }])
  assert.deepEqual(rows, [{ role: 'assistant', content: 'still here' }])
})

test('toChatMessages: an empty assistant message is dropped, not sent as empty', () => {
  assert.deepEqual(toChatMessages([{ role: 'assistant', content: [{ type: 'text', text: '' }] }]), [])
})

test('toToolDefs: OpenAI tool shape, undefined when there are none', () => {
  assert.equal(toToolDefs([]), undefined)
  assert.equal(toToolDefs(undefined), undefined)
  assert.deepEqual(toToolDefs([{ name: 'read', description: 'read a file', parameters: { type: 'object' } }]), [{
    type: 'function',
    function: { name: 'read', description: 'read a file', parameters: { type: 'object' } },
  }])
})

test('toLayerRequest: the layer request is built, and streaming is off', () => {
  const request = toLayerRequest({
    model: '__pool__:fast-free',
    messages: [{ role: 'user', content: 'hi' }],
    system: 'discipline',
    maxTokens: 512,
    temperature: 0.3,
    topP: 0.9,
    stop: ['\n\nEND'],
    tools: [{ name: 'read', description: '', parameters: {} }],
  }, '__pool__:fast-free')
  assert.equal(request.model, '__pool__:fast-free')
  assert.equal(request.stream, false)
  assert.equal(request.max_tokens, 512)
  assert.equal(request.max_completion_tokens, 512)
  assert.equal(request.temperature, 0.3)
  assert.equal(request.topP, 0.9)
  assert.deepEqual(request.stop, ['\n\nEND'])
  assert.equal(request.tools.length, 1)
  assert.deepEqual(request.messages.map(row => row.role), ['system', 'user'])
})

test('toLayerRequest: absent fields stay absent', () => {
  const request = toLayerRequest({ model: 'kilo', messages: [{ role: 'user', content: 'hi' }] }, 'kilo')
  assert.deepEqual(Object.keys(request).sort(), ['messages', 'model', 'stream'])
})

test('isPoolSpec: pools only', () => {
  assert.equal(isPoolSpec('__pool__:fast-free'), true)
  assert.equal(isPoolSpec('kilo/deepseek-v4.1-flash'), false)
  assert.equal(isPoolSpec('__pool:fast-free'), false)
  assert.equal(isPoolSpec(''), false)
})

// ── catalog ────────────────────────────────────────────────────────────────────

test('catalogRows: pools first, then channels, then execution units', () => {
  const rows = catalogRows(tableWithExecutors(), ROUTE)
  const ids = rows.map(row => row.id)
  const firstPool = ids.findIndex(id => id.startsWith('__pool__:'))
  const firstChannel = ids.findIndex(id => id.includes('/'))
  const firstExecutor = ids.findIndex(id => id.startsWith('merger/'))

  assert.equal(firstPool, 0, `pools lead, got ${ids[0]}`)
  assert.ok(firstChannel > firstPool, 'channels follow the pools')
  assert.equal(firstExecutor, ids.length - 1, 'execution units close the list')
  assert.ok(rows.every(row => row.provider === ROUTE))
})

test('catalogRows: disabled channels stay out of the catalog', () => {
  const ids = catalogRows(tableWithExecutors()).map(row => row.id)
  assert.ok(!ids.some(id => id.startsWith('jev/')), 'jev is disabled and is documentation, not a lane')
})

test('a pool listing an execution unit is refused at load time, not filtered later', () => {
  // The catalog never sees this table: validation throws before a row can be
  // built, so an executor can never silently become a fallback candidate.
  assert.throws(
    () => tableWithExecutors({ pools: { workers: ['merger'], 'fast-free': ['kilo', 'bunny'] } }),
    /an execution unit is a destination, not a fallback candidate/,
  )
})

test('catalogRows: table order is preserved inside a group', () => {
  const rows = catalogRows(makeConfig())
  assert.deepEqual(
    rows.filter(row => row.id === 'kilo/kilo-flash' || row.id === 'kilo/kilo-mini').map(row => row.id),
    ['kilo/kilo-flash', 'kilo/kilo-mini'],
  )
})

test('catalogRows: no modality is claimed, because the table declares none', () => {
  for (const row of catalogRows(makeConfig())) {
    assert.equal('inputModalities' in row, false, `${row.id} claims a modality`)
  }
})

// ── retry policy ───────────────────────────────────────────────────────────────

test('the retry policy owns nothing: select() already retries inside the call', () => {
  assert.equal(RETRY_POLICY.mode, 'normal')
  assert.equal(RETRY_POLICY.maxRetries, 0)
  // The codes select() already walks over; maxRetries: 0 is what keeps the
  // harness out of the loop, not this list.
  assert.deepEqual(RETRY_POLICY.retryableCodes, ['EMPTY_RESPONSE', 'SERVER', 'TIMEOUT', 'TRANSPORT'])
  assert.throws(() => { RETRY_POLICY.retryableCodes.push('RATE_LIMIT') }, TypeError)
  assert.throws(() => { RETRY_POLICY.maxRetries = 3 }, TypeError)
})

test('the retry policy carries its delay fields at the top level', () => {
  // Both kernels read these off the top level and store the object verbatim;
  // nested under `backoff` they resolve to NaN, which the session log rejects.
  for (const key of ['initialDelayMs', 'maxDelayMs', 'jitterRatio']) {
    assert.ok(key in RETRY_POLICY, `${key} must be top level`)
    assert.equal(typeof RETRY_POLICY[key], 'number')
  }
  assert.equal('backoff' in RETRY_POLICY, false)
})

// ── the adapter contract ───────────────────────────────────────────────────────

function fixture(options = {}) {
  return createModelSelect({ config: options.config ?? makeConfig(), fetchImpl: nodeHttpFetch, log: () => {} })
}

test('providerInfo: id echoes the route and names the provider', () => {
  assert.deepEqual(new ModelSelectAdapter({ api: fixture() }).providerInfo(ROUTE), { id: ROUTE, name: PROVIDER_NAME })
})

test('providerRetryPolicy: the layer-owned policy', () => {
  assert.equal(new ModelSelectAdapter({ api: fixture() }).providerRetryPolicy(), RETRY_POLICY)
})

test('imageRequestPricing: nothing declared, so consumers keep their own estimate', () => {
  assert.equal(new ModelSelectAdapter({ api: fixture() }).imageRequestPricing(ROUTE, 'kilo/kilo-flash'), undefined)
})

test('listModels: what the picker sees, pools first', async () => {
  const rows = await new ModelSelectAdapter({ api: fixture({ config: tableWithExecutors() }) }).listModels(ROUTE)
  assert.ok(rows.length >= 6)
  assert.equal(rows[0].id, '__pool__:fast-free')
  assert.ok(rows.every(row => typeof row.id === 'string' && row.id !== ''))
})

test('resolveModel: a pool spec resolves, and reports the fallback width', async () => {
  const info = await new ModelSelectAdapter({ api: fixture() }).resolveModel(ROUTE, '__pool__:fast-free')
  assert.equal(info.provider, ROUTE)
  assert.equal(info.id, '__pool__:fast-free')
  assert.ok(info.description.includes('candidate'))
})

test('resolveModel: a single channel pins to one candidate', async () => {
  const info = await new ModelSelectAdapter({ api: fixture() }).resolveModel(ROUTE, 'kilo/kilo-flash')
  assert.equal(info.description, 'single channel')
})

test('resolveModel: an unresolvable spec is refused before any turn', async () => {
  const adapter = new ModelSelectAdapter({ api: fixture() })
  await assert.rejects(() => adapter.resolveModel(ROUTE, 'no/such-model'), /unknown channel/)
  await assert.rejects(() => adapter.resolveModel(ROUTE, ''), /empty model/)
  await assert.rejects(() => adapter.resolveModel(ROUTE, '__pool__:ghost'), /unknown or empty pool/)
})

test('resolveModel: availability does not make a model disappear from the picker', async () => {
  const api = fixture()
  const adapter = new ModelSelectAdapter({ api })
  api.availability.report('kilo', false, { note: 'RATE_LIMIT', model: 'kilo-flash' })
  api.availability.report('bunny', false, { note: 'RATE_LIMIT', model: 'bunny-free' })
  const info = await adapter.resolveModel(ROUTE, '__pool__:fast-free')
  assert.equal(info.id, '__pool__:fast-free')
})

test('prepareCall: binds resolved metadata to a stream entry point', async () => {
  const prepared = await new ModelSelectAdapter({ api: fixture() }).prepareCall(ROUTE, '__pool__:fast-free')
  assert.equal(prepared.model.id, '__pool__:fast-free')
  assert.equal(typeof prepared.stream, 'function')
})

// ── the end-to-end path, over loopback ─────────────────────────────────────────

async function drain(iterable) {
  const out = []
  for await (const chunk of iterable) out.push(chunk)
  return out
}

const GENERATE = (extra = {}) => ({
  provider: ROUTE,
  model: '__pool__:fast-free',
  messages: [{ role: 'user', content: 'what should I do' }],
  ...extra,
})

test('stream: a clean answer becomes text-delta, usage, finish', async () => {
  const upstream = await startUpstream(RESP.json())
  try {
    const table = retarget(makeConfig(), 'kilo', upstream.base)
    retarget(table, 'bunny', upstream.base)
    const adapter = new ModelSelectAdapter({ api: fixture({ config: table }) })
    const chunks = await drain(adapter.stream(GENERATE()))
    assert.equal(chunks.length, 3)
    assert.equal(chunks[0].type, 'text-delta')
    assert.match(chunks[0].text, /answer/)
    assert.equal(chunks[1].type, 'usage')
    assert.equal(chunks[1].usage.inputTokens, 3)
    assert.equal(chunks[1].usage.outputTokens, 4)
    assert.equal(chunks[1].usage.totalTokens, 7)
    assert.deepEqual(chunks[2], { type: 'finish', reason: { kind: 'stop' } })
    assert.equal(chunks[0].index, 0)
  } finally {
    await upstream.close()
  }
})

test('stream: a refusal falls over the chain and the answer still arrives', async () => {
  const first = await startUpstream(RESP.rateLimit())
  const second = await startUpstream(RESP.json())
  try {
    const table = retarget(makeConfig(), 'kilo', first.base)
    retarget(table, 'bunny', second.base)
    const adapter = new ModelSelectAdapter({ api: fixture({ config: table }) })
    const chunks = await drain(adapter.stream(GENERATE()))
    const finish = chunks.at(-1)
    assert.equal(finish.type, 'finish')
    assert.equal(finish.reason.kind, 'stop')
    assert.equal(chunks.filter(chunk => chunk.type === 'text-delta').length, 1)
    assert.equal(first.hits.length, 1)
    assert.equal(second.hits.length, 1)
  } finally {
    await first.close()
    await second.close()
  }
})

test('stream: every channel down is a terminal error carrying the whole trail', async () => {
  const upstream = await startUpstream(RESP.server())
  try {
    const table = retarget(makeConfig(), 'kilo', upstream.base)
    retarget(table, 'bunny', upstream.base)
    const adapter = new ModelSelectAdapter({ api: fixture({ config: table }) })
    const chunks = await drain(adapter.stream(GENERATE()))
    assert.equal(chunks.length, 1)
    assert.equal(chunks[0].type, 'finish')
    assert.equal(chunks[0].reason.kind, 'error')
    assert.equal(chunks[0].reason.failure.code, 'SERVER')
    assert.ok(chunks[0].reason.failure.attempts.length >= 1)
    assert.equal(chunks[0].reason.failure.attempts[0].channel, 'kilo')
  } finally {
    await upstream.close()
  }
})

test('stream: the preset and the situation briefing reach the upstream', async () => {
  const upstream = await startUpstream(RESP.json())
  try {
    const table = makeConfig()
    table.defaults.preset = ['有 merge 就 merge', '不确定就说「不确定」']
    retarget(table, 'kilo', upstream.base)
    retarget(table, 'bunny', upstream.base)
    const adapter = new ModelSelectAdapter({ api: fixture({ config: table }) })
    const chunks = await drain(adapter.stream(GENERATE()))
    assert.deepEqual(chunks.at(-1).reason.kind, 'stop')
    const body = upstream.hits[0].body
    assert.equal(body.messages[0].role, 'system')
    assert.match(body.messages[0].content, /预设/)
    assert.match(body.messages[0].content, /有 merge 就 merge/)
    assert.equal(body.messages.at(-1).content, 'what should I do')
    assert.equal('preset' in body, false)
  } finally {
    await upstream.close()
  }
})

test('stream: a caller-supplied status rides along as the situation briefing', async () => {
  const upstream = await startUpstream(RESP.json())
  try {
    const table = retarget(makeConfig(), 'kilo', upstream.base)
    retarget(table, 'bunny', upstream.base)
    const adapter = new ModelSelectAdapter({ api: fixture({ config: table }) })
    await drain(adapter.stream(GENERATE({ status: 'kilo 在限流中' })))
    assert.match(upstream.hits[0].body.messages[0].content, /近况/)
    assert.match(upstream.hits[0].body.messages[0].content, /kilo 在限流中/)
  } finally {
    await upstream.close()
  }
})

test('stream: tool calls surface as tool-call deltas and a tool-calls finish', async () => {
  const toolAnswer = {
    kind: 'json',
    status: 200,
    body: {
      id: 'chatcmpl_tools',
      object: 'chat.completion',
      model: 'kilo-flash',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call_9', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }],
        },
        finish_reason: 'tool_calls',
      }],
    },
  }
  const upstream = await startUpstream(toolAnswer)
  try {
    const table = retarget(makeConfig(), 'kilo', upstream.base)
    retarget(table, 'bunny', upstream.base)
    const adapter = new ModelSelectAdapter({ api: fixture({ config: table }) })
    const chunks = await drain(adapter.stream(GENERATE({ tools: [{ name: 'read_file', description: 'read', parameters: {} }] })))
    const call = chunks.find(chunk => chunk.type === 'tool-call-delta')
    assert.equal(call.id, 'call_9')
    assert.equal(call.name, 'read_file')
    assert.equal(call.argumentsDelta, '{"path":"a.txt"}')
    assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'tool-calls' } })
    assert.equal(upstream.hits[0].body.tools[0].function.name, 'read_file')
  } finally {
    await upstream.close()
  }
})

test('stream: a tool result message round-trips back through the conversation', async () => {
  const upstream = await startUpstream(RESP.json())
  try {
    const table = retarget(makeConfig(), 'kilo', upstream.base)
    retarget(table, 'bunny', upstream.base)
    const adapter = new ModelSelectAdapter({ api: fixture({ config: table }) })
    await drain(adapter.stream(GENERATE({
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'check the file' }] },
        { role: 'assistant', content: [{ type: 'tool-call', id: 'call_1', name: 'read_file', arguments: { path: 'a.txt' } }] },
        { role: 'tool', toolCallId: 'call_1', content: [{ type: 'text', text: 'contents' }] },
      ],
    })))
    const body = upstream.hits[0].body
    assert.deepEqual(body.messages.map(row => row.role), ['system', 'user', 'assistant', 'tool'])
    assert.deepEqual(body.messages[2].tool_calls, [{
      id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } },
    ])
    assert.equal(body.messages[3].tool_call_id, 'call_1')
  } finally {
    await upstream.close()
  }
})

test('stream: an explicit execution unit receives a session, not a conversation', async () => {
  const executor = {
    kind: 'json',
    status: 200,
    body: {
      id: 'chatcmpl_exec',
      object: 'chat.completion',
      model: 'kilo-flash',
      choices: [{ index: 0, message: { role: 'assistant', content: 'merged PR 12' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 2, completion_tokens: 3 },
    },
  }
  const upstream = await startUpstream(executor)
  try {
    const table = retarget(tableWithExecutors(), 'merger', upstream.base)
    const adapter = new ModelSelectAdapter({ api: fixture({ config: table }) })
    const chunks = await drain(adapter.stream({
      provider: ROUTE,
      model: 'merger/kilo-flash',
      messages: [{ role: 'user', content: '合并 PR 12' }],
    }))
    assert.deepEqual(chunks.at(-1).reason.kind, 'stop')
    assert.match(chunks[0].text, /merged PR 12/)
    const body = upstream.hits[0].body
    assert.equal(body.model, 'kilo-flash')
    assert.equal(body.session, 'merge-queue')
    // An explicitly named execution unit receives the conversation, tagged with
    // its session: the layer invented no task and dropped no history.
    assert.equal(body.messages.length, 2)
    assert.equal(body.messages[0].role, 'system')
    assert.match(body.messages[0].content, /预设/)
    assert.equal(body.messages[1].content, '合并 PR 12')
    assert.equal('decision' in body, false)
    assert.equal('preset' in body, false)
  } finally {
    await upstream.close()
  }
})

test('stream: a verdict that names an operation hands the turn to the executor', async () => {
  const verdict = {
    kind: 'json',
    status: 200,
    body: { id: 'd1', object: 'decision', model: 'jev-1.13-free', choice: { action: 'merge', score: 0.91 } },
  }
  const executor = {
    kind: 'json',
    status: 200,
    body: {
      id: 'chatcmpl_exec', object: 'chat.completion', model: 'kilo-flash',
      choices: [{ index: 0, message: { role: 'assistant', content: 'done merging' }, finish_reason: 'stop' }],
    },
  }
  const router = await startUpstream(verdict)
  const runner = await startUpstream(executor)
  try {
    const table = tableWithExecutors()
    table.channels.jev.disabled = false
    retarget(table, 'jev', router.base)
    retarget(table, 'merger', runner.base)
    const adapter = new ModelSelectAdapter({ api: fixture({ config: table }) })
    const chunks = await drain(adapter.stream(GENERATE({
      model: '__pool__:decide',
      decision: { options: ['merge', 'audit', 'idle'] },
      task: '合并 PR 12',
      messages: [{ role: 'user', content: '现在该干嘛' }],
    })))
    assert.deepEqual(chunks.at(-1).reason.kind, 'stop')
    assert.match(chunks[0].text, /done merging/)
    assert.equal(runner.hits[0].body.session, 'merge-queue')
    assert.equal(runner.hits[0].body.messages[0].content, '合并 PR 12')
    assert.equal(router.hits[0].body.options.length, 3)
    assert.equal('messages' in router.hits[0].body, false)
  } finally {
    await router.close()
    await runner.close()
  }
})

test('stream: cancellation is threaded to the dispatch', async () => {
  const upstream = await startUpstream(() => ({ kind: 'hang', status: 200 }))
  try {
    const table = makeConfig()
    table.defaults.timeoutMs = 300
    retarget(table, 'kilo', upstream.base)
    retarget(table, 'bunny', upstream.base)
    const api = fixture({ config: table })
    const adapter = new ModelSelectAdapter({ api })
    const controller = new AbortController()
    controller.abort()
    const chunks = await drain(adapter.stream(GENERATE({ signal: controller.signal })))
    assert.equal(chunks.length, 1)
    assert.equal(chunks[0].type, 'finish')
    assert.equal(chunks[0].reason.kind, 'error')
  } finally {
    await upstream.close()
  }
})

test('stream: a thrown prepare error ends as a terminal error, not a throw', async () => {
  const adapter = new ModelSelectAdapter({ api: null })
  const chunks = await drain(adapter.stream(GENERATE()))
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].type, 'finish')
  assert.equal(chunks[0].reason.kind, 'error')
})

// ── index.js wiring ────────────────────────────────────────────────────────────

function fakeHost({ withLlm = true, withRoutes = false } = {}) {
  const registrations = []
  const routes = []
  const ctx = {
    logger: { info: () => {}, warn: () => {}, log: () => {} },
    fiber: { entry: { options: { id: 'model-select' } } },
    route: withRoutes
      ? (path, handler) => { routes.push({ path, handler }); return handler }
      : undefined,
  }
  if (withLlm) {
    ctx.llm = {
      registerAdapter: (providerRoutes, adapter) => {
        registrations.push({ kind: 'adapter', routes: providerRoutes, adapter })
        return () => { registrations.pop() }
      },
      registerConfigurableProviders: rows => { registrations.push({ kind: 'providers', rows }) },
      registerModelDiscovery: (namespace, fn) => { registrations.push({ kind: 'discovery', namespace, fn }) },
    }
  }
  return { ctx, registrations, routes }
}

test('inject: the llm lane is declared, so the plugin is only mounted where it can serve', () => {
  assert.deepEqual(inject, ['llm'])
  assert.equal(name, 'model-select')
})

test('apply: registers the adapter as the model-select provider', () => {
  const { ctx, registrations } = fakeHost()
  const handle = apply(ctx, { config: makeConfig() })

  const adapterRegistration = registrations.find(entry => entry.kind === 'adapter')
  assert.ok(adapterRegistration, 'registerAdapter was called')
  assert.deepEqual(adapterRegistration.routes, [ROUTE])
  assert.equal(adapterRegistration.adapter, handle.adapter)
  assert.equal(typeof adapterRegistration.adapter.stream, 'function')
  assert.equal(typeof adapterRegistration.adapter.resolveModel, 'function')
  assert.equal(typeof adapterRegistration.adapter.listModels, 'function')

  const providers = registrations.find(entry => entry.kind === 'providers')
  assert.ok(providers, 'the configurable-provider surface was registered')
  assert.equal(providers.rows[0].provider, ROUTE)
  assert.equal(providers.rows[0].settingsNs, 'model-select')

  const discovery = registrations.find(entry => entry.kind === 'discovery')
  assert.equal(discovery.namespace, 'model-select')
  assert.equal(typeof discovery.fn, 'function')
})

test('apply: the discovery catalog matches the adapter catalog', async () => {
  const { ctx, registrations } = fakeHost()
  apply(ctx, { config: tableWithExecutors() })
  const discovery = registrations.find(entry => entry.kind === 'discovery')
  const advertised = await discovery.fn()
  assert.ok(advertised.length >= 6)
  assert.equal(advertised[0].id, '__pool__:fast-free')
  assert.equal(advertised.every(row => row.provider === ROUTE), true)
})

test('apply: dispose releases the registration', () => {
  const { ctx, registrations } = fakeHost()
  const handle = apply(ctx, { config: makeConfig() })
  const afterApply = registrations.length
  assert.equal(afterApply, 3)
  handle.dispose()
  assert.equal(registrations.length, afterApply - 1)
})

test('apply: mounts the HTTP routes when the host offers them', () => {
  const { ctx, routes } = fakeHost({ withRoutes: true })
  apply(ctx, { config: makeConfig() })
  assert.deepEqual(routes.map(route => route.path), [
    '/v1/chat/completions', '/chat/completions', '/v1/models', '/models', '/health',
  ])
  assert.ok(routes.every(route => typeof route.handler === 'function'))
})

test('apply: without an llm runtime it builds the layer and reports, without throwing', () => {
  const { ctx, registrations } = fakeHost({ withLlm: false })
  let handle = null
  assert.doesNotThrow(() => { handle = apply(ctx, { config: makeConfig() }) })
  assert.equal(registrations.length, 0)
  assert.ok(handle.api)
  assert.equal(typeof handle.dispose, 'function')
  handle.dispose()
})

test('apply: a host with the llm lane but no routing table still mounts the provider', () => {
  const { ctx, registrations } = fakeHost({ withLlm: true, withRoutes: false })
  const handle = apply(ctx, { config: makeConfig() })
  assert.ok(registrations.some(entry => entry.kind === 'adapter'))
  assert.equal(typeof handle.dispose, 'function')
  handle.dispose()
})

test('the standalone runner path is untouched: createModelSelect needs no host', () => {
  const api = createModelSelect({ config: makeConfig(), log: () => {} })
  assert.equal(typeof api.complete, 'function')
  assert.equal(typeof api.models, 'function')
  assert.ok(api.models().length >= 3)
})

// ── a table with an execution unit ─────────────────────────────────────────────

const TABLE_WITH_EXECUTORS = {
  version: 1,
  defaults: {
    timeoutMs: 5000,
    availabilityTtlMs: 60000,
    maxAttempts: 4,
    decidePool: 'decide',
    fallbackPool: 'fast-free',
    preset: ['有 merge 就 merge', '不确定就说「不确定」'],
  },
  channels: {
    ...structuredClone(BASE_TABLE.channels),
    // JEV's local endpoint is a dead 404, so the table carries it disabled, as
    // documentation. A test that wants the router running re-enables it.
    jev: { ...structuredClone(BASE_TABLE.channels.jev), disabled: true },
    merger: {
      baseUrl: 'http://127.0.0.1:9',
      type: 'dispatch',
      path: 'chat/completions',
      defaultModel: 'kilo-flash',
      models: ['kilo-flash'],
      session: 'merge-queue',
      operations: ['merge'],
      dispatchBody: { stream: false },
    },
  },
  pools: structuredClone(BASE_TABLE.pools),
}

function tableWithExecutors(overrides = {}) {
  return validateConfig({ ...structuredClone(TABLE_WITH_EXECUTORS), ...overrides }, [], '<test>')
}
