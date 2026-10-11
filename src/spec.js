/**
 * From a `model` field to an ordered candidate list.
 *
 * The `model` field is the plugin's own extension of the OpenAI spelling: one
 * string that may name several channels, in the order the caller wants them
 * tried. The three shapes the spec accepts:
 *
 *   "kilo/free,space-bunny-free"      → comma list of channels and/or models
 *   "__pool__:fast-free"              → a named pool, expanded from the table
 *   "space-bunny-free"                → a single id: a channel key or a model id
 *
 * Resolution is pure: it reads the table and the availability cache and returns
 * an ordered array. Nothing here talks to the network, which is what makes the
 * fallback order inspectable before a single byte is sent.
 *
 * Resolution also knows the request's *intent*, because the channel table has
 * two kinds of channel and they are not interchangeable:
 *
 *   decide intent (the request carries `decision`) → decide channels first,
 *     then the fallback tail of chat channels, so a router that is down degrades
 *     to a generation model and the request still gets an answer.
 *   chat intent (the ordinary case) → chat channels only. Sending a prose prompt
 *     to a decision model burns quota for an answer nobody can parse.
 *
 * Within each kind the caller's order is preserved; a half that the caller left
 * empty is filled from the table's `defaults.decidePool` or `fallbackPool`, so
 * `{"model": "kilo", "decision": {...}}` still has a place to degrade to.
 *
 * @module src/spec.js
 */

import { CODE, SelectError } from './errors.js'
import { modelServingChannels, CHANNEL_TYPE_CHAT, CHANNEL_TYPE_DECIDE, CHANNEL_TYPE_DISPATCH } from './channels.js'
import { INTENT_DECIDE, INTENT_CHAT } from './intent.js'

export const POOL_PREFIX = '__pool__:'

/** How deep a pool may nest before the table is declared broken. */
const POOL_DEPTH_MAX = 4

/**
 * Split a `model` string into typed items.
 *
 * @returns {Array<{pool:string}|{channel:string,model?:string}>}
 */
export function parseModelSpec(spec) {
  const text = String(spec ?? '').trim()
  if (text === '') return []
  if (text.startsWith(POOL_PREFIX)) {
    const name = text.slice(POOL_PREFIX.length).trim()
    if (name === '') throw new SelectError(`"${spec}" names an empty pool`, CODE.config)
    return [{ pool: name }]
  }
  return text
    .split(',')
    .map(item => item.trim())
    .filter(item => item !== '')
    .map(parseItem)
}

/**
 * Read one comma item.
 *
 * `channel/model` names a channel and pins its model; a bare token is ambiguous
 * between a channel key and a model id, so `channel` carries whichever token was
 * written and `resolveSpec` decides which one it was, using the table.
 */
export function parseItem(text) {
  const value = String(text ?? '').trim()
  if (value === '') return null
  if (value.startsWith(POOL_PREFIX)) return { pool: value.slice(POOL_PREFIX.length).trim() }
  const slash = value.indexOf('/')
  if (slash === -1) return { channel: value }
  const channel = value.slice(0, slash).trim()
  const model = value.slice(slash + 1).trim()
  if (channel === '') return { channel: model }
  return model === '' ? { channel } : { channel, model }
}

/**
 * Expand one `model` string into candidates, without any intent logic.
 *
 * Pooled apart from `resolveCandidates` so that filling an empty half from a
 * default pool goes through the exact same expansion, nesting, cycle detection,
 * and availability filtering as the spec the caller wrote.
 */
