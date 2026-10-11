/**
 * The real dispatch: one channel, one request, one answer.
 *
 * Kept separate from `select` because it is the only part of the layer that
 * touches the wire. `select` decides; this performs. Inject `fetchImpl` in tests
 * and the whole loop runs against an in-process server.
 *
 * Three wire shapes live behind this file, and they differ in both directions:
 *
 *   chat channel   → POST {baseUrl}/chat/completions with the request as written,
 *                    and the answer is passed through.
 *   decide channel → POST {baseUrl}/v1/decide with the decision, and the answer
 *                    is a structured verdict that must be projected into the chat
 *                    envelope before `select` sees it.
 *   dispatch channel → POST {baseUrl}/chat/completions with a session body: the
 *                    task to run, the session it belongs to, and the context it
 *                    came from. The executor is a model, so the answer is passed
 *                    through like a chat one.
 *
 * The decide projection is what makes the degradation invisible: the fallback loop,
 * the response writer, and the caller never learn that the answer was routed rather
 * than generated. The verdict arrives as the assistant's content, encoded as JSON,
 * which is the same contract OpenAI uses for structured outputs.
 *
 * @module src/upstream.js
 */

import {
  CODE,
  SelectError,
  classifyFetchError,
  classifyHttpStatus,
  describeCause,
  summarizeErrorBody,
} from './errors.js'
import { CHANNEL_TYPE_CHAT, CHANNEL_TYPE_DECIDE, CHANNEL_TYPE_DISPATCH } from './channels.js'

export const SERVICE_UA = 'dsh-model-select/0.1.0'

export const DEFAULT_TIMEOUT_MS = 60000

function joinUrl(base, pathValue, type) {
  const root = String(base ?? '').replace(/\/+$/, '')
  if (root === '') throw new SelectError('the channel has an empty baseUrl', CODE.config)
  const fallback = type === CHANNEL_TYPE_DECIDE ? 'v1/decide' : 'chat/completions'
  let path = String(pathValue ?? fallback).trim()
  if (path === '') path = fallback
  if (!path.startsWith('/')) path = `/${path}`
  return `${root}${path}`
}

function buildHeaders(channel, { stream, extra = {} } = {}) {
  const headers = {
    'content-type': 'application/json',
    'user-agent': SERVICE_UA,
    accept: stream ? 'text/event-stream' : 'application/json',
    ...(Object.entries(extra ?? {}).filter(([, value]) => value !== undefined && value !== null && value !== '')),
    ...(Object.entries(channel.headers ?? {}).filter(([, value]) => value !== undefined && value !== null && value !== '')),
  }
  const token = channel.auth?.token
  if (channel.auth && token) {
    if (channel.auth.type === 'query' || channel.auth.type === 'bearer-query') {
      headers['api-key'] = token
    } else {
      headers.authorization = `Bearer ${token}`
    }
  }
  return headers
}

function flattenHeaders(headers) {
  const out = {}
  if (headers?.entries) for (const [key, value] of headers.entries()) out[key.toLowerCase()] = value
  return out
}

/**
 * Build the dispatch function the select loop calls.
 *
 * @param {object} options
 * @param {object} options.channels - the validated table
 * @param {number} [options.timeoutMs]
 * @param {Function} [options.fetchImpl] - injectable transport
 * @param {object} [options.extraHeaders] - headers merged into every request
 *
 * @returns {(candidate, request, {signal, timeoutMs, stream}?) => Promise<object>}
 *   resolves to `{statusCode, headers, json, stream:false}` or
 *   `{statusCode, headers, body:ReadableStream, stream:true}`;
 *   throws `SelectError` with a channel and a code.
 */
export function createDispatch({
  channels,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl,
  extraHeaders = {},
} = {}) {
  if (!channels || typeof channels !== 'object') {
    throw new SelectError('createDispatch needs a channel table', CODE.config)
  }
  const fetcher = typeof fetchImpl === 'function'
    ? fetchImpl
    : typeof globalThis.fetch === 'function'
      ? globalThis.fetch.bind(globalThis)
      : null
  if (fetcher === null) {
    throw new SelectError('no fetch implementation is available; pass fetchImpl', CODE.config)
  }

  return async function dispatch(candidate, request, { signal, timeoutMs: attemptTimeoutMs, stream } = {}) {
    const channelName = candidate?.channel
    const channel = channels[channelName]
    if (!channel) {
      throw new SelectError(`unknown channel "${channelName}"`, CODE.config, { channel: channelName })
    }

    const deadlineMs = Number.isFinite(attemptTimeoutMs) && attemptTimeoutMs > 0 ? attemptTimeoutMs : timeoutMs
    const model = candidate.model
    const type = candidate.type ?? channel.type ?? CHANNEL_TYPE_CHAT
    // A decision is one verdict, not a conversation. A stream makes no sense here,
    // so the flag is ignored for decide channels and the answer comes back as JSON.
    const wantsStream = type === CHANNEL_TYPE_DECIDE
      ? false
      : stream === undefined ? request?.stream === true : stream === true

    const body = type === CHANNEL_TYPE_DECIDE
      ? buildDecisionBody(request, model, channel)
      : type === CHANNEL_TYPE_DISPATCH
        ? buildSessionBody(request, model, channel)
        : chatBody(request, model)

    const requestHeaders = buildHeaders(channel, { stream: wantsStream, extra: extraHeaders })
    const url = joinUrl(channel.baseUrl, channel.path, type)

    const deadline = AbortSignal.timeout(deadlineMs)
    const combined = signal && !signal.aborted ? AbortSignal.any([signal, deadline]) : deadline

    let response
    try {
      response = await fetcher(url, {
        method: 'POST',
        headers: requestHeaders,
        body: JSON.stringify(body),
        redirect: 'error',
        signal: combined,
      })
    } catch (error) {
      throw new SelectError(
        `the upstream did not answer: ${error?.message ?? error}${describeCause(error)}`,
        classifyFetchError(error, { callerSignal: signal, deadlineSignal: deadline }),
        { channel: channelName, model },
      )
    }

    const outHeaders = flattenHeaders(response.headers)

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      const reason = summarizeErrorBody(text) || `the upstream answered HTTP ${response.status}`
      throw new SelectError(reason, classifyHttpStatus(response.status, text), {
        channel: channelName,
        model,
        statusCode: response.status,
      })
    }

    if (wantsStream) {
      if (response.body === null || response.body === undefined) {
        throw new SelectError('the upstream returned no stream body', CODE.empty, { channel: channelName, model, statusCode: response.status })
      }
      return { statusCode: response.status, headers: outHeaders, body: response.body, stream: true }
    }

    const json = await readJson(response, {
      timeoutMs: deadlineMs,
      channel: channelName,
      model,
    })
    return {
      statusCode: response.status,
      headers: outHeaders,
      json: type === CHANNEL_TYPE_DECIDE ? projectDecision(json, model) : json,
      stream: false,
    }
  }
}

