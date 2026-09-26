import Link from 'next/link'
import { notFound } from 'next/navigation'
import type { Metadata } from 'next'

import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/feedback'
import { GuestBill } from '@/features/payments/components/guest-bill'
import { readReceiptFields } from '@/features/printing/receipt-fields'
import { readPaymentConfig } from '@/features/payments/service'
import { getOrderForGuest, readOptions } from '@/features/orders/queries'
import { resolvePublicBranch } from '@/features/branches/public-branch'
import { resolvePublicTenant } from '@/server/db/tenant'
import { askedForPreview, qrAccess } from '@/features/qr/access'
import { qrPath } from '@/features/qr/guest-path'
import { resolveExperience } from '@/features/qr/queries'
import { BrandTheme } from '@/features/orders/components/brand-theme'
import { localeForCurrency } from '@/lib/money'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Your bill' }

/**
 * The bill, for a guest who came in through a QR code — the same `GuestBill`
 * the `/order` tree mounts, reached without the cookie that tree needs.
 */
export default async function GuestBillPage({
  params,
  searchParams,
}: {
  params: Promise<{ code: string; orderId: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const [{ code, orderId }, query] = await Promise.all([params, searchParams])

  /*
   * Resolved from the code in the path, like every other screen on a QR
   * guest's journey. `/order/bill` resolves the restaurant from a cookie that
   * a scanned guest never has — so "View bill" from their tracker was a 404.
   * The slug is passed to `resolvePublicTenant` EXPLICITLY, which is its
   * path-slug branch and reads no cookie at all.
   */
  const experience = await resolveExperience(code)
  if (!experience) notFound()
  const access = await qrAccess({ experience, asked: askedForPreview(query.preview) })
  if (!access.allowed) notFound()

  /*
   * Re-resolved rather than trusted from the row, exactly as the menu and
   * cart pages do: a location that has since been closed, deleted or turned
   * into a warehouse stops serving its guests' screens, tracker included.
   */
  const branch = await resolvePublicBranch(experience.restaurantId, experience.branch.code).catch(
    () => null,
  )
  if (!branch) notFound()

  const restaurant = await resolvePublicTenant(experience.restaurant.slug)
  if (!restaurant || restaurant.id !== experience.restaurantId) notFound()

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
              <Link href={qrPath(code, 'menu')}>Back to the menu</Link>
            </Button>
          }
        />
      </div>
    )
  }

  return (
    <BrandTheme logoUrl={restaurant.logoUrl} coverUrl={restaurant.coverUrl}>
      <GuestBill
        links={{ track: qrPath(code, 'track', order.id), menu: qrPath(code, 'menu') }}
        restaurantName={restaurant.name}
        restaurantAddress={[restaurant.addressLine, restaurant.city].filter(Boolean).join(', ') || null}
        currency={restaurant.currency}
        locale={restaurant.locale === 'en' ? localeForCurrency(restaurant.currency) : restaurant.locale}
        paymentConfig={readPaymentConfig(restaurant.paymentConfig)}
        fields={readReceiptFields(restaurant.receiptConfig)}
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
