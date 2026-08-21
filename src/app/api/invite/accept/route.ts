import { NextResponse, type NextRequest } from 'next/server'

import { prisma } from '@/server/db/prisma'
import { hashPassword, generateToken } from '@/server/auth/password'
import { createSession } from '@/server/auth/session'
import { enforceRateLimit } from '@/server/security/rate-limit'
import { nextStaffCode } from '@/features/staff/codes'
import { appUrl } from '@/lib/env'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * A share link: one URL that signs a shared device in as a role.
 *
 * This is intentionally not a personal login. A kitchen tablet or a counter
 * screen gets a link, and whoever holds it gets that role until the invite
 * expires or is switched off — so the link IS the credential and must be treated
 * like one. Individual staff should use their own email and sign-in code
 * instead, which is what /dashboard/staff/codes hands out.
 *
 * Deliberately NOT single-use: a shared screen reopens it after every reboot.
 */
export async function GET(request: NextRequest) {
  try {
    const url = new URL(request.url)
    const token = url.searchParams.get('token')
    const target = url.searchParams.get('target') ?? '/'
    if (!token) return NextResponse.json({ error: 'token is required' }, { status: 400 })

    // The token is the only thing standing between a stranger and a staff
    // session, so the guess rate has to be bounded like any other login.
    await enforceRateLimit('login')

    const invite = await prisma.invite.findUnique({ where: { token } })
    if (!invite || !invite.isActive) return NextResponse.json({ error: 'invalid or inactive invite' }, { status: 404 })
    if (invite.expiresAt && invite.expiresAt < new Date()) return NextResponse.json({ error: 'invite expired' }, { status: 410 })

    // The tenant must be live, or this hands out a session into a suspended
    // restaurant that every page would then bounce.
    const restaurant = await prisma.restaurant.findFirst({
      where: { id: invite.restaurantId, status: 'ACTIVE', isActive: true },
      select: { id: true },
    })
    if (!restaurant) return NextResponse.json({ error: 'this restaurant is not active' }, { status: 403 })

    const email = `invite+${invite.token}@invites.local`

    let user = await prisma.user.findFirst({ where: { email, restaurantId: invite.restaurantId } })
    if (!user) {
      const pwd = generateToken(12)
      const hash = await hashPassword(pwd)
      user = await prisma.user.create({
        data: {
          email,
          passwordHash: hash,
          name: `${invite.role} (shared link)`,
          role: invite.role,
          restaurantId: invite.restaurantId,
          isActive: true,
          // Without a code this device's orders are unattributable, and "who
          // served table 4" is the whole point of staff codes.
          staffCode: await nextStaffCode(prisma, invite.restaurantId),
        },
      })
    }
    if (!user.isActive || user.deletedAt) {
      return NextResponse.json({ error: 'this link has been disabled' }, { status: 403 })
    }

    await createSession(user.id)

    /*
     * `target` comes from the query string. A leading `//` or a backslash makes
     * a browser read what follows as a host, so `?target=//evil.example` would
     * send someone straight off the site from a link that looks like ours.
     */
    const safeTarget =
      target.startsWith('/') && !target.startsWith('//') && !target.includes('\\') ? target : '/'
    return NextResponse.redirect(`${appUrl()}${safeTarget}`)
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}
