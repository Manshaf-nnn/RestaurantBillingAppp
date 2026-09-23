import type { Metadata } from 'next'
import Link from 'next/link'
import { Eye, PhoneCall } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { PageHeader, SectionCard, StatCard } from '@/features/dashboard/components/page-header'
import { PeriodPicker } from '@/features/dashboard/components/period-picker'
import { describeRange, resolveRange } from '@/features/reports/range'
import { ReportTable } from '@/features/reports/components/report-table'
import { getCustomerInsights } from '@/features/customers/insights'
import { listSegment, type CustomerSegment } from '@/features/customers/segments'
import { listCustomerCategories } from '@/features/customers/service'
import { InsightFilters } from '@/features/customers/components/insight-filters'
import { formatMoney } from '@/lib/money'
import { PERMISSIONS, visibleBranchIds } from '@/lib/rbac'
import { requirePagePermission } from '@/server/auth/guard'
import { requireRestaurant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Customer insights' }

/**
 * Customer insights (pro.A.md §3).
 *
 * Every figure comes from `getCustomerInsights`, which computes in SQL using
 * the sales report's own definitions — so "revenue from customers" here and
 * net sales there are the same number. The old page added up
 * `Customer.totalSpent`, a counter that includes tax and ignores partial
 * refunds, and called the result revenue.
 *
 * The filter at the top narrows the population, and every figure below is
 * about that population. So "regulars who have not been in for a month" is a
 * question you can ask, see answered, and then act on with one button.
 */
export default async function CustomerInsightsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const user = await requirePagePermission(
    PERMISSIONS.CUSTOMER_ANALYTICS,
    '/dashboard/customers/analytics',
  )
  const restaurant = await requireRestaurant(user.restaurantId)
  const money = (m: number) => formatMoney(m, restaurant.currency)

  const params = await searchParams
  const str = (key: string) => (typeof params[key] === 'string' ? (params[key] as string).trim() : '')
  const num = (key: string) => {
    const raw = str(key)
    if (!raw) return undefined
    const value = Number(raw)
    return Number.isFinite(value) ? Math.trunc(value) : undefined
  }

  /*
   * Selectable (correctionA.md §3). The window was a bare `Date.now() - 30
   * days` inside the query, so "the last 30 days" meant something different
   * at every visit. Resolving through the shared helper puts it on the
   * restaurant's midnight.
   */
  const range = resolveRange({
    preset: str('preset') || 'LAST_30',
    from: str('from'),
    to: str('to'),
    timeZone: restaurant.timezone,
  })
  const periodLabel = describeRange(range)

  const segment: CustomerSegment = {
    ...(str('q') ? { q: str('q') } : {}),
    ...(str('category') ? { categoryId: str('category') } : {}),
    ...(num('minVisits') !== undefined ? { minVisits: num('minVisits') } : {}),
    ...(num('minSpent') !== undefined ? { minSpent: num('minSpent')! * 100 } : {}),
    ...(num('notSeenForDays') !== undefined ? { notSeenForDays: num('notSeenForDays') } : {}),
    ...(num('minPoints') !== undefined ? { minPoints: num('minPoints') } : {}),
    ...(['new', 'returning', 'repeat', 'regular', 'lapsed'].includes(str('kind'))
      ? { kind: str('kind') as CustomerSegment['kind'] }
      : {}),
  }
  const filtered = Object.keys(segment).length > 0
  const branchIds = visibleBranchIds(user)

  const [data, categories, lapsing] = await Promise.all([
    getCustomerInsights({ restaurantId: user.restaurantId, range, branchIds, segment }),
    listCustomerCategories({ restaurantId: user.restaurantId }),
    /*
     * Worth a phone call: people with a history who have stopped coming. Its
     * own query rather than a slice of the figures above, because it is a
     * lifetime question ("have they stopped") and not a period one.
     */
    listSegment({
      restaurantId: user.restaurantId,
      branchIds,
      segment: { ...segment, kind: 'lapsed' },
      perPage: 20,
    }),
  ])

  const retention =
    data.totalCustomers > 0 ? Math.round((data.repeatCustomers / data.totalCustomers) * 100) : 0
  const now = Date.now()

  return (
    <>
      <PageHeader
        title="Customer insights"
        description={`Who comes back, who spends, and who has stopped coming · ${periodLabel}`}
      />

      <div className="mb-5">
        <PeriodPicker preset={range.preset} from={str('from')} to={str('to')} label={periodLabel} />
      </div>

      {/*
        The same filter vocabulary as the customer list (pro.A.md §3), so a
        group described here is a group you can then open, export or offer a
        discount to without describing it twice.
      */}
      <InsightFilters
        categories={categories.map((category) => ({ id: category.id, name: category.name }))}
        currency={restaurant.currency}
        reaches={data.totalCustomers}
      />

      {filtered ? (
        <p className="mb-4 text-sm text-muted-foreground">
          Every figure below is about the {data.totalCustomers.toLocaleString()} customer
          {data.totalCustomers === 1 ? '' : 's'} this filter reaches.
        </p>
      ) : null}

      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Customers" value={data.totalCustomers.toLocaleString()} />
        <StatCard
          label="New this period"
          value={data.newCustomers.toLocaleString()}
          hint={`${data.returningCustomers.toLocaleString()} returning`}
        />
        <StatCard
          label="Revenue"
          value={money(data.revenue)}
          hint="Net of refunds, before tax — the same basis as the sales report"
        />
        <StatCard
          label="Average spend"
          value={money(data.averageSpend)}
          hint={`${data.visits.toLocaleString()} visits`}
        />
      </div>

      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Came back" value={`${retention}%`} hint={`${data.repeatCustomers} with 2+ visits`} />
        <StatCard label="Regulars" value={data.regularCustomers.toLocaleString()} hint="5+ visits, seen in 60 days" />
        <StatCard label="Gone quiet" value={data.inactiveCustomers.toLocaleString()} hint="2+ visits, away 45 days" />
        <StatCard
          label="Points"
          value={data.pointsEarned.toLocaleString()}
          hint={`${data.pointsRedeemed.toLocaleString()} redeemed`}
        />
      </div>

      {lapsing.rows.length > 0 && (
        <SectionCard
          title="Worth a phone call"
          description="Guests with a history — two visits or more — who have not been in for a while. One-time visitors are excluded, because they were never regulars to win back."
          actions={<Badge variant="warning">{lapsing.total}</Badge>}
        >
          <ul className="divide-y divide-border">
            {lapsing.rows.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-3 py-2.5 text-sm">
                <Link
                  href={`/dashboard/customers/${c.id}`}
                  className="font-medium text-primary underline-offset-2 hover:underline"
                >
                  {c.name || 'Unnamed'}
                </Link>
                {c.phone && (
                  <a
                    href={`tel:${c.phone}`}
                    className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
                  >
                    <PhoneCall className="h-3.5 w-3.5" />
                    {c.phone}
                  </a>
                )}
                {c.category ? <Badge variant="secondary" size="sm">{c.category.name}</Badge> : null}
                <span className="text-muted-foreground">{c.totalOrders} visits</span>
                <span className="ml-auto flex items-center gap-3">
                  <span className="text-amber-600 dark:text-amber-400">
                    {c.lastOrderAt
                      ? `${Math.floor((now - c.lastOrderAt.getTime()) / 86_400_000)} days ago`
                      : 'never'}
                  </span>
                  <Button variant="outline" size="sm" asChild>
                    <Link href={`/dashboard/customers/${c.id}`}>
                      <Eye /> View details
                    </Link>
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        </SectionCard>
      )}

      <div className="mt-5 space-y-5">
        {/*
          Every name opens that customer's details — their profile, and every
          bill they have paid, one by one (pro.A.md §2, §3). A table of totals
          with no way through to the person behind them is a report, not an
          insight.
        */}
        <ReportTable
          currency={restaurant.currency}
          title="Top customers by spend"
          columns={[
            { key: 'name', label: 'Customer', format: 'text', fallback: 'Unnamed' },
            { key: 'phone', label: 'Phone', format: 'text' },
            { key: 'visits', label: 'Visits', align: 'right' },
            { key: 'spend', label: 'Spend', align: 'right', format: 'money' },
          ]}
          rows={data.topBySpend as unknown as Array<Record<string, unknown>>}
          filename="top-customers-by-spend"
          hrefTemplate="/dashboard/customers/{id}"
        />

        <ReportTable
          currency={restaurant.currency}
          title="Top customers by visits"
          columns={[
            { key: 'name', label: 'Customer', format: 'text', fallback: 'Unnamed' },
            { key: 'phone', label: 'Phone', format: 'text' },
            { key: 'visits', label: 'Visits', align: 'right' },
            { key: 'spend', label: 'Spend', align: 'right', format: 'money' },
          ]}
          rows={data.topByVisits as unknown as Array<Record<string, unknown>>}
          filename="top-customers-by-visits"
          hrefTemplate="/dashboard/customers/{id}"
        />

        <ReportTable
          currency={restaurant.currency}
          title="By category"
          columns={[
            { key: 'name', label: 'Category', format: 'text' },
            { key: 'customers', label: 'Customers', align: 'right' },
            { key: 'revenue', label: 'Revenue', align: 'right', format: 'money' },
          ]}
          rows={data.byCategory as unknown as Array<Record<string, unknown>>}
          filename="customers-by-category"
        />
      </div>
    </>
  )
}
