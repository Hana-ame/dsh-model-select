/**
 * The phone menu: a caller that has looked at the candidate list and picked a
 * number.
 *
 * Everything else in the layer resolves a `model` string into a list and then
 * walks that list from the front. A number says "do not walk, dial this one".
 * It is a preference the caller made by hand, after reading the menu, so it
 * outranks the fallback order and outranks a router verdict — the caller said
 * which lane they want, and the layer does not second-guess a human.
 *
 * The indices are 1-based on purpose: a menu that starts at zero is a bug in
 * every other place it exists. `choice: 1` is the first candidate.
 *
 * Accepted spellings are `choice` and `selection`. They are deliberately not
 * `decision.choice`, which is a different thing read off a router verdict, and
 * `decision` stays where `intent.js` reads it.
 *
 * Selection runs after resolution and never inside it, because resolution is
 * pure: it answers "which lanes can serve this model id" and must not depend on
 * what a caller typed into a menu field.
 *
 * @module src/selection.js
 */

import { CODE, SelectError } from './errors.js'
import { candidatesLabel } from './spec.js'

/** The two request fields a menu pick may arrive as. */
export const CHOICE_FIELDS = ['choice', 'selection']

/** The largest menu the layer will dial into. */
const CHOICE_MAX = 10000

/** One of the two field names, rendered for a message. */
function fieldLabel(field) {
  return `\`${field}\``
}

/**
 * Read a menu pick out of a request, without knowing the menu.
 *
 * Returns `{present:false}` when the caller sent nothing, `{present:true, field,
 * value}` when they sent something dialable, and `{present:true, error}` when
 * they sent something that is not a menu index.
 *
 * A number or a string of digits. `0`, negatives, fractions, and `true` are all
 * refusals rather than coercions: a caller who meant index one and typed `1.0`
 * gets told, instead of silently being routed to a lane they did not pick.
 *
 * @param {object} [request]
 * @returns {{present:false}|{present:true, field:string, value:number}|{present:true, error:SelectError}}
 */
export function readChoice(request) {
  const hits = []
  for (const field of CHOICE_FIELDS) {
    const raw = request?.[field]
    if (raw !== undefined && raw !== null && raw !== '') hits.push({ field, raw })
  }
  if (hits.length === 0) return { present: false }

  const values = hits.map(hit => parseChoice(hit.raw))
  for (let i = 0; i < values.length; i += 1) {
    if (values[i] === null) {
      return {
        present: true,
        error: choiceError(
          `${fieldLabel(hits[i].field)} must be a 1-based whole number, got ${JSON.stringify(hits[i].raw)}`,
        ),
      }
    }
  }

  // Two fields that disagree is a caller bug, not an ambiguity to resolve.
  // Two fields that agree are redundant but harmless.
  const first = hits[0]
  for (let i = 1; i < hits.length; i += 1) {
    if (hits[i].raw !== first.raw) {
      return {
        present: true,
        error: choiceError(
          `\`${hits[0].field}\` and \`${hits[i].field}\` disagree (${JSON.stringify(hits[0].raw)} vs ${JSON.stringify(hits[i].raw)}); send one`,
        ),
      }
    }
  }

  return { present: true, field: first.field, value: values[0] }
}

/** Coerce a menu value, refusing anything that is not a whole index. */
function parseChoice(raw) {
  if (typeof raw === 'number') {
    return Number.isSafeInteger(raw) && raw > 0 ? raw : null
  }
  if (typeof raw === 'string') {
    const text = raw.trim()
    if (!/^[0-9]+$/.test(text)) return null
    const parsed = Number(text)
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
  }
  return null
}

function choiceError(message) {
  return new SelectError(message, CODE.config)
}

/**
 * Apply a menu pick to a resolved candidate list.
 *
 * The picked lane becomes the whole list. That is what "skip the fallback"
 * means: a caller who dialled a number did not ask for a walk, so a refusal on
 * that lane comes back as a refusal rather than being quietly retried on the
 * next lane. The list is truncated, not reordered, so nothing downstream has to
 * know a pick happened.
 *
 * @param {Array<object>} candidates - a resolved, ordered list
 * @param {object} [request]
 * @returns {{candidates:Array<object>, picked:null|object}}
 *   `picked` is `{field, index, total, key, channel, model, type}` for an audit
 *   trail, or `null` when the caller did not pick.
 */
export function pickCandidate(candidates, request) {
  const list = Array.isArray(candidates) ? candidates : []
  const choice = readChoice(request)
  if (!choice.present) return { candidates: list, picked: null }
  if (choice.error) throw choice.error

  if (choice.value > CHOICE_MAX) {
    throw choiceError(`${fieldLabel(choice.field)} ${choice.value} is larger than ${CHOICE_MAX}`)
  }
  if (choice.value > list.length) {
    throw choiceError(
      `${fieldLabel(choice.field)} ${choice.value} is out of range: ${list.length} candidate` +
      `${list.length === 1 ? '' : 's'} in order (${candidatesLabel(list)})`,
    )
  }

  const candidate = list[choice.value - 1]
  return {
    candidates: [candidate],
    picked: {
      field: choice.field,
      index: choice.value,
      total: list.length,
      channel: candidate.channel,
      model: candidate.model,
      type: candidate.type,
      key: candidate.key ?? `${candidate.channel}/${candidate.model}`,
    },
  }
}
