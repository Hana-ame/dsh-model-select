/**
 * The channel table: the only place a channel, a pool, or a fallback order is
 * declared. Everything else reads this object; nothing hardcodes a base URL.
 *
 * The table is data on disk, not code, so adding a channel is an edit and not a
 * deploy — the whole point of the compat layer is that "which model answers
 * this turn" stays a configuration decision, while "how failures are handled"
 * stays code.
 *
 * @module src/channels.js
 */

import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { CODE, SelectError } from './errors.js'

export const DEFAULTS = {
  timeoutMs: 60000,
  availabilityTtlMs: 60000,
  maxAttempts: 4,
  loopMs: 0,
}

/**
 * Three kinds of channel, and the split is the plugin's whole reason for existing.
 *
 *   decide   — a decision model (JEV and its kin). Answers `/v1/decide` with a
 *              structured verdict and no prose at all. This is the router.
 *   dispatch — an execution unit (a session). It does not answer a question, it
 *              runs the work the router picked. It is reached by the verdict, not
 *              by a model id.
 *   chat     — a generation model. Answers `/v1/chat/completions` in free text.
 *              The tail of every fallback chain: what runs when the router
 *              cannot be reached or has picked something nobody executes.
 *
 * A request that wants a *choice* goes to `decide` first; the verdict names an
 * operation, and a `dispatch` channel that claims that operation takes the work.
 * When neither happens, the request degrades to `chat`. A request that wants
 * prose never touches a decide channel. `type` is what the fallback loop uses to
 * tell them apart, and `dispatch` uses it to pick the endpoint and the shape.
 */
export const CHANNEL_TYPE_CHAT = 'chat'
export const CHANNEL_TYPE_DECIDE = 'decide'
export const CHANNEL_TYPE_DISPATCH = 'dispatch'
export const CHANNEL_TYPES = [CHANNEL_TYPE_CHAT, CHANNEL_TYPE_DECIDE, CHANNEL_TYPE_DISPATCH]

/**
 * The endpoint each type answers on when the table does not name one.
 *
 * A dispatch channel answers on `chat/completions` like a chat channel: the
 * executor is a model that runs work, and `session` is how the request tells it
 * which execution unit the task belongs to.
 */
export function defaultPath(type) {
  return type === CHANNEL_TYPE_DECIDE ? 'v1/decide' : 'chat/completions'
}

export const DEFAULT_CONFIG_URL = new URL('../config/channels.json', import.meta.url)

const ENV_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g

/**
 * Expand `${VAR}` and `${VAR:-default}` in one string.
 *
 * A variable that is *set* wins, even when it is empty — an operator who exports
 * an empty token is choosing "no credential", and that is a legitimate state for
 * a free channel. Only a variable that is *unset* falls back, and only that case
 * warns.
 */
export function expandEnv(text, env = process.env, warnings = []) {
  if (typeof text !== 'string') return text
  return text.replace(ENV_PATTERN, (_whole, name, fallback) => {
    const value = env[name]
    if (value !== undefined) return value
    if (fallback !== undefined) return fallback
    warnings.push(`${name} is not set; substituting an empty value`)
    return ''
  })
}

/** Expand every string in a nested structure, in place of a copy. */
export function expandEnvDeep(value, env, warnings) {
  if (typeof value === 'string') return expandEnv(value, env, warnings)
  if (Array.isArray(value)) return value.map(item => expandEnvDeep(item, env, warnings))
  if (value !== null && typeof value === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value)) out[key] = expandEnvDeep(item, env, warnings)
    return out
  }
  return value
}

/**
 * Load and validate the channel table.
 *
 * A missing or unreadable file throws: a compat layer that silently fell back to
 * an in-code default table would answer every request with a guess about which
 * channel is reachable. Failing loudly is the behaviour worth having.
 *
 * @param {string|URL} [configPath] - defaults to config/channels.json beside src/
 * @param {object} [options]
 * @param {object} [options.env] - environment source, defaults to process.env
 * @returns {{channels:object, pools:object, defaults:object, warnings:string[]}}
 */
