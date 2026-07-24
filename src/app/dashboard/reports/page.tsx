import type { Metadata } from 'next'

import { ReportsView } from '@/features/reports/components/reports-view'
import { getReportSummary, resolveRange } from '@/features/analytics/queries'
import { PERMISSIONS } from '@/lib/rbac'
import { requirePagePermission } from '@/server/auth/guard'
import { requireRestaurant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Reports' }

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>
}) {
  const user = await requirePagePermission(PERMISSIONS.REPORT_VIEW, '/dashboard/reports')
  const { range = 'week' } = await searchParams

  const restaurant = await requireRestaurant(user.restaurantId)
  const summary = await getReportSummary(user.restaurantId, resolveRange(range))

  return (
    <ReportsView
      summary={summary}
      range={range}
      currency={restaurant.currency}
      locale={restaurant.locale === 'en' ? 'en-IN' : restaurant.locale}
    />
  )
}
