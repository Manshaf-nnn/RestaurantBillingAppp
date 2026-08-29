import type { Metadata } from 'next'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { notFound } from 'next/navigation'

import { PageHeader } from '@/features/dashboard/components/page-header'
import { StationsManager } from '@/features/kitchen/components/stations-manager'
import { listStations, unmappedDishes } from '@/features/kitchen/service'
import { PERMISSIONS, can, canAccessBranch } from '@/lib/rbac'
import { requirePagePermission } from '@/server/auth/guard'
import { prisma } from '@/server/db/prisma'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Kitchen sections' }

/**
 * The sections this kitchen is divided into.
 *
 * ── Why it hangs off a location ─────────────────────────────────────────────
 *
 * A section belongs to one site. Two branches rarely have the same layout — one
 * has a pizza oven, the other sends pizza through the main kitchen — and an
 * order taken at one must never surface on the other's screen. Putting the
 * screen under the location makes the scope obvious rather than something a
 * branch picker decides.
 *
 * Guarded on the kitchen-section permission rather than the location one, which
 * is also the right meaning: switching **Kitchen sections** off for a role
 * should hide this, while switching **Locations** off should not.
 */
export default async function KitchenStationsPage({
  params,
}: {
  params: Promise<{ branchId: string }>
}) {
  const { branchId } = await params
  const user = await requirePagePermission(
    PERMISSIONS.KITCHEN_STATION_VIEW,
    `/dashboard/locations/${branchId}/kitchen-stations`,
  )

  // Before anything is read. The permission says "may see kitchen sections"; it
  // does not say whose, and the id came from the URL.
  if (!canAccessBranch(user, branchId)) notFound()

  const branch = await prisma.branch.findFirst({
    where: { id: branchId, restaurantId: user.restaurantId, deletedAt: null },
    select: { id: true, name: true, type: true },
  })
  if (!branch) notFound()

  const [stations, unmapped, staff] = await Promise.all([
    listStations({ restaurantId: user.restaurantId, branchId, includeRetired: true }),
    unmappedDishes(prisma, { restaurantId: user.restaurantId, branchId }),
    /*
     * Anyone who can work a kitchen rail is a candidate. Confined accounts are
     * narrowed to this branch; an owner or manager who spans sites is offered
     * everywhere, because they legitimately cover more than one.
     */
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
      <Link
        href={`/dashboard/locations/${branchId}`}
        className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        {branch.name}
      </Link>

      <PageHeader
        title="Kitchen sections"
        description={`How ${branch.name}'s kitchen is divided up, and which dishes each section cooks.`}
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
