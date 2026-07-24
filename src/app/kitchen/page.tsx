import type { Metadata } from 'next'

import { KitchenBoard } from '@/features/kitchen/components/kitchen-board'
import { getKitchenQueue, getKitchenStats, readOptions } from '@/features/orders/queries'
import { PERMISSIONS, ROLE_LABELS } from '@/lib/rbac'
import { requirePagePermission } from '@/server/auth/guard'
import { requireRestaurant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Kitchen display' }

export default async function KitchenPage() {
  const user = await requirePagePermission(PERMISSIONS.KITCHEN_VIEW, '/kitchen')

  const [restaurant, queue, stats] = await Promise.all([
    requireRestaurant(user.restaurantId),
    getKitchenQueue(user.restaurantId),
    getKitchenStats(user.restaurantId),
  ])

  return (
    <KitchenBoard
      restaurantName={restaurant.name}
      user={{ name: user.name, role: ROLE_LABELS[user.role] }}
      initialStats={stats}
      initialTickets={queue.map((order) => ({
        id: order.id,
        orderNumber: order.orderNumber,
        status: order.status,
        tableNumber: order.table?.number ?? null,
        customerName: order.customerName,
        notes: order.notes,
        placedAt: order.placedAt.toISOString(),
        estimatedMinutes: order.estimatedMinutes,
        items: order.items
          .filter((item) => item.status !== 'CANCELLED')
          .map((item) => ({
            id: item.id,
            name: item.name,
            quantity: item.quantity,
            notes: item.notes,
            isVeg: item.isVeg,
            optionsLabel: readOptions(item.options)
              .map((option) => option.name)
              .join(' · '),
          })),
      }))}
    />
  )
}
