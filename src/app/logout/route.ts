import { NextResponse, type NextRequest } from 'next/server'

import { destroySession } from '@/server/auth/session'

export const dynamic = 'force-dynamic'

/**
 * One-click sign-out link.
 *   GET /logout  →  clears the session and returns to the login screen.
 * Handy for switching between the demo accounts.
 *
 * ── Who may trigger it ──────────────────────────────────────────────────────
 *
 * A GET that changes state is reachable from anywhere a URL can be planted: an
 * `<img src="https://tableflow…/logout">` on any page signs the visitor out of
 * their till. Not a breach, but on a busy counter a forced sign-out mid-order
 * is a real cost, and the fix is one header check.
 *
 * Fetch metadata is the browser telling the server how a request came to be.
 * A user typing the address or following a link on this site arrives as a
 * top-level document navigation from `same-origin` (or `none` for a typed URL
 * or bookmark). An image tag, a script or a cross-site link cannot produce
 * that combination. Requests that carry no fetch metadata at all — a very old
 * browser, or a tool — are let through: the route is unreferenced and the
 * worst outcome is a sign-out, so it is not worth locking out a real person
 * on an old device to refuse a curl.
 *
 * Both scopes are destroyed. An operator who signs into the admin console and
 * a restaurant on the same browser expects "log out" to mean log out.
 */
export async function GET(request: NextRequest) {
  const site = request.headers.get('sec-fetch-site')
  const dest = request.headers.get('sec-fetch-dest')

  const crossSite = site === 'cross-site' || site === 'same-site'
  const notANavigation = dest !== null && dest !== 'document'
  if (crossSite || notANavigation) {
    // Nothing destroyed. Send them to the login page, which shows them as
    // still signed in if they are.
    return NextResponse.redirect(new URL('/login', request.url))
  }

  await destroySession('staff')
  await destroySession('admin')
  return NextResponse.redirect(new URL('/login', request.url))
}