export function loadConfig(configPath = DEFAULT_CONFIG_URL, { env = process.env } = {}) {
  const file = typeof configPath === 'string' ? configPath : fileURLToPath(configPath)
  const warnings = []
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (error) {
    throw new SelectError(
      `could not read the channel table ${file}: ${error?.message ?? error}`,
      CODE.config,
    )
  }

  let doc
  try {
    doc = JSON.parse(raw)
  } catch (error) {
    throw new SelectError(`the channel table ${file} is not valid JSON: ${error.message}`, CODE.config)
  }

  // Expand only the subtrees that carry data. The document may also carry prose
  // (a notes field, a changelog) that mentions a placeholder as an example, and
  // expanding that would warn about a variable nobody meant to use.
  const expanded = { ...doc }
  for (const field of ['channels', 'defaults', 'pools']) {
    if (doc[field] !== undefined) expanded[field] = expandEnvDeep(doc[field], env, warnings)
  }
  return validateConfig(expanded, warnings, file)
}

/**
 * Validate the loaded document into the shape the rest of the layer assumes.
 * Exported on its own so callers that build a table in memory (the tests, and
 * later a settings page) get the same guarantees as callers that read a file.
 */
export function validateConfig(doc, warnings = [], source = '<inline>') {
  if (doc === null || typeof doc !== 'object') {
    throw new SelectError(`the channel table ${source} must be a JSON object`, CODE.config)
  }
  const channels = doc.channels
  if (channels === null || typeof channels !== 'object' || Array.isArray(channels)) {
    throw new SelectError(`the channel table ${source} has no "channels" object`, CODE.config)
  }
  if (Object.keys(channels).length === 0) {
    throw new SelectError(`the channel table ${source} declares no channels`, CODE.config)
  }

  const rows = {}
  for (const [name, channel] of Object.entries(channels)) {
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) {
      throw new SelectError(`channel "${name}" in ${source} has an unusable key (letters, digits, . _ - only)`, CODE.config)
    }
    rows[name] = validateChannel(name, channel, source)
  }

  const pools = {}
  if (doc.pools !== undefined && doc.pools !== null && typeof doc.pools === 'object') {
    for (const [name, members] of Object.entries(doc.pools)) {
      if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) {
        throw new SelectError(`pool "${name}" in ${source} has an unusable key`, CODE.config)
      }
      if (!Array.isArray(members) || members.length === 0 || !members.every(member => typeof member === 'string')) {
        throw new SelectError(`pool "${name}" in ${source} must be a non-empty array of strings`, CODE.config)
      }
      pools[name] = [...members]
    }
  }

  // An execution unit is a destination: a verdict points at it, and the caller
  // names it. Putting one in a pool would make it a fallback candidate, which is
  // the opposite of what a dispatch channel is for — so the table says so at load.
  for (const [name, members] of Object.entries(pools)) {
    const executors = members.filter(member => rows[member]?.type === CHANNEL_TYPE_DISPATCH)
    if (executors.length > 0) {
      throw new SelectError(
        `pool "${name}" in ${source} lists ${executors.join(', ')}; an execution unit is a destination, not a fallback candidate — name it directly instead`,
        CODE.config,
      )
    }
  }

  const rawDefaults = doc.defaults ?? {}
  const defaults = {
    timeoutMs: positiveInt(rawDefaults.timeoutMs, DEFAULTS.timeoutMs, 'timeoutMs', source),
    availabilityTtlMs: positiveInt(rawDefaults.availabilityTtlMs, DEFAULTS.availabilityTtlMs, 'availabilityTtlMs', source),
    maxAttempts: positiveInt(rawDefaults.maxAttempts, DEFAULTS.maxAttempts, 'maxAttempts', source),
    headers: rawDefaults.headers ?? {},
    decidePool: namedPool(rawDefaults.decidePool, 'decidePool', source),
    fallbackPool: namedPool(rawDefaults.fallbackPool, 'fallbackPool', source),
    // The discipline every generated answer carries. A string or a list of
    // clauses; `toLines` flattens either. Empty means "no preset in the table",
    // and the layer then falls back to its built-in default.
    preset: presetValue(rawDefaults.preset, 'preset', source),
    // The patrol period. Zero is a valid setting, not an absence: it means "the
    // layer does not decide what to do next on its own", which is a deliberate
    // posture for a layer that should not start dialling executors because a
    // config file said 60000.
    loopMs: periodInt(rawDefaults.loopMs, 'loopMs', source),
  }

  // Both must name a pool that exists: a default pool that points at nothing is a
  // silent dead end, because the request would just degrade to whatever the tail
  // offers.
  for (const [label, ref] of Object.entries({ decidePool: defaults.decidePool, fallbackPool: defaults.fallbackPool })) {
    if (ref !== undefined && !pools[ref]) {
      throw new SelectError(`defaults.${label} in ${source} names unknown pool "${ref}"`, CODE.config)
    }
  }

  return { version: doc.version ?? 1, channels: rows, pools, defaults, warnings, source: fileOf(source) }
}

