/**
 * Shared failure vocabulary for the select layer.
 *
 * One code set, one retryable set, one error class — the fallback loop decides
 * everything from `retryable`, so a new failure kind is one line here and never
 * a new branch in `select()`. The split follows the one already proven on the
 * free lane: only failures that a *different* channel can plausibly answer
 * differently are retryable. A request defect (400/401/403) replays identically
 * into every channel, so it stops the loop instead of burning the quota of the
 * whole pool.
 *
 * @module src/errors.js
 */

export const CODE = {
  /** Quota or rate limit: another channel may still have budget left. */
  rateLimit: 'RATE_LIMIT',
  /** The deadline expired before a first byte or a full JSON answer. */
  timeout: 'TIMEOUT',
  /** An HTTP 2xx with no assistant content — the answer exists, the text does not. */
  empty: 'EMPTY_RESPONSE',
  /** DNS, TCP or TLS refusal, a reset, a proxy that dropped the hop. */
  transport: 'TRANSPORT',
  /** Upstream 5xx: the channel itself is broken. */
  server: 'SERVER',
  /** The request is wrong. Replaying it at another channel reproduces the refusal. */
  client: 'CLIENT_ERROR',
  /** The channel refuses the credential. */
  credential: 'INVALID_CREDENTIAL',
  /** The channel table or the model spec is not usable. Never retryable. */
  config: 'CONFIG',
  /** The caller walked away. Not a channel failure at all. */
  aborted: 'ABORTED',
}

/**
 * The only failures worth reaching for the next candidate. `CLIENT_ERROR`,
 * `INVALID_CREDENTIAL`, `CONFIG` and `ABORTED` are deliberately absent.
 */
const RETRYABLE = new Set([
  CODE.rateLimit,
  CODE.timeout,
  CODE.empty,
  CODE.transport,
  CODE.server,
])

export function isRetryable(code) {
  return RETRYABLE.has(code)
}

/**
 * The one error the select layer throws and returns. Carries the HTTP status and
 * the candidate it came from, so the caller can echo a useful diagnostic instead
 * of a bare 500 — and `retryable` is fixed at construction time, which is what
 * makes the fallback predicate a property read rather than a second decision.
 */
export class SelectError extends Error {
  constructor(message, code, details = {}) {
    super(message)
    this.name = 'SelectError'
    this.code = code
    this.statusCode = details.statusCode
    this.channel = details.channel
    this.model = details.model
    this.retryable = isRetryable(code)
  }
}

/**
 * Map an HTTP status onto a failure code, letting the body override the status
 * where the body is the more specific fact: a gateway that answers 200 with a
 * `rate_limit` error object is a quota event, not a healthy answer.
 */
export function classifyHttpStatus(status, text = '') {
  const flat = String(text ?? '').toLowerCase()
  if (status === 429 || /rate.?limit|too many requests|usage limit|quota/i.test(flat)) {
    return CODE.rateLimit
  }
  if (status === 401 || status === 403) return CODE.credential
  if (status >= 500) return CODE.server
  if (status >= 400) return CODE.client
  // A 2xx with an error envelope falls through to SERVER: the channel answered,
  // but not with an answer. That is worth a fallback, so it stays retryable.
  return CODE.server
}

/**
 * Turn a rejected `fetch` into a code, keeping the two abort causes apart.
 *
 * The caller's own signal aborting is not a channel failure — the user cancelled
 * the turn — so it must not mark the channel down or consume the next candidate.
 * Only the deadline aborting is a timeout.
 */
export function classifyFetchError(error, { callerSignal, deadlineSignal } = {}) {
  if (callerSignal?.aborted === true) return CODE.aborted
  if (deadlineSignal?.aborted === true) return CODE.timeout
  const name = String(error?.name ?? '')
  if (name === 'AbortError' || name === 'TimeoutError') return CODE.timeout
  return CODE.transport
}

/** Pull a short human-readable reason out of an upstream error body. */
export function summarizeErrorBody(text, limit = 300) {
  const trimmed = String(text ?? '').trim()
  if (trimmed === '') return ''
  try {
    const json = JSON.parse(trimmed)
    const message = json?.error?.message ?? (typeof json?.error === 'string' ? json.error : undefined) ?? json?.message
    if (typeof message === 'string' && message !== '') return cut(message, limit)
  } catch { /* not JSON; fall through to the raw reduction */ }
  return cut(trimmed, limit)
}

/** The socket-level facts behind a transport failure, off the `cause` chain. */
export function describeCause(error, depth = 3) {
  const parts = []
  let node = error
  for (let i = 0; i < depth && node; i += 1) {
    const code = typeof node.code === 'string' && node.code !== '' ? node.code : ''
    const line = typeof node.message === 'string' ? node.message.split('\n')[0].trim() : ''
    if (code === '' && line === '') break
    const fact = line === '' ? code : code === '' ? line : line.includes(code) ? line : `${line} (${code})`
    if (!parts.includes(fact)) parts.push(fact)
    node = node.cause
  }
  return parts.length > 0 ? ` — ${parts.join('; ')}` : ''
}

function cut(text, limit) {
  const value = String(text ?? '')
  return value.length > limit ? `${value.slice(0, limit)}…` : value
}
