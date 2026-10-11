/**
 * The patrol.
 *
 * Everything here runs on an injected clock and an injected timer, so a test
 * covers a whole lifetime of patrols in microseconds: to a tick the period is a
 * number, and nothing in the loop knows whether it came from a wall clock or a
 * test. The fake executor records what it was sent, so the assertions are about
 * what went out the door, not about what the patrol intended to do.
 *
 * The three things that matter most are the guards: a patrol that re-dispatches
 * the same work every tick, a patrol that stacks on the one still running, and a
 * patrol that dies because one execution unit did not take its work.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { createLoop, normalizeTodo, idleInspector } from '../src/loop.js'
import { validateConfig } from '../src/channels.js'
import { CODE } from '../src/errors.js'
import { createModelSelect } from '../index.js'
import { okJson, makeConfig } from './helpers.js'

function caught(fn) {
  try {
    fn()
  } catch (error) {
    return error
  }
  throw new Error('expected a throw')
}

// ── fixtures ───────────────────────────────────────────────────────────────────

const EXECUTORS = {
  merge: { name: 'merge-runner', defaultModel: 'mr-1', session: 'merge-runner' },
  triage: { name: 'triage-runner', defaultModel: 'tr-1', session: 'triage-runner' },
  audit: { name: 'audit-runner', defaultModel: 'au-1', session: 'audit-runner' },
  ingest: { name: 'ingest-runner', defaultModel: 'ig-1', session: 'ingest-runner' },
}

/**
 * Arm a loop on a clock the test owns.
 *
 * `fire()` runs every armed timer once and lets the patrol's trailing re-arm
 * settle, so one call to it is one full period.
 */
function armed(overrides = {}) {
  let clock = 0
  const due = []
  const logs = []
  const calls = []
  let todos = overrides.todos ?? []

  /**
   * Wait for the patrol the timers just started to finish.
   *
   * The timer callback fires the patrol and forgets about it, so a test cannot
   * await it directly. `busy` is the truth about whether it has, which is also
   * the guard a caller sees, so this is an honest way to wait.
   */
  async function settle() {
    for (let i = 0; i < 10000 && loop.status().busy; i += 1) await Promise.resolve()
    // The patrol re-arms itself in a .then that runs after busy goes false.
    await Promise.resolve()
    await Promise.resolve()
  }

  /** Run the armed timers without waiting for the patrols they start. */
  function runDue() {
    const timers = due.splice(0, due.length)
    for (const entry of timers) entry.fn()
    return timers.length
  }

  /** Run every armed timer once, wait for it, and let the trailing re-arm settle. */
  async function fire(times = 1) {
    for (let i = 0; i < times; i += 1) {
      const timers = due.splice(0, due.length)
      if (timers.length === 0) break
      for (const entry of timers) entry.fn()
      await settle()
      await Promise.resolve()
    }
  }

  /**
   * Every dispatch is recorded, whatever produced the answer. The transport is
   * only where the answer comes from, so a test that overrides it still gets to
   * count what went out the door.
   */
  async function dispatch(candidate, request, opts) {
    const at = calls.length
    calls.push({ at, candidate, request, opts })
    const step = overrides.steps?.[at] ?? overrides.steps?.[overrides.steps.length - 1]
    let out
    if (typeof overrides.dispatch === 'function') out = await overrides.dispatch(candidate, request)
    else if (step !== undefined) out = typeof step === 'function' ? await step(candidate, request) : step
    else out = okJson(candidate.model, 'done')
    if (out instanceof Error) throw out
    if (out && typeof out === 'object' && out.throw !== undefined) throw out.throw
    return out
  }

  const loop = createLoop({
    inspect: overrides.inspect ?? (async () => todos),
    dispatch,
    executors: overrides.executors ?? EXECUTORS,
    compose: overrides.compose,
    intervalMs: overrides.intervalMs ?? 60000,
    timeoutMs: overrides.timeoutMs ?? 60000,
    suppressMs: overrides.suppressMs,
    retryAfterMs: overrides.retryAfterMs,
    log: message => logs.push(message),
    now: () => clock,
    setTimeout: (fn, ms) => { due.push({ fn, ms }); return due.length },
    clearTimeout: () => { due.splice(0, due.length) },
  })

  const api = {
    loop,
    calls,
    logs,
    due,
    get clock() { return clock },
    advance(ms) { clock += ms },
    todos: () => todos,
    setTodos(value) { todos = value },
    settle,
    runDue,
    fire,
  }
  return api
}

