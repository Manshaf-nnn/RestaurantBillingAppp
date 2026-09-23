import type { Metadata } from 'next'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { LocalDateTime } from '@/components/local-time'
import { PageHeader, SectionCard, StatCard } from '@/features/dashboard/components/page-header'
import { getCustomerProfile } from '@/features/customers/analytics'
import { formatMoney } from '@/lib/money'
import { PERMISSIONS } from '@/lib/rbac'
import { selectedBranch } from '@/features/dashboard/selected-branch'
import { requirePagePermission } from '@/server/auth/guard'
import { requireRestaurant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Customer' }

export default async function CustomerPage({
  params,
  searchParams,
}: {
  params: Promise<{ customerId: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { customerId } = await params
  const user = await requirePagePermission(PERMISSIONS.CUSTOMER_VIEW, `/dashboard/customers/${customerId}`)
  const restaurant = await requireRestaurant(user.restaurantId)
  const money = (m: number) => formatMoney(m, restaurant.currency)
  // Same helper as the list, so the switcher moves both together.
  const selection = await selectedBranch(user, await searchParams)
  const c = await getCustomerProfile({
    restaurantId: user.restaurantId,
    customerId,
    branchIds: selection.branchIds,
  })

  return (
    <>
      <Link
        href="/dashboard/customers"
        className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        Customers
      </Link>
      <PageHeader
        title={c.name ?? 'Unnamed customer'}
        description={[c.phone, c.email].filter(Boolean).join(' · ') || 'No contact details'}
        actions={
          <div className="flex items-center gap-2">
            {c.categoryName ? <Badge variant="secondary">{c.categoryName}</Badge> : null}
            {c.marketingConsent && <Badge variant="success">marketing ok</Badge>}
          </div>
        }
      />

      {/*
        Who they are (pro.A.md §2). Only the lines that have something in
        them: a grid of empty labels tells a reader nothing and makes the ones
        that do matter harder to find.
      */}
      {[c.address, c.birthday, c.anniversary, c.firstOrderAt, c.notes].some(Boolean) ? (
        <dl className="mb-5 grid gap-x-6 gap-y-2 rounded-xl border bg-card p-4 text-sm shadow-soft sm:grid-cols-2 lg:grid-cols-4">
          {c.address ? (
            <div><dt className="text-xs text-muted-foreground">Address</dt><dd>{c.address}</dd></div>
          ) : null}
          {c.birthday ? (
            <div>
              <dt className="text-xs text-muted-foreground">Date of birth</dt>
              <dd><LocalDateTime value={c.birthday} options={{ dateStyle: 'medium' }} /></dd>
            </div>
          ) : null}
          {c.anniversary ? (
            <div>
              <dt className="text-xs text-muted-foreground">Anniversary</dt>
              <dd><LocalDateTime value={c.anniversary} options={{ dateStyle: 'medium' }} /></dd>
            </div>
          ) : null}
          {c.firstOrderAt ? (
            <div>
              <dt className="text-xs text-muted-foreground">First visit</dt>
              <dd><LocalDateTime value={c.firstOrderAt} options={{ dateStyle: 'medium' }} /></dd>
            </div>
          ) : null}
        </dl>
      ) : null}

      {/*
        The labels say which figures these are. They used to read "Lifetime
        spend" and "Visits" off the group-wide counters while the order list
        below was branch-filtered — twelve visits over three orders, with
        nothing to explain the gap.
      */}
      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label={c.figuresScopedToBranch ? 'Spend here' : 'Lifetime spend'}
          value={money(c.totalSpent)}
          hint={c.figuresScopedToBranch ? 'At the locations you can see' : undefined}
        />
        <StatCard
          label={c.figuresScopedToBranch ? 'Visits here' : 'Visits'}
          value={String(c.totalOrders)}
        />
        <StatCard label="Average order" value={money(c.averageOrder)} />
        <StatCard
          label={c.figuresScopedToBranch ? 'Last visit here' : 'Last visit'}
          value={c.daysSinceLastVisit === null ? '—' : c.daysSinceLastVisit === 0 ? 'Today' : `${c.daysSinceLastVisit}d ago`}
        />
      </div>

      {/* The rest of what §2 asks for, and only when it is not all zero. */}
      {c.cancelledOrders + c.refundedOrders + c.outstanding > 0 ? (
        <div className="mb-6 grid gap-3 sm:grid-cols-3">
          <StatCard label="Cancelled orders" value={String(c.cancelledOrders)} />
          <StatCard label="Orders refunded" value={String(c.refundedOrders)} />
          <StatCard
            label="Still owed"
            value={money(c.outstanding)}
            hint={c.outstanding > 0 ? 'Across their unpaid bills' : undefined}
          />
        </div>
      ) : null}

      {c.loyaltyPoints > 0 && (
        <div className="mb-5 rounded-lg border border-border p-3 text-sm">
          <span className="text-muted-foreground">Loyalty balance</span>
          <span className="ml-2 font-semibold tabular-nums">{c.loyaltyPoints} points</span>
          {/*
            Deliberately not scoped, and said out loud so it is not read as an
            inconsistency. Points are one counter with no ledger behind them —
            there is nothing to replay per branch — and a regular should not
            lose their balance for visiting the other site.
          */}
          {c.figuresScopedToBranch ? (
            <span className="ml-2 text-xs text-muted-foreground">
              across every location — points follow the person
            </span>
          ) : null}
        </div>
      )}

      {c.favouriteItems.length > 0 && (
        <SectionCard title="Usually orders" description="What they come back for.">
          <ul className="divide-y divide-border">
            {c.favouriteItems.map((f) => (
              <li key={f.name} className="flex justify-between py-2 text-sm">
                <span>{f.name}</span>
                <span className="tabular-nums text-muted-foreground">
                  {f.quantity} × · {money(f.spend)}
                </span>
              </li>
            ))}
          </ul>
        </SectionCard>
      )}

      {/*
        The whole bill on every row (pro.A.md §2). What they had, what came
        off it, what was charged and how it was paid — the questions somebody
        opens a customer to answer. The order number still opens the
        authoritative detail page; nothing here recomputes money, it renders
        the columns the order already stores.
      */}
      <SectionCard
        title="Order history"
        description="The last twenty, newest first. Tap the number for the full order."
      >
        {c.recentOrders.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">No orders yet.</p>
        ) : (
          <ul className="space-y-3">
            {c.recentOrders.map((o) => (
              <li key={o.id} className="rounded-lg border p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <Link
                    href={`/dashboard/orders/${o.id}`}
                    className="font-semibold tabular-nums text-primary underline-offset-2 hover:underline"
                  >
                    {o.orderNumber}
                  </Link>
                  <Badge variant="outline" size="sm">{o.type.replace('_', '-').toLowerCase()}</Badge>
                  {o.branchName ? <span className="text-xs text-muted-foreground">{o.branchName}</span> : null}
                  <span className="text-xs text-muted-foreground"><LocalDateTime value={o.placedAt} /></span>
                  <Badge
                    size="sm"
                    variant={
                      o.paymentStatus === 'PAID' ? 'success'
                        : o.paymentStatus === 'REFUNDED' ? 'destructive'
                          : o.paymentStatus === 'PARTIAL' ? 'warning' : 'secondary'
                    }
                  >
                    {o.paymentStatus.toLowerCase()}
                  </Badge>
                  <span className="ml-auto font-semibold tabular-nums">{money(o.total)}</span>
                </div>

                <ul className="mt-2 space-y-0.5 text-xs text-muted-foreground">
                  {o.items.map((item, index) => (
                    <li key={index} className="flex justify-between gap-3">
                      <span>
                        {item.quantity} × {item.name}
                        {item.discountAmount > 0 ? (
                          <span className="ml-1 text-success">− {money(item.discountAmount)}</span>
                        ) : null}
                      </span>
                      <span className="tabular-nums">
                        {money(item.lineTotal - item.discountAmount)}
                      </span>
                    </li>
                  ))}
                </ul>

                <dl className="mt-2 flex flex-wrap gap-x-4 gap-y-0.5 border-t pt-2 text-xs text-muted-foreground">
                  <span><dt className="inline">Subtotal </dt><dd className="inline tabular-nums">{money(o.subtotal)}</dd></span>
                  {o.discountTotal > 0 ? (
                    <span><dt className="inline">Discount </dt><dd className="inline tabular-nums">− {money(o.discountTotal)}</dd></span>
                  ) : null}
                  {o.loyaltyDiscount > 0 ? (
                    <span><dt className="inline">Loyalty </dt><dd className="inline tabular-nums">− {money(o.loyaltyDiscount)}</dd></span>
                  ) : null}
                  {o.serviceCharge > 0 ? (
                    <span><dt className="inline">Service </dt><dd className="inline tabular-nums">{money(o.serviceCharge)}</dd></span>
                  ) : null}
                  {o.taxTotal > 0 ? (
                    <span><dt className="inline">Tax </dt><dd className="inline tabular-nums">{money(o.taxTotal)}</dd></span>
                  ) : null}
                  {o.tipAmount > 0 ? (
                    <span><dt className="inline">Tip </dt><dd className="inline tabular-nums">{money(o.tipAmount)}</dd></span>
                  ) : null}
                  {o.loyaltyEarned > 0 ? (
                    <span><dt className="inline">Earned </dt><dd className="inline tabular-nums">{o.loyaltyEarned} pts</dd></span>
                  ) : null}
                  {o.loyaltyRedeemed > 0 ? (
                    <span><dt className="inline">Redeemed </dt><dd className="inline tabular-nums">{o.loyaltyRedeemed} pts</dd></span>
                  ) : null}
                  {o.cashierName ? (
                    <span><dt className="inline">Served by </dt><dd className="inline">{o.cashierName}</dd></span>
                  ) : null}
                </dl>

                {o.payments.length > 0 || o.refunds.length > 0 ? (
                  <div className="mt-2 flex flex-wrap gap-2 text-xs">
                    {o.payments.map((payment) => (
                      <Badge key={payment.id} variant="secondary" size="sm">
                        {payment.method.replace('_', ' ').toLowerCase()} {money(payment.amount)}
                      </Badge>
                    ))}
                    {o.refunds.map((refund) => (
                      <Badge key={refund.id} variant="destructive" size="sm">
                        refunded {money(refund.amount)}
                        {refund.reason ? ` · ${refund.reason}` : ''}
                      </Badge>
                    ))}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      {c.notes && (
        <SectionCard title="Notes" description="Visible to staff, never to the guest.">
          <p className="text-sm">{c.notes}</p>
        </SectionCard>
      )}
    </>
  )
}
