import type { Metadata } from 'next'

import { ReportsView } from '@/features/reports/components/reports-view'
import { getReportSummary, resolveRange } from '@/features/analytics/queries'
import { selectedBranch } from '@/features/dashboard/selected-branch'
import { PERMISSIONS } from '@/lib/rbac'
import { requirePagePermission } from '@/server/auth/guard'
import { requireRestaurant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Reports' }

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string; branch?: string }>
}) {
  const user = await requirePagePermission(PERMISSIONS.REPORT_VIEW, '/dashboard/reports')
  const params = await searchParams
  const { range = 'week' } = params

  const restaurant = await requireRestaurant(user.restaurantId)
  // This page was the last report with no branch filter at all, so a branch
  // manager opening it read the whole group's revenue, cost and profit.
  const { branchIds } = await selectedBranch(user, params)
  const summary = await getReportSummary(user.restaurantId, resolveRange(range), branchIds)

  return (
    <ReportsView
      summary={summary}
      range={range}
      currency={restaurant.currency}
      locale={restaurant.locale === 'en' ? 'en-IN' : restaurant.locale}
    />
  )
}
