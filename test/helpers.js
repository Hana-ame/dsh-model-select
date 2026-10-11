/**
 * Test fixtures: an in-memory channel table, a scriptable dispatch, a real
 * loopback upstream, and a fetch that never touches the network proxy.
 *
 * Every fixture avoids the outbound proxy on purpose. This suite must pass on a
 * machine with a broken proxy, an unset token, and no internet at all — it is
 * verifying control flow, not connectivity.
 */

import http from 'node:http'
import { validateConfig } from '../src/channels.js'
import { SelectError, classifyHttpStatus } from '../src/errors.js'

// ── channel table ──────────────────────────────────────────────────────────────

export const BASE_TABLE = {
  version: 1,
  defaults: {
    timeoutMs: 5000,
    availabilityTtlMs: 60000,
    maxAttempts: 4,
    decidePool: 'decide',
    fallbackPool: 'fast-free',
  },
  channels: {
    kilo: {
      baseUrl: 'http://127.0.0.1:1',
      path: 'chat/completions',
      defaultModel: 'kilo-flash',
      models: ['kilo-flash', 'kilo-mini'],
    },
    bunny: {
      baseUrl: 'http://127.0.0.1:2',
      path: 'chat/completions',
      defaultModel: 'bunny-free',
      models: ['bunny-free'],
    },
    sense: {
      baseUrl: 'http://127.0.0.1:3',
      path: 'chat/completions',
      defaultModel: 'sense-lite',
      models: ['sense-lite'],
    },
    jev: {
      baseUrl: 'http://127.0.0.1:4',
      type: 'decide',
      path: 'decide',
      defaultModel: 'jev-1.13-free',
      models: ['jev-1.13-free'],
    },
  },
  pools: {
    'fast-free': ['kilo', 'bunny'],
    all: ['kilo', 'bunny', 'sense'],
    decide: ['jev'],
  },
}

/** Build a validated table, with the channels and pools the tests expect. */
export function makeConfig(overrides = {}) {
  const merged = {}
  for (const [key, value] of Object.entries({ ...BASE_TABLE, ...overrides })) {
    merged[key] = structuredClone(value)
  }
  return validateConfig(merged, [], '<test>')
}

/** Point a table's channels at real loopback upstreams. */
export function retarget(config, channel, base) {
  config.channels[channel].baseUrl = base.replace(/\/+$/, '')
  return config
}

// ── dispatch stub ──────────────────────────────────────────────────────────────

/**
 * A dispatch whose behaviour is a script.
 *
 * Each entry is either a result object, a function `(candidate, request) => result`,
 * an `Error` to throw, or `{throw: error}`. Entries are consumed in order; the
 * last one repeats, so a two-step script covers any longer candidate list.
 */
export function stubDispatch(script, { label = 'stub' } = {}) {
  const calls = []
  let index = 0
  const fn = async (candidate, request, opts) => {
    const at = index
    index += 1
    calls.push({ at, candidate, request, opts })
    const step = script[at] ?? script[script.length - 1]
    const out = typeof step === 'function' ? await step(candidate, request) : step
    if (out instanceof Error) throw out
    if (out && typeof out === 'object' && out.throw !== undefined) throw out.throw
    return out
  }
  return { calls, fn, label }
}

/** A JSON chat-completion result, the shape dispatch returns. */
export const okJson = (model, content, extra = {}) => ({
  statusCode: 200,
  headers: {},
  stream: false,
  json: {
    id: `chatcmpl_${model}`,
    object: 'chat.completion',
    created: 1,
    model,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    ...extra,
  },
})

/** A 200 with no answer in it — the failure the fallback exists for. */
export const emptyJson = () => ({
  statusCode: 200,
  headers: {},
  stream: false,
  json: {
    id: 'chatcmpl_empty',
    object: 'chat.completion',
    created: 1,
    model: 'empty',
    choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'stop' }],
  },
})

