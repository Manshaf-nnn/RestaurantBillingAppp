import type { Metadata } from 'next'

import { PageHeader } from '@/features/dashboard/components/page-header'
import { OrdersTable } from '@/features/orders/components/orders-table'
import { listOrders } from '@/features/orders/queries'
import { PERMISSIONS } from '@/lib/rbac'
import { scopeToOne, selectedBranch } from '@/features/dashboard/selected-branch'
import { requirePagePermission } from '@/server/auth/guard'
import { requireRestaurant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Orders' }

export default async function OrdersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const user = await requirePagePermission(PERMISSIONS.ORDER_VIEW, '/dashboard/orders')
  const params = await searchParams
  const restaurant = await requireRestaurant(user.restaurantId)
  const selection = await selectedBranch(user, params)

  const result = await listOrders(user.restaurantId, {
    branchId: scopeToOne(selection),
    search: params.search,
    status: params.status ?? 'ALL',
    paymentStatus: params.paymentStatus ?? 'ALL',
    type: params.type ?? 'ALL',
    page: params.page ? Number(params.page) : 1,
  })

  return (
    <>
      <PageHeader title="Orders" description={`${result.total} orders`} />
      <OrdersTable
        currency={restaurant.currency}
        locale={restaurant.locale === 'en' ? 'en-IN' : restaurant.locale}
        total={result.total}
        page={result.page}
        pageCount={result.pageCount}
        filters={{
          search: params.search ?? '',
          status: params.status ?? 'ALL',
          paymentStatus: params.paymentStatus ?? 'ALL',
          type: params.type ?? 'ALL',
        }}
        orders={result.orders.map((order) => ({
          id: order.id,
          orderNumber: order.orderNumber,
          status: order.status,
          paymentStatus: order.paymentStatus,
          type: order.type,
          tableNumber: order.table?.number ?? null,
          customerName: order.customerName,
          customerPhone: order.customerPhone,
          itemCount: order.items.reduce((total, item) => total + item.quantity, 0),
          grandTotal: order.grandTotal,
          placedAt: order.placedAt.toISOString(),
        }))}
      />
    </>
  )
}
