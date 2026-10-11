/**
 * select: the fallback loop.
 *
 *   candidates → availability filter (already done in resolveCandidates)
 *             → dispatch the first
 *             → 429 / timeout / empty / transport / 5xx → the next
 *             → a request defect (4xx) or a caller cancel → stop
 *             → success → return, with the channel actually used
 *             → all failed → return the last error
 *
 * `dispatch` is injected, which is the whole reason this file is testable
 * offline: the loop is pure orchestration over a callable that says "this
 * channel gave me this answer" or threw a classified failure.
 *
 * @module src/select.js
 */

import { CODE, SelectError } from './errors.js'
import { inspectContent, peekSse, replaySse } from './stream.js'

/**
 * Run one request through an ordered candidate list.
 *
 * @param {Array<{channel:string, model:string, key?:string}>} candidates - already resolved and filtered
 * @param {object} request - the OpenAI-shaped request body (messages, stream, ...)
 * @param {object} [opts]
 * @param {(candidate, request, {signal, timeoutMs, stream}) => Promise<object>} [opts.dispatch]
 * @param {object} [opts.availability] - the cache; successes and retryable failures are recorded
 * @param {import('node:stream/web').AbortSignal} [opts.signal] - the caller's cancel
 * @param {number} [opts.timeoutMs] - per-attempt deadline
 * @param {number} [opts.maxAttempts] - a cap on how many candidates are tried
 * @param {(message: string) => void} [opts.log]
 *
 * @returns {Promise<object>} `{ok:true, channel, model, modelField, response, attempts, retries, elapsedMs}`
 *   `type` is the channel's kind, so a caller can see whether the answer was routed
   or generated.
 *
 *   or `{ok:false, error, attempts, retries}` with `error` the last failure.
 */
export async function select(candidates, request, opts = {}) {
  const {
    dispatch,
    availability,
    signal,
    timeoutMs,
    maxAttempts,
    log = () => {},
  } = opts

  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new SelectError('select() got no candidates', CODE.config)
  }
  if (typeof dispatch !== 'function') {
    throw new SelectError('select() needs a dispatch function', CODE.config)
  }

  const stream = request?.stream === true
  const cap = Number.isFinite(maxAttempts) && maxAttempts > 0
    ? Math.min(candidates.length, Math.trunc(maxAttempts))
    : candidates.length

  const attempts = []
  let lastError = null

  for (let i = 0; i < cap; i += 1) {
    const candidate = candidates[i]
    const key = candidate.key ?? `${candidate.channel}/${candidate.model}`
    const startedAt = Date.now()

    try {
      const response = await dispatch(candidate, request, { signal, timeoutMs, stream })
      const verdict = await verifyResponse(response, { candidate, key, stream, timeoutMs, signal })
      if (!verdict.ok) {
        throw new SelectError(verdict.reason, verdict.code, {
          channel: candidate.channel,
          model: candidate.model,
          statusCode: response?.statusCode,
        })
      }

      availability?.report(candidate.channel, true, { note: 'answered', model: candidate.model })
      if (i > 0) log(`select: ${key} answered after ${i} fallback${i === 1 ? '' : 's'}`)

      return {
        ok: true,
        channel: candidate.channel,
        model: candidate.model,
        type: candidate.type,
        key,
        modelField: key,
        response,
        attempts,
        retries: i,
        elapsedMs: Date.now() - startedAt,
      }
    } catch (error) {
      const failure = normalize(error, candidate, key)
      attempts.push({
        channel: candidate.channel,
        model: candidate.model,
        key,
        error: describe(failure),
        elapsedMs: Date.now() - startedAt,
      })
      lastError = failure
      log(`select: ${key} failed (${failure.code}${failure.statusCode ? ` HTTP ${failure.statusCode}` : ''}): ${failure.message}`)

      if (!failure.retryable) break // a request defect replays identically into the next channel
      availability?.report(candidate.channel, false, { note: failure.code, model: candidate.model })
    }
  }

  return {
    ok: false,
    channel: null,
    model: null,
    key: null,
    modelField: null,
    response: null,
    attempts,
    retries: Math.max(0, attempts.length - 1),
    error: describe(lastError),
    errorObj: lastError,
  }
}

