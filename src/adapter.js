/**
 * The DSH provider adapter.
 *
 * model-select is a routing layer, so this adapter is a vocabulary translation
 * over the very same `select()` call the HTTP endpoint uses. Nothing in here
 * decides which channel answers a turn: `select()` does, with the same
 * retryable judgement, the same availability cache, and the same 60s TTL that
 * the `/v1/chat/completions` route has. The adapter only translates what DSH
 * calls `GenerateOptions` into what the layer calls a request, and what the
 * layer calls a response into what DSH calls a chunk stream.
 *
 * Two consequences of that shape:
 *
 *   - a session created through this provider and a session created through the
 *     HTTP endpoint see identical behaviour, because they share one decision
 *     core. There is no second copy of the fallback logic to drift.
 *   - the preset and the situation briefing reach the model on both routes at
 *     once, because `applyContext` runs inside the layer, not here. The whole
 *     "do not rely on the model's goodwill" argument is enforced by code that
 *     neither entry point can skip.
 *
 * The chunk protocol emitted below is the harness's raw streaming vocabulary,
 * not the layer's own: `text-delta` for answer text, `tool-call-delta` for a
 * tool invocation, `usage` before the terminal `finish`. The layer answers in
 * one JSON document rather than incrementally, so a call delivers as a single
 * delta followed by `finish` — see `stream()`.
 *
 * @module src/adapter.js
 */

import { resolveCandidates } from './spec.js'
import { describe } from './select.js'
import { CODE } from './errors.js'

export const ROUTE = 'model-select'
export const PROVIDER_NAME = 'Model Select'

/**
 * How an upstream JSON answer names a tool call. OpenAI and the DeepSeek/Kilo
 * gateways agree on this shape; a gateway that spells it differently is simply
 * invisible to this adapter, which is the honest way to fail a capability we
 * have not verified.
 */
const TOOL_ARG_KEYS = ['arguments', 'arguments_json', 'input']

/**
 * The model-spec vocabulary this provider understands:
 *
 *   `__pool__:<name>`       the fallback chain over the channels in that pool
 *   `<channel>/<model>`     one channel pinned to one of its models
 *   `<channel>`             one channel on its defaultModel
 *
 * All three are exactly what the layer's resolver already accepts, which is why
 * `session_create(provider="model-select", model="__pool__:fast-free")` needs no
 * new vocabulary and no translation table.
 */
export function isPoolSpec(spec) {
  return typeof spec === 'string' && spec.startsWith('__pool__:')
}

/**
 * Rows for the harness's model catalog: the pools first, because a pool is the
 * thing this provider is for, then the individual channels, then the execution
 * units. Table order is preserved inside each group.
 *
 * `inputModalities` is deliberately absent from every row: the table records no
 * modality, and the type says absence means "unknown" while an explicit `[]`
 * would mean "cannot accept anything". A claim we have not verified costs us
 * more than a picker that stops short of answering.
 *
 * Disabled channels are excluded, for the same reason `/v1/models` excludes
 * them: they are documentation in the table, not reachable lanes.
 */
export function catalogRows(config, provider = ROUTE) {
  const rows = []
  const channels = config?.channels ?? {}

  for (const [pool, members] of Object.entries(config?.pools ?? {})) {
    if (!Array.isArray(members) || members.length === 0) continue
    const usable = members.filter(name => {
      const channel = channels[name]
      return channel && channel.disabled !== true && channel.type !== CHANNEL_TYPE_DISPATCH_OF()
    })
    if (usable.length === 0) continue // a pool of pure executors cannot answer a conversation
    rows.push({
      provider,
      id: `__pool__:${pool}`,
      name: `pool · ${pool}`,
      description: `fallback chain over ${usable.join(', ')}`,
    })
  }

  for (const [name, channel] of Object.entries(channels)) {
    if (channel.disabled === true) continue
    for (const model of channel.models ?? []) {
      rows.push({
        provider,
        id: `${name}/${model}`,
        name: `${name}/${model}`,
        description: channel.type === 'dispatch'
          ? `execution unit for ${channel.operations.join(', ')} — sends the conversation as context and runs it as a task in session ${channel.session ?? name}`
          : channel.type === 'decide'
            ? 'router: answers with a structured verdict, not a conversation'
            : 'generation channel',
      })
    }
  }
  return rows
}

