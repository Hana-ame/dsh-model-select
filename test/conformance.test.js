/**
 * Conformance against the real `@deepseek-ai/dsh-llm` runtime, not a restatement
 * of it.
 *
 * These tests import the shipped harness package and drive the adapter's output
 * through the validators that package owns: `resolveRetryPolicy` for the retry
 * policy, `BlockAssembler` for the chunk stream, and the runtime's own route
 * metadata rule for `providerInfo`. If the harness changes its vocabulary, these
 * fail instead of silently agreeing with a copy of the old one.
 *
 * The package is resolved from the checked-out global install. When it is absent
 * the whole file is skipped rather than failing, because a missing host
 * dependency is an environment fact, not a defect in the adapter.
 *
 * @module test/conformance.test.js
 */

import test, { before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { ModelSelectAdapter, RETRY_POLICY, ROUTE } from '../src/adapter.js'
import { createModelSelect, apply } from '../index.js'
import { makeConfig, retarget, startUpstream, RESP_HELPERS, nodeHttpFetch } from './helpers.js'

const RESP = RESP_HELPERS

/** Where the harness keeps its own dependencies in a global install. */
const HOSTS = [
  'node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm',
  'node_modules/@deepseek-ai/dsh-llm',
]

// The layout of a standard node install: <prefix>/lib/node_modules/<pkg>/lib/index.js
const NODE_LIB = path.resolve(path.dirname(process.execPath), '..', 'lib')
const PACKAGE = HOSTS
  .map(host => path.join(NODE_LIB, host, 'lib', 'index.js'))
  .find(candidate => fs.existsSync(candidate)) ?? null

let llm = null

before(async () => {
  if (PACKAGE) llm = await import(PACKAGE)
})

function records(chunks) {
  return chunks.map(chunk => ({ type: 'chunk', time: 0, chunk }))
}

const AVAILABLE = PACKAGE !== null
const SKIP = AVAILABLE ? false : { skip: 'the host llm runtime is not installed here' }

// ── retry policy ─────────────────────────────────────────────────────────────

test('the retry policy matches what the runtime resolves from the canonical config', { skip: SKIP }, () => {
  const resolved = llm.resolveRetryPolicy({
    mode: 'normal',
    maxRetries: 0,
    retryableCodes: ['EMPTY_RESPONSE', 'SERVER', 'TIMEOUT', 'TRANSPORT'],
    backoff: { initialDelayMs: 700, maxDelayMs: 8000, jitterRatio: 0.2 },
  }, 'model-select: providerRetryPolicy')

  assert.deepEqual(resolved, RETRY_POLICY)
})

test('the retry policy is frozen, because registration captures it by value', { skip: SKIP }, () => {
  assert.throws(() => { RETRY_POLICY.maxRetries = 5 }, TypeError)
  assert.throws(() => { RETRY_POLICY.initialDelayMs = 1000 }, TypeError)
})

test('the runtime falls back to its own default when an adapter declares nothing', { skip: SKIP }, () => {
  // `providerRetryPolicy() ?? resolveRetryPolicy(undefined, path)` — the runtime
  // would have used this had this adapter returned undefined.
  const fallback = llm.resolveRetryPolicy(undefined, 'model-select: default')
  assert.equal(fallback.mode, 'normal')
  assert.ok(fallback.maxRetries >= RETRY_POLICY.maxRetries, 'the declared policy is at least as conservative')
})

// ── provider metadata: the runtime's own registration rule ────────────────────

test('providerInfo preserves its route id and carries a non-empty name', { skip: SKIP }, () => {
  const adapter = new ModelSelectAdapter({ api: createModelSelect({ config: makeConfig(), fetchImpl: nodeHttpFetch, log: () => {} }) })
  const info = adapter.providerInfo(ROUTE)

  // `prepareRoutes` throws INVALID_ADAPTER unless these hold.
  assert.equal(typeof info.id, 'string')
  assert.equal(info.id, ROUTE)
  assert.equal(typeof info.name, 'string')
  assert.ok(info.name.length > 0)
})

// ── the chunk stream through the runtime's own assembler ──────────────────────

async function chunksFor(upstreamBody, build) {
  const upstream = await startUpstream(upstreamBody)
  try {
    const table = retarget(makeConfig(), 'kilo', upstream.base)
    retarget(table, 'bunny', upstream.base)
    const adapter = new ModelSelectAdapter({ api: createModelSelect({ config: table, fetchImpl: nodeHttpFetch, log: () => {} }) })
    const options = build(adapter)
    const out = []
    for await (const chunk of adapter.stream(options)) out.push(chunk)
    return { chunks: out, upstream }
  } finally {
    await upstream.close()
  }
}

test('a clean answer assembles into a message the runtime accepts', { skip: SKIP }, async () => {
  const { chunks } = await chunksFor(RESP.json(), adapter => ({
    provider: ROUTE,
    model: '__pool__:fast-free',
    messages: [{ role: 'user', content: 'what should I do' }],
  }))

  const assembler = new llm.BlockAssembler()
  for (const chunk of chunks) assembler.push(chunk)

  const message = assembler.message()
  assert.ok(message, 'the assembler produced a message')
  assert.equal(message.role, 'assistant')
  assert.match(String(message.content?.[0]?.text ?? ''), /answer/)

  const finish = assembler.finish
  assert.equal(finish.kind, 'stop')

  assert.ok(llm.isVisibleChunk(chunks[0]), 'the text delta is visible')
  assert.equal(llm.isTokenDelta(chunks[0]), true)
  // The durable record form the runtime logs: raw chunks kept for replay.
  const records = chunks.map(chunk => ({ type: 'chunk', time: 0, chunk }))
  assert.ok(llm.joinAssistantStreamText(records).includes('answer'))
})

test('a tool call assembles into an executable block', { skip: SKIP }, async () => {
  const { chunks } = await chunksFor({
    kind: 'json',
    status: 200,
    body: {
      id: 'chatcmpl_tools', object: 'chat.completion', model: 'kilo-flash',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_9', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }] },
        finish_reason: 'tool_calls',
      }],
    },
  }, adapter => ({
    provider: ROUTE,
    model: '__pool__:fast-free',
    messages: [{ role: 'user', content: 'check the file' }],
    tools: [{ name: 'read_file', description: 'read a file', parameters: { type: 'object' } }],
  }))

  const assembler = new llm.BlockAssembler()
  for (const chunk of chunks) assembler.push(chunk)

  const blocks = assembler.blocks()
  assert.ok(blocks.some(block => block.type === 'tool-call'), `assembled a tool call, got ${blocks.map(b => b.type).join(',')}`)

  const call = blocks.find(block => block.type === 'tool-call')
  assert.equal(call.name, 'read_file')

  assert.equal(assembler.finish.kind, 'tool-calls')

  // A tool-only answer carries no visible text, which is correct: the call is the
  // answer, and the agent loop decides what to say next.
  assert.equal(chunks.some(chunk => chunk.type === 'text-delta'), false)
  assert.equal(llm.assistantStreamHasVisibleText(records(chunks)), false)
  assert.equal(llm.chunkHasVisibleText(chunks.find(chunk => chunk.type === 'tool-call-delta')), false)
})

