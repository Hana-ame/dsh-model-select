/**
 * The routing step: a verdict is not an answer, it is a decision about which
 * execution unit does the work.
 *
 * Everything in this file is reachable from two directions, and that is the
 * point. The HTTP handler calls it to write an OpenAI-shaped response, and the
 * provider adapter calls it to yield a chunk stream. When routing lived inside
 * `serveCompletion` it could only be reached over HTTP, which meant a turn that
 * entered through the provider got the router's verdict as its answer instead of
 * the work being done.
 *
 * `routeTurn` is the whole walk — compose, resolve, select, route, degrade — and
 * `routeDecision` is the single handover inside it.
 *
 * @module src/routing.js
 */

import { CODE, SelectError } from './errors.js'
import { CHANNEL_TYPE_DECIDE, CHANNEL_TYPE_DISPATCH } from './channels.js'
import { resolveCandidates } from './spec.js'
import { pickCandidate } from './selection.js'
import { detectIntent, INTENT_DECIDE } from './intent.js'
import { select } from './select.js'
import { applyContext } from './context.js'
import { executorIndex, operationFromVerdict, sessionRequest } from './operations.js'
import { inspectContent } from './stream.js'

/**
 * Hand a verdict to the execution unit that claims it.
 *
 * The return is a small tagged union:
 *
 *   - `null`            the verdict carried no operation, so it stands as the answer
 *   - `{kind:'dispatched', ...}`  an execution unit did the work
 *   - `{kind:'degrade', ...}`     nobody could do it; the generation tail takes the turn
 *
 * It never throws. An execution unit that will not take the work is a reason to
 * degrade, never a reason to lose the router's answer.
 *
 * @param {object} args
 * @param {object} args.outcome - the decide outcome, with `response.json.decision`
 * @param {object} args.request - the request the verdict came from
 * @param {object} args.executors - operation → execution unit
 * @param {Function} args.dispatch - the transport
 * @param {(message: string) => void} [args.log]
 * @param {number} [args.timeoutMs]
 * @param {AbortSignal} [args.signal]
 * @returns {Promise<null|object>}
 */
export async function routeDecision({ outcome, request, executors, dispatch, log = () => {}, timeoutMs = 60000, signal }) {
  const verdict = outcome.response?.json?.decision ?? {}
  const operation = operationFromVerdict(verdict)
  if (operation === undefined) {
    // Nothing was picked: the router gave a verdict with no operation in it.
    // That verdict is the answer — there is nothing to hand over, and the
    // generation tail has nothing new to be asked.
    log('the router gave a verdict with no operation in it; the verdict stands')
    return null
  }

  const executor = executors?.[operation]
  if (executor === undefined) {
    // An operation the router picked and nobody claims: the caller asked for
    // work to be done, and it cannot be done here, so the tail takes the turn
    // and the choice stays in the body as the reason.
    log(`the router picked "${operation}", which no execution unit claims; degrading to the generation tail`)
    return { kind: 'degrade', operation, verdict, reason: 'no_executor' }
  }

  const started = Date.now()
  const attempt = {
    channel: executor.name,
    model: executor.defaultModel,
    type: CHANNEL_TYPE_DISPATCH,
    key: `${executor.name}/${executor.defaultModel}`,
  }
  try {
    const response = await dispatch(attempt, sessionRequest(executor, request), { signal, stream: false, timeoutMs })
    // An executor that answers with nothing has not done the work, so it is a
    // reason to degrade rather than a completion to return.
    if (inspectContent(response.json ?? {}).ok !== true) {
      log(`dispatch to ${executor.name} answered with nothing; degrading to the generation tail`)
      return { kind: 'degrade', operation, executor, verdict, reason: CODE.empty }
    }
    return {
      kind: 'dispatched',
      operation,
      executor,
      verdict,
      response,
      elapsedMs: Date.now() - started,
    }
  } catch (error) {
    const reason = error instanceof SelectError ? error.code : CODE.server
    log(`dispatch to ${executor.name} will not take "${operation}" (${reason}); degrading to the generation tail`)
    return { kind: 'degrade', operation, executor, verdict, reason }
  }
}

