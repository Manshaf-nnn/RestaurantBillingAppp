import 'server-only'

/**
 * A per-process rate limiter for writes nobody is waiting on.
 *
 * ── What it is for ──────────────────────────────────────────────────────────
 *
 * Two columns want to record "this person was doing something just now":
 * `Session.lastUsedAt`, so the profile page can honestly say when a device was
 * last used, and `StaffShift.lastActionAt`, which is where a shift's hours come
 * from. Both would otherwise mean a database write on every single request, and
 * neither is worth one — a minute of resolution is plenty for either question,
 * and nothing in the app reads them mid-request.
 *
 * ── Deliberately not exact ──────────────────────────────────────────────────
 *
 * The map is per Node process, so with several instances the same user can get
 * one write per instance per window. That is fine: the writes are idempotent
 * `UPDATE … SET column = now()` on a single indexed row, and the worst case
 * degrades to roughly one small write per request — which is what an unthrottled
 * implementation would have cost anyway. Coordinating this through Redis would
 * be a lot of machinery to save a write that is already cheap.
 *
 * `server.mjs` runs for weeks at a time under PM2, so the map is bounded rather
 * than left to grow one entry per user for ever.
 */

const lastWrite = new Map<string, number>()

/** How many keys to hold before dropping the lot and starting again. */
const MAX_KEYS = 5_000

/**
 * True at most once per `everyMs` for a given key, and it records the decision.
 *
 * Call it immediately before the write, not before deciding whether to do the
 * surrounding work — a caller that asks and then bails out has consumed the
 * window and the write will not happen until the next one.
 */
export function due(key: string, everyMs: number): boolean {
  const now = Date.now()
  const previous = lastWrite.get(key)
  if (previous !== undefined && now - previous < everyMs) return false

  /*
   * Cleared wholesale rather than evicted one at a time. Losing the window for
   * everybody costs one extra write each; an LRU here would be real code and a
   * real allocation on a path whose entire point is being cheap.
   */
  if (lastWrite.size >= MAX_KEYS) lastWrite.clear()

  lastWrite.set(key, now)
  return true
}

/** Forget every recorded window. Tests only — a fresh process starts empty. */
export function resetPresenceThrottle(): void {
  lastWrite.clear()
}