// ── construction ───────────────────────────────────────────────────────────────

test('a patrol needs an inspector and a transport', () => {
  assert.equal(caught(() => createLoop({ dispatch: async () => {} })).code, CODE.config)
  assert.equal(caught(() => createLoop({ inspect: async () => [] })).code, CODE.config)
})

test('the shipped inspector reports nothing, because the layer has no state to report from', async () => {
  assert.deepEqual(await idleInspector(), [])

  const world = armed({ intervalMs: 0 })
  await world.loop.tick()
  const status = world.loop.status()
  assert.equal(status.patrols, 1)
  assert.equal(status.dispatched, 0)
  assert.equal(status.running, false)
})

// ── one patrol ─────────────────────────────────────────────────────────────────

test('a patrol hands each todo to the executor that claims its operation', async () => {
  const world = armed({
    todos: [
      { operation: 'merge', task: 'merge PR #42' },
      { operation: 'triage', task: 'triage the stuck session' },
      { operation: 'audit', task: 'settle the ledger' },
      { operation: 'ingest', task: 'land the note' },
    ],
  })

  const record = await world.loop.tick()

  assert.equal(record.ok, true)
  assert.equal(record.dispatched.length, 4)
  assert.deepEqual(
    record.dispatched.map(entry => entry.executor),
    ['merge-runner', 'triage-runner', 'audit-runner', 'ingest-runner'],
  )
  assert.deepEqual(
    world.calls.map(call => call.candidate.channel),
    ['merge-runner', 'triage-runner', 'audit-runner', 'ingest-runner'],
  )
  assert.equal(world.calls[0].candidate.model, 'mr-1')
  assert.equal(world.calls[2].candidate.type, 'dispatch')
})

test('a patrol dispatches serially, in the order the inspector reported them', async () => {
  const order = []
  const slow = async (candidate, request) => {
    order.push(candidate.channel)
    return okJson(candidate.model, 'ok')
  }
  const world = armed({
    dispatch: slow,
    todos: [
      { operation: 'audit', task: 'second reported, first done' },
      { operation: 'merge', task: 'first reported' },
    ],
  })

  await world.loop.tick()
  assert.deepEqual(world.calls.map(call => call.at), [0, 1])
  assert.deepEqual(order, ['audit-runner', 'merge-runner'])
})

test('the dispatch body is the session shape the verdict road uses, with the discipline in it', async () => {
  const config = makeConfigWithPreset()
  const api = createModelSelect({ config })
  const world = armed({
    compose: request => api.withContext(request),
    todos: [{ operation: 'merge', task: 'merge PR #42', label: 'patrol-42', status: 'merge window open' }],
  })

  await world.loop.tick()
  const { request, opts } = world.calls[0]

  assert.equal(request.model, 'mr-1')
  assert.equal(request.session, 'merge-runner')
  assert.equal(request.temperature, undefined)
  assert.equal(request.label, 'patrol-42')
  assert.deepEqual(request.messages, [{ role: 'user', content: 'merge PR #42' }])
  assert.equal(opts.stream, false)
  assert.equal(opts.timeoutMs, 60000)

  // The discipline and the situation, one system message, folded once.
  const context = request.context
  assert.ok(Array.isArray(context) && context.length > 0)
  const system = context[0]
  assert.equal(system.role, 'system')
  assert.match(system.content, /【预设 · 行为纪律】/)
  assert.match(system.content, /merge window open/)
  assert.match(system.content, /【近况说明 · 当前状态】/)
  assert.ok(system.content.indexOf('【预设 · 行为纪律】') === 0)
  assert.equal((system.content.match(/【预设 · 行为纪律】/g) || []).length, 1)
})

// ── dedupe ─────────────────────────────────────────────────────────────────────

