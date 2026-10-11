/**
 * The patrol: an unattended tick that inspects what is due and hands it to the
 * execution units that claim it.
 *
 * This is the loop half of the layer. `select` answers one turn; the patrol
 * decides what the next turn should be. It runs inside the process, on its own
 * clock, and it owns no state of its own except a memo of what it already sent —
 * because the whole point of an unattended tick is that it keeps firing while
 * nothing is watching, and a tick that re-dispatches the same pull request every
 * sixty seconds is a tick that has learned nothing.
 *
 * The patrol is deliberately small. It has four moving parts and nothing else:
 *
 *   inspect()  what is due. Injected. The layer cannot know which pull request is
 *              ready to merge or which session is stuck, so it asks.
 *   dedupe     the memo. A todo that was already handed over is not handed over
 *              again until its memo expires.
 *   dispatch   the same executor call a router verdict uses, through the same
 *              `sessionRequest`, so an execution unit cannot tell the two roads
 *              apart.
 *   guard      one patrol at a time. A tick that starts while the last one is
 *              still dialling executors is dropped, not queued, so a slow
 *              executor cannot build a backlog of the same work.
 *
 * @module src/loop.js
 */

import { CODE, SelectError } from './errors.js'
import { CHANNEL_TYPE_DISPATCH } from './channels.js'
import { sessionRequest } from './operations.js'
import { inspectContent } from './stream.js'

/** How a patrol caller may spell the thing it wants done. */
const TASK_KEYS = ['task', 'message', 'content', 'brief']
const OPERATION_KEYS = ['operation', 'op', 'route', 'session', 'target']

/**
 * One piece of work a patrol hands over.
 *
 * An inspector returns plain objects and the loop normalises them, because an
 * inspector is written by whoever has the state — a git hook, a session index, a
 * ledger — and none of them will speak this exact spelling.
 */
export function normalizeTodo(todo) {
  if (todo === null || typeof todo !== 'object' || Array.isArray(todo)) {
    return { error: 'a todo is not an object' }
  }

  let operation = undefined
  for (const key of OPERATION_KEYS) {
    if (typeof todo[key] === 'string' && todo[key].trim() !== '') {
      operation = todo[key].trim()
      break
    }
  }
  if (operation === undefined) return { error: 'no operation named' }

  let task = undefined
  for (const key of TASK_KEYS) {
    if (typeof todo[key] === 'string' && todo[key].trim() !== '') {
      task = todo[key].trim()
      break
    }
  }
  if (task === undefined) {
    return { error: `operation "${operation}" has no task to run` }
  }

  // The dedupe key. An explicit key wins — an inspector that knows a stable
  // identifier, a pull request number, should supply it, because a task string
  // that is reworded is still the same piece of work.
  const key = typeof todo.key === 'string' && todo.key.trim() !== ''
    ? todo.key.trim()
    : `${operation}\u0000${task}`

  const out = { key, operation, task }
  if (typeof todo.label === 'string' && todo.label.trim() !== '') out.label = todo.label.trim()
  if (typeof todo.status === 'string' && todo.status.trim() !== '') out.status = todo.status.trim()
  return out
}

/** The candidate a dispatch call needs, from an execution unit row. */
function candidateFor(executor) {
  return {
    channel: executor.name,
    model: executor.defaultModel,
    type: CHANNEL_TYPE_DISPATCH,
    key: `${executor.name}/${executor.defaultModel}`,
  }
}

