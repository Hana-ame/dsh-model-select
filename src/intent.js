/**
 * Selection intent: does this turn ask to *choose*, or to *generate*?
 *
 * JEV (TypeSafe AI "System One Model") is a *decision* model — it routes,
 * scores, and classifies; it does not write. Its native endpoint is
 * `/v1/decide`, which returns a structured verdict, not free text. This layer's
 * main interface stays OpenAI's `/v1/chat/completions`, so the negotiation is
 * one optional field on the request body:
 *
 *   { "model": "...", "messages": [...], "decision": { "options": [...] } }
 *
 * A request that carries `decision` wants a *choice*. It is answered by a
 * `decide` channel (JEV and its kin) and the verdict is projected back into the
 * chat envelope — the chosen thing arrives as the assistant's content, encoded
 * as JSON, so a caller that only speaks OpenAI can still read it. When no decide
 * channel exists, or every one of them fails, the request degrades to the tail of
 * the fallback chain, which is a plain generation model. That degradation is not
 * a special path: it is just the fallback loop reaching a channel of a different
 * type.
 *
 * A request without `decision` is a normal completion. It never reaches a decide
 * channel, because sending a generation prompt to a router is a waste of the
 * quota and an answer nobody can parse.
 *
 * @module src/intent.js
 */

export const INTENT_DECIDE = 'decide'
export const INTENT_CHAT = 'chat'

/** Accepted spellings for the list of things to choose between. */
const OPTION_FIELDS = ['options', 'choices', 'candidates']

/** Optional fields that travel to the decide endpoint unchanged. */
const PASSTHROUGH_FIELDS = ['task', 'criteria', 'prompt', 'top_k', 'output', 'temperature', 'label']

/**
 * Does this request ask to choose?
 *
 * `decision` present and well-formed → decide. Everything else → chat, which
 * includes a caller who left the field off and a caller who misspelled it.
 *
 * @param {object} [request]
 * @returns {'decide'|'chat'}
 */
export function detectIntent(request) {
  return decisionSpec(request).ok ? INTENT_DECIDE : INTENT_CHAT
}

/**
 * Validate the `decision` field.
 *
 * Three states, and the first two are not the same thing: `present: false` is a
 * request that simply wants prose (no error), while `present: true, ok: false`
 * is a caller that asked for a decision and did not name the choices — a request
 * defect that must come back as a 400 rather than being silently rewritten into
 * a generation call.
 *
 * @returns {{present:boolean, ok:boolean, decision?:object, status?:number, message?:string}}
 */
export function decisionSpec(request) {
  const decision = request?.decision
  if (decision === undefined || decision === null) {
    return { present: false, ok: false, message: '`decision` is not present' }
  }
  if (typeof decision !== 'object' || Array.isArray(decision)) {
    return { present: true, ok: false, status: 400, message: '`decision` must be an object' }
  }

  const options = firstPresent(decision, OPTION_FIELDS)
  if (!Array.isArray(options) || options.length === 0) {
    return {
      present: true,
      ok: false,
      status: 400,
      message: '`decision.options` must be a non-empty array of the things to choose between',
    }
  }
  for (const [index, option] of options.entries()) {
    const valid = (typeof option === 'string' && option !== '')
      || (typeof option === 'object' && option !== null && !Array.isArray(option))
    if (!valid) {
      return {
        present: true,
        ok: false,
        status: 400,
        message: `each entry of \`decision.options\` must be a non-empty string or an object (entry ${index} is not)`,
      }
    }
  }

  const normalized = { ...decision }
  for (const alias of OPTION_FIELDS) delete normalized[alias]
  normalized.options = options

  const topK = decision.top_k ?? decision.topK
  if (topK !== undefined) {
    const parsed = Number(topK)
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return { present: true, ok: false, status: 400, message: '`decision.top_k` must be a positive number' }
    }
    normalized.top_k = Math.trunc(parsed)
  }

  for (const key of ['criteria', 'task', 'prompt']) {
    const value = normalized[key]
    if (value !== undefined && value !== null && typeof value !== 'string') {
      return { present: true, ok: false, status: 400, message: `\`decision.${key}\` must be a string` }
    }
  }

  return { present: true, ok: true, decision: normalized }
}

/** A one-line description of a decision spec, for logs and headers. */
export function decisionLabel(request) {
  const spec = decisionSpec(request)
  if (!spec.ok) return 'none'
  return `${spec.decision.options.length} options`
}

function firstPresent(decision, fields) {
  for (const field of fields) {
    if (decision[field] !== undefined) return decision[field]
  }
  return undefined
}
