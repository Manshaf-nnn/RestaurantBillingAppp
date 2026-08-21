import type { Metadata } from 'next'

import { TablesManager } from '@/features/floor/components/tables-manager'
import { can, PERMISSIONS } from '@/lib/rbac'
import { scopeToOne, selectedBranch } from '@/features/dashboard/selected-branch'
import { requirePagePermission } from '@/server/auth/guard'
import { prisma } from '@/server/db/prisma'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Tables' }

export default async function TablesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const user = await requirePagePermission(PERMISSIONS.TABLE_VIEW, '/dashboard/tables')

  /*
   * A table stands in one building — table 4 at Kandy and table 4 at Colombo are
   * different tables — so a chosen location narrows the list.
   *
   * Tables with no location are shown at every location rather than nowhere.
   * `RestaurantTable.branchId` is nullable and no screen has ever written it, so
   * a strict filter would show an empty floor plan to a restaurant that plainly
   * has tables. Unassigned means "not yet decided", not "belongs to no one".
   */
  const branchId = scopeToOne(await selectedBranch(user, await searchParams))

  const tables = await prisma.restaurantTable.findMany({
    where: {
      restaurantId: user.restaurantId,
      isActive: true,
      ...(branchId ? { OR: [{ branchId }, { branchId: null }] } : {}),
    },
    orderBy: [{ area: 'asc' }, { sortOrder: 'asc' }, { number: 'asc' }],
    include: {
      _count: {
        select: { orders: { where: { status: { notIn: ['COMPLETED', 'CANCELLED'] } } } },
      },
    },
  })

  return (
    <TablesManager
      canManage={can(user, PERMISSIONS.TABLE_MANAGE)}
      tables={tables.map((table) => ({
        id: table.id,
        number: table.number,
        label: table.label,
        area: table.area,
        capacity: table.capacity,
        status: table.status,
        notes: table.notes,
        openOrders: table._count.orders,
      }))}
    />
  )
}