test('a failed turn assembles to a terminal error, not a hang', { skip: SKIP }, async () => {
  const { chunks } = await chunksFor(RESP.server(), adapter => ({
    provider: ROUTE,
    model: '__pool__:fast-free',
    messages: [{ role: 'user', content: 'hi' }],
  }))

  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].type, 'finish')
  assert.equal(chunks[0].reason.kind, 'error')

  const failure = chunks[0].reason.failure
  assert.equal(typeof failure.code, 'string')
  assert.ok(failure.code.length > 0, 'a failure carries a code')
  assert.equal(typeof failure.message, 'string')
  assert.ok(Array.isArray(failure.attempts), 'the trail is kept for the caller')
})

test('the adapter exposes every method the runtime calls', { skip: SKIP }, () => {
  const adapter = new ModelSelectAdapter({ api: createModelSelect({ config: makeConfig(), fetchImpl: nodeHttpFetch, log: () => {} }) })
  for (const method of ['providerInfo', 'providerRetryPolicy', 'imageRequestPricing', 'listModels', 'resolveModel', 'prepareCall', 'stream']) {
    assert.equal(typeof adapter[method], 'function', `${method} is callable`)
  }
  // OFM does not extend the abstract class either: the runtime dispatches
  // structurally, so a structural adapter is a conforming one.
  assert.equal(adapter instanceof llm.LlmAdapter, false, 'structural conformance is intentional')
})

// ── the runtime itself, run against this adapter ──────────────────────────────
//
// `LlmRuntime` is a typert service and needs a live fiber to construct, so the
// registry is exercised through its prototype: `prepareRoutes`, `listModels` and
// `resolveModelInfoFor` each read only the maps a registration writes. That runs
// the runtime's real validation rather than a copy of it, which is the difference
// between "I guessed the rule" and "the runtime accepted this adapter".