/**
 * Build one loop.
 *
 * @param {object} args
 * @param {Function} args.inspect - `() => todo[]`; throws mean the patrol could
 *   not look, which is reported rather than retried inside the same tick.
 * @param {Function} args.dispatch - the same transport `select` dials.
 * @param {object} [args.executors] - operation → execution unit.
 * @param {(request:object)=>object} [args.compose] - the preamble step. Wired to
 *   the layer's `applyContext` so a patrol dispatch carries the same discipline
 *   and situation briefing a routed verdict does.
 * @param {number} [args.intervalMs] - the patrol period. Zero or absent means
 *   the clock never starts; `tick()` still works by hand.
 * @param {number} [args.timeoutMs] - per dispatch deadline.
 * @param {number} [args.suppressMs] - how long a success stays memoed.
 * @param {number} [args.retryAfterMs] - how soon a failure may be retried.
 * @param {Function} [args.log]
 * @param {Function} [args.now] - injectable clock, for tests.
 * @param {Function} [args.setTimeout] - injectable timer, for tests.
 * @param {Function} [args.clearTimeout]
 */
export function createLoop({
  inspect,
  dispatch,
  executors,
  compose = request => request,
  intervalMs = 0,
  timeoutMs = 60000,
  suppressMs,
  retryAfterMs,
  log = () => {},
  now = () => Date.now(),
  setTimeout: setTimeoutFn = setTimeout,
  clearTimeout: clearTimeoutFn = clearTimeout,
}) {
  if (typeof inspect !== 'function') {
    throw new SelectError('createLoop needs an inspect function', CODE.config)
  }
  if (typeof dispatch !== 'function') {
    throw new SelectError('createLoop needs a dispatch function', CODE.config)
  }

  const period = Number.isFinite(intervalMs) && intervalMs > 0 ? Math.trunc(intervalMs) : 0
  const suppressFor = Number.isFinite(suppressMs) && suppressMs > 0 ? Math.trunc(suppressMs) : period * 10 || 600000
  const retryAfter = Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? Math.trunc(retryAfterMs) : period || 60000

  /** todo key → the memo for it. */
  const seen = new Map()

  let busy = false
  let running = false
  let timer = null
  let last = null
  const counters = { patrols: 0, dispatched: 0, deduped: 0, failed: 0, skipped: 0 }

  const ttlOf = state => (state === 'failed' ? retryAfter : suppressFor)

  const prune = (at) => {
    for (const [key, memo] of seen) {
      if (at - memo.at >= ttlOf(memo.state)) seen.delete(key)
    }
  }

  /**
   * One patrol: inspect, dedupe, dispatch each new piece of work.
   *
   * Serial on purpose — an execution unit is a session, and a session that gets
   * two tasks at once is a session that answers neither well. A patrol that is
   * still running when the next one is due is dropped, so a slow executor
   * stretches the period rather than stacking copies of the same task.
   *
   * Never throws. A patrol that throws would kill the timer chain and leave the
   * layer looking healthy while nothing is being done, which is the failure this
   * piece of code exists to prevent.
   *
   * @returns {object} an audit record of the tick
   */
  async function tick() {
    const started = now()

    if (busy) {
      counters.skipped += 1
      const record = { ok: false, skipped: 'busy', at: started, elapsedMs: 0 }
      log('patrol skipped: the last one is still running')
      last = record
      return record
    }

    busy = true
    const record = {
      ok: true,
      at: started,
      dispatched: [],
      deduped: [],
      skipped: [],
      failed: [],
      error: undefined,
    }

    try {
      prune(started)

      let todos
      try {
        todos = await inspect()
      } catch (error) {
        record.ok = false
        record.error = String(error?.message ?? error)
        log(`patrol could not inspect: ${record.error}`)
        return record
      }

      for (const todo of Array.isArray(todos) ? todos : []) {
        const result = normalizeTodo(todo)
        if (result.error !== undefined) {
          record.skipped.push({ todo: { ...todo }, reason: result.error })
          counters.skipped += 1
          log(`patrol skipped a malformed todo: ${result.error}`)
          continue
        }

        const { key, operation, task, label, status } = result

        const memo = seen.get(key)
        if (memo !== undefined) {
          const entry = { key, operation, state: memo.state, ageMs: started - memo.at }
          record.deduped.push(entry)
          counters.deduped += 1
          log(`patrol held ${operation} "${key}" (${memo.state}, ${entry.ageMs}ms ago)`)
          continue
        }

        const executor = executors?.[operation]
        if (executor === undefined) {
          // No execution unit claims this operation. Memo it anyway, so the
          // patrol does not log the same missing executor on every tick.
          seen.set(key, { at: started, state: 'unclaimed', operation })
          const entry = { key, operation, reason: 'no execution unit claims it' }
          record.skipped.push(entry)
          counters.skipped += 1
          log(`patrol dropped ${operation} "${key}": no execution unit claims it`)
          continue
        }

        const request = compose({
          messages: [{ role: 'user', content: task }],
          label,
          status,
        })
        const candidate = candidateFor(executor)
        const at = now()
        try {
          // No caller signal: a patrol has no user to cancel it. The deadline
          // is the only thing that can stop a dial.
          const response = await dispatch(candidate, sessionRequest(executor, request), {
            stream: false,
            timeoutMs,
          })
          if (inspectContent(response.json ?? {}).ok !== true) {
            throw new SelectError('the execution unit answered with nothing', CODE.empty, {
              channel: executor.name,
              model: executor.defaultModel,
            })
          }
          seen.set(key, { at: now(), state: 'done', operation, executor: executor.name })
          const entry = {
            key,
            operation,
            executor: executor.name,
            session: executor.session ?? executor.name,
            elapsedMs: now() - at,
          }
          record.dispatched.push(entry)
          counters.dispatched += 1
          log(`patrol sent ${operation} "${key}" to ${executor.name} (${entry.elapsedMs}ms)`)
        } catch (error) {
          const code = error instanceof SelectError ? error.code : CODE.server
          seen.set(key, { at: now(), state: 'failed', operation, executor: executor.name })
          const entry = {
            key,
            operation,
            executor: executor.name,
            code,
            message: String(error?.message ?? error),
            elapsedMs: now() - at,
            retryAfterMs: retryAfter,
          }
          record.failed.push(entry)
          counters.failed += 1
          log(`patrol could not send ${operation} "${key}" to ${executor.name} (${code}); retrying in ${retryAfter}ms`)
        }
      }
    } finally {
      busy = false
      record.elapsedMs = now() - started
      counters.patrols += 1
      last = record
    }

    return record
  }

  /** Arm the clock. Idempotent, and a no-op when no period is configured. */
  function start() {
    if (running) return status()
    if (period <= 0) {
      log('the patrol has no interval; set defaults.loopMs or call tick() by hand')
      return status()
    }
    running = true
    const arm = () => {
      timer = setTimeoutFn(() => {
        timer = null
        // Scheduled from the end of the previous patrol, not from a fixed
        // lattice: a slow executor lengthens the period instead of stacking
        // ticks on top of the one still running.
        void tick().then(() => { if (running) arm() })
      }, period)
    }
    arm()
    log(`patrol armed: every ${period}ms`)
    return status()
  }

  /** Disarm the clock. Idempotent. A patrol in flight runs to completion. */
  function stop() {
    if (timer !== null) {
      clearTimeoutFn(timer)
      timer = null
    }
    running = false
    return status()
  }

  function status() {
    return {
      running,
      busy,
      intervalMs: period,
      suppressMs: suppressFor,
      retryAfterMs: retryAfter,
      patrols: counters.patrols,
      dispatched: counters.dispatched,
      deduped: counters.deduped,
      failed: counters.failed,
      skipped: counters.skipped,
      memoed: seen.size,
      last,
    }
  }

  return {
    tick,
    /** One patrol, named for the thing it does. */
    patrol: tick,
    start,
    stop,
    status,
    get running() { return running },
    get busy() { return busy },
  }
}

/**
 * The inspector the layer ships.
 *
 * It reports nothing, on purpose. The layer has no git remote, no session index
 * and no ledger, so any todo it invented would be a guess. An operator who gives
 * it state gets a patrol; an operator who does not gets a quiet timer.
 *
 * @returns {Promise<never[]>}
 */
export async function idleInspector() {
  return []
}
