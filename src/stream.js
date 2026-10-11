/**
 * Stream peeking: read an upstream SSE body far enough to know whether it will
 * carry any assistant content, without handing a single byte to the client.
 *
 * This is what makes fallback safe for streaming requests. A stream answer is
 * not observable until it ends, so "the answer was empty" would otherwise be
 * reported only after the client already saw a 200 with no content. Peeking
 * solves that by holding the response open until either the first content-bearing
 * frame arrives or the stream closes: only then do the headers go out, and the
 * buffered bytes are replayed in front of the live reader so no frame is lost.
 *
 * Frames are buffered as raw chunks, never as re-encoded strings — the decoder
 * is used only to find line boundaries, so the replay is byte-exact.
 *
 * @module src/stream.js
 */

import { CODE, SelectError } from './errors.js'

/**
 * Does one decoded `data:` payload carry assistant content?
 *
 * Reasoning text does not count: a model can spend a whole turn thinking and
 * still hand the client nothing to render, which is exactly the empty answer the
 * fallback is meant to catch. Tool calls do count, because the caller is about
 * to be asked to run something.
 */
export function isSseContent(payload) {
  let json
  try {
    json = JSON.parse(payload)
  } catch {
    return false
  }
  if (json?.error !== undefined) return false

  const delta = json?.choices?.[0]?.delta
  if (delta) {
    if (typeof delta.content === 'string' && delta.content.trim() !== '') return true
    if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) return true
  }
  if (Array.isArray(json?.output) && json.output.length > 0) return true
  if (typeof json?.content === 'string' && json.content.trim() !== '') return true
  return false
}

/**
 * Is this JSON document an assistant answer, or an empty one?
 *
 * Returns `{ok:true}` or a retryable empty verdict. A non-empty `content` and a
 * non-empty `tool_calls` are both answers; a `null` or `''` content with no tool
 * calls is not.
 */
export function inspectContent(json) {
  const choices = json?.choices
  const choice = Array.isArray(choices) && choices.length > 0 ? choices[0] : undefined
  if (!choice) return { ok: false, code: CODE.empty, reason: 'the response carries no choices' }

  const message = choice.message ?? choice.delta ?? {}
  const raw = message.content
  const content = typeof raw === 'string' ? raw : raw === null || raw === undefined ? '' : String(raw)
  const hasToolCalls = Array.isArray(message.tool_calls) && message.tool_calls.length > 0

  if (content.trim() === '' && !hasToolCalls) {
    return { ok: false, code: CODE.empty, reason: 'the assistant content is empty' }
  }
  return { ok: true }
}

/**
 * Read one frame off a body reader, bound by a deadline and an abort signal.
 *
 * The reader's pending `next()` is raced rather than awaited, so a connection
 * that accepts the request and then goes silent dies at the deadline instead of
 * holding the turn for its full timeout. The race loser is settled and ignored:
 * cancelling the reader resolves it later, and that outcome must not surface as
 * an unhandled rejection after the caller has moved on.
 */
async function readFrame(reader, { timeoutMs, signal }) {
  if (signal?.aborted === true) throw new SelectError('request aborted', CODE.aborted)
  const pending = reader.read()
  pending.catch(() => {})
  let timer
  let onAbort
  const halted = new Promise((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new SelectError('the upstream stream was silent past its deadline', CODE.timeout)),
      Math.max(1, timeoutMs),
    )
    timer.unref?.()
    if (signal) {
      onAbort = () => reject(new SelectError('request aborted', CODE.aborted))
      signal.addEventListener('abort', onAbort, { once: true })
    }
  })
  try {
    return await Promise.race([pending, halted])
  } finally {
    clearTimeout(timer)
    if (onAbort !== undefined && signal !== undefined) signal.removeEventListener('abort', onAbort)
  }
}

/**
 * Consume an SSE body until the first content-bearing `data:` frame, or until it
 * closes.
 *
 * @returns {Promise<{sawContent:boolean, chunks:Uint8Array[], reader:object, closed:boolean}>}
 */
export async function peekSse(body, { timeoutMs = 60000, signal, isContent = isSseContent, channel, model } = {}) {
  if (typeof body?.getReader !== 'function') {
    throw new SelectError('the upstream body is not readable', CODE.transport, { channel, model })
  }
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const chunks = []
  let buffer = ''
  let sawContent = false
  let closed = false

  try {
    while (!sawContent && !closed) {
      const { value, done } = await readFrame(reader, { timeoutMs, signal })
      if (done) {
        closed = true
        break
      }
      if (value === undefined) continue
      chunks.push(value)
      buffer += decoder.decode(value, { stream: true })

      let newline
      while (!closed && !sawContent && (newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, '').trim()
        buffer = buffer.slice(newline + 1)
        if (line === '' || line.startsWith(':')) continue // comments keep the stream alive, not the answer
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (payload === '' || payload === '[DONE]') {
          closed = true
          break
        }
        if (isContent(payload)) {
          sawContent = true
          break
        }
      }
    }
  } catch (error) {
    await reader.cancel().catch(() => {})
    throw normalize(error, { signal, channel, model })
  }

  return { sawContent, chunks, reader, closed }
}

function normalize(error, { signal, channel, model }) {
  if (error instanceof SelectError) {
    if (error.channel === undefined) error.channel = channel
    if (error.model === undefined) error.model = model
    return error
  }
  if (signal?.aborted === true || error?.name === 'AbortError') {
    return new SelectError('request aborted', CODE.aborted, { channel, model })
  }
  return new SelectError(`reading the upstream stream failed: ${error?.message ?? error}`, CODE.transport, { channel, model })
}

/**
 * Rebuild a body stream from a peek: the buffered chunks first, then the reader
 * that follows. The reader keeps whatever it was doing, so the caller sees the
 * exact byte sequence the upstream produced.
 */
export function replaySse(peek) {
  const { chunks, reader, closed } = peek
  return new ReadableStream({
    async start(controller) {
      try {
        for (const chunk of chunks) controller.enqueue(chunk)
        if (closed) {
          controller.close()
          return
        }
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          if (value !== undefined) controller.enqueue(value)
        }
        controller.close()
      } catch (error) {
        await reader.cancel().catch(() => {})
        controller.error(error)
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => {})
    },
  })
}
