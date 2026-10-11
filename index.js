/**
 * dsh-model-select — plugin entry.
 *
 * Compatibility layer for a harness whose model keeps forgetting, drifting, and
 * refusing to continue. The answer is not a longer prompt: it is code that
 * decides which channel answers a turn and that never lets a failed turn reach
 * the caller. Discipline is injected by configuration, reliability is carried by
 * the skeleton.
 *
 * Wiring, mirroring dsh-our-free-model:
 *   - `apply(ctx, config)` is the host entry; it builds the layer, registers the
 *     provider adapter with `ctx.llm.registerAdapter`, and then mounts the
 *     OpenAI-compatible HTTP routes through whatever server facility the host
 *     offers, if any.
 *   - the browser / settings half is not claimed yet — that is the DSH profile
 *     step, which this skeleton deliberately does not touch.
 *
 * Until the profile is deployed the layer runs standalone, which is how it is
 * tested here:
 *
 *   node index.js --serve [--port 8787] [--config config/channels.json] [--key TOKEN]
 *
 * @module index.js
 */

import fs from 'node:fs'
import { pathToFileURL } from 'node:url'
import { loadConfig, DEFAULT_CONFIG_URL } from './src/channels.js'
import { AvailabilityCache } from './src/availability.js'
import { createDispatch } from './src/upstream.js'
import { resolveCandidates } from './src/spec.js'
import { detectIntent } from './src/intent.js'
import { executorIndex, operationFromVerdict, sessionRequest } from './src/operations.js'
import { DEFAULT_PRESET, applyContext } from './src/context.js'
import { select } from './src/select.js'
import { routeTurn } from './src/routing.js'
import { readChoice, pickCandidate, CHOICE_FIELDS } from './src/selection.js'
import { createLoop, idleInspector } from './src/loop.js'
import { startServer, createCompatHandler, SERVICE, SERVICE_VERSION } from './src/forward.js'
import { ModelSelectAdapter, ROUTE as PROVIDER_ROUTE, PROVIDER_NAME, catalogRows } from './src/adapter.js'

export const name = 'model-select'
export const version = readPackageVersion()

/**
 * One service is named, and it is the one that makes this plugin reachable.
 *
 * `llm` is what turns the layer from an HTTP service into a provider: registering
 * the adapter is the act of becoming selectable as `session_create(provider=
 * "model-select", ...)`, and DSH withholds from a context any service its fiber
 * does not name here — and keeps that fiber PENDING while one is absent. So a
 * composition without the LLM runtime never mounts this plugin at all, which is
 * the correct outcome: with no adapter to register, the plugin would be a dead
 * endpoint waiting to be pointed at.
 *
 * What that costs, and how it is avoided:
 * - the standalone runner is untouched. `node index.js --serve` calls
 *   `createModelSelect()` directly and never passes through `apply`, so the
 *   layer keeps working with no host kernel present.
 * - the HTTP mounting below is opportunistic. It reads `ctx.plugin` / `ctx.route`
 *   defensively and logs when no mounting facility exists, because a host that
 *   offers the LLM lane but no routing table is still a valid composition — the
 *   provider registration is enough for `session_create` to reach the model.
 */
export const inject = ['llm']

/**
 * Build the layer without starting anything.
 *
 * Every moving part is an option, so the tests and the DSH profile can each
 * swap exactly one thing without rewriting the rest: inject `dispatch` for an
 * in-process upstream, `config` for an in-memory table, `availability` for a
 * clock that moves on demand.
 *
 * @param {object} [options]
 * @param {object|import('./src/channels.js').default} [options.config] - a loaded table
 * @param {string|URL} [options.configPath]
 * @param {object} [options.availability]
 * @param {Function} [options.dispatch]
 * @param {object} [options.defaults]
 * @param {Function} [options.log]
 * @param {object} [options.fetchImpl]
 * @param {string} [options.apiKey]
 * @returns {object} the layer's public surface
 */