function registered(adapter, providers = [ROUTE]) {
  const runtime = Object.create(llm.LlmRuntime.prototype)
  runtime.adapters = new Map()
  runtime.directory = new Map()
  runtime.discoveries = new Map()
  const owned = new Set()
  const registrations = runtime.prepareRoutes(providers, adapter, owned)
  for (const registration of registrations) runtime.adapters.set(registration.provider.id, registration)
  return { runtime, owned }
}

test('the runtime accepts this adapter at registration time', { skip: SKIP }, () => {
  const adapter = new ModelSelectAdapter({ api: createModelSelect({ config: makeConfig(), fetchImpl: nodeHttpFetch, log: () => {} }) })
  const { runtime } = registered(adapter)

  assert.equal(runtime.listProviders().length, 1)
  assert.deepEqual(runtime.listProviders(), [{ id: ROUTE, name: 'Model Select' }])
})

test('registration captures the retry policy verbatim', { skip: SKIP }, () => {
  const adapter = new ModelSelectAdapter({ api: createModelSelect({ config: makeConfig(), fetchImpl: nodeHttpFetch, log: () => {} }) })
  const { runtime } = registered(adapter)
  assert.equal(runtime.providerRetryPolicy(ROUTE), RETRY_POLICY)
})

test('an unregistered provider reports no adapter, not a throw from the adapter', { skip: SKIP }, async () => {
  const adapter = new ModelSelectAdapter({ api: createModelSelect({ config: makeConfig(), fetchImpl: nodeHttpFetch, log: () => {} }) })
  const { runtime } = registered(adapter)
  await assert.rejects(() => runtime.listModels('deepseek'), /no adapter registered/)
})

test('the runtime accepts this catalog as model metadata', { skip: SKIP }, async () => {
  const config = makeConfig()
  const adapter = new ModelSelectAdapter({ api: createModelSelect({ config, fetchImpl: nodeHttpFetch, log: () => {} }) })
  const { runtime } = registered(adapter)

  const catalog = await runtime.listModels(ROUTE)
  assert.ok(catalog.length > 0)
  assert.deepEqual(catalog.map(row => row.provider), catalog.map(() => ROUTE))
  assert.ok(catalog.every(row => typeof row.id === 'string' && row.id.length > 0))
  assert.ok(catalog.every(row => typeof row.name === 'string' && row.name.length > 0))
  // `listModels` throws INVALID_CATALOG on a duplicate id; reaching here means
  // the ids are unique, which is what the picker relies on.
  assert.equal(new Set(catalog.map(row => row.id)).size, catalog.length)
})

test('the runtime normalizes a resolved pool spec into model info', { skip: SKIP }, async () => {
  const adapter = new ModelSelectAdapter({ api: createModelSelect({ config: makeConfig(), fetchImpl: nodeHttpFetch, log: () => {} }) })
  const { runtime } = registered(adapter)

  const info = await runtime.resolveModelInfo(ROUTE, '__pool__:fast-free')
  assert.equal(info.provider, ROUTE)
  assert.equal(info.id, '__pool__:fast-free')
  assert.equal(typeof info.name, 'string')
  assert.ok(info.name.length > 0)
  assert.equal(info.context, undefined)
  assert.equal(info.inputModalities, undefined)
  assert.equal(info.reasoning, undefined)
})

test('the runtime normalizes a resolved channel spec into model info', { skip: SKIP }, async () => {
  const adapter = new ModelSelectAdapter({ api: createModelSelect({ config: makeConfig(), fetchImpl: nodeHttpFetch, log: () => {} }) })
  const { runtime } = registered(adapter)
  const info = await runtime.resolveModelInfo(ROUTE, 'kilo/kilo-flash')
  assert.equal(info.id, 'kilo/kilo-flash')
  assert.ok(info.name.length > 0)
})

test('a spec the resolver cannot parse is refused by the runtime path too', { skip: SKIP }, async () => {
  const adapter = new ModelSelectAdapter({ api: createModelSelect({ config: makeConfig(), fetchImpl: nodeHttpFetch, log: () => {} }) })
  const { runtime } = registered(adapter)
  await assert.rejects(() => runtime.resolveModelInfo(ROUTE, 'no/such-model'), /unknown channel/)
})