/** Indirection so this module stays import-order independent from channels.js. */
function CHANNEL_TYPE_DISPATCH_OF() {
  return 'dispatch'
}

/**
 * Translate one DSH conversation message into the OpenAI chat shape.
 *
 * Roles fold the way the harness documents them: a `developer` message is a
 * system prompt, so it joins `system`; `tool` results keep their call id;
 * everything else keeps its role.
 *
 * Blocks:
 *   text        → text
 *   reasoning   → text, prefixed. A thinking model that receives its own prior
 *                 reasoning back expects it verbatim, and several gateways
 *                 refuse a history that omits it.
 *   image       → text handle. Bytes never cross this adapter: DSH already
 *                 offloads images to a read-only path and projects them to a
 *                 text reference, and that projection is what the model can act
 *                 on regardless of the upstream's vision support.
 *   tool-call   → OpenAI `tool_calls` on the assistant message
 *   other       → dropped. A block we cannot project is a block we do not lie
 *                 about; the conversation stays coherent without it.
 */
export function toChatMessages(messages, system) {
  const out = []

  if (typeof system === 'string' && system.trim() !== '') {
    out.push({ role: 'system', content: system })
  }

  for (const message of messages ?? []) {
    if (message === null || typeof message !== 'object') continue
    const blocks = Array.isArray(message.content) ? message.content : []
    const toolCalls = []
    const textParts = []
    let content = ''

    if (typeof message.content === 'string') {
      content = message.content
    } else if (blocks.length === 0) {
      continue
    } else {
      for (const block of blocks) {
        if (block === null || typeof block !== 'object') continue
        if (block.type === 'text') {
          if (typeof block.text === 'string' && block.text !== '') textParts.push(block.text)
        } else if (block.type === 'reasoning') {
          if (typeof block.text === 'string' && block.text !== '') textParts.push(`[thinking] ${block.text}`)
        } else if (block.type === 'image') {
          const attachment = block.attachment ?? {}
          const handle = attachment.path ?? attachment.readOnlyPath ?? attachment.savedPath ?? ''
          const label = attachment.name ?? attachment.fileName ?? 'image'
          const size = Number.isFinite(attachment.bytes) ? attachment.bytes : attachment.size
          textParts.push(`[image] ${label}${size !== undefined ? ` (${size} bytes)` : ''}${handle ? ` — ${handle}` : ''}`)
        } else if (block.type === 'file') {
          const ref = block.reference ?? block.attachment ?? {}
          const handle = ref.path ?? ref.readOnlyPath ?? ref.savedPath ?? ref.name ?? ''
          textParts.push(`[file] ${handle}`)
        } else if (block.type === 'tool-call') {
          toolCalls.push({
            id: String(block.id ?? ''),
            type: 'function',
            function: {
              name: String(block.name ?? ''),
              arguments: typeof block.arguments === 'string' ? block.arguments : JSON.stringify(block.arguments ?? {}),
            },
          })
        }
      }
      content = textParts.join('\n')
    }

    if (content === '' && toolCalls.length === 0) continue

    if (message.role === 'tool') {
      out.push({
        role: 'tool',
        tool_call_id: String(message.toolCallId ?? message.tool_call_id ?? ''),
        name: typeof message.name === 'string' ? message.name : undefined,
        content: `${content}${message.isError ? `\n[the call failed]` : ''}`,
      })
    } else {
      const row = { role: message.role === 'developer' ? 'system' : message.role, content }
      if (toolCalls.length > 0) row.tool_calls = toolCalls
      out.push(row)
    }
  }

  return out
}

/** The tool declarations the harness passes, in the shape these gateways take. */
export function toToolDefs(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined
  return tools.map(tool => ({
    type: 'function',
    function: {
      name: String(tool?.name ?? ''),
      description: typeof tool?.description === 'string' ? tool.description : '',
      parameters: tool?.parameters && typeof tool.parameters === 'object' ? tool.parameters : {},
    },
  }))
}