/** An SSE stream body from frame strings, plus a matching dispatch result. */
export const sseResult = frames => ({
  statusCode: 200,
  headers: { 'content-type': 'text/event-stream' },
  stream: true,
  body: toStream(frames),
})

/** Every frame of the "this is a 200 with nothing in it" shape. */
export const emptySseResult = () => sseResult([
  'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":""}}]}\n\n',
  'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
  'data: [DONE]\n\n',
])

export const okSseResult = (text = 'hello') => sseResult([
  'data: {"id":"c2","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":""}}]}\n\n',
  `data: {"id":"c2","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"${text}"}}]}\n\n`,
  'data: {"id":"c2","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
  'data: [DONE]\n\n',
])

export function toStream(parts) {
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(typeof part === 'string' ? Buffer.from(part) : part)
      controller.close()
    },
  })
}

/** Collect a ReadableStream into a string. */
export async function readStream(stream) {
  const out = []
  for await (const chunk of stream) out.push(Buffer.from(chunk))
  return Buffer.concat(out).toString('utf8')
}

export const httpError = (status, message = 'failed') =>
  new SelectError(message, classifyHttpStatus(status, message), { statusCode: status })

export const codeError = (code, message = 'failed') => new SelectError(message, code)

// ── loopback upstream ──────────────────────────────────────────────────────────

const RESP = {
  /** A normal chat-completion, with the model the caller asked for. */
  json: (model = 'upstream') => ({
    kind: 'json',
    status: 200,
    body: {
      id: `chatcmpl_${model}`,
      object: 'chat.completion',
      created: 1,
      model,
      choices: [{ index: 0, message: { role: 'assistant', content: `answer from ${model}` }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
    },
  }),

  /** An empty answer: 200, but nothing to render. */
  empty: () => ({
    kind: 'json',
    status: 200,
    body: {
      id: 'chatcmpl_empty',
      object: 'chat.completion',
      created: 1,
      model: 'empty',
      choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'stop' }],
    },
  }),

  /** The free lane's characteristic failure. */
  rateLimit: () => ({
    kind: 'json',
    status: 429,
    body: { error: { message: 'rate limit exceeded for this session', type: 'rate_limit_error' } },
  }),

  badRequest: () => ({
    kind: 'json',
    status: 400,
    body: { error: { message: 'the request is malformed', type: 'invalid_request_error' } },
  }),

  server: () => ({
    kind: 'json',
    status: 503,
    body: { error: { message: 'no capacity', type: 'server_error' } },
  }),

  /** A stream with real content, in three frames. */
  sse: (model = 'upstream', text = 'answer from stream') => ({
    kind: 'sse',
    status: 200,
    model,
    frames: [
      `data: {"id":"c1","object":"chat.completion.chunk","model":"${model}","choices":[{"index":0,"delta":{"role":"assistant","content":""}}]}\n\n`,
      `data: {"id":"c1","object":"chat.completion.chunk","model":"${model}","choices":[{"index":0,"delta":{"content":"${text}"}}]}\n\n`,
      'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ],
  }),

  /** A stream that ends without saying anything. */
  sseEmpty: () => ({
    kind: 'sse',
    status: 200,
    frames: [
      'data: {"id":"c2","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":""}}]}\n\n',
      'data: {"id":"c2","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ],
  }),

  /** Close the stream immediately, which reads as a timeout to the caller. */
  hang: () => ({ kind: 'hang', status: 200 }),
}

/**
 * Start an upstream that answers from a script, on a free loopback port.
 *
 * `script` is a function `(hit, index) => RESP entry` or an array of entries.
 * Every request is recorded in `hits` with the parsed body, so a test can
 * assert which model the layer asked the channel for.
 */
export async function startUpstream(script, { host = '127.0.0.1' } = {}) {
  const hits = []
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      let body = {}
      try { body = raw === '' ? {} : JSON.parse(raw) } catch { body = { raw } }
      const index = hits.length
      hits.push({ method: req.method, url: req.url, headers: req.headers, body, at: Date.now(), index })
      const handler = typeof script === 'function'
        ? script(hits[index], index)
        : Array.isArray(script)
          ? (script[index] ?? script[script.length - 1])
          : script
      writeResponse(res, handler ?? RESP.json())
    })
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, host, () => {
      const port = server.address().port
      resolve({
        server,
        port,
        base: `http://127.0.0.1:${port}`,
        hits,
        close: () => new Promise(resolveClose => {
          server.closeAllConnections?.()
          server.close(resolveClose)
        }),
      })
    })
  })
}

