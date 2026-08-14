import { NextResponse, type NextRequest } from 'next/server'

import { requirePermission } from '@/server/auth/guard'
import { prisma } from '@/server/db/prisma'
import { generateToken } from '@/server/auth/password'
import { appUrl } from '@/lib/env'
import { PERMISSIONS, ROLE_HOME, type Permission } from '@/lib/rbac'

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
  } catch (err: any) {
    return NextResponse.json({ error: String(err?.message ?? err) }, { status: 403 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await requirePermission(PERMISSIONS.STAFF_MANAGE)
    const body = await request.json().catch(() => ({})) as { role?: string; days?: number; target?: string }
    const role = (body.role ?? 'WAITER') as keyof typeof ROLE_HOME
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
  } catch (err: any) {
    return NextResponse.json({ error: String(err?.message ?? err) }, { status: 403 })
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
  } catch (err: any) {
    return NextResponse.json({ error: String(err?.message ?? err) }, { status: 403 })
  }
}
