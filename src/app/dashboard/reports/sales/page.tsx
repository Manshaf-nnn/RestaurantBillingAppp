import type { Metadata } from 'next'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { PageHeader, SectionCard, StatCard } from '@/features/dashboard/components/page-header'
import { ReportFilters } from '@/features/reports/components/report-filters'
import { ReportTable } from '@/features/reports/components/report-table'
import { ReportViewPicker } from '@/features/reports/components/report-view-picker'
import { resolveRange } from '@/features/reports/range'
import { getSalesReport, getPaymentsReport, getItemPaymentDetail } from '@/features/reports/sales'
import { listLocations } from '@/features/transfers/queries'
import { formatMoney } from '@/lib/money'
import { formatDateTime } from '@/lib/datetime'
import { PERMISSIONS } from '@/lib/rbac'
import { selectedBranch } from '@/features/dashboard/selected-branch'
import { requirePagePermission } from '@/server/auth/guard'
import { requireRestaurant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Sales report' }

/**
 * Sales.
 *
 * ── One breakdown at a time ─────────────────────────────────────────────────
 *
 * This used to stack seven tables down one page — payment method, item,
 * category, location, employee, hour, day — and render every one on every
 * load. An owner who wanted to know what sold scrolled past four tables to
 * reach it. The breakdown is a choice now, carried in `?view=`, so the page
 * answers the question that was asked and the URL says which one it was.
 *
 * The totals stay on every view. They are the report's answer to "how did we
 * do", not one breakdown among several, and hiding them behind a tab would
 * make the owner pick a breakdown before they could see the number they came
 * for.
 *
 * ── Clicking an item ────────────────────────────────────────────────────────
 *
 * "Sold 43" is a count. What an owner actually asks next is "and what came in
 * for them" — so an item row opens the bills it was on and the payments
 * recorded against each. Stated carefully, because a payment settles a BILL:
 * see the note on `getItemPaymentDetail`.
 */

const VIEWS = [
  { value: 'summary', label: 'Summary' },
  { value: 'item', label: 'By item' },
  { value: 'category', label: 'By category' },
  { value: 'day', label: 'By date' },
  { value: 'hour', label: 'By time' },
  { value: 'payment', label: 'By payment method' },
  { value: 'staff', label: 'By employee' },
  { value: 'location', label: 'By location' },
] as const

type View = (typeof VIEWS)[number]['value']

export default async function SalesReportPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const user = await requirePagePermission(PERMISSIONS.REPORT_SALES, '/dashboard/reports/sales')
  const restaurant = await requireRestaurant(user.restaurantId)
  const money = (m: number) => formatMoney(m, restaurant.currency)
  const when = (value: Date | string | null) =>
    value ? formatDateTime(value, { locale: restaurant.locale, timeZone: restaurant.timezone }) : '—'

  const p = await searchParams
  const str = (k: string) => (typeof p[k] === 'string' ? (p[k] as string) : '')
  const range = resolveRange({ preset: str('preset') || 'TODAY', from: str('from'), to: str('to'), timeZone: restaurant.timezone })

  /*
   * Resolved through the shared helper so the top-bar switcher and this page's
   * own picker always agree, and so a remembered choice survives arriving here
   * from the nav rather than from a link that carries `?branch=`.
   */
  const selection = await selectedBranch(user, p)
  const allowed = selection.branchIds
  const locations = await listLocations(user.restaurantId, allowed)
  const chosen = selection.branchId
  const branchIds = selection.branchIds

  const asked = str('view')
  const view: View = (VIEWS.some((v) => v.value === asked) ? asked : 'summary') as View
  /** A row was drilled into: the item's own name, as snapshotted on the line. */
  const drillItem = str('item')

  /*
   * Only what this view needs. The payment breakdown is also loaded for the
   * summary, because the cash-discrepancy banner below reads it.
   */
  const needsPayments = view === 'summary' || view === 'payment'
  const [sales, payments, detail] = await Promise.all([
    getSalesReport({ restaurantId: user.restaurantId, range, branchIds }),
    needsPayments
      ? getPaymentsReport({ restaurantId: user.restaurantId, range, branchIds })
      : Promise.resolve(null),
    drillItem
      ? getItemPaymentDetail({ restaurantId: user.restaurantId, range, branchIds, itemName: drillItem })
      : Promise.resolve(null),
  ])
  const t = sales.totals

  /** The link an item row opens: this same screen, with that item drilled in. */
  const itemHref = (() => {
    const next = new URLSearchParams()
    for (const key of ['preset', 'from', 'to', 'branch']) {
      const value = str(key)
      if (value) next.set(key, value)
    }
    next.set('view', 'item')
    return `/dashboard/reports/sales?${next.toString()}&item={key}`
  })()

  /** Back to the item list, keeping the period and the location. */
  const backHref = (() => {
    const next = new URLSearchParams()
    for (const key of ['preset', 'from', 'to', 'branch']) {
      const value = str(key)
      if (value) next.set(key, value)
    }
    next.set('view', 'item')
    return `/dashboard/reports/sales?${next.toString()}`
  })()

  const stamp = range.preset.toLowerCase()

  return (
    <>
      <PageHeader title="Sales" description={`${range.label} · ${restaurant.name}`} />
      <ReportFilters
        preset={range.preset}
        from={str('from')}
        to={str('to')}
        locations={locations}
        branchId={chosen}
      />

      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Gross sales" value={money(t.grossSales)} />
        <StatCard label="Net sales" value={money(t.netSales)} hint="after discounts and refunds, before tax" />
        <StatCard label="Orders" value={String(t.orders)} />
        <StatCard label="Average order" value={money(t.averageOrderValue)} />
      </div>

      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Discounts" value={money(t.discounts)} />
        <StatCard label="Refunds" value={money(t.refunds)} />
        <StatCard label="Tax collected" value={money(t.tax)} hint="not the restaurant's money" />
        <StatCard label="Service charge" value={money(t.serviceCharge)} />
      </div>

      {payments && payments.cashDiscrepancy !== 0 && payments.drawersClosed > 0 && (
        <div className="mb-6 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-300">
          Cash drawers over this period were {payments.cashDiscrepancy > 0 ? 'over' : 'short'} by{' '}
          <strong>{money(Math.abs(payments.cashDiscrepancy))}</strong> across {payments.drawersClosed}{' '}
          closed {payments.drawersClosed === 1 ? 'drawer' : 'drawers'}. This is reported separately from
          takings — a till that was short still took what it took.
        </div>
      )}

      {/* The drill-down replaces the picker: it is one item, not a breakdown. */}
      {detail ? (
        <ItemPayments
          detail={detail}
          backHref={backHref}
          money={money}
          whenLabel={when}
          rangeLabel={range.label}
        />
      ) : (
        <>
          <ReportViewPicker views={[...VIEWS]} active={view} />

          {view === 'summary' ? (
            <div className="space-y-5">
              <ReportTable
                currency={restaurant.currency}
                title="By payment method"
                description="How the money came in over this period."
                columns={[
                  { key: 'label', label: 'Method' },
                  { key: 'count', label: 'Payments', align: 'right' },
                  { key: 'amount', label: 'Amount', align: 'right', format: 'money' },
                  { key: 'share', label: 'Share', align: 'right', format: 'percent' },
                ]}
                rows={(payments?.byMethod ?? []) as unknown as Array<Record<string, unknown>>}
                filename={`payments-${stamp}`}
              />
              <p className="text-sm text-muted-foreground">
                Pick a breakdown above for what sold, when it sold, and who sold it.
              </p>
            </div>
          ) : null}

          {view === 'item' ? (
            <ReportTable
              currency={restaurant.currency}
              title="By item"
              description="Top 50 by revenue. Open one to see the bills it was on and what was paid."
              columns={[
                { key: 'label', label: 'Item' },
                { key: 'quantity', label: 'Sold', align: 'right' },
                { key: 'orders', label: 'Lines', align: 'right' },
                { key: 'sales', label: 'Revenue', align: 'right', format: 'money' },
              ]}
              rows={sales.byItem as unknown as Array<Record<string, unknown>>}
              filename={`sales-by-item-${stamp}`}
              hrefTemplate={itemHref}
            />
          ) : null}

          {view === 'category' ? (
            <ReportTable
              currency={restaurant.currency}
              title="By category"
              columns={[
                { key: 'label', label: 'Category' },
                { key: 'orders', label: 'Lines', align: 'right' },
                { key: 'sales', label: 'Revenue', align: 'right', format: 'money' },
              ]}
              rows={sales.byCategory as unknown as Array<Record<string, unknown>>}
              filename={`sales-by-category-${stamp}`}
            />
          ) : null}

          {view === 'day' ? (
            <ReportTable
              currency={restaurant.currency}
              title="By date"
              description="Each day in the period."
              columns={[
                { key: 'label', label: 'Day' },
                { key: 'orders', label: 'Orders', align: 'right' },
                { key: 'sales', label: 'Revenue', align: 'right', format: 'money' },
              ]}
              rows={sales.byDay as unknown as Array<Record<string, unknown>>}
              filename={`sales-by-day-${stamp}`}
            />
          ) : null}

          {view === 'hour' ? (
            <ReportTable
              currency={restaurant.currency}
              title="By time of day"
              // Said plainly: this is every 7pm in the period added together,
              // not 7pm on one date. Reading it as the latter would make a
              // week look like a very busy evening.
              description="Hour of the day, added up across the whole period — useful for rostering."
              columns={[
                { key: 'label', label: 'Hour' },
                { key: 'orders', label: 'Orders', align: 'right' },
                { key: 'sales', label: 'Revenue', align: 'right', format: 'money' },
              ]}
              rows={sales.byHour as unknown as Array<Record<string, unknown>>}
              filename={`sales-by-hour-${stamp}`}
            />
          ) : null}

          {view === 'payment' ? (
            <ReportTable
              currency={restaurant.currency}
              title="By payment method"
              columns={[
                { key: 'label', label: 'Method' },
                { key: 'count', label: 'Payments', align: 'right' },
                { key: 'amount', label: 'Amount', align: 'right', format: 'money' },
                { key: 'share', label: 'Share', align: 'right', format: 'percent' },
              ]}
              rows={(payments?.byMethod ?? []) as unknown as Array<Record<string, unknown>>}
              filename={`payments-${stamp}`}
            />
          ) : null}

          {view === 'staff' ? (
            <ReportTable
              currency={restaurant.currency}
              title="By employee"
              description="Orders entered by each member of staff."
              columns={[
                { key: 'label', label: 'Employee' },
                { key: 'orders', label: 'Orders', align: 'right' },
                { key: 'sales', label: 'Revenue', align: 'right', format: 'money' },
              ]}
              rows={sales.byEmployee as unknown as Array<Record<string, unknown>>}
              filename={`sales-by-employee-${stamp}`}
              empty="Nobody is credited with an order in this period."
            />
          ) : null}

          {view === 'location' ? (
            <ReportTable
              currency={restaurant.currency}
              title="By location"
              columns={[
                { key: 'label', label: 'Location' },
                { key: 'orders', label: 'Orders', align: 'right' },
                { key: 'sales', label: 'Revenue', align: 'right', format: 'money' },
              ]}
              rows={sales.byBranch as unknown as Array<Record<string, unknown>>}
              filename={`sales-by-location-${stamp}`}
              empty="Only one location sold anything in this period."
            />
          ) : null}
        </>
      )}
    </>
  )
}