test('the same todo is not dispatched twice inside its memo', async () => {
  const world = armed({
    intervalMs: 60000,
    suppressMs: 600000,
    todos: [{ operation: 'merge', task: 'merge PR #42' }],
  })

  await world.loop.tick()
  world.advance(120000)
  const second = await world.loop.tick()

  assert.equal(world.calls.length, 1)
  assert.equal(second.dispatched.length, 0)
  assert.equal(second.deduped.length, 1)
  assert.equal(second.deduped[0].state, 'done')
  assert.equal(second.deduped[0].ageMs, 120000)
  assert.match(world.logs.join('\n'), /held merge/)
})

test('a memo expires, so the same work can be done again', async () => {
  const world = armed({
    intervalMs: 60000,
    suppressMs: 60000,
    todos: [{ operation: 'merge', task: 'merge PR #42' }],
  })

  await world.loop.tick()
  world.advance(60001)
  const again = await world.loop.tick()

  assert.equal(world.calls.length, 2)
  assert.equal(again.dispatched.length, 1)
  assert.equal(world.loop.status().deduped, 0)
})

test('a failure is retried after retryAfterMs while a success stays memoed', async () => {
  const world = armed({
    intervalMs: 60000,
    suppressMs: 3600000,
    retryAfterMs: 60000,
    steps: [okJson('tr-1', 'triaged'), { throw: new Error('merge-runner refused') }, okJson('mr-1', 'retried')],
    todos: [
      { operation: 'triage', task: 'triage the stuck session' },
      { operation: 'merge', task: 'merge PR #42' },
    ],
  })

  const first = await world.loop.tick()
  assert.equal(first.dispatched.length, 1)
  assert.equal(first.dispatched[0].executor, 'triage-runner')
  assert.equal(first.failed.length, 1)
  assert.equal(first.failed[0].code, 'SERVER')
  assert.equal(first.failed[0].executor, 'merge-runner')
  assert.equal(first.failed[0].retryAfterMs, 60000)

  // One period later: the success is still memoed, the failure is not.
  world.advance(60001)
  const retry = await world.loop.tick()
  assert.equal(world.calls.length, 3)
  assert.equal(retry.dispatched.length, 1)
  assert.equal(retry.dispatched[0].executor, 'merge-runner')
  assert.equal(retry.deduped.length, 1)
  assert.equal(retry.deduped[0].state, 'done')
  assert.equal(retry.failed.length, 0)
})

test('a failure memo expires before a success memo', async () => {
  const world = armed({
    intervalMs: 60000,
    suppressMs: 3600000,
    retryAfterMs: 60000,
    steps: [{ throw: new Error('refused') }, okJson('mr-1', 'now it takes it')],
    todos: [{ operation: 'merge', task: 'merge PR #42' }],
  })

  await world.loop.tick()
  world.advance(3600001) // far past both windows
  await world.loop.tick()
  assert.equal(world.calls.length, 2)
})

test('an explicit key wins over the derived one, so reworded work is still the same work', async () => {
  const world = armed({
    suppressMs: 600000,
    todos: [{ operation: 'merge', task: 'merge PR #42', key: 'pr:42' }],
  })
  await world.loop.tick()

  world.setTodos([{ operation: 'merge', task: 'please merge PR #42 again', key: 'pr:42' }])
  const second = await world.loop.tick()

  assert.equal(world.calls.length, 1)
  assert.equal(second.deduped[0].key, 'pr:42')
})

// ── the guards ─────────────────────────────────────────────────────────────────

test('an unknown operation is skipped and memoed, never a throw', async () => {
  const world = armed({
    suppressMs: 600000,
    todos: [{ operation: 'release', task: 'cut the release' }],
  })

  const record = await world.loop.tick()

  assert.equal(record.ok, true)
  assert.equal(world.calls.length, 0)
  assert.equal(record.skipped.length, 1)
  assert.equal(record.skipped[0].reason, 'no execution unit claims it')
  assert.match(world.logs.join('\n'), /no execution unit claims it/)

  // Memoed as unclaimed, so the patrol does not re-report it every tick.
  world.advance(1000)
  const again = await world.loop.tick()
  assert.equal(again.skipped.length, 0)
  assert.equal(again.deduped.length, 1)
  assert.equal(again.deduped[0].state, 'unclaimed')
})

