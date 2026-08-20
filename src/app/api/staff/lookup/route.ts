import { NextResponse, type NextRequest } from 'next/server'

import { prisma } from '@/server/db/prisma'
import { resolvePublicTenant } from '@/server/db/tenant'
import { enforceRateLimit } from '@/server/security/rate-limit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Turn a staff code into a name and email for the sign-in page.
 *
 * Unauthenticated by necessity — it runs before anyone has signed in — so it
 * returns only what a colleague already knows: whose code it is and the email
 * to type. It never reveals a password, a role's permissions, or whether an
 * account is locked, and it is rate limited so the code space cannot be walked
 * to enumerate staff.
 *
 * The code identifies; the password still authenticates. Nothing here grants
 * access to anything.
 */
export async function GET(request: NextRequest) {
  try {
    await enforceRateLimit('login')

    const code = request.nextUrl.searchParams.get('code')?.trim().toUpperCase()
    if (!code || code.length > 16) return NextResponse.json({ found: false })

    const tenant = await resolvePublicTenant()
    if (!tenant) return NextResponse.json({ found: false })

    const staff = await prisma.user.findFirst({
      where: { restaurantId: tenant.id, staffCode: code, isActive: true, deletedAt: null },
      select: { name: true, email: true, role: true },
    })
    if (!staff) return NextResponse.json({ found: false })

    return NextResponse.json({ found: true, name: staff.name, email: staff.email, role: staff.role })
  } catch {
    // A lookup failure must never block signing in the ordinary way.
    return NextResponse.json({ found: false })
  }
}
