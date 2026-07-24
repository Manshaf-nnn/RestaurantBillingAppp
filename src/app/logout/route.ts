import { NextResponse, type NextRequest } from 'next/server'

import { destroySession } from '@/server/auth/session'

export const dynamic = 'force-dynamic'

/**
 * One-click sign-out link.
 *   GET /logout  →  clears the session and returns to the login screen.
 * Handy for switching between the demo accounts.
 */
export async function GET(request: NextRequest) {
  await destroySession()
  return NextResponse.redirect(new URL('/login', request.url))
}
