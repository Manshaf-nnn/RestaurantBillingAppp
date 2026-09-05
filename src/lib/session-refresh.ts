'use client'

/**
 * One silent session refresh, shared by everything in the tab that might want
 * one (athu.md).
 *
 * ── Why it is deduplicated ──────────────────────────────────────────────────
 *
 * When the access token expires, EVERYTHING notices at once: the pulse poller
 * gets a 401, three buttons the user pressed come back unauthorised, a prefetch
 * fails. Ten callers asking for a refresh must produce one request — the server
 * side is race-tolerant now, but ten concurrent refreshes still cost ten
 * serverless invocations for one cookie, and the point of the fix was to stop
 * treating a routine expiry as an emergency.
 *
 * The in-flight promise is module-level, so every importer in the tab shares
 * it. A second caller while one is in flight simply awaits the same promise.
 *
 * ── What it deliberately does not do ────────────────────────────────────────
 *
 * It does not redirect, does not touch cookies (the server sets them on the
 * response) and does not store anything. It answers one question — "is there a
 * session now?" — and the caller decides what to do with a no.
 */

let inFlight: Promise<boolean> | null = null
let lastAttemptAt = 0

/** Which cookie namespace this page lives in. */
function scopeForPath(pathname: string): 'admin' | 'staff' {
  return pathname === '/admin' || pathname.startsWith('/admin/') ? 'admin' : 'staff'
}

/**
 * Ask the server to renew the session from the refresh cookie.
 *
 * Resolves `true` when a session now exists (renewed, rotated, or handed the
 * successor of a just-rotated token), `false` when there is genuinely nothing
 * to refresh and the caller should send the user to sign in.
 *
 * `minIntervalMs` stops a poller that keeps getting 401s from asking every
 * tick: inside the interval the previous answer's failure is returned again.
 */
export function requestSessionRefresh(minIntervalMs = 0): Promise<boolean> {
  if (inFlight) return inFlight
  if (minIntervalMs > 0 && Date.now() - lastAttemptAt < minIntervalMs) {
    return Promise.resolve(false)
  }
  lastAttemptAt = Date.now()

  const scope = scopeForPath(typeof window !== 'undefined' ? window.location.pathname : '/')

  inFlight = fetch(`/api/auth/refresh?scope=${scope}`, {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { accept: 'application/json' },
  })
    .then((response) => response.ok)
    .catch(() => false)
    .finally(() => {
      inFlight = null
    })

  return inFlight
}

/** Where a signed-out visitor on this page should go to sign back in. */
export function loginPathFor(pathname: string): string {
  const base = scopeForPath(pathname) === 'admin' ? '/admin/login' : '/login'
  return `${base}?next=${encodeURIComponent(pathname)}`
}