test('a malformed todo is skipped with a reason and does not stop the patrol', async () => {
  const world = armed({
    todos: [
      null,
      'a string',
      { operation: 'merge' },
      { task: 'no operation named' },
      { operation: 'merge', task: 'a real task' },
    ],
  })

  const record = await world.loop.tick()

  assert.equal(record.ok, true)
  assert.equal(record.skipped.length, 4)
  assert.match(record.skipped[0].reason, /not an object/)
  assert.match(record.skipped[2].reason, /no task to run/)
  assert.match(record.skipped[3].reason, /no operation named/)
  assert.equal(record.dispatched.length, 1)
  assert.equal(world.calls.length, 1)
})

test('one executor refusing does not cost the other todos', async () => {
  const world = armed({
    steps: [
      { throw: new Error('merge-runner is down') },
      okJson('tr-1', 'triaged'),
    ],
    todos: [
      { operation: 'merge', task: 'merge PR #42' },
      { operation: 'triage', task: 'triage the stuck session' },
    ],
  })

  const record = await world.loop.tick()

  assert.equal(record.ok, true)
  assert.equal(record.failed.length, 1)
  assert.equal(record.failed[0].code, 'SERVER')
  assert.equal(record.dispatched.length, 1)
  assert.equal(record.dispatched[0].executor, 'triage-runner')
  assert.equal(world.calls.length, 2)
  assert.match(world.logs.join('\n'), /could not send merge/)
})

test('an executor that answers with nothing has not done the work', async () => {
  const empty = {
    statusCode: 200,
    headers: {},
    stream: false,
    json: { id: 'x', model: 'mr-1', choices: [{ message: { role: 'assistant', content: '' }, finish_reason: 'stop' }] },
  }
  const world = armed({
    steps: [empty],
    todos: [{ operation: 'merge', task: 'merge PR #42' }],
  })

  const record = await world.loop.tick()
  assert.equal(record.failed.length, 1)
  assert.equal(record.failed[0].code, CODE.empty)
  assert.match(record.failed[0].message, /nothing/)
})

test('an inspector that throws is reported, never a dead timer', async () => {
  const world = armed({
    inspect: async () => {
      throw new Error('git is not configured')
    },
  })

  const record = await world.loop.tick()

  assert.equal(record.ok, false)
  assert.match(record.error, /git is not configured/)
  assert.equal(record.dispatched.length, 0)
  assert.equal(world.loop.status().busy, false)
  assert.match(world.logs.join('\n'), /could not inspect/)
})

test('a second patrol while the first is still running is dropped, not queued', async () => {
  let release
  const gate = () => new Promise(resolve => { release = resolve })
  const waiting = gate()

  const slowDispatch = async candidate => {
    await waiting
    return okJson(candidate.model, 'slow')
  }
  const world = armed({
    dispatch: slowDispatch,
    todos: [{ operation: 'merge', task: 'merge PR #42' }],
  })

  const first = world.loop.tick()
  assert.equal(world.loop.status().busy, true)

  // The clock ticks again while the first patrol is still dialling.
  const skipped = await world.loop.tick()
  assert.deepEqual(skipped, { ok: false, skipped: 'busy', at: 0, elapsedMs: 0 })

  release()
  const record = await first
  assert.equal(record.dispatched.length, 1)
  assert.equal(world.calls.length, 1)
  assert.equal(world.loop.status().busy, false)
  assert.match(world.logs.join('\n'), /skipped: the last one is still running/)
})

// ── the clock ──────────────────────────────────────────────────────────────────

test('start arms one timer per period, and the period trails the patrol', async () => {
  const world = armed({
    intervalMs: 60000,
    todos: [{ operation: 'merge', task: 'merge PR #42' }, { operation: 'triage', task: 'stuck' }],
  })

  world.loop.start()
  assert.equal(world.loop.status().running, true)
  assert.equal(world.loop.status().patrols, 0)

  await world.fire(1)
  assert.equal(world.loop.status().patrols, 1)
  assert.equal(world.calls.length, 2)

  // The same todos in the next period are memoed, not re-dispatched.
  await world.fire(1)
  assert.equal(world.loop.status().patrols, 2)
  assert.equal(world.calls.length, 2)
})

