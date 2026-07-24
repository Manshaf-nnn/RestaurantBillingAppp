import type { Metadata } from 'next'

import { TablesManager } from '@/features/floor/components/tables-manager'
import { can, PERMISSIONS } from '@/lib/rbac'
import { requirePagePermission } from '@/server/auth/guard'
import { prisma } from '@/server/db/prisma'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Tables' }

export default async function TablesPage() {
  const user = await requirePagePermission(PERMISSIONS.TABLE_VIEW, '/dashboard/tables')

  const tables = await prisma.restaurantTable.findMany({
    where: { restaurantId: user.restaurantId, isActive: true },
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
