import { NextResponse, type NextRequest } from 'next/server'

import { prisma } from '@/server/db/prisma'
import { hashPassword, generateToken } from '@/server/auth/password'
import { createSession } from '@/server/auth/session'
import { appUrl } from '@/lib/env'

export const runtime = 'edge'
export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  try {
    const url = new URL(request.url)
    const token = url.searchParams.get('token')
    const target = url.searchParams.get('target') ?? '/'
    if (!token) return NextResponse.json({ error: 'token is required' }, { status: 400 })

    const invite = await prisma.invite.findUnique({ where: { token } })
    if (!invite || !invite.isActive) return NextResponse.json({ error: 'invalid or inactive invite' }, { status: 404 })
    if (invite.expiresAt && invite.expiresAt < new Date()) return NextResponse.json({ error: 'invite expired' }, { status: 410 })

    const email = `invite+${invite.token}@invites.local`

    let user = await prisma.user.findFirst({ where: { email, restaurantId: invite.restaurantId } })
    if (!user) {
      const pwd = generateToken(12)
      const hash = await hashPassword(pwd)
      user = await prisma.user.create({
        data: {
          email,
          passwordHash: hash,
          name: `${invite.role} (invite)` ,
          role: invite.role,
          restaurantId: invite.restaurantId,
          isActive: true,
        },
      })
    }

    // Issue session cookies for this user (staff scope)
    await createSession(user.id)

    // Redirect to the desired path within the app
    const dest = `${appUrl()}${target.startsWith('/') ? target : `/${target}`}`
    return NextResponse.redirect(dest)
  } catch (err: any) {
    return NextResponse.json({ error: String(err?.message ?? err) }, { status: 500 })
  }
}
