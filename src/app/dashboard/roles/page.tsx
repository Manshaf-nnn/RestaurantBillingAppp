import type { Metadata } from 'next'

import { PageHeader } from '@/features/dashboard/components/page-header'
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

  const [roles, locations] = await Promise.all([
    listRoles(user.restaurantId, reach),
    listLocations(user.restaurantId, reach),
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
        title="Roles"
        description="Give a job title only the features it needs. Changes reach everyone in the role straight away."
      />
      <RoleBuilder
        roles={roles}
        presets={presets}
        locations={locations}
        // "All locations" is only somebody's to grant if they have all of them.
        canAssignAllLocations={reach === null}
        grantable={grantable}
      />
    </>
  )
}
