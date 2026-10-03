import type { Metadata } from 'next'
import Link from 'next/link'
import { BarChart3 } from 'lucide-react'

import { Button } from '@/components/ui/button'

import { PageHeader, SectionCard, StatCard } from '@/features/dashboard/components/page-header'
import { getRiderPay } from '@/features/orders/rider-pay'
import { resolveRange } from '@/features/reports/range'
import { AutoRefresh } from '@/components/auto-refresh'
import { DeliveryDesk } from '@/features/orders/components/delivery-desk'
import { getDeliveryQueue, readOptions } from '@/features/orders/queries'
import { selectedBranch } from '@/features/dashboard/selected-branch'
import { formatMoney, localeForCurrency } from '@/lib/money'
import { PERMISSIONS, can } from '@/lib/rbac'
import { requirePagePermission } from '@/server/auth/guard'
import { requireRestaurant } from '@/server/db/tenant'
import { outstandingOn } from '@/features/orders/pricing'

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
  const today = resolveRange({ preset: 'TODAY', timeZone: restaurant.timezone })
  const month = resolveRange({ preset: 'THIS_MONTH', timeZone: restaurant.timezone })
  const seesEveryone = can(user, PERMISSIONS.REPORT_SALES)
  const [queue, pay] = await Promise.all([
    getDeliveryQueue(user.restaurantId, selection.branchIds),
    getRiderPay({
      restaurantId: user.restaurantId,
      branchIds: selection.branchIds,
      riderId: user.id,
      today,
      month,
      // Everybody's figures are the owner's to see; a rider sees their own.
      everyone: seesEveryone,
    }),
  ])
  const locale = restaurant.locale === 'en' ? localeForCurrency(restaurant.currency) : restaurant.locale
  const money = (minor: number) => formatMoney(minor, restaurant.currency, locale)
  const rate = pay.rate

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
        outstanding: outstandingOn({ ...order, paidTotal: paid }),
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
        actions={
          // The report is money; riders who use the desk hold only the status permission.
          can(user, PERMISSIONS.REPORT_SALES) ? (
            <Button variant="outline" asChild>
              <Link href="/dashboard/reports/delivery">
                <BarChart3 /> Delivery report
              </Link>
            </Button>
          ) : null
        }
      />
      {/*
        What delivering earns, worked out and read-only. The rate is the
        owner's (Settings → Cash controls → Delivery pay); each closed delivery
        carries what it earned, and these are sums of that. There is nothing on
        this screen to type a figure into.
      */}
      {rate > 0 || pay.mine.month.earned > 0 ? (
        <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard label="Pay per delivery" value={money(rate)} hint="Set by the owner" />
          <StatCard
            label="Your deliveries today"
            value={pay.mine.today.delivered}
            hint={`${pay.mine.month.delivered} this month`}
          />
          <StatCard label="You earned today" value={money(pay.mine.today.earned)} />
          <StatCard label="You earned this month" value={money(pay.mine.month.earned)} />
        </div>
      ) : null}

      {seesEveryone && pay.riders.length > 0 ? (
        <SectionCard
          title="Rider pay"
          description="What each rider has earned from the deliveries they closed. Pay them from these figures."
          className="mb-4"
        >
          <div className="overflow-x-auto">
            <table className="w-full min-w-[32rem] text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="pb-2 pr-3 font-medium">Rider</th>
                  <th className="pb-2 pr-3 text-right font-medium">Today</th>
                  <th className="pb-2 pr-3 text-right font-medium">Earned today</th>
                  <th className="pb-2 pr-3 text-right font-medium">This month</th>
                  <th className="pb-2 text-right font-medium">Earned this month</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {pay.riders.map((rider) => (
                  <tr key={rider.id}>
                    <td className="py-2 pr-3 font-medium">{rider.name}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{rider.today.delivered}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{money(rider.today.earned)}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{rider.month.delivered}</td>
                    <td className="py-2 text-right font-semibold tabular-nums">{money(rider.month.earned)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SectionCard>
      ) : null}

      <DeliveryDesk
        rows={rows}
        currency={restaurant.currency}
        locale={locale}
        timeZone={restaurant.timezone}
      />
    </>
  )
}
