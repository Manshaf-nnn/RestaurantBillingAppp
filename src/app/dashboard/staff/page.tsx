import type { Metadata } from 'next'

import { listBranches } from '@/features/branches/service'
import { StaffManager } from '@/features/staff/components/staff-manager'
import { assignableRoles, can, PERMISSIONS } from '@/lib/rbac'
import { requirePagePermission } from '@/server/auth/guard'
import { prisma } from '@/server/db/prisma'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Staff' }

export default async function StaffPage() {
  const user = await requirePagePermission(PERMISSIONS.STAFF_VIEW, '/dashboard/staff')

  const [staff, locations] = await Promise.all([
    prisma.user.findMany({
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
        branchId: true,
        branch: { select: { name: true } },
      },
    }),
    /*
     * Switched-off locations are included on purpose. Someone may still be tied
     * to one, and dropping it from the picker would show their assignment as
     * "All locations" — then quietly write that back the next time anyone saved
     * the form, handing a site-scoped account the whole chain.
     */
    listBranches(user.restaurantId),
  ])

  return (
    <StaffManager
      canManage={can(user, PERMISSIONS.STAFF_MANAGE)}
      currentUserId={user.id}
      assignableRoles={assignableRoles(user.role)}
      locations={locations.map((l) => ({ id: l.id, name: l.name, isActive: l.isActive }))}
      staff={staff.map((member) => ({
        id: member.id,
        name: member.name,
        email: member.email,
        phone: member.phone,
        role: member.role,
        isActive: member.isActive,
        lastLoginAt: member.lastLoginAt?.toISOString() ?? null,
        branchId: member.branchId,
        branchName: member.branch?.name ?? null,
      }))}
    />
  )
}