/**
 * One turn, end to end, with nothing written to any response.
 *
 *   1. compose — the preset and the situation briefing fold into `messages`
 *   2. resolve — the `model` field becomes an ordered candidate list
 *   3. pick    — a `choice` or `selection` number locks one lane, and the
 *                fallback walk runs on that lane alone
 *   4. select  — fall back over the chain
 *   5. route   — a verdict from a decide channel goes to its execution unit
 *   6. degrade — an executor that will not take the work sends the tail over the
 *                same chain, minus the decide channels
 *
 * Steps 4 and 6 are the same walk: same request, same timeout, same attempt cap,
 * same signal. A degradation is not a second turn.
 *
 * Resolution failures throw, because the caller has to decide what an
 * unresolvable model is worth reporting; routing failures degrade instead,
 * because a handover that does not happen is not the end of the turn.
 *
 * @param {object} args
 * @param {object} args.request - the request, as the caller sent it
 * @param {object} args.config - the validated channel table
 * @param {object} [args.availability] - the cache
 * @param {Function} args.dispatch - the transport
 * @param {object} [args.executors] - operation → execution unit
 * @param {object} [args.defaults]
 * @param {(message: string) => void} [args.log]
 * @param {AbortSignal} [args.signal]
 * @param {number} [args.timeoutMs]
 * @param {number} [args.maxAttempts]
 * @param {Function} [args.select] - injectable, for tests
 * @param {Function} [args.resolve] - injectable candidate resolver
 * @returns {Promise<{intent:string, menu:Array<object>, candidates:Array<object>, picked:null|object, outcome:object, routed:null|object}>}
 *   `menu` is the resolved list as the model field asked for it; `candidates` is
 *   what was actually walked, which is one lane when a menu number was dialed.
 *   Keeping both is what lets a caller tell "one candidate" from "the whole pool
 *   happened to resolve to one".
 */
export async function routeTurn({
  request,
  config,
  availability,
  dispatch,
  executors,
  defaults = {},
  log = () => {},
  signal,
  timeoutMs,
  maxAttempts,
  select: selectImpl = select,
  resolve,
}) {
  if (!config?.channels) throw new SelectError('routeTurn needs a channel table', CODE.config)
  if (typeof dispatch !== 'function') throw new SelectError('routeTurn needs a dispatch function', CODE.config)

  const composed = applyContext(request, { config, availability })
  const intent = detectIntent(composed)

  const resolveCandidatesHere = resolve ?? ((spec) => resolveCandidates(spec, {
    config,
    availability,
    intent,
    defaults: config.defaults,
  }))

  const runSelect = (candidateList) => selectImpl(candidateList, composed, {
    dispatch,
    availability,
    signal,
    timeoutMs,
    maxAttempts,
    log,
  })

  // Resolve first, then pick. A menu number indexes a list that does not exist
  // until the model field is resolved, so the pick cannot happen earlier — and
  // doing it after keeps `resolveCandidates` pure, reading only the table and
  // the cache, with no knowledge of what a caller typed into a menu field.
  let menu
  let candidates
  let picked = null
  try {
    menu = resolveCandidatesHere(composed?.model, composed)
    const selection = pickCandidate(menu, composed)
    candidates = selection.candidates
    picked = selection.picked
    if (picked !== null) {
      log(`menu: candidate ${picked.index} of ${picked.total} dialed by ${picked.field} -> ${picked.key}`)
    }
  } catch (error) {
    if (error instanceof SelectError) throw error
    throw new SelectError(String(error?.message ?? error), CODE.config)
  }

  let outcome = await runSelect(candidates)
  let routed = null

  if (outcome.ok && intent === INTENT_DECIDE && outcome.type === CHANNEL_TYPE_DECIDE) {
    routed = await routeDecision({ outcome, request: composed, executors, dispatch, log, timeoutMs, signal })
    if (routed?.kind === 'degrade') {
      // The tail comes from the menu, not from the walked list. A caller who
      // dialled one lane got one lane, but a verdict the router gave them still
      // has to reach an execution unit — the degrade is how it does, and a
      // truncated list would leave it nowhere to go.
      const tail = menu.filter(candidate => candidate.type !== CHANNEL_TYPE_DECIDE)
      if (tail.length > 0) outcome = await runSelect(tail)
    }
  }

  return { intent, menu, candidates, picked, outcome, routed }
}
