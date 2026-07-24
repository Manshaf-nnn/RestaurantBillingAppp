import { cookies } from 'next/headers'
import { NextResponse, type NextRequest } from 'next/server'

import { REFRESH_COOKIE } from '@/server/auth/jwt'
import { rotateSession } from '@/server/auth/session'

export const dynamic = 'force-dynamic'

/**
 * Silent token refresh.
 *
 * Middleware redirects here when the access JWT has expired but a refresh
 * cookie is still present; the refresh token is rotated and the visitor is
 * returned to where they were heading. Called directly (no `next` param) it
 * behaves as a JSON endpoint for client-side retry logic.
 */
async function handle(request: NextRequest) {
  const store = await cookies()
  const refreshToken = store.get(REFRESH_COOKIE)?.value
  const nextPath = request.nextUrl.searchParams.get('next')

  const safeNext = nextPath && nextPath.startsWith('/') && !nextPath.startsWith('//') ? nextPath : null

  if (!refreshToken) {
    return finish(request, safeNext, false)
  }

  const user = await rotateSession(refreshToken)
  if (!user) {
    // The session was revoked or expired — clear the stale cookies.
    store.delete(REFRESH_COOKIE)
    return finish(request, safeNext, false)
  }

  return finish(request, safeNext, true, {
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
  user?: Record<string, unknown>,
) {
  if (nextPath) {
    const target = ok
      ? new URL(nextPath, request.url)
      : new URL(`/login?next=${encodeURIComponent(nextPath)}`, request.url)
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