function validateChannel(name, channel, source) {
  if (channel === null || typeof channel !== 'object') {
    throw new SelectError(`channel "${name}" in ${source} must be an object`, CODE.config)
  }
  const baseUrl = channel.baseUrl
  if (typeof baseUrl !== 'string' || !/^https?:\/\//i.test(baseUrl.trim())) {
    throw new SelectError(`channel "${name}" in ${source} needs an http(s) baseUrl`, CODE.config)
  }
  const models = Array.isArray(channel.models) ? channel.models.filter(model => typeof model === 'string' && model !== '') : []
  const defaultModel = typeof channel.defaultModel === 'string' && channel.defaultModel !== '' ? channel.defaultModel : models[0]
  if (!defaultModel) {
    throw new SelectError(`channel "${name}" in ${source} declares no model to fall back on`, CODE.config)
  }

  const type = channel.type === undefined ? CHANNEL_TYPE_CHAT : channel.type
  if (!CHANNEL_TYPES.includes(type)) {
    throw new SelectError(`channel "${name}" in ${source} has an unusable type "${type}" (${CHANNEL_TYPES.join(', ')} only)`, CODE.config)
  }

  // Which operations this channel executes. Only a dispatch channel can claim
  // them — a router picks, an executor does.
  const operations = Array.isArray(channel.operations)
    ? channel.operations.filter(op => typeof op === 'string' && op.trim() !== '').map(op => op.trim())
    : []
  if (type === CHANNEL_TYPE_DISPATCH && operations.length === 0) {
    throw new SelectError(`channel "${name}" in ${source} is a dispatch channel that claims no operation`, CODE.config)
  }

  return {
    name,
    type,
    baseUrl: baseUrl.trim().replace(/\/+$/, ''),
    path: typeof channel.path === 'string' && channel.path !== '' ? channel.path : defaultPath(type),
    defaultModel,
    models,
    auth: channel.auth ?? null,
    headers: channel.headers ?? {},
    // The execution unit a dispatch channel hands work to. The channel name is a
    // serviceable default: a table entry called "merge-runner" runs "merge-runner".
    session: typeof channel.session === 'string' && channel.session.trim() !== ''
      ? channel.session.trim()
      : name,
    operations: [...new Set(operations)],
    decideBody: channel.decideBody !== null && typeof (channel.decideBody ?? {}) === 'object'
      ? channel.decideBody
      : {},
    dispatchBody: channel.dispatchBody !== null && typeof (channel.dispatchBody ?? {}) === 'object'
      ? channel.dispatchBody
      : {},
    // Declared but not dialed: a table entry a router will not reach. It is skipped
    // in pools and model fan-out, and naming it directly is a config error. This is
    // how a channel ships as documentation before an endpoint is known.
    disabled: channel.disabled === true,
  }
}