test('a slow patrol stretches the period instead of stacking ticks', async () => {
  let release
  const waiting = new Promise(resolve => { release = resolve })

  const world = armed({
    intervalMs: 60000,
    dispatch: async candidate => { await waiting; return okJson(candidate.model, 'slow') },
    todos: [{ operation: 'merge', task: 'merge PR #42' }],
  })

  world.loop.start()
  assert.equal(world.due.length, 1, 'one timer armed at start')

  world.runDue()
  assert.equal(world.loop.status().busy, true)
  assert.equal(world.due.length, 0, 'nothing is stacked on top of a running patrol')

  // The clock moves; no timer fires, because the last patrol has not returned.
  world.advance(60000)
  assert.equal(world.due.length, 0)
  assert.equal(world.loop.status().patrols, 0)

  release()
  await world.settle()
  assert.equal(world.loop.status().patrols, 1)
  assert.equal(world.due.length, 1, 'the next period is armed from the end of the patrol')

  world.runDue()
  await world.settle()
  assert.equal(world.loop.status().patrols, 2)
})

test('a zero period stays unarmed and still answers a hand tick', async () => {
  const world = armed({ intervalMs: 0, todos: [{ operation: 'merge', task: 'merge PR #42' }] })

  const status = world.loop.start()
  assert.equal(status.running, false)
  assert.match(world.logs.join('\n'), /no interval/)

  await world.loop.tick()
  assert.equal(world.calls.length, 1)
  assert.equal(world.loop.status().running, false)
})

test('stop disarms the clock and is idempotent', async () => {
  const world = armed({ intervalMs: 60000, todos: [{ operation: 'merge', task: 'merge PR #42' }] })

  world.loop.start()
  world.loop.stop()
  assert.equal(world.loop.status().running, false)

  await world.fire(3)
  assert.equal(world.loop.status().patrols, 0)
  assert.equal(world.calls.length, 0)

  const again = world.loop.stop()
  assert.equal(again.running, false)
})

test('status reports the running totals a caller can audit', async () => {
  const world = armed({
    suppressMs: 600000,
    todos: [
      { operation: 'merge', task: 'merge PR #42' },
      { operation: 'release', task: 'cut it' },
      'not an object',
    ],
  })

  await world.loop.tick()
  await world.loop.tick()

  const status = world.loop.status()
  assert.equal(status.intervalMs, 60000)
  assert.equal(status.suppressMs, 600000)
  assert.equal(status.retryAfterMs, 60000)
  assert.equal(status.patrols, 2)
  assert.equal(status.dispatched, 1)
  // First patrol memoed both; the second deduped both. The malformed todo is
  // skipped on every patrol, so it counts twice.
  assert.equal(status.deduped, 2)
  assert.equal(status.skipped, 3)
  assert.equal(status.memoed, 2)
  assert.equal(status.busy, false)
  assert.equal(status.last.dispatched.length, 0)
})

// ── todo spellings ─────────────────────────────────────────────────────────────

for (const [label, todo] of [
  ['the task field', { operation: 'merge', task: 'merge #42' }],
  ['a message', { operation: 'merge', message: 'merge #42' }],
  ['a brief', { operation: 'merge', brief: 'merge #42' }],
  ['an op spelling', { op: 'merge', task: 'merge #42' }],
  ['a target spelling', { target: 'merge', task: 'merge #42' }],
]) {
  test(`${label} is normalised to the loop's shape`, () => {
    const out = normalizeTodo(todo)
    assert.equal(out.error, undefined)
    assert.equal(out.operation, 'merge')
    assert.equal(out.task, 'merge #42')
    assert.equal(out.key, 'merge\u0000merge #42')
  })
}

test('a todo needs both an operation and something to run', () => {
  assert.equal(normalizeTodo(null).error, 'a todo is not an object')
  assert.equal(normalizeTodo(42).error, 'a todo is not an object')
  assert.equal(normalizeTodo({ task: 'merge #42' }).error, 'no operation named')
  assert.equal(normalizeTodo({ operation: 'merge' }).error, 'operation "merge" has no task to run')
  assert.equal(normalizeTodo({ operation: '  ', task: 'blank' }).error, 'no operation named')
  assert.equal(normalizeTodo({ operation: 'merge', task: '   ' }).error, 'operation "merge" has no task to run')
})

test('a label and a status ride along only when they are real', () => {
  assert.deepEqual(
    normalizeTodo({ operation: 'merge', task: 'merge #42', label: '  patrol  ', status: '  window open  ' }),
    { key: 'merge\u0000merge #42', operation: 'merge', task: 'merge #42', label: 'patrol', status: 'window open' },
  )
  const bare = normalizeTodo({ operation: 'merge', task: 'merge #42', label: 7, status: [] })
  assert.equal(bare.label, undefined)
  assert.equal(bare.status, undefined)
})

