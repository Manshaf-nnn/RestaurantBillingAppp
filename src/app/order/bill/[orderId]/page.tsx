import Link from 'next/link'
import { notFound } from 'next/navigation'
import type { Metadata } from 'next'

import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/feedback'
import { GuestBill } from '@/features/payments/components/guest-bill'
import { readPaymentConfig } from '@/features/payments/service'
import { getOrderForGuest, readOptions } from '@/features/orders/queries'
import { resolvePublicTenant } from '@/server/db/tenant'
import { BrandTheme } from '@/features/orders/components/brand-theme'
import { localeForCurrency } from '@/lib/money'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Your bill' }

export default async function GuestBillPage({
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
          title="Bill not available"
          description="We could not find that bill on this device. Ask our staff and they will bring it over."
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
      <GuestBill
        restaurantName={restaurant.name}
        restaurantAddress={[restaurant.addressLine, restaurant.city].filter(Boolean).join(', ') || null}
        currency={restaurant.currency}
        locale={restaurant.locale === 'en' ? localeForCurrency(restaurant.currency) : restaurant.locale}
        paymentConfig={readPaymentConfig(restaurant.paymentConfig)}
        bill={{
          id: order.id,
          orderNumber: order.orderNumber,
          tableNumber: order.tableNumber ?? order.table?.number ?? null,
          customerName: order.customerName,
          customerEmail: order.customerEmail,
          placedAt: order.placedAt.toISOString(),
          paymentStatus: order.paymentStatus,
          subtotal: order.subtotal,
          discountTotal: order.discountTotal,
          loyaltyDiscount: order.loyaltyDiscount,
          serviceCharge: order.serviceCharge,
          taxTotal: order.taxTotal,
          tipAmount: order.tipAmount,
          roundingAdj: order.roundingAdj,
          grandTotal: order.grandTotal,
          paidTotal: order.paidTotal,
          taxLabel: restaurant.taxLabel,
          couponCode: order.coupon?.code ?? null,
          items: order.items.map((item) => ({
            id: item.id,
            name: item.name,
            optionsLabel: readOptions(item.options)
              .map((option) => option.name)
              .join(', '),
            quantity: item.quantity,
            unitPrice: item.unitPrice + item.optionsTotal,
            lineTotal: item.lineTotal,
          })),
        }}
      />
    </BrandTheme>
  )
}