/**
 * Is this dispatch result an answer?
 *
 * A JSON body is judged by its content. A stream is peeked before anything is
 * handed back, because a stream that ends empty must fall back to the next
 * channel rather than reaching the client as an empty 200 — and after the peek
 * succeeds, the body is replaced with a replay that starts where the peek left
 * off, so the caller pipes it unchanged.
 */
async function verifyResponse(response, { candidate, key, stream, timeoutMs, signal }) {
  if (response === null || typeof response !== 'object') {
    return { ok: false, code: CODE.transport, reason: 'dispatch returned no result' }
  }

  if (response.json !== undefined && response.json !== null) {
    const envelope = response.json.error
    if (envelope !== undefined) {
      const status = typeof response.statusCode === 'number' ? response.statusCode : 200
      return {
        ok: false,
        code: httpEnvelopeCode(envelope, status),
        reason: envelopeMessage(envelope),
        statusCode: status,
      }
    }
    return inspectContent(response.json)
  }

  if (response.body !== undefined && response.body !== null) {
    if (stream !== true) {
      return { ok: false, code: CODE.empty, reason: 'the upstream streamed back an answer the caller did not ask for' }
    }
    try {
      const peek = await peekSse(response.body, {
        timeoutMs,
        signal,
        channel: candidate.channel,
        model: candidate.model,
      })
      if (!peek.sawContent) {
        return { ok: false, code: CODE.empty, reason: 'the upstream stream closed without assistant content' }
      }
      response.body = replaySse(peek)
      return { ok: true }
    } catch (error) {
      const failure = normalize(error, candidate, key)
      return { ok: false, code: failure.code, reason: failure.message, statusCode: failure.statusCode }
    }
  }

  return { ok: false, code: CODE.empty, reason: 'dispatch returned neither a JSON body nor a stream' }
}

/** Classify a 2xx error envelope by its own text, not by the HTTP status. */
function httpEnvelopeCode(envelope, status) {
  const text = typeof envelope === 'string' ? envelope : JSON.stringify(envelope)
  const flat = text.toLowerCase()
  if (/rate.?limit|too many requests|usage limit|quota/.test(flat)) return CODE.rateLimit
  if (status === 401 || status === 403) return CODE.credential
  if (status >= 500) return CODE.server
  if (status >= 400) return CODE.client
  return CODE.server
}

function envelopeMessage(envelope) {
  if (typeof envelope === 'string') return envelope
  const message = envelope?.message ?? envelope?.msg
  if (typeof message === 'string' && message !== '') return message
  const type = typeof envelope?.type === 'string' ? envelope.type : undefined
  return type ? `the upstream answered with ${type}` : 'the upstream answered with an error envelope'
}

/** Anything that is not already a classified failure becomes a transport error. */
function normalize(error, candidate, key) {
  if (error instanceof SelectError) {
    if (error.channel === undefined) error.channel = candidate.channel
    if (error.model === undefined) error.model = candidate.model
    return error
  }
  return new SelectError(String(error?.message ?? error ?? 'unknown failure'), CODE.transport, {
    channel: candidate.channel,
    model: candidate.model,
  })
}

/** A JSON-safe projection of a failure for logs, headers and the error body. */
export function describe(error) {
  if (!error) return null
  return {
    code: error.code,
    message: String(error.message ?? error),
    retryable: error.retryable,
    ...(error.statusCode !== undefined ? { statusCode: error.statusCode } : {}),
    ...(error.channel !== undefined ? { channel: error.channel } : {}),
    ...(error.model !== undefined ? { model: error.model } : {}),
  }
}

/**
 * Resolve a spec and run it, for callers that want one call. The select loop
 * stays separated from candidate resolution because each has a different failure
 * mode: resolution fails before any network, dispatch fails per channel.
 */
export async function selectForRequest(request, { resolve, ...opts } = {}) {
  if (typeof resolve !== 'function') {
    throw new SelectError('selectForRequest needs a resolve function', CODE.config)
  }
  const candidates = resolve(request?.model)
  return select(candidates, request, opts)
}