// ── config ─────────────────────────────────────────────────────────────────────

test('defaults.loopMs defaults to disabled, and a value is checked', () => {
  const base = {
    version: 1,
    defaults: {},
    channels: { kilo: { baseUrl: 'http://127.0.0.1:1', defaultModel: 'k', models: ['k'] } },
    pools: {},
  }
  assert.equal(validateConfig({ ...base }, [], '<t>').defaults.loopMs, 0)
  assert.equal(validateConfig({ ...base, defaults: { loopMs: 0 } }, [], '<t>').defaults.loopMs, 0)
  assert.equal(validateConfig({ ...base, defaults: { loopMs: 60000 } }, [], '<t>').defaults.loopMs, 60000)
  assert.equal(validateConfig({ ...base, defaults: { loopMs: '60000' } }, [], '<t>').defaults.loopMs, 60000)

  for (const bad of [-1, 1.5, 'soon']) {
    const error = (() => {
      try {
        validateConfig({ ...base, defaults: { loopMs: bad } }, [], '<t>')
      } catch (thrown) {
        return thrown
      }
      return null
    })()
    assert.equal(error?.code, CODE.config)
    assert.match(error.message, /loopMs/)
  }
})

// ── the layer ──────────────────────────────────────────────────────────────────

function makeConfigWithPreset() {
  return validateConfig({
    version: 1,
    defaults: {
      timeoutMs: 5000,
      availabilityTtlMs: 60000,
      maxAttempts: 4,
      loopMs: 60000,
      fallbackPool: 'fast-free',
      preset: ['one discipline line'],
    },
    channels: {
      kilo: { baseUrl: 'http://127.0.0.1:1', defaultModel: 'kilo-flash', models: ['kilo-flash'] },
      'merge-runner': {
        type: 'dispatch',
        baseUrl: 'http://127.0.0.1:9',
        path: 'chat/completions',
        defaultModel: 'mr-1',
        models: ['mr-1'],
        session: 'merge-runner',
        operations: ['merge'],
        dispatchBody: { stream: false },
      },
    },
    pools: { 'fast-free': ['kilo'] },
  }, [], '<test>')
}

test('api.loop builds a patrol wired to the layer composition and the layer executors', async () => {
  const config = makeConfigWithPreset()
  const calls = []
  const api = createModelSelect({
    config,
    dispatch: async (candidate, request, opts) => {
      calls.push({ candidate, request, opts })
      return okJson(candidate.model, 'done')
    },
  })

  assert.deepEqual(Object.keys(api.executors), ['merge'])
  const loop = api.loop(async () => [{ operation: 'merge', task: 'merge PR #42' }])

  await loop.tick()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].candidate.channel, 'merge-runner')
  assert.match(calls[0].request.context[0].content, /one discipline line/)

  const status = loop.status()
  assert.equal(status.intervalMs, 60000)
  assert.equal(status.dispatched, 1)
})

test('apply arms the patrol only when a period and an inspector are both offered', async () => {
  const { apply } = await import('../index.js')
  const config = makeConfigWithPreset()
  const logs = []
  const ctx = { logger: { info: () => {}, warn: message => logs.push(message) } }

  // A period with no inspector: built, but unarmed — and said so.
  const quiet = apply(ctx, { config })
  assert.ok(quiet.patrol, 'the patrol is built')
  assert.equal(quiet.patrol.status().running, false)
  assert.equal(quiet.patrol.status().patrols, 0)
  assert.match(logs.join('\n'), /no inspect function was offered/)
  quiet.dispose()

  // A period with an inspector: the patrol is built and armed.
  const live = apply(ctx, {
    config,
    inspect: async () => [{ operation: 'merge', task: 'merge PR #42' }],
  })
  assert.ok(live.patrol, 'the patrol should exist when an inspector is offered')
  assert.equal(live.patrol.status().running, true)
  assert.equal(live.patrol.status().intervalMs, 60000)
  assert.equal(live.patrol.status().patrols, 0)

  live.dispose()
  assert.equal(live.patrol.status().running, false)
})
