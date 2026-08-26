import type { Metadata } from 'next'

import { listBranches } from '@/features/branches/service'
import { listRoles } from '@/features/access/service'
import { StaffManager } from '@/features/staff/components/staff-manager'
import { assignableRoles, can, PERMISSIONS, visibleBranchIds } from '@/lib/rbac'
import { requirePagePermission } from '@/server/auth/guard'
import { prisma } from '@/server/db/prisma'
import { AutoRefresh } from '@/components/auto-refresh'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Staff' }

export default async function StaffPage() {
  const user = await requirePagePermission(PERMISSIONS.STAFF_VIEW, '/dashboard/staff')

  /*
   * A branch manager sees and manages their own team, and nobody else's.
   *
   * This list used to be restaurant-wide: a Kandy manager could read every
   * employee in the chain with their email, phone and last sign-in. Null means
   * unrestricted — an owner or a group manager — and `[]` means confined with
   * no branch, which correctly shows nothing rather than everything.
   */
  const reach = visibleBranchIds({ role: user.role, branchId: user.branchId })

  const [staff, locations, customRoles] = await Promise.all([
    prisma.user.findMany({
      where: {
        restaurantId: user.restaurantId,
        deletedAt: null,
        // Someone who sees every site is not on any one team, so they are only
        // listed for people who can see every site.
        ...(reach ? { branchId: { in: reach } } : {}),
      },
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
        staffRoleId: true,
        staffRole: { select: { name: true } },
      },
    }),
    /*
     * Switched-off locations are included on purpose. Someone may still be tied
     * to one, and dropping it from the picker would show their assignment as
     * "All locations" — then quietly write that back the next time anyone saved
     * the form, handing a site-scoped account the whole chain.
     */
    listBranches(user.restaurantId),
    /*
     * Only the active ones. A switched-off role is not somebody to assign — the
     * action refuses it — and listing it in the picker would look like an
     * option that fails on save for no visible reason.
     */
    listRoles(user.restaurantId, reach).then((roles) => roles.filter((role) => role.isActive)),
  ])

  /*
   * And they can only assign somebody to a location they run. The server
   * refuses anything else anyway — `homeBranchFor` calls `assertBranchAccess`
   * — but offering the whole chain in a dropdown disclosed every location's
   * name and guaranteed an error for anyone who picked one.
   */
  const pickable = locations.filter((l) => reach === null || reach.includes(l.id))

  return (
    <>
      <AutoRefresh scope="catalog" intervalMs={10000} />
    <StaffManager
      canManage={can(user, PERMISSIONS.STAFF_MANAGE)}
      currentUserId={user.id}
      assignableRoles={assignableRoles(user.role)}
      locations={pickable.map((l) => ({ id: l.id, name: l.name, isActive: l.isActive }))}
      /*
       * "All locations" is only offered to somebody who has all of them.
       * `homeBranchFor` now refuses a blank branch from a confined creator —
       * that was the escalation route to an unscoped accountant account.
       */
      canAssignAllLocations={reach === null}
      /*
       * Only offered to somebody who may manage staff at all. `assignRole`
       * re-checks it, and also refuses a role carrying permissions this person
       * does not hold — assigning is granting.
       */
      customRoles={
        can(user, PERMISSIONS.STAFF_MANAGE)
          ? customRoles.map((role) => ({
              id: role.id,
              name: role.name,
              preset: role.preset,
              presetLabel: role.presetLabel,
            }))
          : undefined
      }
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
        staffRoleId: member.staffRoleId,
        staffRoleName: member.staffRole?.name ?? null,
      }))}
    />
    </>
  )
}
