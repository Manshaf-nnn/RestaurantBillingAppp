import type { Metadata } from 'next'

import { StaffManager } from '@/features/staff/components/staff-manager'
import { assignableRoles, can, PERMISSIONS } from '@/lib/rbac'
import { requirePagePermission } from '@/server/auth/guard'
import { prisma } from '@/server/db/prisma'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Staff' }

export default async function StaffPage() {
  const user = await requirePagePermission(PERMISSIONS.STAFF_VIEW, '/dashboard/staff')

  const staff = await prisma.user.findMany({
    where: { restaurantId: user.restaurantId, deletedAt: null },
    orderBy: [{ role: 'asc' }, { name: 'asc' }],
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      role: true,
      isActive: true,
      lastLoginAt: true,
    },
  })

  return (
    <StaffManager
      canManage={can(user, PERMISSIONS.STAFF_MANAGE)}
      currentUserId={user.id}
      assignableRoles={assignableRoles(user.role)}
      staff={staff.map((member) => ({
        id: member.id,
        name: member.name,
        email: member.email,
        phone: member.phone,
        role: member.role,
        isActive: member.isActive,
        lastLoginAt: member.lastLoginAt?.toISOString() ?? null,
      }))}
    />
  )
}
