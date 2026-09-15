import type { Metadata } from 'next'
import Link from 'next/link'
import { PhoneCall } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { PageHeader, SectionCard, StatCard } from '@/features/dashboard/components/page-header'
import { PeriodPicker } from '@/features/dashboard/components/period-picker'
import { describeRange, resolveRange } from '@/features/reports/range'
import { ReportTable } from '@/features/reports/components/report-table'
import { getCustomerAnalytics } from '@/features/customers/analytics'
import { formatMoney } from '@/lib/money'
import { PERMISSIONS, visibleBranchIds } from '@/lib/rbac'
import { requirePagePermission } from '@/server/auth/guard'
import { requireRestaurant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Customer analytics' }

export default async function CustomerAnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const user = await requirePagePermission(PERMISSIONS.CUSTOMER_ANALYTICS, '/dashboard/customers/analytics')
  const restaurant = await requireRestaurant(user.restaurantId)
  const money = (m: number) => formatMoney(m, restaurant.currency)

  const params = await searchParams
  const str = (key: string) => (typeof params[key] === 'string' ? (params[key] as string) : '')

  /*
   * Selectable (correctionA.md §3).
   *
   * The window was a bare `Date.now() - 30 days` inside the query, which put
   * the boundary at whatever time of day the page happened to be opened — so
   * "the last 30 days" quietly meant something different each visit, and every
   * figure on the page moved with it. Resolving through the shared helper puts
   * it on the restaurant's midnight and lets somebody ask a different question.
   */
  const range = resolveRange({
    preset: str('preset') || 'LAST_30',
    from: str('from'),
    to: str('to'),
    timeZone: restaurant.timezone,
  })
  const periodLabel = describeRange(range)

  const data = await getCustomerAnalytics({
    restaurantId: user.restaurantId,
    since: range.from,
    // Each branch reads its own guests. See `customersAtBranch`.
    branchIds: visibleBranchIds(user),
  })

  const retention = data.totalCustomers > 0
    ? Math.round((data.returning / data.totalCustomers) * 100)
    : 0

  return (
    <>
      <PageHeader
        title="Customers"
        description={`Who comes back, who spends, and who has stopped coming · ${periodLabel}`}
      />

      <div className="mb-5">
        <PeriodPicker preset={range.preset} from={str('from')} to={str('to')} label={periodLabel} />
      </div>

      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Customers" value={String(data.totalCustomers)} />
        <StatCard label="Came back" value={`${retention}%`} hint={`${data.returning} of ${data.totalCustomers}`} />
        <StatCard label="Average spend" value={money(data.averageSpend)} />
        <StatCard label="Average visits" value={String(data.averageVisits)} />
      </div>

      {data.lapsing.length > 0 && (
        <SectionCard
          title="Worth a phone call"
          description="Regulars — two visits or more — who have not been in for a while. One-time visitors are excluded, because they were never regulars to win back."
          actions={<Badge variant="warning">{data.lapsing.length}</Badge>}
        >
          <ul className="divide-y divide-border">
            {data.lapsing.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-3 py-2.5 text-sm">
                <Link
                  href={`/dashboard/customers/${c.id}`}
                  className="font-medium text-primary underline-offset-2 hover:underline"
                >
                  {c.name ?? 'Unnamed'}
                </Link>
                {c.phone && (
                  <a href={`tel:${c.phone}`} className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground">
                    <PhoneCall className="h-3.5 w-3.5" />
                    {c.phone}
                  </a>
                )}
                <span className="text-muted-foreground">{c.orders} visits</span>
                <span className="ml-auto text-amber-600 dark:text-amber-400">
                  {c.daysSince} days ago
                </span>
              </li>
            ))}
          </ul>
        </SectionCard>
      )}

      <div className="mt-5 space-y-5">
        <ReportTable
          currency={restaurant.currency}
          title="Top spenders"
          columns={[
            { key: 'name', label: 'Customer', format: 'text', fallback: 'Unnamed' },
            { key: 'phone', label: 'Phone', format: 'text' },
            { key: 'orders', label: 'Visits', align: 'right' },
            { key: 'spent', label: 'Lifetime spend', align: 'right', format: 'money' },
          ]}
          rows={data.topSpenders as unknown as Array<Record<string, unknown>>}
          filename="top-spenders"
        />

        <ReportTable
          currency={restaurant.currency}
          title="Most frequent"
          columns={[
            { key: 'name', label: 'Customer', format: 'text', fallback: 'Unnamed' },
            { key: 'phone', label: 'Phone', format: 'text' },
            { key: 'orders', label: 'Visits', align: 'right' },
            { key: 'spent', label: 'Lifetime spend', align: 'right', format: 'money' },
          ]}
          rows={data.mostFrequent as unknown as Array<Record<string, unknown>>}
          filename="most-frequent-customers"
        />

        <ReportTable
          currency={restaurant.currency}
          title="By group"
          columns={[
            { key: 'group', label: 'Group', format: 'label' },
            { key: 'count', label: 'Customers', align: 'right' },
            { key: 'spent', label: 'Lifetime spend', align: 'right', format: 'money' },
          ]}
          rows={data.byGroup as unknown as Array<Record<string, unknown>>}
          filename="customers-by-group"
        />
      </div>

      <div className="mt-5 rounded-lg border border-border p-3 text-sm text-muted-foreground">
        {data.withConsent} of {data.totalCustomers} customers have opted in to marketing.
        Consent is never assumed from someone leaving a phone number to collect an order.
      </div>
    </>
  )
}
