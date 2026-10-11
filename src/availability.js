/**
 * The availability cache: an in-memory map of "this channel just failed" that
 * expires on its own.
 *
 * It is deliberately short-lived and single-process. Its job is not to be a
 * load balancer and it is not a source of truth — it is a one-way valve that
 * keeps a channel which answered 429 or a timeout out of the fallback order for
 * about a minute, so the next request does not waste a turn re-discovering the
 * same failure. After the TTL the entry is gone and the channel is tried again,
 * which is what makes a dead channel come back without a restart.
 *
 * @module src/availability.js
 */

export const DEFAULT_TTL_MS = 60000

/**
 * @param {object} [options]
 * @param {number} [options.ttlMs] - how long a verdict stays in force
 * @param {() => number} [options.now] - injectable clock, so tests do not sleep
 */
export class AvailabilityCache {
  constructor({ ttlMs = DEFAULT_TTL_MS, now = Date.now } = {}) {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new TypeError('ttlMs must be a positive number')
    this.ttlMs = ttlMs
    this.now = typeof now === 'function' ? now : Date.now
    /** @type {Map<string, {state:'up'|'down', at:number, note:string, model?:string}>} */
    this.entries = new Map()
  }

  /**
   * Is this channel eligible? Unknown channels and expired verdicts are eligible.
   * An expired entry is dropped on read rather than left to rot in the map.
   */
  isEnabled(key) {
    const entry = this.entries.get(key)
    if (entry === undefined) return true
    if (this.now() - entry.at > this.ttlMs) {
      this.entries.delete(key)
      return true
    }
    return entry.state === 'up'
  }

  /**
   * Record one outcome. `ok` false marks the channel down for the TTL; `true`
   * marks it up, which clears a stale down verdict immediately instead of
   * waiting out the clock.
   */
  report(key, ok, { note = '', model } = {}) {
    if (typeof key !== 'string' || key === '') return
    this.entries.set(key, {
      state: ok ? 'up' : 'down',
      at: this.now(),
      note: typeof note === 'string' ? note : '',
      ...(typeof model === 'string' && model !== '' ? { model } : {}),
    })
  }

  /** Drop one verdict, for a manual "try that channel again" action. */
  forget(key) {
    this.entries.delete(key)
  }

  clear() {
    this.entries.clear()
  }

  /** Only live verdicts: expired ones are gone by the time they are read. */
  get size() {
    return this.liveEntries().length
  }

  liveEntries() {
    const rows = []
    for (const [key, entry] of this.entries) {
      if (this.now() - entry.at > this.ttlMs) {
        this.entries.delete(key)
        continue
      }
      rows.push({ key, state: entry.state, ageMs: this.now() - entry.at, ttlMs: this.ttlMs, note: entry.note, ...(entry.model ? { model: entry.model } : {}) })
    }
    return rows
  }

  /** A snapshot the settings page or a health route can show. */
  snapshot() {
    return { ttlMs: this.ttlMs, at: this.now(), entries: this.liveEntries() }
  }
}

/** A cache nobody reads: useful as the "availability disabled" mode. */
export const OPEN_CACHE = {
  isEnabled: () => true,
  report: () => {},
  forget: () => {},
  clear: () => {},
  snapshot: () => ({ ttlMs: 0, at: 0, entries: [] }),
}