/**
 * The layer request behind one DSH request.
 *
 * `stream: false` is deliberate: the layer already peeks a stream to prove it is
 * non-empty before reporting success, so asking for streaming only spends the
 * upstream's stream budget for no gain at this hop. One JSON answer also makes
 * the chunk translation a single, inspectable document.
 *
 * Nothing else is passed through that the layer does not own. `maxTokens` becomes
 * `max_tokens` (and `max_completion_tokens` as well), because the gateways
 * disagree about which one they honour and some refuse whichever is absent.
 */
export function toLayerRequest(options, spec) {
  const messages = toChatMessages(options?.messages, options?.system)
  const tools = toToolDefs(options?.tools)
  const request = {
    model: spec,
    messages,
    stream: false,
  }
  if (typeof options?.temperature === 'number' && Number.isFinite(options.temperature)) {
    request.temperature = options.temperature
  }
  if (typeof options?.topP === 'number' && Number.isFinite(options.topP)) {
    request.topP = options.topP
  }
  if (typeof options?.maxTokens === 'number' && Number.isFinite(options.maxTokens) && options.maxTokens > 0) {
    request.max_tokens = options.maxTokens
    request.max_completion_tokens = options.maxTokens
  }
  if (Array.isArray(options?.stop) && options.stop.length > 0) request.stop = options.stop
  if (tools !== undefined) request.tools = tools

  // The layer's own fields are not OpenAI fields, and the harness's
  // `GenerateOptions` has no slot for them, so a caller that builds a request
  // directly here is the only door they have. `decision` matters: it is what
  // makes the router reachable from this side at all, because without it the
  // intent is `chat` and a decide pool resolves to nothing. `choice` and
  // `selection` are the phone menu: a caller on this side picks a lane by number
  // the same way a caller over HTTP does, so both doors must pass the number
  // through or the menu is a feature of one door only.
  for (const key of ['decision', 'task', 'preset', 'status', 'choice', 'selection']) {
    const value = options?.[key]
    if (value !== undefined && value !== null && value !== '') request[key] = value
  }

  return request
}

/**
 * The provider retry policy this route owns.
 *
 * `maxRetries: 0` on purpose. `select()` already retries inside the call —
 * RATE_LIMIT, TIMEOUT, EMPTY_RESPONSE, TRANSPORT and SERVER each hand the turn
 * to the next candidate, up to `defaults.maxAttempts` — and every retryable
 * failure also marks the channel down for 60s. A harness-level retry would
 * re-fan-out the same pool while those lanes are still cooling off, paying for
 * the same turn twice and arriving later. The delay fields are carried at the
 * top level, because both kernels read them off the top level and store the
 * object verbatim; nested under `backoff` they become `NaN`, which the durable
 * session log then rejects.
 *
 * `maxRetries: 0` is the only field doing work here. The rest carries values the
 * runtime itself would emit, so the object stays legal if a kernel variant ever
 * re-resolves it instead of storing it verbatim: `retryableCodes` must be
 * non-empty and duplicate-free, and it names exactly the codes `select()` already
 * walks over, so the two lists cannot drift apart; the backoff fields must be
 * positive, and would not be read anyway with no retries left.
 */
export const RETRY_POLICY = Object.freeze({
  mode: 'normal',
  maxRetries: 0,
  retryableCodes: Object.freeze(['EMPTY_RESPONSE', 'SERVER', 'TIMEOUT', 'TRANSPORT']),
  initialDelayMs: 700,
  maxDelayMs: 8000,
  jitterRatio: 0.2,
})

/**
 * `delta` is a convenience projection for callers that do not care about the
 * harness's block index; the chunks themselves carry the protocol fields.
 */
