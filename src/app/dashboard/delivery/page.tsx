import type { Metadata } from 'next'

import { PageHeader } from '@/features/dashboard/components/page-header'
import { AutoRefresh } from '@/components/auto-refresh'
import { DeliveryDesk } from '@/features/orders/components/delivery-desk'
import { getDeliveryQueue, readOptions } from '@/features/orders/queries'
import { selectedBranch } from '@/features/dashboard/selected-branch'
import { localeForCurrency } from '@/lib/money'
import { PERMISSIONS } from '@/lib/rbac'
import { requirePagePermission } from '@/server/auth/guard'
import { requireRestaurant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Delivery Desk' }

/**
 * Deliveries waiting at the door.
 *
 * ── Ready, and only ready ───────────────────────────────────────────────────
 *
 * An order reaches this screen the moment the kitchen marks it READY and
 * leaves it the moment the PIN closes it. Everything before that belongs to
 * the till's Delivery tab, where somebody accepts the order and sends it to
 * be cooked; this screen is the last step and shows nothing a person standing
 * at a door cannot act on.
 *
 * ── The PIN is not loaded ───────────────────────────────────────────────────
 *
 * `getDeliveryQueue` selects no `deliveryPin`, so it is absent from this page,
 * from the payload behind it and from anything the browser can be made to
 * reveal. Checking it is `completeDelivery`'s job and the server's alone.
 */
export default async function DeliveryDeskPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const user = await requirePagePermission(PERMISSIONS.ORDER_UPDATE_STATUS, '/dashboard/delivery')
  const restaurant = await requireRestaurant(user.restaurantId)
  const params = await searchParams

  /*
   * The same branch scoping every other staff screen uses, so a rider at one
   * site is not handed another site's doors. `completeDelivery` checks it
   * again against the order it locked.
   */
  const selection = await selectedBranch(user, params)
  const queue = await getDeliveryQueue(user.restaurantId, selection.branchIds)

  const rows = queue
    .filter((order) => order.status === 'READY')
    .map((order) => {
      const paid = order.payments
        .filter((payment) => payment.status === 'PAID')
        .reduce((sum, payment) => sum + payment.amount, 0)
      return {
        id: order.id,
        orderNumber: order.orderNumber,
        customerName: order.customerName,
        customerPhone: order.customerPhone || null,
        // The snapshot, so a place since renamed still reads as it was chosen.
        place: order.deliveryLocationName,
        placeNote: order.deliveryLocation?.note ?? null,
        placedAt: order.placedAt.toISOString(),
        readyAt: order.readyAt?.toISOString() ?? null,
        grandTotal: order.grandTotal,
        outstanding: Math.max(0, order.grandTotal + order.tipAmount - paid),
        items: order.items.map((item) => ({
          id: item.id,
          name: item.name,
          quantity: item.quantity,
          options: readOptions(item.options)
            .map((option) => option.name)
            .join(' · '),
          notes: item.notes,
        })),
      }
    })

  return (
    <>
      {/* The kitchen marks orders ready while this screen is open. */}
      <AutoRefresh scope="orders" intervalMs={15000} />
      <PageHeader
        title="Delivery Desk"
        description="Orders the kitchen has marked ready. Confirm the customer's PIN to close one."
      />
      <DeliveryDesk
        rows={rows}
        currency={restaurant.currency}
        locale={restaurant.locale === 'en' ? localeForCurrency(restaurant.currency) : restaurant.locale}
        timeZone={restaurant.timezone}
      />
    </>
  )
}
