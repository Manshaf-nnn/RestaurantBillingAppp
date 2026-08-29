import type { Metadata } from 'next'
import { notFound, redirect } from 'next/navigation'

import { AutoRefresh } from '@/components/auto-refresh'
import { StationBoard } from '@/features/kitchen/components/station-board'
import { getStationQueue } from '@/features/kitchen/queries'
import { listStations, stationsFor } from '@/features/kitchen/service'
import { scopeToOne, selectedBranch } from '@/features/dashboard/selected-branch'
import { PERMISSIONS, can } from '@/lib/rbac'
import { requirePagePermission } from '@/server/auth/guard'
import { prisma } from '@/server/db/prisma'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Kitchen section' }

/**
 * One section's screen.
 *
 * ── The id in the URL proves nothing ────────────────────────────────────────
 *
 * A section id is just a string somebody can type. The branch is resolved from
 * the signed-in account the same way every other station screen does it, and
 * then the section is looked up *within that branch* — so pasting another
 * site's id lands on a not-found rather than on their dinner service.
 *
 * ── Who may stand here ──────────────────────────────────────────────────────
 *
 * A cook assigned to sections sees only those. A cook assigned to none sees any
 * of them, which is the right default for a small kitchen where everybody
 * covers everything — the alternative is a newly hired chef staring at a locked
 * screen until somebody remembers to tick a box.
 */
export default async function StationPage({
  params,
  searchParams,
}: {
  params: Promise<{ stationId: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { stationId } = await params
  const user = await requirePagePermission(PERMISSIONS.KITCHEN_VIEW, `/kitchen/${stationId}`)

  const selection = await selectedBranch(user, await searchParams)
  const branchId = scopeToOne(selection)
  if (!branchId || branchId === '__none__') redirect('/kitchen')

  const station = await prisma.kitchenStation.findFirst({
    where: { id: stationId, restaurantId: user.restaurantId, branchId, isActive: true },
    select: { id: true, name: true, description: true },
  })
  if (!station) notFound()

  const allowed = await stationsFor({
    restaurantId: user.restaurantId,
    branchId,
    userId: user.id,
  })
  // `null` means "not assigned to any section", which reads as all of them.
  if (allowed !== null && !allowed.includes(station.id)) notFound()

  const [items, siblings] = await Promise.all([
    getStationQueue({ restaurantId: user.restaurantId, branchId, stationId: station.id }),
    listStations({ restaurantId: user.restaurantId, branchId }),
  ])

  const mine = siblings.filter((s) => allowed === null || allowed.includes(s.id))

  return (
    <>
      {/*
        Item writes already move the `ops` pulse token, because it watches
        MAX(order_items.updatedAt) — so a section refreshes when any other
        section touches the same order, with no new plumbing.
      */}
      <AutoRefresh scope="ops" intervalMs={2500} />
      <StationBoard
        stationId={station.id}
        stationName={station.name}
        items={items}
        siblings={mine.map((s) => ({ id: s.id, name: s.name }))}
        canReassign={can(user, PERMISSIONS.KITCHEN_REASSIGN)}
      />
    </>
  )
}