/**
 * The discipline, as written: a string, or a list of non-empty strings. Anything
 * else is a config error — a preset that silently does not apply is a discipline
 * that is not a discipline.
 */
function presetValue(value, label, source) {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    if (!value.every(item => typeof item === 'string' && item.trim() !== '')) {
      throw new SelectError(`${label} in ${source} must be strings`, CODE.config)
    }
    return value
  }
  throw new SelectError(`${label} in ${source} must be a string or a list of strings`, CODE.config)
}

/** A pool name or nothing; never a silent default. */
function namedPool(value, label, source) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || value.trim() === '') {
    throw new SelectError(`defaults.${label} in ${source} must be a pool name`, CODE.config)
  }
  return value.trim()
}

function positiveInt(value, fallback, label, source) {
  if (value === undefined || value === null || value === '') return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isInteger(parsed)) {
    throw new SelectError(`${label} in ${source} must be a positive integer (got ${value})`, CODE.config)
  }
  return parsed
}

/**
 * A period in milliseconds. Unlike `positiveInt`, zero is a first-class value
 * here: it means "disabled", and the difference matters, because a patrol that
 * nobody asked for is a layer doing work it was not hired to do.
 */
function periodInt(value, label, source) {
  if (value === undefined || value === null || value === '') return 0
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0 || !Number.isInteger(parsed)) {
    throw new SelectError(
      `${label} in ${source} must be a whole number of milliseconds >= 0 (got ${value}); 0 disables the patrol`,
      CODE.config,
    )
  }
  return parsed
}

function fileOf(source) {
  return typeof source === 'string' ? source : String(source)
}

/**
 * Which channels serve a model id, in channel-table order.
 *
 * Two passes on purpose: a model that is only a channel's `defaultModel` but not
 * in its `models` list is still served (the list is a discovery convenience, not
 * an allowlist), and it wins the ordering tie so a bare model id lands on the
 * channel that declares it first.
 *
 * Dispatch channels never match: a model id is never a way of saying "run the
 * merge executor". An executor is reached by naming it or by a router verdict.
 */
export function modelServingChannels(config, modelId) {
  if (typeof modelId !== 'string' || modelId === '') return []
  const hits = []
  for (const [name, channel] of Object.entries(config.channels ?? {})) {
    if (channel.disabled) continue
    if (channel.type === CHANNEL_TYPE_DISPATCH) continue
    if (channel.defaultModel === modelId) hits.push(name)
  }
  for (const [name, channel] of Object.entries(config.channels ?? {})) {
    if (hits.includes(name)) continue
    if (channel.disabled) continue
    if (channel.type === CHANNEL_TYPE_DISPATCH) continue
    if (channel.models.includes(modelId)) hits.push(name)
  }
  return hits
}

/**
 * Every `channel/model` pair the table can serve — the `/v1/models` row source.
 * Dispatch executors are listed too, tagged, so an operator can see which model
 * would run an operation. They are never candidates for a bare model id.
 */
export function listModels(config) {
  const rows = []
  const seen = new Set()
  for (const [name, channel] of Object.entries(config.channels ?? {})) {
    if (channel.disabled) continue
    const ids = [...new Set([channel.defaultModel, ...channel.models])]
    for (const model of ids) {
      const key = `${name}/${model}`
      if (seen.has(key)) continue
      seen.add(key)
      rows.push({ key, channel: name, model, type: channel.type })
    }
  }
  return rows
}

/** Resolve the config path for a caller that only knows the package directory. */
export function defaultConfigPath() {
  return fileURLToPath(DEFAULT_CONFIG_URL)
}
