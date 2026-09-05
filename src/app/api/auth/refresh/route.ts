import { cookies } from 'next/headers'
import { NextResponse, type NextRequest } from 'next/server'

import { refreshCookieName, type SessionScope } from '@/server/auth/jwt'
import { rotateSession } from '@/server/auth/session'

export const dynamic = 'force-dynamic'

/**
 * Silent token refresh — scope-aware.
 *
 * Middleware redirects here when an access JWT has expired but a refresh cookie
 * remains; the client also POSTs here (no `next`) before retrying a Server
 * Action that came back unauthorised. `?scope=admin` refreshes the admin
 * session (falls back to staff). The visitor is returned to where they were
 * heading.
 *
 * ── What this route no longer does ──────────────────────────────────────────
 *
 * It used to delete the refresh cookie whenever `rotateSession` returned null.
 * That looked like hygiene and was the bug: when two tabs refreshed at once,
 * the loser found its token already rotated, got null, and deleted the cookie
 * the WINNER had just set — same cookie name, one jar — sending a user with a
 * perfectly live session to the login screen. Cookie handling now lives in
 * `rotateSession`, which clears cookies only on a genuine refusal and leaves the
 * refresh cookie alone when a sibling has just rotated it.
 */
async function handle(request: NextRequest) {
  const scope: SessionScope = request.nextUrl.searchParams.get('scope') === 'admin' ? 'admin' : 'staff'
  const store = await cookies()
  const refreshToken = store.get(refreshCookieName(scope))?.value
  const nextPath = request.nextUrl.searchParams.get('next')

  const safeNext = nextPath && nextPath.startsWith('/') && !nextPath.startsWith('//') ? nextPath : null
  const loginPath = scope === 'admin' ? '/admin/login' : '/login'

  if (!refreshToken) {
    return finish(request, safeNext, false, loginPath)
  }

  const user = await rotateSession(refreshToken, scope)
  if (!user) {
    return finish(request, safeNext, false, loginPath)
  }

  return finish(request, safeNext, true, loginPath, {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    restaurantId: user.restaurantId,
  })
}

function finish(
  request: NextRequest,
  nextPath: string | null,
  ok: boolean,
  loginPath: string,
  user?: Record<string, unknown>,
) {
  if (nextPath) {
    const target = ok
      ? new URL(nextPath, request.url)
      : new URL(`${loginPath}?next=${encodeURIComponent(nextPath)}`, request.url)
    return NextResponse.redirect(target)
  }

  return NextResponse.json(
    ok ? { ok: true, user } : { ok: false, error: 'Session expired', code: 'UNAUTHORIZED' },
    { status: ok ? 200 : 401 },
  )
}

export async function GET(request: NextRequest) {
  return handle(request)
}

export async function POST(request: NextRequest) {
  return handle(request)
}
