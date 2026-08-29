import type { Metadata } from 'next'
import { redirect } from 'next/navigation'

import { PageHeader } from '@/features/dashboard/components/page-header'
import { StationBranchPicker } from '@/features/dashboard/components/station-branch-picker'
import {
  listStationBranches,
  scopeToOne,
  selectedBranch,
} from '@/features/dashboard/selected-branch'
import { StationsManager } from '@/features/kitchen/components/stations-manager'
import { listStations, unmappedDishes } from '@/features/kitchen/service'
import { PERMISSIONS, can } from '@/lib/rbac'
import { requirePagePermission } from '@/server/auth/guard'
import { prisma } from '@/server/db/prisma'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Kitchen sections' }

/**
 * How a kitchen is divided up, and which dishes each part cooks.
 *
 * ── Why this exists as well as the one under Locations ──────────────────────
 *
 * The per-location route came first and is a fine deep link, but it was the
 * ONLY way in — reachable through a card on a location's page and nowhere else.
 * Sections are the thing every other part of this feature depends on: with none
 * created, the menu has nothing to route to and the kitchen has nothing to
 * route with. Something that central belongs in the sidebar.
 *
 * Branch-scoped the same way the kitchen and floor screens are, because a
 * section belongs to one site and "all locations" is not a kitchen.
 */
export default async function KitchenStationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const user = await requirePagePermission(
    PERMISSIONS.KITCHEN_STATION_VIEW,
    '/dashboard/kitchen-stations',
  )

  const selection = await selectedBranch(user, await searchParams)
  const branchId = scopeToOne(selection)

  if (!branchId || branchId === '__none__') {
    const choices = await listStationBranches(user)
    if (choices.length > 1) {
      return (
        <StationBranchPicker
          title="Kitchen sections"
          description="Which kitchen? Each location is divided up its own way."
          branches={choices}
          basePath="/dashboard/kitchen-stations"
        />
      )
    }
    if (choices.length === 1) redirect(`/dashboard/kitchen-stations?branch=${choices[0].id}`)

    return (
      <>
        <PageHeader
          title="Kitchen sections"
          description="How a kitchen is divided up, and which dishes each part cooks."
        />
        <p className="rounded-xl border border-border p-6 text-center text-sm text-muted-foreground">
          You are not assigned to a location, so there is no kitchen to set up.
        </p>
      </>
    )
  }

  const branch = await prisma.branch.findFirst({
    where: { id: branchId, restaurantId: user.restaurantId, deletedAt: null },
    select: { id: true, name: true },
  })
  if (!branch) redirect('/dashboard/kitchen-stations')

  const [stations, unmapped, staff] = await Promise.all([
    listStations({ restaurantId: user.restaurantId, branchId, includeRetired: true }),
    unmappedDishes(prisma, { restaurantId: user.restaurantId, branchId }),
    prisma.user.findMany({
      where: {
        restaurantId: user.restaurantId,
        isActive: true,
        OR: [{ branchId }, { branchId: null }],
      },
      select: { id: true, name: true, staffCode: true, role: true },
      orderBy: { name: 'asc' },
    }),
  ])

  return (
    <>
      <PageHeader
        title="Kitchen sections"
        description={`${branch.name} — split the kitchen into the parts it actually has, then say which one cooks each dish.`}
      />

      <StationsManager
        branchId={branchId}
        branchName={branch.name}
        canManage={can(user, PERMISSIONS.KITCHEN_STATION_MANAGE)}
        stations={stations.map((station) => ({
          id: station.id,
          name: station.name,
          description: station.description,
          printerName: station.printerName,
          sortOrder: station.sortOrder,
          isActive: station.isActive,
          dishCount: station._count.menu,
          staff: station.staff.map((row) => ({
            id: row.user.id,
            name: row.user.name,
            staffCode: row.user.staffCode,
          })),
        }))}
        unmapped={unmapped}
        staffOptions={staff.map((person) => ({
          id: person.id,
          name: person.name,
          staffCode: person.staffCode,
          role: person.role as string,
        }))}
      />
    </>
  )
}
