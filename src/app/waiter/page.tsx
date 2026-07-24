import type { Metadata } from 'next'

import { WaiterBoard, type WaiterOrder } from '@/features/waiter/components/waiter-board'
import { getWaiterBoard } from '@/features/orders/queries'
import { PERMISSIONS, ROLE_LABELS } from '@/lib/rbac'
import { requirePagePermission } from '@/server/auth/guard'
import { requireRestaurant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Waiter station' }

type BoardOrder = Awaited<ReturnType<typeof getWaiterBoard>>['ready'][number]

function toWaiterOrder(order: BoardOrder): WaiterOrder {
  return {
    id: order.id,
    orderNumber: order.orderNumber,
    status: order.status as WaiterOrder['status'],
    tableNumber: order.table?.number ?? null,
    customerName: order.customerName,
    grandTotal: order.grandTotal,
    readyAt: order.readyAt?.toISOString() ?? null,
    placedAt: order.placedAt.toISOString(),
    items: order.items
      .filter((item) => item.status !== 'CANCELLED')
      .map((item) => ({
        id: item.id,
        name: item.name,
        quantity: item.quantity,
        isVeg: item.isVeg,
        notes: item.notes,
      })),
  }
}

export default async function WaiterPage() {
  const user = await requirePagePermission(PERMISSIONS.WAITER_VIEW, '/waiter')

  const [restaurant, board] = await Promise.all([
    requireRestaurant(user.restaurantId),
    getWaiterBoard(user.restaurantId),
  ])

  return (
    <WaiterBoard
      restaurantName={restaurant.name}
      currency={restaurant.currency}
      locale={restaurant.locale === 'en' ? 'en-IN' : restaurant.locale}
      user={{ name: user.name, role: ROLE_LABELS[user.role] }}
      initialReady={board.ready.map(toWaiterOrder)}
      initialServing={board.serving.map(toWaiterOrder)}
      initialRequests={board.requests.map((request) => ({
        id: request.id,
        tableNumber: request.table.number,
        type: request.type,
        note: request.note,
        createdAt: request.createdAt.toISOString(),
      }))}
      initialTables={board.tables.map((table) => ({
        id: table.id,
        number: table.number,
        label: table.label,
        area: table.area,
        capacity: table.capacity,
        status: table.status,
        openOrders: table.orders.map((order) => ({
          id: order.id,
          orderNumber: order.orderNumber,
          status: order.status,
          grandTotal: order.grandTotal,
          paymentStatus: order.paymentStatus,
        })),
      }))}
    />
  )
}
