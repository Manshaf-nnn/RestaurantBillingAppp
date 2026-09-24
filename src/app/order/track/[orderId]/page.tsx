import Link from 'next/link'
import { notFound } from 'next/navigation'
import type { Metadata } from 'next'

import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/feedback'
import { OrderTracker } from '@/features/orders/components/order-tracker'
import { getOrderForGuest, readOptions } from '@/features/orders/queries'
import { getGuestAppearance } from '@/features/guest/queries'
import { resolvePublicTenant } from '@/server/db/tenant'
import { BrandTheme } from '@/features/orders/components/brand-theme'
import { GuestLoyalty } from '@/features/loyalty/components/guest-loyalty'
import { localeForCurrency } from '@/lib/money'

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

  // The same setting the welcome screen, the menu and the checkout read.
  const appearance = await getGuestAppearance(restaurant.id)

  return (
    <BrandTheme logoUrl={restaurant.logoUrl} coverUrl={restaurant.coverUrl}>
      <OrderTracker
        restaurantName={restaurant.name}
        showSteps={appearance.trackShowSteps}
        showItems={appearance.trackShowItems}
        showBill={appearance.trackShowBill}
        allowAdding={appearance.trackAllowAdding}
        showEdit={appearance.trackShowEdit}
        currency={restaurant.currency}
        locale={restaurant.locale === 'en' ? localeForCurrency(restaurant.currency) : restaurant.locale}
        order={{
          id: order.id,
          orderNumber: order.orderNumber,
          status: order.status,
          tableId: order.tableId,
          branchCode: order.branch?.code ?? null,
          slug: restaurant.slug,
          tableNumber: order.tableNumber ?? order.table?.number ?? null,
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
            preparedQty: item.preparedQty,
            servedQty: item.servedQty,
            optionsLabel: readOptions(item.options)
              .map((option) => option.name)
              .join(' · '),
          })),
        }}
      />
      {/*
        Loyalty, on the screen the guest is already looking at (loyalty spec).
        Only while the bill is unpaid: after settlement there is nothing to
        spend a reward against, and the points earned are already theirs.
      */}
      {appearance.trackShowLoyalty && restaurant.loyaltyEnabled && order.paymentStatus === 'UNPAID' ? (
        <div className="mx-auto w-full max-w-lg px-4 pb-6">
          <GuestLoyalty
            orderId={order.id}
            slug={restaurant.slug}
            currency={restaurant.currency}
            locale={restaurant.locale === 'en' ? localeForCurrency(restaurant.currency) : restaurant.locale}
            knownPhone={order.customerPhone || null}
          />
        </div>
      ) : null}
    </BrandTheme>
  )
}
