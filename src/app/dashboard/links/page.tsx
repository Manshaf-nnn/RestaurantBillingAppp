import type { Metadata } from 'next'

import { LinksManager } from '@/features/access/components/links-manager'
import { listAccessLinks } from '@/features/access/links'
import { listRoles } from '@/features/access/service'
import { ROLE_PRESETS } from '@/features/access/schema'
import { PageHeader } from '@/features/dashboard/components/page-header'
import { selectedBranch } from '@/features/dashboard/selected-branch'
import { listLocations } from '@/features/transfers/queries'
import { PERMISSIONS, ROLE_LABELS, assignableRoles, requiresOwnBranch } from '@/lib/rbac'
import { requirePagePermission } from '@/server/auth/guard'
import { prisma } from '@/server/db/prisma'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Access links' }

/**
 * Access links.
 *
 * The page this replaced was a bare `'use client'` component with no server
 * guard of any kind — the sidebar hid it behind `staff.manage` and the page
 * itself asked for nothing, so anybody who typed the URL reached the screen
 * that mints staff sign-in links.
 */
export default async function AccessLinksPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const user = await requirePagePermission(PERMISSIONS.STAFF_MANAGE, '/dashboard/links')

  const selection = await selectedBranch(user, await searchParams)
  const reach = selection.branchIds

  const [links, locations, customRoles, staff] = await Promise.all([
    listAccessLinks(user.restaurantId, reach),
    listLocations(user.restaurantId, reach),
    listRoles(user.restaurantId, reach).then((roles) => roles.filter((role) => role.isActive)),
    /*
     * Only people this person may act on, and only within their reach. The
     * action re-checks both — a link IS an account, so it passes the same rank
     * and branch rules as creating one — but a dropdown whose entries are
     * refused on submit is worse than one that never offered them.
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
      select: { id: true, name: true, email: true },
      orderBy: { name: 'asc' },
    }),
  ])

  const allowed = new Set(assignableRoles(user.role))
  const roles = ROLE_PRESETS.filter((preset) => allowed.has(preset)).map((preset) => ({
    value: preset,
    label: ROLE_LABELS[preset],
    needsBranch: requiresOwnBranch(preset),
  }))

  return (
    <>
      <PageHeader
        title="Access links"
        description="One link per person or screen. A personal link asks for an email and code; a shared screen signs itself in."
      />
      <LinksManager
        links={links}
        roles={roles}
        customRoles={customRoles.map((role) => ({ id: role.id, name: role.name }))}
        locations={locations}
        staff={staff}
      />
    </>
  )
}
