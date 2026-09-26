import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'

import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/feedback'
import { resolvePublicBranch } from '@/features/branches/public-branch'
import { getGuestAppearance } from '@/features/guest/queries'
import { GuestLoyalty } from '@/features/loyalty/components/guest-loyalty'
import { BrandTheme } from '@/features/orders/components/brand-theme'
import { OrderTracker } from '@/features/orders/components/order-tracker'
import { getOrderForGuest, readOptions } from '@/features/orders/queries'
import { askedForPreview, qrAccess } from '@/features/qr/access'
import { qrPath } from '@/features/qr/guest-path'
import { resolveExperience } from '@/features/qr/queries'
import { localeForCurrency } from '@/lib/money'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Track your order' }

/**
 * The tracker, for a guest who came in through a QR code.
 *
 * ── Why a second tracker route ──────────────────────────────────────────────
 *
 * `/order/track/<id>` sits under a layout that resolves the restaurant from
 * the request — host, then a cookie the `/order/<slug>` middleware sets. A
 * guest who scanned a code never touched `/order/<slug>`, so they have no
 * cookie, and `/m/<code>` deliberately sets none: the code in the path already
 * names the restaurant, the branch and the configuration, and a cookie is how
 * a branch once went stale. So every delivery guest ordered, was sent to
 * `/order/track`, and met a 404 in a layout their page never got to run.
 *
 * This route keeps them under `/m/<code>`, resolving the restaurant the same
 * way every other screen on their journey does. It renders the SAME tracker
 * component — there is one tracker, mounted from two trees — with its links
 * pointed back into this one.
 */
export default async function QrTrackOrderPage({
  params,
  searchParams,
}: {
  params: Promise<{ code: string; orderId: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const [{ code, orderId }, query] = await Promise.all([params, searchParams])

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

  const restaurant = experience.restaurant

  /*
   * Scoped to the code's restaurant AND to this device's guest session — the
   * same rule as the ordinary tracker. Knowing an order id is not enough, and
   * an order from another restaurant's code resolves to nothing here.
   */
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
              <Link href={qrPath(code, 'menu')}>Back to the menu</Link>
            </Button>
          }
        />
      </div>
    )
  }

  const appearance = await getGuestAppearance(restaurant.id)
  const locale =
    restaurant.locale === 'en' ? localeForCurrency(restaurant.currency) : restaurant.locale

  return (
    <BrandTheme logoUrl={restaurant.logoUrl} coverUrl={null}>
      <OrderTracker
        restaurantName={restaurant.name}
        showSteps={appearance.trackShowSteps}
        showItems={appearance.trackShowItems}
        showBill={appearance.trackShowBill}
        allowAdding={appearance.trackAllowAdding}
        showEdit={appearance.trackShowEdit}
        currency={restaurant.currency}
        locale={locale}
        // Back into THIS tree — the menu that can add to the order, and the
        // bill — both resolved from the code, neither from a cookie.
        links={{ menu: qrPath(code, 'menu'), bill: qrPath(code, 'bill', order.id) }}
        order={{
          id: order.id,
          orderNumber: order.orderNumber,
          status: order.status,
          tableId: order.tableId,
          branchCode: order.branch?.code ?? null,
          slug: restaurant.slug,
          tableNumber: order.tableNumber ?? order.table?.number ?? null,
          type: order.type,
          deliveryLocationName: order.deliveryLocationName,
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
      {appearance.trackShowLoyalty &&
      restaurant.loyaltyEnabled &&
      experience.showLoyalty &&
      order.paymentStatus === 'UNPAID' ? (
        <div className="mx-auto w-full max-w-lg px-4 pb-6">
          <GuestLoyalty
            orderId={order.id}
            slug={restaurant.slug}
            currency={restaurant.currency}
            locale={locale}
            knownPhone={order.customerPhone || null}
          />
        </div>
      ) : null}
    </BrandTheme>
  )
}