function resolveSpec(spec, { config, availability }) {
  const items = parseModelSpec(spec)
  if (items.length === 0) {
    throw new SelectError('the model field is empty', CODE.config)
  }

  const candidates = []
  const seen = new Set()
  const poolsSeen = new Set()
  const skipped = []
  const suppressed = []

  const add = item => {
    const channel = config.channels[item.channel]
    if (!channel) throw new SelectError(`unknown channel "${item.channel}"`, CODE.config)
    if (channel.disabled) {
      // Named on purpose, so it is not a preference to ignore but a request.
      throw new SelectError(`channel "${item.channel}" is disabled in the table`, CODE.config)
    }
    const model = item.model ?? channel.defaultModel
    if (!model) throw new SelectError(`channel "${item.channel}" declares no model`, CODE.config)
    if (availability && !availability.isEnabled(item.channel)) {
      skipped.push(`${item.channel}/${model}`)
      return
    }
    const key = `${item.channel}/${model}`
    if (seen.has(key)) return
    seen.add(key)
    candidates.push({ channel: item.channel, model, type: channel.type, key })
  }

  const expandPool = (name, depth) => {
    if (depth > POOL_DEPTH_MAX) {
      throw new SelectError(`pool "${name}" is nested more than ${POOL_DEPTH_MAX} deep`, CODE.config)
    }
    if (poolsSeen.has(name)) {
      throw new SelectError(`pool "${name}" refers to itself, directly or through another pool`, CODE.config)
    }
    const members = config.pools?.[name]
    if (!Array.isArray(members) || members.length === 0) {
      throw new SelectError(`unknown or empty pool "${name}"`, CODE.config)
    }
    poolsSeen.add(name)
    for (const member of members) {
      const item = typeof member === 'string' ? parseItem(member) : member
      if (item === null) continue
      // A pool is a preference list, so a member that is disabled is quietly not
      // preferred. Naming it directly is still an error, which is what tells an
      // operator apart from a table edit.
      if (typeof item.channel === 'string' && config.channels[item.channel]?.disabled) {
        suppressed.push(item.channel)
        continue
      }
      expandItem(item, depth + 1)
    }
    poolsSeen.delete(name)
  }

  const expandItem = (item, depth = 1) => {
    if (item.pool !== undefined) return expandPool(item.pool, depth)

    const token = item.channel ?? ''
    const explicitModel = item.model ?? null

    if (token !== '' && config.channels[token]) {
      // A real channel key. The explicit model is a pin, not an allowlist: the
      // table may serve ids it does not list.
      return add({ channel: token, model: explicitModel })
    }

    if (token !== '' && explicitModel !== null) {
      // "foo/bar" where foo is not a channel: the whole token may be a model id
      // that happens to contain a slash, which several providers use.
      const hits = modelServingChannels(config, `${token}/${explicitModel}`)
      if (hits.length > 0) {
        for (const channel of hits) add({ channel, model: `${token}/${explicitModel}` })
        return
      }
      throw new SelectError(`unknown channel "${token}"`, CODE.config)
    }

    // Not a channel key: treat the token as a model id and fan out over every
    // channel that serves it, in table order.
    const hits = modelServingChannels(config, token)
    if (hits.length === 0) {
      throw new SelectError(`"${token}" is neither a channel nor a model served by the table`, CODE.config)
    }
    for (const channel of hits) add({ channel, model: token })
  }

  for (const item of items) expandItem(item)
  return { candidates, skipped, suppressed: [...new Set(suppressed)] }
}

/**
 * Resolve a `model` spec into the ordered candidate list the fallback loop walks.
 *
 * @param {string} spec - the raw `model` field
 * @param {object} options
 * @param {object} options.config - a table from `loadConfig`
 * @param {object} [options.availability] - the cache; filtered candidates are dropped, not errored
 * @param {'decide'|'chat'} [options.intent] - the request's intent, from `detectIntent`
 * @param {object} [options.defaults] - overrides for the table's own defaults
 * @returns {Array<{channel:string, model:string, type:string, key:string}>}
 */