export function createModelSelect(options = {}) {
  const log = options.log ?? (() => {})
  const config = options.config ?? loadConfig(options.configPath ?? DEFAULT_CONFIG_URL)
  const availability = options.availability ?? new AvailabilityCache({
    ttlMs: config.defaults?.availabilityTtlMs,
  })
  const dispatch = options.dispatch ?? createDispatch({
    channels: config.channels,
    timeoutMs: config.defaults?.timeoutMs,
    fetchImpl: options.fetchImpl,
    headers: config.defaults?.headers,
  })
  const defaults = {
    timeoutMs: config.defaults?.timeoutMs,
    maxAttempts: config.defaults?.maxAttempts,
    ...options.defaults,
  }

  if (Array.isArray(config.warnings) && config.warnings.length > 0) {
    for (const warning of config.warnings) log(`channel table: ${warning}`)
  }

  /**
   * The core call, with no composition of its own.
   *
   * Both public entry points compose exactly once and then land here, which is
   * what keeps the preamble from stacking: composing twice would append the
   * whole discipline to the system message a second time.
   */
  const runSelect = (candidates, request, opts = {}) => select(candidates, request, {
    dispatch,
    availability,
    ...defaults,
    log,
    ...opts,
  })

  const api = {
    service: SERVICE,
    version: SERVICE_VERSION,
    config,
    availability,
    defaults,
    dispatch,
    // Operation → the execution unit that claims it. A verdict that names an
    // operation not here has nowhere to go and degrades to the generation tail.
    executors: executorIndex(config),
    preset: DEFAULT_PRESET,

    /**
     * The one thing this service owes every entry point, regardless of how the
     * turn arrived: the preset and the situation briefing, folded into the
     * messages before anything is resolved or dialled.
     *
     * It lives here and not in the HTTP handler, because a discipline that only
     * one of the two doors enforces is a discipline the other door skips. The
     * handler calls `applyContext` itself before reaching the core, so this
     * composition and that one never stack on the same request — each request is
     * composed once, at whichever boundary it enters.
     */
    withContext(request) {
      return applyContext(request, { config, availability })
    },

    /**
     * Resolve a `model` field into the ordered candidate list, nothing more.
     * Pass the request so the call can see the `decision` field and order the
     * candidates by intent: decide channels first, chat channels as the tail.
     */
    candidates(spec, request = null) {
      return resolveCandidates(spec, {
        config,
        availability,
        intent: detectIntent(request),
        defaults: config.defaults,
      })
    },

    /**
     * The whole turn, with nothing written anywhere: compose, resolve, select,
     * route, degrade.
     *
     * This is the shape an entry point should take a turn in, because it is where
     * the two guarantees live. The HTTP handler runs this same walk and then
     * writes an OpenAI-shaped body; the provider adapter runs it and yields a
     * chunk stream. There is no second copy of the walk anywhere, which is what
     * makes "the preset always reaches the model" and "a verdict always gets
     * handed over" claims about the layer instead of about one door.
     *
     *   intent      'decide' | 'chat', from the request
     *   candidates  the ordered list that was walked
     *   outcome     the select result — `ok`, `response`, `attempts`, `type`
     *   routed      null, or `{kind:'dispatched'|'degrade', operation, verdict, ...}`
     *
     * When `routed.kind === 'dispatched'` the work was done by an execution unit,
     * and its answer is `routed.response` — not `outcome.response`, which is what
     * the router said. Both are kept so a caller can audit the whole path.
     */
    routeTurn(request, opts = {}) {
      return routeTurn({
        request,
        config,
        availability,
        dispatch,
        executors: api.executors,
        defaults,
        log,
        timeoutMs: defaults.timeoutMs,
        maxAttempts: defaults.maxAttempts,
        ...opts,
      })
    },

    /**
     * The whole turn, flattened to the select result.
     *
     * Use `routeTurn` instead when you need the handover: this returns
     * `outcome`, which is the router's verdict on a dispatched turn, not the work
     * that was done.
     */
    async complete(request, opts = {}) {
      const turn = await api.routeTurn(request, opts)
      return turn.outcome
    },

    /** Given the candidates, compose and fall back. */
    select(candidates, request, opts = {}) {
      return runSelect(candidates, api.withContext(request), opts)
    },

    /**
     * The model catalog, in the harness's discovery shape: the pools first, then
     * the channels, then the execution units. Pools are advertised because a
     * pool is the thing this provider exists for — a single channel has no
     * fallback chain and none of the reliability argument behind the layer.
     */
    models() {
      return catalogRows(config, PROVIDER_ROUTE)
    },

    /**
     * The phone menu. Given the same request a turn would use, this answers
     * "what could a caller dial, and what did they dial".
     *
     * It is exposed separately from `routeTurn` because the menu is the thing a
     * caller needs to see before they pick: `menu()` lists the lanes and their
     * numbers, and `choice()` reports what a request's number resolves to, or
     * throws the same error the turn would, so a caller can preview a bad pick
     * without paying for a dispatch.
     */
    menu(model = null, request = null) {
      // No model given means the layer's own default lane, so the menu is
      // answerable with nothing but a request.
      const spec = model ?? request?.model ?? `__pool__:${config.defaults?.fallbackPool}`
      return api.candidates(spec, request).map((candidate, index) => ({
        index: index + 1,
        channel: candidate.channel,
        model: candidate.model,
        type: candidate.type,
        key: candidate.key,
      }))
    },

    /**
     * What a `choice` or `selection` field resolves to, without dispatching.
     * Throws a CONFIG SelectError on an unparseable or out-of-range number.
     */
    choice(request, model = null) {
      const read = readChoice(request)
      if (!read.present) return { present: false }
      if (read.error) throw read.error
      // Resolve the menu first, so an out-of-range number is reported against
      // the same list a turn would walk, not against a guess.
      const list = api.candidates(request?.model ?? model ?? `__pool__:${config.defaults?.fallbackPool}`, request)
      const { picked } = pickCandidate(list, request)
      return picked
    },

    /**
     * The unattended patrol: inspect what is due, and hand each piece of work to
     * the execution unit that claims its operation.
     *
     * It composes through the same `applyContext` a turn does, so a patrol dispatch
     * carries the discipline and the situation briefing the routed road does —
     * one guarantee, one place. The inspector is injected; the shipped one reports
     * nothing, because this layer has no git remote, no session index and no
     * ledger, and a todo it invented would be a guess.
     *
     * `start()` arms the clock from `defaults.loopMs`, `tick()` runs one patrol
     * by hand, and `status()` reports what the last one did. Either road can drive
     * it: an operator may let the layer own its clock, or call `tick()` from a
     * DSH schedule, a cron job, or a button, and the memo keeps the two from
     * dispatching the same work twice.
     */
    loop(inspect) {
      return createLoop({
        inspect,
        dispatch,
        executors: api.executors,
        compose: request => api.withContext(request),
        intervalMs: config.defaults?.loopMs,
        timeoutMs: defaults.timeoutMs,
        log,
      })
    },

    /**
     * What a verdict picks, and what an executor would receive.
     *
     * `route(request)` answers: which operation does this verdict name, does an
     * execution unit claim it, and what would be sent. No wire is touched, which
     * is how a caller previews a handover before committing to it.
     */
    route(request) {
      const verdict = request?.decision ?? {}
      const operation = operationFromVerdict(verdict)
      const executor = operation === undefined ? undefined : api.executors[operation]
      return {
        verdict,
        operation,
        executor: executor ?? null,
        body: executor === undefined ? null : sessionRequest(executor, request),
      }
    },

    /** Route handler for a host that mounts paths itself. */
    handler(serverOptions = {}) {
      return createCompatHandler({
        config,
        availability,
        dispatch,
        defaults,
        apiKey: serverOptions.apiKey ?? options.apiKey,
        log,
      })
    },

    /** Bind the OpenAI-compatible listener. */
    async start(serverOptions = {}) {
      return startServer({
        config,
        availability,
        dispatch,
        defaults,
        apiKey: serverOptions.apiKey ?? options.apiKey,
        log,
        ...serverOptions,
      })
    },

    async close(server) {
      if (server?.close) await server.close()
    },
  }

  return api
}

