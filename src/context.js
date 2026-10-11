/**
 * The preamble a generated answer carries: a discipline preset plus a snapshot
 * of the current situation.
 *
 * Both halves are present in every chat body the layer sends. That is the point
 * of the compat layer: a model that forgets the last turn still gets the
 * discipline and the current state re-stated in this one, and an answer that
 * does not honour the discipline is a failure this layer can see.
 *
 *   预设（行为纪律）— what to do. Editable in the channel table under
 *                     `defaults.preset`; absent there it falls back to the
 *                     built-in default. A caller may override it per request.
 *   近况说明（当前状态）— where things stand now. Taken from the request when it
 *                     carries one, otherwise synthesised from the availability
 *                     cache: the only state the layer itself has.
 *
 * Composition happens once, before candidate resolution, so a decision model
 * sees the same context a fallback model does. `messages` is where it lands,
 * which is why neither body builder has to know about it.
 *
 * @module src/context.js
 */

/**
 * The discipline the layer ships with.
 *
 * Four clauses from the project note plus one guard: the guard is the clause that
 * turns "the model quietly guesses" into "the model says it is guessing", which
 * is the only failure mode this layer can still route.
 */
export const DEFAULT_PRESET = [
  '有 merge 就 merge（合并能合并的，别为形式拆两次）',
  '有问题就处理（发现了问题先处理，别只记录）',
  '没事做就审计（空档用于盘点，不用于等待）',
  '知识要录入（新结论落到知识节点，不留在会话里）',
  '不确定就说「不确定」并说明缺什么（不要猜，别用形容词代替证据）',
]

/** Flatten a preset or a status value into a list of non-empty lines. */
export function toLines(value) {
  if (value === undefined || value === null || value === '') return []
  if (Array.isArray(value)) return value.flatMap(toLines)
  if (typeof value === 'string') {
    return value.split(/\r?\n/).map(line => line.trim()).filter(line => line !== '')
  }
  if (typeof value === 'object') {
    return Object.entries(value).map(([key, item]) => {
      const rendered = Array.isArray(item) || (item !== null && typeof item === 'object')
        ? JSON.stringify(item)
        : String(item)
      return `${key}: ${rendered}`
    }).filter(line => line !== '')
  }
  return [String(value)]
}

/**
 * The discipline for this request: the caller's, then the table's, then the
 * built-in default. There is always one — a generation answer that never says
 * what it is supposed to do is the failure this layer exists to prevent.
 */
export function presetLines(request, config = {}) {
  const fromRequest = toLines(request?.preset)
  if (fromRequest.length > 0) return fromRequest
  const fromTable = toLines(config?.defaults?.preset)
  if (fromTable.length > 0) return fromTable
  return [...DEFAULT_PRESET]
}

/**
 * The current situation for this request: the caller's snapshot when it has one,
 * otherwise whatever the layer itself knows — the channels it has marked up or
 * down since the last verdict.
 */
export function statusLines(request, availability) {
  const fromRequest = toLines(request?.status)
  if (fromRequest.length > 0) return fromRequest
  return cacheLines(availability)
}

/** What the availability cache says, in the shape a model can read. */
export function cacheLines(availability) {
  let rows
  try {
    rows = availability?.snapshot?.().entries ?? []
  } catch {
    return []
  }
  return rows.map(row => {
    const since = row.state === 'down' && Number.isFinite(row.ageMs)
      ? `（${Math.round(row.ageMs / 1000)}s，${row.note ?? '原因未记录'}）`
      : ''
    return `通道 ${row.key}：${row.state}${since}`
  })
}

/**
 * The preamble, or nothing when there is neither a discipline nor a situation.
 *
 * Rendered as one system message with two headed sections. The headings are part
 * of the contract a model should follow, so they are stable strings rather than
 * clever formatting.
 */
export function composePreamble(preset, status) {
  const lines = []
  if ((preset ?? []).length > 0) {
    lines.push('【预设 · 行为纪律】')
    preset.forEach((line, index) => lines.push(`${index + 1}. ${line}`))
  }
  if ((status ?? []).length > 0) {
    if (lines.length > 0) lines.push('')
    lines.push('【近况说明 · 当前状态】')
    ;(status ?? []).forEach(line => lines.push(`- ${line}`))
  }
  return lines.length > 0 ? lines.join('\n') : undefined
}

/**
 * The request the layer actually sends: the preamble folded into `messages`, and
 * the two composition fields gone, because they have been delivered.
 *
 * When `messages` already opens with a system message the preamble is appended to
 * it rather than becoming a second one — most upstreams read the first system
 * message and a stacked second one is noise.
 *
 * Returns a new object; the caller's request is never mutated.
 */
export function applyContext(request, { config, availability } = {}) {
  const source = request ?? {}
  const preamble = composePreamble(presetLines(source, config), statusLines(source, availability))

  const out = { ...source }
  delete out.preset
  delete out.status

  if (preamble === undefined) return out

  // A request with no messages is invalid and must fail as invalid. Composition
  // must not manufacture a conversation that the validation layer then accepts.
  if (!Array.isArray(source.messages) || source.messages.length === 0) return out

  const messages = [...source.messages]
  const head = messages[0]
  if (head && typeof head === 'object' && head.role === 'system') {
    const existing = typeof head.content === 'string' ? head.content : ''
    messages[0] = { ...head, content: existing === '' ? preamble : `${existing}\n\n${preamble}` }
  } else {
    messages.unshift({ role: 'system', content: preamble })
  }
  out.messages = messages
  return out
}
