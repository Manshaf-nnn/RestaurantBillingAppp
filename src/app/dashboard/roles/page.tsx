import type { Metadata } from 'next'

import { PageHeader } from '@/features/dashboard/components/page-header'
import { AccessTabs } from '@/features/access/components/access-tabs'
import { RoleBuilder } from '@/features/access/components/role-builder'
import { ROLE_PRESETS } from '@/features/access/schema'
import { listRoles } from '@/features/access/service'
import { selectedBranch } from '@/features/dashboard/selected-branch'
import { listLocations } from '@/features/transfers/queries'
import {
  PERMISSIONS,
  ROLE_LABELS,
  ROLE_PERMISSIONS,
  assignableRoles,
  permissionsFor,
  requiresOwnBranch,
} from '@/lib/rbac'
import { requirePagePermission } from '@/server/auth/guard'
import { prisma } from '@/server/db/prisma'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Roles' }

/**
 * The role builder.
 *
 * Everything the grid needs is computed here, on the server, and handed down
 * as data — the dominant pattern in this codebase (`canManage={can(user, …)}`
 * at about thirty call sites). In particular `grantable` is the signed-in
 * person's own permission set: the server refuses anything beyond it anyway,
 * but a switch that always fails is worse than one that is greyed out with a
 * reason next to it.
 */
export default async function RolesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const user = await requirePagePermission(PERMISSIONS.STAFF_MANAGE, '/dashboard/roles')

  const selection = await selectedBranch(user, await searchParams)
  const reach = selection.branchIds

  const [roles, locations, staff] = await Promise.all([
    listRoles(user.restaurantId, reach),
    listLocations(user.restaurantId, reach),
    /*
     * Who can be put on a new role as it is created — the same list the
     * links screen offers, for the same reason: only people this person may
     * act on, only within their reach, only switched on. `planAssignment`
     * re-checks every one of those on submit; this stops the picker offering
     * a name the server would refuse.
     */
    prisma.user.findMany({
      where: {
        restaurantId: user.restaurantId,
        deletedAt: null,
        isActive: true,
        role: { in: assignableRoles(user.role) },
        ...(reach ? { branchId: { in: reach } } : {}),
        // The synthetic accounts behind shared-screen links are not people.
        email: { not: { contains: '@invites.local' } },
      },
      select: {
        id: true,
        name: true,
        role: true,
        branchId: true,
        branch: { select: { name: true } },
        staffRole: { select: { name: true } },
      },
      orderBy: { name: 'asc' },
    }),
  ])

  /*
   * Only the presets this person may actually hand out. `assignableRoles` is
   * the same ladder the staff form uses — nobody mints their own rank or above
   * — and offering the rest would be a dropdown whose choices are refused on
   * submit.
   */
  const allowed = new Set(assignableRoles(user.role))
  const presets = ROLE_PRESETS.filter((preset) => allowed.has(preset)).map((preset) => ({
    value: preset,
    label: ROLE_LABELS[preset],
    permissions: ROLE_PERMISSIONS[preset] as string[],
    needsBranch: requiresOwnBranch(preset),
  }))

  const grantable = [...permissionsFor(user)]

  return (
    <>
      <PageHeader
        title="Role &amp; access"
        description="Give a job title only the features it needs. Changes reach everyone in the role straight away."
      />
      <AccessTabs active="roles" />
      <RoleBuilder
        roles={roles}
        presets={presets}
        locations={locations}
        staff={staff.map((member) => ({
          id: member.id,
          name: member.name,
          roleLabel: member.staffRole?.name ?? ROLE_LABELS[member.role],
          branchId: member.branchId,
          branchName: member.branch?.name ?? null,
        }))}
        // "All locations" is only somebody's to grant if they have all of them.
        canAssignAllLocations={reach === null}
        grantable={grantable}
      />
    </>
  )
}
