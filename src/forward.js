/**
 * The OpenAI-compatible surface: POST /v1/chat/completions.
 *
 * One request in, one request out. The only thing this layer adds to the
 * upstream's answer is the identity of the channel that produced it: the `model`
 * field is rewritten to `channel/model`, and the same facts come back as
 * response headers so a caller that ignores the body can still tell.
 *
 * Response headers are held back until the first usable answer. That is what
 * makes the fallback invisible: a 429 from the first channel never reaches the
 * client, because the client is not told anything has started.
 *
 * @module src/forward.js
 */

import http from 'node:http'
import { CODE, SelectError } from './errors.js'
import { listModels } from './channels.js'
import { resolveCandidates, candidatesLabel } from './spec.js'
import { CHANNEL_TYPE_DISPATCH } from './channels.js'
import { select } from './select.js'
import { detectIntent, decisionSpec, INTENT_DECIDE } from './intent.js'
import { executorIndex } from './operations.js'
import { routeTurn } from './routing.js'
import { inspectContent } from './stream.js'

export const SERVICE = 'dsh-model-select'
export const SERVICE_VERSION = '0.1.0'

const MAX_BODY_BYTES = 8 * 1024 * 1024
const COMPLETION_PATHS = new Set(['/v1/chat/completions', '/chat/completions'])
const MODELS_PATHS = new Set(['/v1/models', '/models'])
const HEALTH_PATHS = new Set(['/', '/health'])

/**
 * @param {object} options
 * @param {object} options.config - a validated channel table
 * @param {object} [options.availability] - the cache
 * @param {Function} [options.dispatch] - the transport
 * @param {Function} [options.select] - injectable, for tests
 * @param {Function} [options.resolve] - injectable candidate resolver
 * @param {string} [options.apiKey] - when set, every request needs it
 * @param {object} [options.defaults]
 * @param {(message: string) => void} [options.log]
 */
