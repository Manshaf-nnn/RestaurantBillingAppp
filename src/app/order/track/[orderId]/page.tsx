import Link from 'next/link'
import { notFound } from 'next/navigation'
import type { Metadata } from 'next'

import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/feedback'
import { OrderTracker } from '@/features/orders/components/order-tracker'
import { getOrderForGuest, readOptions } from '@/features/orders/queries'
import { resolvePublicTenant } from '@/server/db/tenant'
import { BrandTheme } from '@/features/orders/components/brand-theme'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Track your order' }

export default async function TrackOrderPage({
  params,
}: {
  params: Promise<{ orderId: string }>
}) {
  const { orderId } = await params
  const restaurant = await resolvePublicTenant()
  if (!restaurant) notFound()

  const order = await getOrderForGuest(restaurant.id, orderId)

  if (!order) {
    return (
      <div className="flex min-h-dvh items-center p-6">
        <EmptyState
          className="w-full border-none"
          title="We could not find that order"
          description="This order may belong to a different device, or it is no longer available."
          action={
            <Button asChild>
              <Link href="/order/menu">Back to the menu</Link>
            </Button>
          }
        />
      </div>
    )
  }

  return (
    <BrandTheme logoUrl={restaurant.logoUrl} coverUrl={restaurant.coverUrl}>
      <OrderTracker
        restaurantName={restaurant.name}
        currency={restaurant.currency}
        locale={restaurant.locale === 'en' ? 'en-IN' : restaurant.locale}
        order={{
          id: order.id,
          orderNumber: order.orderNumber,
          status: order.status,
          tableId: order.tableId,
          tableNumber: order.table?.number ?? null,
          customerName: order.customerName,
          grandTotal: order.grandTotal,
          estimatedMinutes: order.estimatedMinutes,
          placedAt: order.placedAt.toISOString(),
          paymentStatus: order.paymentStatus,
          cancelReason: order.cancelReason,
          items: order.items.map((item) => ({
            id: item.id,
            name: item.name,
            quantity: item.quantity,
            lineTotal: item.lineTotal,
            notes: item.notes,
            isVeg: item.isVeg,
            status: item.status,
            optionsLabel: readOptions(item.options)
              .map((option) => option.name)
              .join(' · '),
          })),
        }}
      />
    </BrandTheme>
  )
}