function writeResponse(res, response) {
  if (response?.kind === 'sse') {
    res.writeHead(response.status ?? 200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' })
    for (const frame of response.frames) res.write(frame)
    res.end()
    return
  }
  if (response?.kind === 'hang') {
    res.writeHead(200, { 'content-type': 'application/json' })
    return
  }
  const body = JSON.stringify(response?.body ?? {})
  res.writeHead(response?.status ?? 200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

export const RESP_HELPERS = RESP

/** Send one request to a loopback server, with no proxy in the way. */
export function request(port, { method = 'POST', path = '/', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method, path, headers: { ...headers } },
      res => {
        const chunks = []
        res.on('data', chunk => chunks.push(chunk))
        res.on('end', () => {
          const buffer = Buffer.concat(chunks)
          let parsed = undefined
          try { parsed = JSON.parse(buffer.toString('utf8')) } catch { /* streamed */ }
          resolve({
            status: res.statusCode,
            headers: res.headers,
            text: buffer.toString('utf8'),
            json: parsed,
          })
        })
      },
    )
    req.on('error', reject)
    if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body))
    req.end()
  })
}

/**
 * A fetch that answers only to node:http, so the plugin's real dispatch can be
 * exercised against the loopback upstream without the outbound proxy.
 */
export function nodeHttpFetch(url, init = {}) {
  const target = new URL(url)
  const options = {
    method: init.method ?? 'GET',
    hostname: target.hostname,
    port: target.port || 80,
    path: `${target.pathname}${target.search}`,
    headers: {},
  }
  for (const [key, value] of Object.entries(init.headers ?? {})) options.headers[key.toLowerCase()] = value

  return new Promise((resolve, reject) => {
    const req = http.request(options, res => {
      const headerMap = new Map()
      for (const [key, value] of Object.entries(res.headers)) {
        headerMap.set(key.toLowerCase(), Array.isArray(value) ? value.join(', ') : value)
      }

      // A body that nobody reads must not queue data forever, and a body that is
      // cancelled must destroy the socket rather than keep the stream feeding it.
      let settled = false
      const settle = fn => (event) => {
        if (settled) return
        settled = true
        try { fn(event) } catch { /* already closed */ }
      }
      const body = new ReadableStream({
        start(controller) {
          res.on('data', chunk => {
            if (settled) return
            try { controller.enqueue(chunk) } catch { settled = true }
          })
          res.on('end', settle(() => controller.close()))
          res.on('error', settle(error => controller.error(error)))
          res.on('aborted', settle(() => controller.error(new Error('aborted'))))
        },
        cancel() {
          settled = true
          res.destroy()
        },
      })
      const text = async () => readAll(body).then(buffer => buffer.toString('utf8'))
      resolve({
        ok: res.statusCode >= 200 && res.statusCode < 300,
        status: res.statusCode,
        headers: {
          get: key => headerMap.get(String(key).toLowerCase()) ?? null,
          entries: () => headerMap.entries(),
        },
        body,
        text,
        json: async () => JSON.parse(await text()),
      })
    })
    req.on('error', reject)
    if (init.signal !== undefined) {
      if (init.signal.aborted) return reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
      init.signal.addEventListener('abort', () => req.destroy(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true })
    }
    if (init.body !== undefined && init.body !== null) req.write(init.body)
    req.end()
  })
}

async function readAll(stream) {
  const out = []
  for await (const chunk of stream) out.push(Buffer.from(chunk))
  return Buffer.concat(out)
}