export function createCompatHandler({
  config,
  availability,
  dispatch,
  select: selectImpl = select,
  resolve = (spec, request) => resolveCandidates(spec, {
    config,
    availability,
    intent: detectIntent(request),
    defaults: config.defaults,
  }),
  apiKey,
  defaults = {},
  log = () => {},
} = {}) {
  if (!config?.channels) throw new SelectError('the handler needs a channel table', CODE.config)
  if (typeof dispatch !== 'function') throw new SelectError('the handler needs a dispatch function', CODE.config)

  const timeoutMs = defaults.timeoutMs ?? config.defaults?.timeoutMs ?? 60000
  const maxAttempts = defaults.maxAttempts ?? config.defaults?.maxAttempts ?? 4
  // Operation → execution unit, recomputed from the table once. The table is the
  // only source: a verdict that names something not here has nowhere to go.
  const executors = executorIndex(config)

  return async function handle(req, res) {
    let path
    try {
      path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname.replace(/\/+$/, '') || '/'
    } catch {
      openAiError(res, 400, 'invalid_request_error', 'the request path could not be parsed')
      return
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders())
      res.end()
      return
    }

    if (HEALTH_PATHS.has(path)) {
      json(res, 200, health(config, availability))
      return
    }

    if (apiKey !== undefined && apiKey !== '' && !authorized(req, apiKey)) {
      openAiError(res, 401, 'invalid_request_error', 'missing or invalid API key')
      return
    }

    if (req.method === 'GET' && MODELS_PATHS.has(path)) {
      json(res, 200, {
        object: 'list',
        data: listModels(config).map(row => ({
          id: row.key,
          object: 'model',
          created: 0,
          owned_by: row.channel,
        })),
      })
      return
    }

    if (req.method === 'POST' && COMPLETION_PATHS.has(path)) {
      await serveCompletion(req, res)
      return
    }

    openAiError(res, 404, 'not_found_error', `no route for ${req.method} ${path}`)
  }

  /** Parse, resolve, select, and write the answer back in the caller's spelling. */
  async function serveCompletion(req, res) {
    const parsed = await readBody(req)
    if (!parsed.ok) {
      openAiError(res, parsed.status, 'invalid_request_error', parsed.message)
      return
    }
    // No composition here: `routeTurn` does it. Composing in two places would
    // append the whole discipline to the system message twice.
    const body = parsed.value

    if (typeof body.model !== 'string' || body.model.trim() === '') {
      openAiError(res, 400, 'invalid_request_error', '`model` is required')
      return
    }
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      openAiError(res, 400, 'invalid_request_error', '`messages` must be a non-empty array')
      return
    }

    // A caller that asks for a decision and does not name the choices gets a 400,
    // not a silently rewritten completion: the request said "choose", so the answer
    // must be a choice.
    const intent = detectIntent(body)
    const spec = decisionSpec(body)
    if (spec.present && !spec.ok) {
      openAiError(res, spec.status ?? 400, 'invalid_request_error', spec.message)
      return
    }

    const startedAt = Date.now()
    const signal = watchClient(req, res)

    let candidates
    let menu
    let picked = null
    let outcome
    let routed = null
    try {
      // The walk lives in `routing.js`, not here: the provider adapter takes the
      // same route, so a turn that entered through the harness gets the handover
      // a turn over HTTP gets.
      const turn = await routeTurn({
        request: body,
        config,
        availability,
        dispatch,
        executors,
        defaults,
        log: message => log(message),
        signal,
        timeoutMs,
        maxAttempts,
        select: selectImpl,
        resolve,
      })
      candidates = turn.candidates
      menu = turn.menu ?? candidates
      picked = turn.picked ?? null
      outcome = turn.outcome
      routed = turn.routed
    } catch (error) {
      const failure = error instanceof SelectError ? error : new SelectError(String(error?.message ?? error), CODE.config)
      const status = failure.statusCode && failure.statusCode >= 400 && failure.statusCode < 500
        ? failure.statusCode
        : 400
      openAiError(res, status, 'invalid_request_error', failure.message, { code: failure.code })
      return
    }

    if (routed?.kind === 'dispatched') {
      writeDispatched(res, routed, menu)
      return
    }

    if (!outcome.ok) {
      log(`all ${outcome.attempts.length} candidates failed; last was ${outcome.error?.code ?? 'unknown'}`)
      json(res, 503, {
        error: {
          message: `every candidate failed: ${outcome.error?.message ?? 'unknown failure'}`,
          type: 'server_error',
          param: null,
          code: 'all_channels_failed',
          last: outcome.error,
          attempts: outcome.attempts,
        },
      })
      return
    }

    // The tail took a turn the router had chosen work for. The answer is prose,
    // but the choice is the reason, so it stays in the body and in the headers.
    if (routed?.kind === 'degrade' && routed.operation !== undefined) {
      if (outcome.response?.json !== undefined) outcome.response.json.decision = routed.verdict
      res.setHeader('x-select-operation', routed.operation)
      res.setHeader('x-select-degraded', routed.reason ?? 'dispatch_failed')
    }

    res.setHeader('x-select-elapsed-ms', String(Date.now() - startedAt))
    res.setHeader('x-select-candidates', candidatesLabel(candidates))
    res.setHeader('x-select-intent', intent)
    res.setHeader('x-select-channel-type', outcome.type ?? 'chat')
    // The menu the caller could have dialed, and the number they dialed. Kept
    // separate from `x-select-candidates`, which is what was walked: with a pick
    // the two differ, and the difference is the whole point.
    if (picked !== null) {
      res.setHeader('x-select-menu', candidatesLabel(menu))
      res.setHeader('x-select-choice', `${picked.index}/${picked.total}`)
    }

    const response = outcome.response
    if (body.stream === true) {
      // A decision is one verdict, so a decide channel answers in JSON even when
      // the caller opened a stream. Synthesise the frames instead of sending a JSON
      // blob down a stream a client has told it to parse as SSE.
      const streamed = response.body !== undefined && response.body !== null
        ? response
        : { ...response, body: completionToStream(response.json) }
      await writeStreamResponse(res, streamed, outcome)
    } else {
      writeJsonResponse(res, response, outcome)
    }
  }
}