function chatBody(request, model) {
  const body = { ...(request ?? {}) }
  // Composition fields have already been delivered as a system message by
  // `applyContext`; keeping them here would let an upstream see two copies of the
  // same instruction.
  delete body.decision
  delete body.preset
  delete body.status
  delete body.model
  body.model = model
  return body
}

/**
 * What a dispatch channel receives. `messages` carries the task to run and nothing
 * else, and `context` carries the conversation the task came from. The executor
 * answers like a chat model, so the response is passed through unchanged.
 */
function buildSessionBody(request, model, channel) {
  const body = { ...(request ?? {}) }
  delete body.decision
  delete body.model
  body.model = model
  if (!body.session) body.session = channel.session ?? channel.name
  return { ...body, ...channel.dispatchBody }
}

/**
 * What a decide endpoint receives: the choices, the conversation as context, and
 * the reason the caller thinks it needs a choice.
 *
 * `messages` is folded into `context` rather than kept as `messages`, because a
 * router does not continue a conversation — it picks between things. Keeping the
 * field name would be an invitation to send a router a completion prompt.
 *
 * `channel.decideBody` lets a table entry add or rename fields for an upstream
 * that does not speak this canonical spelling.
 */
function buildDecisionBody(request, model, channel) {
  const decision = (request ?? {}).decision ?? {}
  const options = decision.options ?? decision.choices ?? decision.candidates ?? []
  const body = {
    model,
    options: Array.isArray(options) ? options : [],
    context: Array.isArray(request?.messages) ? request.messages : [],
    ...channel.decideBody,
  }
  for (const key of ['task', 'criteria', 'prompt', 'top_k', 'output', 'temperature', 'label']) {
    const value = decision[key]
    if (value !== undefined && value !== null && value !== '') body[key] = value
  }
  return body
}

/**
 * Keys a decide answer is allowed to use for framing rather than deciding.
 * Anything else is verdict content, and everything that is not content means the
 * router picked nothing — which is the empty answer the fallback exists for.
 */
const DECISION_FRAME_KEYS = new Set([
  'id', 'object', 'created', 'model', 'usage', 'system_fingerprint',
  'decision', 'request_id', 'logprobs', 'service_tier',
])

/**
 * A decide answer into a chat-completion-shaped answer.
 *
 * The verdict becomes the assistant's content, JSON-encoded. An upstream that
 * answered with an envelope and nothing inside it yields empty content, which
 * `select` then treats as the empty response it already knows how to fall back
 * from — a router that chose nothing is not an answer.
 */
export function projectDecision(body, model) {
  const source = body !== null && typeof body === 'object' ? body : {}
  const verdict = {}
  for (const [key, value] of Object.entries(source)) {
    if (!DECISION_FRAME_KEYS.has(key)) verdict[key] = value
  }
  const choseSomething = Object.keys(verdict).length > 0
  return {
    id: source.id ?? `chatcmpl_${randomHex(8)}`,
    object: 'chat.completion',
    created: source.created ?? Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: { role: 'assistant', content: choseSomething ? JSON.stringify(verdict) : '', refusal: null },
      finish_reason: 'stop',
    }],
    ...(source.usage ? { usage: source.usage } : {}),
    decision: verdict,
  }
}

function randomHex(bytes) {
  let out = ''
  for (let i = 0; i < bytes; i += 1) out += Math.floor(Math.random() * 256).toString(16).padStart(2, '0')
  return out
}

/**
 * Read a JSON body without letting a slow upstream hold the turn forever.
 * `Response#json()` takes no signal, so the deadline cancels the body instead.
 */
async function readJson(response, { timeoutMs, channel, model }) {
  let timer
  const deadline = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      void response.body?.cancel?.().catch(() => {})
      reject(new SelectError('the upstream did not answer with JSON before its deadline', CODE.timeout, {
        channel,
        model,
        statusCode: response.status,
      }))
    }, Math.max(1, timeoutMs))
    timer.unref?.()
  })
  const body = response.json().then(
    json => json,
    async error => {
      void response.body?.cancel?.().catch(() => {})
      throw new SelectError(`the upstream did not answer with JSON: ${error?.message ?? error}`, CODE.server, {
        channel,
        model,
        statusCode: response.status,
      })
    },
  )
  try {
    return await Promise.race([body, deadline])
  } finally {
    clearTimeout(timer)
  }
}
