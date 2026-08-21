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
   * A table stands in one building — table 4 at Kandy and table 4 at Colombo
   * are different tables — so a chosen location narrows the list, strictly.
   *
   * This used to fall back to showing tables with no branch at every location,
   * because the column was nullable and nothing wrote it, so a strict filter
   * would have shown an empty floor to a restaurant that plainly had tables.
   * Every row now has a branch and the column is NOT NULL, so the fallback is
   * not just unnecessary — it would be a lie.
   */
  const branchId = scopeToOne(await selectedBranch(user, await searchParams))

  const tables = await prisma.restaurantTable.findMany({
    where: {
      restaurantId: user.restaurantId,
      isActive: true,
      ...(branchId ? { branchId } : {}),
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
