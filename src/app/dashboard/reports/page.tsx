import type { Metadata } from 'next'

import { ReportsView } from '@/features/reports/components/reports-view'
import { getReportSummary } from '@/features/analytics/queries'
import { resolveRange, type RangePreset } from '@/features/reports/range'
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
  /*
   * The lowercase tab keys are this page's public URL vocabulary; the resolver
   * speaks presets, in the restaurant's own timezone — this screen used to run
   * on the server's clock, so "Today" rolled over at the wrong midnight.
   */
  const PRESETS: Record<string, RangePreset> = {
    today: 'TODAY', yesterday: 'YESTERDAY', week: 'LAST_7',
    month: 'LAST_30', quarter: 'LAST_90', year: 'THIS_YEAR',
  }
  const summary = await getReportSummary(
    user.restaurantId,
    resolveRange({ preset: PRESETS[range] ?? 'LAST_7', timeZone: restaurant.timezone }),
    branchIds,
  )

  return (
    <ReportsView
      summary={summary}
      range={range}
      currency={restaurant.currency}
      locale={restaurant.locale === 'en' ? 'en-IN' : restaurant.locale}
    />
  )
}