/**
 * One item, and the bills it was on.
 *
 * The careful part is the wording. A payment settles a whole bill and there is
 * no record anywhere of which part of it paid for which dish, so this shows
 * both figures next to each other and says which is which, rather than
 * inventing a split that would look precise and be made up.
 */
function ItemPayments({
  detail,
  backHref,
  money,
  whenLabel,
  rangeLabel,
}: {
  detail: NonNullable<Awaited<ReturnType<typeof getItemPaymentDetail>>>
  backHref: string
  money: (value: number) => string
  whenLabel: (value: Date | string | null) => string
  rangeLabel: string
}) {
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold">{detail.itemName}</h2>
          <p className="text-sm text-muted-foreground">
            Every bill it was on, {rangeLabel.toLowerCase()}, and what was paid against them.
          </p>
        </div>
        <Button asChild variant="outline" size="sm">
          <Link href={backHref}>
            <ArrowLeft /> All items
          </Link>
        </Button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <StatCard label="Sold" value={String(detail.quantity)} hint={`on ${detail.orders} bill${detail.orders === 1 ? '' : 's'}`} />
        <StatCard label="This item" value={money(detail.lineRevenue)} hint="its own lines, before the bill's tax" />
        <StatCard label="Those bills" value={money(detail.billTotal)} hint="everything on them, not just this" />
        <StatCard label="Paid" value={money(detail.paid)} hint="settled against those bills" />
        <StatCard label="Refunded" value={money(detail.refunded)} hint="given back on those bills" />
      </div>

      {/*
        The one sentence that stops these figures being misread. Without it
        somebody reads "Paid 48,000" as the takings for this dish.
      */}
      <div className="rounded-lg border border-border bg-muted/30 p-3 text-sm text-muted-foreground">
        A payment settles a whole bill, so the amounts below are for the entire
        order, not for this item alone. The item&rsquo;s own line total is shown
        beside each one.
      </div>

      {detail.truncated ? (
        <p className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning">
          Showing the most recent {detail.orders} bills. Narrow the period to see the rest.
        </p>
      ) : null}

      <SectionCard title="Bills" description={`${detail.orders} in this period, newest first.`}>
        {detail.rows.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            It was not sold in this period.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[52rem] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="pb-2 pr-3 font-medium">Bill</th>
                  <th className="pb-2 pr-3 font-medium">When</th>
                  <th className="pb-2 pr-3 font-medium">Customer</th>
                  <th className="pb-2 pr-3 text-right font-medium">This item</th>
                  <th className="pb-2 pr-3 text-right font-medium">Bill total</th>
                  <th className="pb-2 font-medium">Payments</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {detail.rows.map((row) => (
                  <tr key={row.orderId} className="align-top">
                    <td className="py-2.5 pr-3">
                      <Link
                        href={`/dashboard/orders/${row.orderId}`}
                        className="font-medium hover:underline"
                      >
                        {row.orderNumber}
                      </Link>
                      {row.branchName ? (
                        <span className="block text-xs text-muted-foreground">{row.branchName}</span>
                      ) : null}
                    </td>
                    <td className="whitespace-nowrap py-2.5 pr-3 text-muted-foreground">
                      {whenLabel(row.placedAt)}
                    </td>
                    <td className="py-2.5 pr-3 text-muted-foreground">{row.customerName ?? '—'}</td>
                    <td className="py-2.5 pr-3 text-right tabular-nums">
                      {row.quantity} × <span className="text-muted-foreground">{money(row.lineTotal)}</span>
                    </td>
                    <td className="py-2.5 pr-3 text-right tabular-nums">{money(row.orderTotal)}</td>
                    <td className="py-2.5">
                      {row.payments.length === 0 ? (
                        <span className="text-xs text-muted-foreground">
                          Nothing recorded — {row.paymentStatus.toLowerCase().replaceAll('_', ' ')}
                        </span>
                      ) : (
                        <ul className="space-y-1">
                          {row.payments.map((payment) => (
                            <li key={payment.id} className="flex flex-wrap items-baseline gap-x-2 text-xs">
                              <span className="font-medium">{payment.methodLabel}</span>
                              <span className="tabular-nums">{money(payment.amount)}</span>
                              {payment.status !== 'PAID' ? (
                                <Badge variant="secondary" size="sm">
                                  {payment.status.toLowerCase()}
                                </Badge>
                              ) : null}
                              <span className="text-muted-foreground">{whenLabel(payment.paidAt)}</span>
                              {payment.receivedByName ? (
                                <span className="text-muted-foreground">· {payment.receivedByName}</span>
                              ) : null}
                              {payment.reference ? (
                                <span className="text-muted-foreground">· {payment.reference}</span>
                              ) : null}
                            </li>
                          ))}
                        </ul>
                      )}
                      {row.refunded > 0 ? (
                        <p className="mt-1 text-xs text-destructive">
                          {money(row.refunded)} refunded on this bill
                        </p>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>
    </div>
  )
}