/**
 * The handover response.
 *
 * The executor is a model, so its answer is passed through like any other
 * completion. Two fields are added: `decision` is what the router picked, and
 * `dispatch` is where it went — an audit trail for "who did the work".
 */
function writeDispatched(res, routed, candidates) {
  const { operation, executor, verdict, response, elapsedMs } = routed
  const json = response.json ?? {}
  const body = {
    ...json,
    id: json.id ?? `chatcmpl_${randomHex(8)}`,
    object: 'chat.completion',
    created: json.created ?? Math.floor(Date.now() / 1000),
    model: `${executor.name}/${executor.defaultModel}`,
    decision: verdict,
    dispatch: {
      operation,
      session: executor.session ?? executor.name,
      channel: executor.name,
      elapsedMs,
    },
  }
  res.writeHead(200, {
    'content-type': 'application/json',
    'x-select-candidates': candidatesLabel(candidates),
    'x-select-intent': INTENT_DECIDE,
    'x-select-channel-type': CHANNEL_TYPE_DISPATCH,
    'x-select-operation': operation,
    'x-select-routed': 'true',
    'x-selected-channel': executor.name,
    'x-selected-model': executor.defaultModel,
    'x-select-retries': '0',
  })
  res.end(JSON.stringify(body))
}

/**
 * Rewrite the `model` field to the channel that actually answered, keeping
 * everything else the upstream sent.
 */
function writeJsonResponse(res, response, outcome) {
  const json = response.json ?? {}
  const body = {
    ...json,
    id: json.id ?? `chatcmpl_${randomHex(8)}`,
    object: 'chat.completion',
    created: json.created ?? Math.floor(Date.now() / 1000),
    model: outcome.modelField,
  }
  res.writeHead(200, {
    'content-type': 'application/json',
    ...selectionHeaders(outcome),
  })
  res.end(JSON.stringify(body))
}

/**
 * Pipe the upstream stream through. Headers go out only after the peek, so a
 * fallback never reaches the client as an empty 200. A `[DONE]` frame is added
 * if the upstream omitted it, because clients terminate on that marker.
 */