test('imageRequestPricing degrades to undefined for an unregistered provider', { skip: SKIP }, () => {
  const adapter = new ModelSelectAdapter({ api: createModelSelect({ config: makeConfig(), fetchImpl: nodeHttpFetch, log: () => {} }) })
  const { runtime } = registered(adapter)
  assert.equal(runtime.imageRequestPricing(ROUTE, 'kilo/kilo-flash'), undefined)
  assert.equal(runtime.imageRequestPricing('deepseek', 'v4'), undefined)
})

// ── the harness call path itself ──────────────────────────────────────────────
//
// `adapterStream(options, undefined)` is the runtime's own final adapter
// boundary: adapter lookup, prepareCall, model normalization, control
// resolution, projection, dispatch, and iteration-failure handling. It reaches
// no fiber, so it runs here. What sits above it is `ctx.waterfall("llm/stream",
// ...)`, a pass-through when no listener is attached — which is the shape of a
// plugin that registers an adapter and adds no stream middleware.

test('the runtime streams a clean answer for a pool spec', { skip: SKIP }, async () => {
  const upstream = await startUpstream(RESP.json())
  try {
    const config = retarget(makeConfig(), 'kilo', upstream.base)
    retarget(config, 'bunny', upstream.base)
    const adapter = new ModelSelectAdapter({ api: createModelSelect({ config, fetchImpl: nodeHttpFetch, log: () => {} }) })
    const { runtime } = registered(adapter)

    const seen = []
    for await (const chunk of runtime.adapterStream({
      provider: ROUTE,
      model: '__pool__:fast-free',
      messages: [{ role: 'user', content: 'what should I do' }],
    }, void 0)) seen.push(chunk)

    const assembler = new llm.BlockAssembler()
    for (const chunk of seen) assembler.push(chunk)

    assert.equal(assembler.message().role, 'assistant')
    assert.match(String(assembler.message().content[0].text), /answer/)
    assert.equal(assembler.finish.kind, 'stop')
  } finally {
    await upstream.close()
  }
})

test('the runtime streams a tool call for a pool spec', { skip: SKIP }, async () => {
  const upstream = await startUpstream({
    kind: 'json',
    status: 200,
    body: {
      id: 'chatcmpl_runtime_tools', object: 'chat.completion', model: 'kilo-flash',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_r1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }] },
        finish_reason: 'tool_calls',
      }],
    },
  })
  try {
    const config = retarget(makeConfig(), 'kilo', upstream.base)
    retarget(config, 'bunny', upstream.base)
    const adapter = new ModelSelectAdapter({ api: createModelSelect({ config, fetchImpl: nodeHttpFetch, log: () => {} }) })
    const { runtime } = registered(adapter)

    const seen = []
    for await (const chunk of runtime.adapterStream({
      provider: ROUTE,
      model: '__pool__:fast-free',
      messages: [{ role: 'user', content: 'check the file' }],
      tools: [{ name: 'read_file', description: 'read a file', parameters: { type: 'object' } }],
    }, void 0)) seen.push(chunk)

    const assembler = new llm.BlockAssembler()
    for (const chunk of seen) assembler.push(chunk)

    const call = assembler.blocks().find(block => block.type === 'tool-call')
    assert.equal(call?.name, 'read_file')
    assert.equal(assembler.finish.kind, 'tool-calls')
  } finally {
    await upstream.close()
  }
})

test('a turn that fails everywhere ends with a terminal error chunk', { skip: SKIP }, async () => {
  const config = retarget(makeConfig(), 'kilo', 'http://127.0.0.1:9')
  retarget(config, 'bunny', 'http://127.0.0.1:9')
  const adapter = new ModelSelectAdapter({ api: createModelSelect({ config, fetchImpl: nodeHttpFetch, log: () => {} }) })
  const { runtime } = registered(adapter)

  const seen = []
  for await (const chunk of runtime.adapterStream({
    provider: ROUTE,
    model: '__pool__:fast-free',
    messages: [{ role: 'user', content: 'hi' }],
  }, void 0)) seen.push(chunk)

  assert.equal(seen.length, 1)
  assert.equal(seen[0].type, 'finish')
  assert.equal(seen[0].reason.kind, 'error')
})