function chunkFromAnswer(answer, usage) {
  const chunks = []
  const message = answer?.choices?.[0]?.message ?? answer?.choices?.[0]?.delta ?? {}
  const text = typeof message.content === 'string' ? message.content : ''
  if (text !== '') {
    chunks.push({ type: 'text-delta', index: 0, text })
  }
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls : []
  calls.forEach((call, index) => {
    const fn = call?.function ?? call
    const id = String(call?.id ?? `call_${index}`)
    const name = String(fn?.name ?? '')
    const raw = TOOL_ARG_KEYS.map(key => fn?.[key]).find(value => value !== undefined) ?? '{}'
    const arguments_ = typeof raw === 'string' ? raw : JSON.stringify(raw)
    chunks.push({ type: 'tool-call-delta', index: 1 + index, id, name, argumentsDelta: arguments_ })
  })
  if (usage !== undefined) chunks.push({ type: 'usage', usage })
  chunks.push({ type: 'finish', reason: finishReason(answer, calls.length) })
  return chunks
}

/** Map an OpenAI finish reason onto the harness's, keeping tool calls distinct. */
function finishReason(answer, toolCallCount) {
  const reason = answer?.choices?.[0]?.finish_reason
  if (toolCallCount > 0 || reason === 'tool_calls') return { kind: 'tool-calls' }
  if (reason === 'length') return { kind: 'max-tokens' }
  if (reason === 'stop') return { kind: 'stop' }
  return { kind: 'stop' }
}

function usageFrom(answer) {
  const usage = answer?.usage
  if (!usage || typeof usage !== 'object') return undefined
  const input = Number(usage.prompt_tokens ?? usage.input_tokens ?? usage.inputTokens ?? 0)
  const output = Number(usage.completion_tokens ?? usage.output_tokens ?? usage.outputTokens ?? 0)
  if (!Number.isFinite(input) || !Number.isFinite(output)) return undefined
  const total = Number(usage.total_tokens ?? usage.totalTokens)
  return {
    inputTokens: input,
    outputTokens: output,
    ...(Number.isFinite(total) ? { totalTokens: total } : {}),
  }
}

/**
 * One provider-wire adapter over a layer instance.
 *
 * Structural, not nominal: the harness validates an adapter by calling its
 * methods rather than testing `instanceof`, which is what lets this file be
 * imported by the layer's own tests without the harness's types.
 *
 * @param {object} dependencies
 * @param {object} dependencies.api - a `createModelSelect()` return value
 * @param {(message: string) => void} [dependencies.log]
 * @param {(message: object) => void} [dependencies.recordTurn] - one line per answered turn
 */
export class ModelSelectAdapter {
  constructor(dependencies) {
    this.api = dependencies?.api
    this.log = dependencies?.log ?? (() => {})
    this.recordTurn = dependencies?.recordTurn
  }

  providerInfo(provider) {
    return { id: provider, name: PROVIDER_NAME }
  }

  providerRetryPolicy() {
    return RETRY_POLICY
  }

  /**
   * Nothing declared: every advertised lane is a free-tier or self-hosted proxy,
   * and none of them publishes a price. Returning `undefined` is the documented
   * way to say "use your own estimate", which is more honest than a guessed zero
   * that would look like a measurement.
   */
  imageRequestPricing() {
    return undefined
  }

  /**
   * The catalog. `listModels` is advisory, not request validation, but the
   * harness's GUI reads it for the picker, so it has to advertise what can
   * actually answer.
   */
  async listModels(provider) {
    return catalogRows(this.api?.config, provider ?? ROUTE)
  }

  /**
   * Does this spec resolve to anything at all?
   *
   * Resolved without the availability cache: a transient 429 should not make a
   * model vanish from the picker, only make the next call to it fall over the
   * chain. "Is this spec real?" and "is this lane up right now?" are different
   * questions, and `select()` owns the second one.
   */
  async resolveModel(provider, model) {
    const config = this.api?.config
    if (!config) throw new SelectLikeError('model-select: the adapter has no channel table', CODE.config)
    const spec = String(model ?? '')
    if (spec.trim() === '') throw new SelectLikeError('model-select: an empty model', CODE.config)

    let probe
    try {
      probe = resolveCandidates(spec, { config, availability: null, intent: 'chat', defaults: config.defaults })
    } catch (error) {
      // A spec the resolver cannot even parse throws rather than returning an
      // empty list; a picker error has the same shape either way.
      throw new SelectLikeError(`model-select: ${String(error?.message ?? error)}`, CODE.config)
    }
    if (!Array.isArray(probe) || probe.length === 0) {
      throw new SelectLikeError(`model-select: "${spec}" resolves to no channel`, CODE.config)
    }
    return {
      provider,
      id: spec,
      name: spec,
      description: isPoolSpec(spec)
        ? `${probe.length} candidate in fallback order`
        : probe.length > 1 ? `${probe.length} candidate in fallback order` : 'single channel',
    }
  }