async function writeStreamResponse(res, response, outcome) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    ...selectionHeaders(outcome),
  })

  const body = response.body
  const decoder = new TextDecoder()
  let tail = ''
  let sawDone = false
  let cancelled = false

  const onClientGone = () => {
    if (!res.writableEnded) {
      cancelled = true
      void body.cancel?.('the client closed the stream')
    }
  }
  res.once('close', onClientGone)

  try {
    for await (const chunk of body) {
      if (res.destroyed || res.writableEnded || cancelled) break
      tail = (tail + decoder.decode(chunk, { stream: true })).slice(-128)
      if (tail.includes('[DONE]')) sawDone = true
      if (!res.write(chunk)) await waitForDrain(res)
    }
    if (!sawDone && !res.writableEnded) res.write('data: [DONE]\n\n')
  } catch (error) {
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify({ error: { message: String(error?.message ?? error), type: 'server_error' } })}\n\n`)
      res.write('data: [DONE]\n\n')
    }
  } finally {
    res.removeListener('close', onClientGone)
    if (!res.writableEnded) res.end()
  }
}

function selectionHeaders(outcome) {
  return {
    'x-selected-channel': outcome.channel,
    'x-selected-model': outcome.model,
    'x-select-retries': String(outcome.retries ?? 0),
  }
}

/** Watch the socket so a caller that walks away cancels the upstream request. */
function watchClient(req, res) {
  const controller = new AbortController()
  const abort = () => {
    if (!controller.signal.aborted) controller.abort()
  }
  req.on('aborted', abort)
  res.on('close', () => {
    if (!res.writableEnded) abort()
  })
  return controller.signal
}

/**
 * Read and parse the request body.
 *
 * The two failures get different statuses: a body that is too large is 413, a
 * body that is not JSON is 400 — the caller can fix one by splitting the request
 * and the other by fixing the encoding.
 *
 * @returns {Promise<{ok:true, value:object}|{ok:false, status:number, message:string}>}
 */
async function readBody(req) {
  const chunks = []
  let size = 0
  try {
    for await (const chunk of req) {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        return { ok: false, status: 413, message: 'the request body is too large' }
      }
      chunks.push(chunk)
    }
  } catch {
    return { ok: false, status: 400, message: 'the request body could not be read' }
  }
  if (size === 0) return { ok: true, value: {} }
  try {
    return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  } catch {
    return { ok: false, status: 400, message: 'the request body is not valid JSON' }
  }
}

/**
 * Turn one chat-completion object into three SSE frames and a terminator.
 * Used only when a decide channel answered a request the caller asked to stream.
 */
function completionToStream(json) {
  const base = {
    id: json?.id ?? `chatcmpl_${randomHex(8)}`,
    object: 'chat.completion.chunk',
    created: json?.created ?? Math.floor(Date.now() / 1000),
    model: json?.model,
  }
  const content = json?.choices?.[0]?.message?.content ?? ''
  const frames = [
    { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] },
    { ...base, choices: [{ index: 0, delta: { content } }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  ]
  return toStream(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).concat(['data: [DONE]\n\n']))
}

function toStream(parts) {
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(typeof part === 'string' ? Buffer.from(part) : part)
      controller.close()
    },
  })
}

function waitForDrain(stream) {
  return new Promise(resolve => {
    stream.once('drain', resolve)
    stream.once('close', resolve)
  })
}

function authorized(req, key) {
  if (typeof key !== 'string' || key === '') return false
  const header = String(req.headers.authorization ?? '')
  if (header.toLowerCase().startsWith('bearer ')) return header.slice(7).trim() === key
  const apiKey = req.headers['x-api-key']
  return typeof apiKey === 'string' && apiKey.trim() === key
}

function corsHeaders() {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'authorization, content-type, x-api-key',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-max-age': '600',
  }
}

function health(config, availability) {
  const executors = executorIndex(config)
  return {
    ok: true,
    service: SERVICE,
    version: SERVICE_VERSION,
    channels: Object.keys(config.channels),
    // Which execution unit would run each operation the router can pick.
    executors: Object.fromEntries(
      Object.entries(executors).map(([operation, executor]) => [operation, executor.name]),
    ),
    types: Object.fromEntries(Object.entries(config.channels).map(([name, channel]) => [name, channel.type])),
    disabled: Object.entries(config.channels)
      .filter(([, channel]) => channel.disabled)
      .map(([name]) => name),
    pools: Object.keys(config.pools ?? {}),
    models: listModels(config).length,
    availability: availability?.snapshot?.() ?? null,
  }
}

function json(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

function openAiError(res, status, type, message, meta = {}) {
  json(res, status, {
    error: {
      message,
      type,
      param: null,
      code: meta.code ?? null,
    },
  })
}

function randomHex(bytes) {
  let out = ''
  for (let i = 0; i < bytes; i += 1) out += Math.floor(Math.random() * 256).toString(16).padStart(2, '0')
  return out
}

/**
 * Bind the handler. Loopback by default, because the caller's key is spent
 * through this door.
 *
 * @returns {Promise<{server, host, port, close}>}
 */
export function startServer({ host = '127.0.0.1', port = 0, log = () => {}, ...handlerOptions }) {
  const handler = createCompatHandler({ log, ...handlerOptions })
  const server = http.createServer((req, res) => {
    handler(req, res).catch(error => {
      log(`request failed: ${error?.message ?? error}`)
      if (!res.headersSent) {
        openAiError(res, 500, 'server_error', String(error?.message ?? error))
      } else {
        res.end()
      }
    })
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      const address = server.address()
      const actualPort = typeof address === 'object' && address ? address.port : port
      log(`listening on ${host}:${actualPort}`)
      resolve({
        server,
        host,
        port: actualPort,
        url: `http://${host}:${actualPort}`,
        close: () => new Promise(resolveClose => {
          server.closeAllConnections?.()
          server.close(() => resolveClose())
        }),
      })
    })
  })
}
