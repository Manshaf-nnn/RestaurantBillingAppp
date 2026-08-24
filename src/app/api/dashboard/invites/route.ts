import { NextResponse, type NextRequest } from 'next/server'

import { requirePermission } from '@/server/auth/guard'
import { prisma } from '@/server/db/prisma'
import { generateToken } from '@/server/auth/password'
import { appUrl } from '@/lib/env'
import { assignableRoles, PERMISSIONS, ROLE_HOME } from '@/lib/rbac'
import type { UserRole } from '@prisma/client'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  try {
    const user = await requirePermission(PERMISSIONS.STAFF_MANAGE)
    const invites = await prisma.invite.findMany({ where: { restaurantId: user.restaurantId }, orderBy: { createdAt: 'desc' } })
    const response = invites.map((i) => ({
      id: i.id,
      role: i.role,
      expiresAt: i.expiresAt,
      isActive: i.isActive,
      url: `${appUrl()}/api/invite/accept?token=${i.token}&target=${encodeURIComponent(ROLE_HOME[i.role])}`,
      createdAt: i.createdAt,
    }))
    return NextResponse.json(response)
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 403 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await requirePermission(PERMISSIONS.STAFF_MANAGE)
    const body = await request.json().catch(() => ({})) as { role?: string; days?: number; target?: string }

    /*
     * The role has to be one this person may actually grant.
     *
     * It used to be cast straight out of the body — `(body.role ?? 'WAITER') as
     * keyof typeof ROLE_HOME` — with nothing checking it. `STAFF_MANAGE` is
     * held by every MANAGER, so a manager could POST `{"role":"ADMIN"}` to this
     * endpoint and walk through the resulting link as an administrator. The UI
     * only ever offered three roles, which is why it was never noticed: the
     * hole was one curl away and invisible from the screen.
     *
     * `assignableRoles` is the same ladder `inviteStaff` has always enforced —
     * nobody may mint their own rank or above. This endpoint was the one door
     * that skipped it.
     */
    const allowed = assignableRoles(user.role)
    const requested = (body.role ?? 'WAITER') as UserRole
    if (!allowed.includes(requested)) {
      return NextResponse.json(
        { error: `You cannot create a link for the ${requested} role` },
        { status: 403 },
      )
    }
    const role = requested
    const days = Number(body.days ?? 7)
    const target = body.target ?? ROLE_HOME[role]

    const token = generateToken(24)
    const expiresAt = new Date(Date.now() + Math.max(1, days) * 24 * 60 * 60 * 1000)

    const invite = await prisma.invite.create({
      data: {
        token,
        restaurantId: user.restaurantId,
        role,
        expiresAt,
        createdById: user.id,
      },
    })

    return NextResponse.json({
      id: invite.id,
      role: invite.role,
      expiresAt: invite.expiresAt,
      url: `${appUrl()}/api/invite/accept?token=${invite.token}&target=${encodeURIComponent(target)}`,
    })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 403 })
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const user = await requirePermission(PERMISSIONS.STAFF_MANAGE)
    const url = new URL(request.url)
    const id = url.searchParams.get('id')
    if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })
    await prisma.invite.updateMany({ where: { id, restaurantId: user.restaurantId }, data: { isActive: false } })
    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 403 })
  }
}