test('a message carrying an image block is not misread as a file reference', { skip: SKIP }, async () => {
  // `adapterStream` consults `ctx.get("attachments")` when a message carries a
  // file ref, and projects images to text when a route declares text-only
  // modalities. This route declares no modalities and this message carries no
  // file ref, so neither branch runs and the stream completes without a fiber.
  const upstream = await startUpstream(RESP.json())
  try {
    const config = retarget(makeConfig(), 'kilo', upstream.base)
    retarget(config, 'bunny', upstream.base)
    const adapter = new ModelSelectAdapter({ api: createModelSelect({ config, fetchImpl: nodeHttpFetch, log: () => {} }) })
    const { runtime } = registered(adapter)

    const seen = []
    for await (const chunk of runtime.adapterStream({
      provider: ROUTE,
      model: '__pool__:fast-free',
      messages: [
        { role: 'user', content: 'what is this' },
        { role: 'user', content: [{ type: 'image', data: { mimeType: 'image/png', data: Buffer.from('abc').toString('base64') } }] },
      ],
    }, void 0)) seen.push(chunk)

    const assembler = new llm.BlockAssembler()
    for (const chunk of seen) assembler.push(chunk)
    assert.equal(assembler.finish.kind, 'stop')
  } finally {
    await upstream.close()
  }
})

// ── apply() into the runtime ──────────────────────────────────────────────────
//
// The last hop that cannot run in a sandbox: `LlmRuntime` is a typert service
// and needs a live fiber. But `registerAdapter`, `registerConfigurableProviders`
// and `registerModelDiscovery` each need only `ctx.effect` to run their body and
// return the yielded disposer, plus an event bus for the update notification.
// A faithful stand-in for those two members lets the real runtime do its own
// validating, so this test covers the actual call `apply()` makes.

function fiberRuntime() {
  const runtime = Object.create(llm.LlmRuntime.prototype)
  runtime.adapters = new Map()
  runtime.directory = new Map()
  runtime.discoveries = new Map()
  runtime.ctx = {
    effect(genFn) {
      const step = genFn().next()
      if (step.done) return () => {}
      return step.value
    },
    events: { dispatch() { return [] } },
  }
  return runtime
}

test('apply() registers the provider in the runtime, and dispose() removes it', { skip: SKIP }, () => {
  const runtime = fiberRuntime()
  const logs = []
  const ctx = {
    logger: { warn: m => logs.push(m), info() {}, error() {} },
    llm: runtime,
    fiber: { entry: { options: { id: 'model-select' } } },
  }

  const handle = apply(ctx, {})
  assert.equal(typeof handle.dispose, 'function')

  // Registered in the live registry, under the id a caller would type.
  assert.deepEqual(runtime.listProviders(), [{ id: ROUTE, name: 'Model Select' }])
  assert.ok(runtime.adapters.has(ROUTE), 'the adapter is mounted at model-select')
  assert.equal(runtime.adapters.get(ROUTE).adapter, handle.adapter)

  // The picker entry point, in the settings namespace the plugin declares.
  const directory = runtime.listConfigurableProviders()
  assert.equal(directory.length, 1)
  assert.equal(directory[0].provider, ROUTE)
  assert.equal(directory[0].settingsNs, 'model-select')

  // The discovery the "detect models" affordance would call.
  const discovered = runtime.discoveries.get('model-select')
  assert.equal(typeof discovered, 'function')
  assert.equal(runtime.discoveries.size, 1)

  handle.dispose()

  assert.equal(runtime.listProviders().length, 0, 'dispose removes the route')
  assert.equal(runtime.directory.size, 0)
  assert.equal(runtime.discoveries.size, 0)
})

test('a mounted provider answers a call through the runtime', { skip: SKIP }, async () => {
  const upstream = await startUpstream(RESP.json())
  try {
    const config = retarget(makeConfig(), 'kilo', upstream.base)
    retarget(config, 'bunny', upstream.base)

    const runtime = fiberRuntime()
    const ctx = {
      logger: { warn() {}, info() {}, error() {} },
      llm: runtime,
      fiber: { entry: { options: { id: 'model-select' } } },
    }
    const handle = apply(ctx, { config, fetchImpl: nodeHttpFetch })

    const seen = []
    for await (const chunk of runtime.adapterStream({
      provider: ROUTE,
      model: '__pool__:fast-free',
      messages: [{ role: 'user', content: 'what should I do' }],
    }, void 0)) seen.push(chunk)

    const assembler = new llm.BlockAssembler()
    for (const chunk of seen) assembler.push(chunk)

    assert.match(String(assembler.message().content[0].text), /answer/)
    assert.equal(assembler.finish.kind, 'stop')
    handle.dispose()
  } finally {
    await upstream.close()
  }
})