export function resolveCandidates(spec, {
  config,
  availability,
  intent = INTENT_CHAT,
  defaults = {},
} = {}) {
  if (!config || !config.channels) {
    throw new SelectError('resolveCandidates needs a channel table', CODE.config)
  }
  const wantsDecision = intent === INTENT_DECIDE

  const { candidates: named, skipped, suppressed } = resolveSpec(spec, { config, availability })
  const decide = named.filter(candidate => candidate.type === CHANNEL_TYPE_DECIDE)
  const chat = named.filter(candidate => candidate.type === CHANNEL_TYPE_CHAT)
  // An executor is a destination, not a member of a fallback order. When the caller
  // names one it comes first — they asked for work to be done — and a pool never
  // pulls one in, so an executor can never become a silent fallback.
  const dispatch = named.filter(candidate => candidate.type === CHANNEL_TYPE_DISPATCH)

  if (wantsDecision) {
    // A router that nobody named still gets one, because the whole point of
    // declaring a decision is that the caller expects to be routed.
    const decideHalf = decide.length > 0 ? decide : fillFromPool(config, 'decidePool', availability)
    // And the fallback tail, because a router that is down must not be a dead end.
    const chatHalf = chat.length > 0 ? chat : fillFromPool(config, 'fallbackPool', availability)
    return dedupe([...dispatch, ...decideHalf, ...chatHalf], skipped, suppressed)
  }

  const generation = [...dispatch, ...chat]
  if (generation.length === 0) {
    if (skipped.length === 0 && suppressed.length === 0) {
      // Nothing was filtered: the caller named decide channels and nothing else.
      throw new SelectError(
        'every named channel is a decide channel; pass a "decision" field to route the request, or name a chat channel',
        CODE.config,
      )
    }
    // Something was filtered, and that is what the caller needs to know.
    return dedupe([], skipped, suppressed)
  }
  return dedupe(generation, skipped, suppressed)
}

/**
 * Expand one of the table's default pools into chat candidates, or come back with
 * nothing. Absent is not an error: a table with no decide pool is simply a
 * generation-only table, and a request then degrades to chat without comment.
 */
function fillFromPool(config, poolKey, availability) {
  const tableDefaults = config.defaults ?? {}
  const name = tableDefaults[poolKey]
  if (name === undefined || name === null || name === '') return []
  const { candidates } = resolveSpec(`__pool__:${name}`, { config, availability })
  // A pool is a preference list, not a type filter: everything it names comes out,
  // and only the half the caller asked for is kept. An executor in a pool is still
  // dropped, because pulling it in here would turn it into a fallback candidate.
  const wanted = poolKey === 'decidePool' ? CHANNEL_TYPE_DECIDE : CHANNEL_TYPE_CHAT
  return candidates.filter(candidate => candidate.type === wanted)
}

function dedupe(candidates, skipped, suppressed = []) {
  const seen = new Set()
  const out = []
  for (const candidate of candidates) {
    if (seen.has(candidate.key)) continue
    seen.add(candidate.key)
    out.push(candidate)
  }
  if (out.length === 0) {
    const reasons = [
      ...skipped.map(item => `${item} is currently marked unavailable`),
      ...suppressed.map(name => `channel ${name} is disabled in the table`),
    ]
    if (reasons.length > 0) {
      throw new SelectError(
        `every candidate was filtered (${reasons.join('; ')}); the availability verdict expires on its own`,
        CODE.config,
      )
    }
    throw new SelectError('the model spec resolved to no candidates', CODE.config)
  }
  return out
}

/**
 * The candidate ordering as a human-readable string, for logs and for the
 * `x-select-candidates` response header. A decide channel carries a `!` so the
 * two kinds are legible in one header instead of being indistinguishable.
 */
export function candidatesLabel(candidates) {
  return candidates
    .map(candidate => {
      if (candidate.type === CHANNEL_TYPE_DECIDE) return `!${candidate.key}`
      if (candidate.type === CHANNEL_TYPE_DISPATCH) return `@${candidate.key}`
      return candidate.key
    })
    .join(',')
}