/**
 * The host entry.
 *
 * Defensive on purpose: the DSH profile step is what makes this precise, and
 * this skeleton must not crash a host that mounts plugins differently. Whatever
 * facility the host exposes is used; whatever it does not is reported to the
 * host's log instead of throwing.
 */
export function apply(ctx, config = {}) {
  const logger = ctx?.logger ?? ctx?.log ?? console
  const log = message => logger?.warn?.(message) ?? logger?.log?.(message)

  const api = createModelSelect({
    config: config.config,
    configPath: config.configPath,
    log,
    fetchImpl: config.fetchImpl,
    apiKey: config.apiKey,
  })

  // ── provider registration ──────────────────────────────────────────────────
  // This is what makes the layer reachable as `session_create(provider="model-select")`.
  // The adapter is structural: `registerAdapter` validates it by calling its
  // methods, not by an instanceof test, so it imports no harness types.
  //
  // Everything a turn can do flows through the same `select()` the HTTP route
  // uses, so the two entry points cannot drift apart — the preset and the
  // situation briefing reach the model on both because `applyContext` runs
  // inside the layer, not in either adapter.
  const adapter = new ModelSelectAdapter({
    api,
    log,
    recordTurn: record => log(`model-select turn: ${record.channel}/${record.model_served} ` +
      `(${record.retries} fallback${record.retries === 1 ? '' : 's'}, ${record.elapsedMs}ms)`),
  })

  // Every registration call below returns a disposer, and the handle `apply`
  // returns promises to call one. So every handle is kept — a discarded one
  // would leave its entry behind after the adapter route is already gone.
  const disposes = []
  const disposeLater = handle => { if (typeof handle === 'function') disposes.push(handle) }

  let registration = null
  const llm = ctx?.llm
  if (llm && typeof llm.registerAdapter === 'function') {
    registration = llm.registerAdapter([PROVIDER_ROUTE], adapter)
    disposeLater(registration)
  } else {
    log('no llm runtime was offered; the layer is built but not registered as a provider')
  }

  // The settings namespace a host already holds, or the plugin name as a
  // fallback. It keys both the configurable-provider directory entry and the
  // discovery, so the picker and "detect models" must agree on one string.
  const settingsNs = ctx?.fiber?.entry?.options?.id ?? name

  // A directory entry for the picker, and a discovery for the in-app "detect
  // models" affordance. Both report the same catalog `listModels` does, so a
  // model the provider advertises is never unselectable.
  if (llm && typeof llm.registerConfigurableProviders === 'function') {
    disposeLater(llm.registerConfigurableProviders([{
      provider: PROVIDER_ROUTE,
      displayName: PROVIDER_NAME,
      settingsNs,
      settingsPath: [],
    }]))
  }
  if (llm && typeof llm.registerModelDiscovery === 'function') {
    disposeLater(llm.registerModelDiscovery(settingsNs, async () => api.models()))
  }

  // ── the patrol, only when asked for ─────────────────────────────────────────
  // `defaults.loopMs` is the switch. Left at zero the layer answers turns and
  // nothing else, which is the posture of a compat layer; set it and the plugin
  // starts dialling executors on a clock of its own.
  //
  // The clock starts lazily and after registration, so a host that registers the
  // provider and never asks for work does not get a patrol it did not order.
  // `config.inspect` supplies the inspector; the default reports nothing, and a
  // patrol that reports nothing is a timer that has learned nothing, so it stays
  // unarmed in that case rather than logging itself once per interval.
  let patrol = null
  const intervalMs = api.config.defaults?.loopMs ?? 0
  if (intervalMs > 0) {
    const inspect = typeof config.inspect === 'function' ? config.inspect : idleInspector
    patrol = api.loop(inspect)
    if (inspect !== idleInspector) patrol.start()
    else log('defaults.loopMs is set but no inspect function was offered; the patrol stays unarmed')
    disposeLater(() => patrol.stop())
  }

  // ── HTTP mounting, opportunistic ───────────────────────────────────────────
  // A host with the LLM lane but no routing table is still valid: the adapter
  // is enough for `session_create` to reach the model.
  const host = ctx?.plugin ?? ctx
  if (host && typeof host.route === 'function') {
    const handler = api.handler()
    for (const path of ['/v1/chat/completions', '/chat/completions', '/v1/models', '/models', '/health']) {
      disposeLater(host.route(path, handler))
    }
  } else if (host && typeof host.http === 'function') {
    void api.start({ host: config.host ?? '127.0.0.1', port: Number(config.port ?? 0) })
      .catch(error => log(`the listener failed to start: ${error?.message ?? error}`))
  } else {
    log('no host routing facility was found; the layer is built but not mounted')
  }

  logger?.info?.(`model-select v${api.version} ready: ${Object.keys(api.config.channels).length} channels, ` +
    `${Object.keys(api.config.pools).length} pools, provider ${PROVIDER_ROUTE}` +
    (intervalMs > 0 ? `, patrol every ${intervalMs}ms` : ', patrol unarmed'))

  return {
    api,
    adapter,
    registration,
    patrol,
    // `splice` runs first, so a second `dispose()` is a no-op.
    dispose: () => {
      for (const dispose of disposes.splice(0)) dispose()
    },
  }
}

