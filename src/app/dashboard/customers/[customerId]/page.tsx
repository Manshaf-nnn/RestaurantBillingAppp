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
            <Badge variant="secondary">{c.group.toLowerCase()}</Badge>
            {c.marketingConsent && <Badge variant="success">marketing ok</Badge>}
          </div>
        }
      />

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

      <SectionCard title="Order history">
        {c.recentOrders.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">No orders yet.</p>
        ) : (
          <ul className="divide-y divide-border">
            {c.recentOrders.map((o) => (
              <li key={o.id}>
                <Link
                  href={`/dashboard/orders/${o.id}`}
                  className="-mx-2 flex flex-wrap items-center gap-3 rounded-lg px-2 py-2.5 text-sm hover:bg-muted"
                >
                  <span className="font-medium tabular-nums">{o.orderNumber}</span>
                  <span className="text-muted-foreground">{o.itemCount} items</span>
                  <span className="ml-auto flex items-center gap-3">
                    <span className="text-xs text-muted-foreground"><LocalDateTime value={o.placedAt} /></span>
                    <span className="font-semibold tabular-nums">{money(o.total)}</span>
                  </span>
                </Link>
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
