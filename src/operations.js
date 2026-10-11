/**
 * From a router verdict to a piece of work: which operation was chosen, which
 * execution unit claims it, and what the executor receives.
 *
 * This is the step the compat layer did not have before. A decide channel does
 * not answer a question, it picks an operation; picking is not doing, so the
 * verdict has to be handed somewhere. That "somewhere" is a `dispatch` channel
 * in the table — a session that claims an operation by name.
 *
 * The registry is derived, never declared separately, because an executor that
 * is not a channel row has no base URL and cannot be dialed. One operation maps
 * to at most one executor: the first channel in table order that claims it wins,
 * so a config cannot silently fan one operation out to two sessions.
 *
 * @module src/operations.js
 */

import { CHANNEL_TYPE_DISPATCH } from './channels.js'
import { CODE, SelectError } from './errors.js'

/** Keys a verdict is likely to use for the thing it chose, in preference order. */
export const OPERATION_KEYS = [
  'choice',
  'selection',
  'action',
  'operation',
  'op',
  'route',
  'selected',
  'top',
  'choices',
  'scores',
]

/** Inner keys a nested choice object is likely to use. */
const INNER_KEYS = ['action', 'operation', 'op', 'route', 'name', 'id']

/**
 * The operation a verdict picked, or nothing.
 *
 * Parsing is deliberately loose and the registry is what makes it safe: a
 * verdict that names something no executor claims is simply not handled, and the
 * request degrades to the generation tail. There is no way to route to a wrong
 * place, because only the table says what exists.
 */
export function operationFromVerdict(verdict) {
  if (verdict === null || typeof verdict !== 'object' || Array.isArray(verdict)) return undefined

  for (const key of OPERATION_KEYS) {
    const found = operationValue(verdict[key])
    if (found !== undefined) return found
  }
  for (const key of OPERATION_KEYS) {
    const nested = verdict[key]
    if (Array.isArray(nested)) {
      for (const item of nested) {
        const found = operationFromVerdict(item)
        if (found !== undefined) return found
      }
    }
  }

  // A verdict that is itself a confidence map, `{ "merge": 0.91 }`. The value must
  // be a number, or a bare frame field like `reason` or `usage` would read as an
  // operation. One numeric entry is readable; more than one is ambiguous, and this
  // layer never guesses.
  const bare = Object.entries(verdict).filter(
    ([key, value]) => !OPERATION_KEYS.includes(key) && !INNER_KEYS.includes(key),
  )
  return bare.length === 1 && typeof bare[0][1] === 'number' ? bare[0][0] : undefined
}

function operationValue(value) {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'string') {
    return value.trim() === '' ? undefined : value.trim()
  }
  if (Array.isArray(value)) return undefined
  if (typeof value === 'object') {
    for (const key of INNER_KEYS) {
      const inner = operationValue(value[key])
      if (inner !== undefined) return inner
    }
    // A confidence map with one entry: `{ "merge": 0.91 }`. More than one entry
    // is ambiguous, so it is not guessed.
    const keys = Object.keys(value).filter(key => !OPERATION_KEYS.includes(key) && !INNER_KEYS.includes(key))
    return keys.length === 1 ? keys[0] : undefined
  }
  return undefined
}

/**
 * `operation → channel row` for every dispatch channel in the table.
 *
 * Disabled channels are skipped, so an executor a router must not reach cannot be
 * reached. Returned as a plain object in table order.
 */
export function executorIndex(config) {
  const index = {}
  for (const channel of Object.values(config?.channels ?? {})) {
    if (channel.disabled) continue
    if (channel.type !== CHANNEL_TYPE_DISPATCH) continue
    for (const operation of channel.operations ?? []) {
      if (!(operation in index)) index[operation] = channel
    }
  }
  return index
}

/**
 * The work to hand over.
 *
 * An explicit `task` field wins, then the decision's own `task`, then the last
 * thing the caller said. A session with nothing to run is a config error, not a
 * quiet empty turn.
 */
export function taskFrom(request) {
  const source = request ?? {}
  const decision = source.decision ?? {}
  const explicit = firstString(source.task, decision.task)
  if (explicit !== undefined) return explicit

  const messages = Array.isArray(source.messages) ? source.messages : []
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (!message || typeof message !== 'object') continue
    if (message.role !== 'user') continue
    const content = typeof message.content === 'string' ? message.content : message.content === null ? '' : String(message.content ?? '')
    if (content.trim() !== '') return content
  }
  throw new SelectError('there is no task to dispatch: pass a "task" field or a user message', CODE.config)
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value
  }
  return undefined
}

/**
 * What a dispatch channel receives.
 *
 * `messages` carries the task and nothing else — an executor runs work, it does
 * not continue a conversation — and `context` carries the conversation for an
 * executor that wants to know where the task came from. `channel.dispatchBody`
 * overrides both, for an upstream that does not speak this spelling.
 */
export function sessionRequest(executor, request) {
  const source = request ?? {}
  const task = taskFrom(source)
  const body = {
    model: executor.defaultModel,
    session: executor.session ?? executor.name,
    messages: [{ role: 'user', content: task }],
    context: Array.isArray(source.messages) ? source.messages : [],
    ...executor.dispatchBody,
  }
  // temperature and label travel with the work; output stays with the router
  // because it tells a decide channel how to answer, which is not a session ask.
  for (const key of ['temperature', 'label']) {
    const value = source[key]
    if (value !== undefined && value !== null && value !== '') body[key] = value
  }
  return body
}