// ── standalone runner ──────────────────────────────────────────────────────────

const IS_MAIN = typeof process !== 'undefined'
  && typeof process.argv[1] === 'string'
  && import.meta.url === pathToFileURL(process.argv[1]).href

if (IS_MAIN) {
  runCli(process.argv.slice(2)).catch(error => {
    console.error(`model-select: ${error?.message ?? error}`)
    process.exitCode = 1
  })
}

function readPackageVersion() {
  try {
    return JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version
  } catch {
    return '0.0.0'
  }
}

async function runCli(argv) {
  const option = (flag, fallback) => {
    const index = argv.indexOf(flag)
    return index === -1 || argv[index + 1] === undefined ? fallback : argv[index + 1]
  }
  const has = flag => argv.includes(flag)

  if (has('--help') || has('-h')) {
    process.stdout.write(`dsh-model-select ${version}

  node index.js --serve [--port 8787] [--host 127.0.0.1] [--key TOKEN] [--config PATH]

  /v1/chat/completions   OpenAI-compatible; \`model\` accepts "a/b,c", "__pool__:name" or a single id
  /v1/models             the channel/model roster
  /health                channels, types, pools, and live availability verdicts

  model spellings:
    "kilo/deepseek-v4.1-flash,space-bunny-free"   ordered candidates
    "__pool__:fast-free"                          a pool from config/channels.json
    "sensenova-6.8-flash-lite"                    one id: a channel key or a model id

  choosing instead of generating: add a "decision" field. The request is answered
  by a decide channel (JEV, /v1/decide) and degrades to the chat tail if none is
  dialable. The verdict comes back as the assistant's content, encoded as JSON.

    {"model": "__pool__:fast-free", "messages": [...],
     "decision": {"options": ["merge", "audit", "idle"], "criteria": "cheapest safe"}}

  when the verdict names an operation ("action" / "operation" / "choice"), the
  layer does not answer: it hands the turn to the dispatch channel that claims
  that operation and sends it there as a session. An executor that will not take
  the work degrades to the chat tail. The handover shows up as x-select-routed:
  true, and as a "dispatch" field in the response.

    {"model": "__pool__:decide", "messages": [...], "task": "合并 PR 12",
     "decision": {"options": ["merge", "audit", "idle"]}}

  so the answer does not forget the last turn:
    "task"    what the executor runs. Absent, the last user message is used.
    "preset"  a string or a list of clauses, folded in front of the messages.
    "status"  the current situation, one or more lines; absent, the layer falls
              back to its own availability cache — all it knows on its own.
`)
    return
  }

  if (!has('--serve')) {
    process.stderr.write('nothing to do. Pass --serve, or import { createModelSelect }.\n')
    return
  }

  const configPath = option('--config', undefined)
  const api = createModelSelect({
    configPath,
    log: message => process.stdout.write(`[${new Date().toISOString()}] ${message}\n`),
    apiKey: option('--key', process.env.MODEL_SELECT_API_KEY),
  })
  const { url, close } = await api.start({
    host: option('--host', '127.0.0.1'),
    port: Number(option('--port', process.env.MODEL_SELECT_PORT ?? 0)),
  })
  process.stdout.write(`model-select listening at ${url}\n`)
  process.stdout.write(`  channels: ${Object.keys(api.config.channels).join(', ')}\n`)
  process.stdout.write(`  pools:    ${Object.keys(api.config.pools).join(', ') || '(none)'}\n`)

  const stop = async () => {
    process.stdout.write('\nstopping\n')
    await close()
    process.exit(0)
  }
  process.once('SIGINT', () => void stop())
  process.once('SIGTERM', () => void stop())
}