  /**
   * Bind one generation: the resolved metadata and the stream entry point that
   * dispatches through the same table it was resolved against.
   */
  async prepareCall(provider, model) {
    const info = await this.resolveModel(provider, model)
    return {
      model: info,
      stream: options => this.stream(options),
    }
  }

  /**
   * One turn. Translate, resolve, fall back, translate the answer back.
   *
   * Cancellation is threaded through to `select`, which passes it to each
   * dispatch; an abort there surfaces as a chunk stream that ends in
   * `{ kind: 'aborted' }` rather than a throw, because the harness normalizes
   * adapter throws anyway and a terminal finish is what the caller expects.
   */
  async *stream(options) {
    const spec = String(options?.model ?? '')
    const request = toLayerRequest(options, spec)
    const signal = options?.signal ?? undefined

    let turn
    try {
      turn = await this.api.routeTurn(request, { signal })
    } catch (error) {
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'CONFIG', message: String(error?.message ?? error) } } }
      return
    }

    const outcome = turn.outcome
    const routed = turn.routed ?? null

    if (!outcome?.ok) {
      const failure = describe(outcome?.errorObj ?? null) ?? outcome?.error ?? null
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: {
            code: failure?.code ?? CODE.transport,
            message: failure?.reason ?? failure?.message ?? 'model-select: every channel failed',
            attempts: Array.isArray(outcome?.attempts) ? outcome.attempts.map(attempt => describe(attempt.error)) : [],
          },
        },
      }
      return
    }

    // A verdict is not an answer. When the router handed the turn over, the work
    // was done by an execution unit and its answer is what gets yielded;
    // `outcome.response` is only what the router said.
    const handover = routed?.kind === 'dispatched' ? routed : null
    const answer = (handover?.response ?? outcome.response)?.json ?? null
    const chunks = chunkFromAnswer(answer, usageFrom(answer))
    this.recordTurn?.({
      model: spec,
      channel: handover?.executor?.name ?? outcome.channel,
      model_served: handover?.executor?.defaultModel ?? outcome.model,
      type: handover ? 'dispatch' : outcome.type,
      operation: routed?.operation ?? null,
      handoff: routed ? routed.kind : null,
      retries: outcome.retries,
      attempts: outcome.attempts.length,
      elapsedMs: handover?.elapsedMs ?? outcome.elapsedMs,
    })
    if (handover) {
      this.log(`model-select: ${spec} routed "${routed.operation}" to ${handover.executor.name}, ${handover.elapsedMs}ms`)
    } else if (routed?.kind === 'degrade') {
      this.log(`model-select: ${spec} degraded "${routed.operation}" to the generation tail (${routed.reason})`)
    } else {
      this.log(`model-select: ${spec} answered by ${outcome.channel}/${outcome.model} after ${outcome.retries} fallback${outcome.retries === 1 ? '' : 's'}`)
    }
    for (const chunk of chunks) yield chunk
  }
}

/**
 * A synchronous, throw-on-build error with the layer's code vocabulary.
 *
 * Kept local rather than imported from `errors.js` because `SelectError` takes a
 * retryable map and a candidate frame at construction, and `resolveModel` has
 * neither — it has not dispatched anything yet. What the caller needs is a
 * code and a message, which is all a picker error ever shows.
 */
class SelectLikeError extends Error {
  constructor(message, code) {
    super(message)
    this.code = code
  }
}
