import type { Metadata } from 'next'
import { Award, Clock, TrendingUp, Users } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { EmptyState } from '@/components/ui/feedback'
import {
  OrdersTrendChart,
  PeakHoursChart,
  RevenueTrendChart,
} from '@/features/analytics/components/charts'
import {
  getPeakHours,
  getPopularItems,
  getSalesSeries,
  getStaffPerformance,
} from '@/features/analytics/queries'
import { PageHeader, SectionCard } from '@/features/dashboard/components/page-header'
import { ROLE_LABELS, PERMISSIONS } from '@/lib/rbac'
import { formatMoney } from '@/lib/money'
import { scopeToOne, selectedBranch } from '@/features/dashboard/selected-branch'
import { requirePagePermission } from '@/server/auth/guard'
import { requireRestaurant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Analytics' }

export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const user = await requirePagePermission(PERMISSIONS.ANALYTICS_VIEW, '/dashboard/analytics')
  const restaurant = await requireRestaurant(user.restaurantId)
  const locale = restaurant.locale === 'en' ? 'en-IN' : restaurant.locale
  const branchId = scopeToOne(await selectedBranch(user, await searchParams))

  const [series, peak, popular, staff] = await Promise.all([
    getSalesSeries(user.restaurantId, 30, branchId),
    getPeakHours(user.restaurantId, 30, branchId),
    getPopularItems(user.restaurantId, 30, 10, branchId),
    getStaffPerformance(user.restaurantId, 30, branchId),
  ])

  const money = (value: number) => formatMoney(value, restaurant.currency, locale)

  return (
    <>
      <PageHeader title="Analytics" description="Trends across the last 30 days" />

      <div className="grid gap-4 lg:grid-cols-2">
        <SectionCard title="Revenue" description="Daily, last 30 days" bodyClassName="p-3 pt-5">
          <RevenueTrendChart data={series} currency={restaurant.currency} locale={locale} />
        </SectionCard>
        <SectionCard title="Order volume" description="Daily, last 30 days" bodyClassName="p-3 pt-5">
          <OrdersTrendChart data={series} currency={restaurant.currency} locale={locale} />
        </SectionCard>
      </div>

      <div className="mt-5">
        <SectionCard title="Peak hours" description="When your guests order most" bodyClassName="p-3 pt-5">
          <PeakHoursChart data={peak} currency={restaurant.currency} locale={locale} />
        </SectionCard>
      </div>

      <div className="mt-5 grid gap-4 lg:grid-cols-2">
        <SectionCard title="Best sellers" description="Last 30 days" bodyClassName="p-0">
          {popular.length === 0 ? (
            <EmptyState className="m-5 border-none" icon={<Award />} title="Not enough data" />
          ) : (
            <ol className="divide-y">
              {popular.map((item, index) => (
                <li key={`${item.foodId}-${index}`} className="flex items-center gap-3 px-5 py-3">
                  <span className="flex size-7 items-center justify-center rounded-lg bg-muted text-xs font-bold">
                    {index + 1}
                  </span>
                  <span className="flex-1 truncate text-sm font-medium">{item.name}</span>
                  <span className="text-xs text-muted-foreground">{item.quantity} sold</span>
                  <span className="text-sm font-semibold tabular-nums">{money(item.revenue)}</span>
                </li>
              ))}
            </ol>
          )}
        </SectionCard>

        <SectionCard title="Staff performance" description="Orders & payments handled" bodyClassName="p-0">
          {staff.length === 0 ? (
            <EmptyState className="m-5 border-none" icon={<Users />} title="No staff activity yet" />
          ) : (
            <ol className="divide-y">
              {staff.map((member) => (
                <li key={member.id} className="flex items-center gap-3 px-5 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{member.name}</p>
                    <Badge variant="secondary" size="sm">
                      {ROLE_LABELS[member.role]}
                    </Badge>
                  </div>
                  <div className="text-right text-xs text-muted-foreground">
                    <p>{member.ordersCreated} orders</p>
                    <p className="font-semibold text-foreground">{money(member.paymentTotal)} collected</p>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </SectionCard>
      </div>
    </>
  )
}
