import type { Metadata } from 'next'

import { KitchenBoard } from '@/features/kitchen/components/kitchen-board'
import { readPaperWidths } from '@/features/printing/paper'
import { getKitchenQueue, getKitchenStats, readOptions } from '@/features/orders/queries'
import { selectedBranch } from '@/features/dashboard/selected-branch'
import { PERMISSIONS, ROLE_LABELS } from '@/lib/rbac'
import { requirePagePermission } from '@/server/auth/guard'
import { requireRestaurant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Kitchen display' }

export default async function KitchenPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const user = await requirePagePermission(PERMISSIONS.KITCHEN_VIEW, '/kitchen')

/*
 * Which locations this screen shows.
 *
 * A floor screen is a physical thing in a physical room: the person reading it
 * is standing at one site. It used to pass only the restaurant id, so Kandy's
 * tickets appeared on Colombo's rail.
 *
 * The branch comes from `selectedBranch`, which reads the URL then the cookie
 * and validates both against what this user may see. For kitchen, waiter and
 * cashier staff that resolves to their own branch and cannot be widened; for an
 * owner it follows the top-bar switcher, and "All locations" still shows
 * everything — which is the one case where a combined view is meaningful, since
 * the owner is not cooking.
 */
  const { branchIds } = await selectedBranch(user, await searchParams)

  const [restaurant, queue, stats] = await Promise.all([
    requireRestaurant(user.restaurantId),
    getKitchenQueue(user.restaurantId, branchIds),
    getKitchenStats(user.restaurantId, branchIds),
  ])

  return (
    <KitchenBoard
      restaurantName={restaurant.name}
      paperWidth={readPaperWidths(restaurant.printerConfig).kitchen}
      user={{ name: user.name, role: ROLE_LABELS[user.role] }}
      initialStats={stats}
      initialTickets={queue.map((order) => ({
        id: order.id,
        orderNumber: order.orderNumber,
        type: order.type as 'DINE_IN' | 'TAKEAWAY' | 'DELIVERY',
        status: order.status,
        tableNumber: order.table?.number ?? null,
        customerName: order.customerName,
        customerPhone: order.customerPhone,
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
            status: item.status,
            optionsLabel: readOptions(item.options)
              .map((option) => option.name)
              .join(' · '),
          })),
      }))}
    />
  )
}
