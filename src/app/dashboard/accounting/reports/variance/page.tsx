import type { Metadata } from 'next'

import { Badge } from '@/components/ui/badge'
import { FoodCostTarget } from '@/features/accounting/components/food-cost-target'
import { getVarianceReport } from '@/features/accounting/variance'
import { PageHeader, SectionCard } from '@/features/dashboard/components/page-header'
import { selectedBranch } from '@/features/dashboard/selected-branch'
import { ReportFilters } from '@/features/reports/components/report-filters'
import { resolveRange } from '@/features/reports/range'
import { listLocations } from '@/features/transfers/queries'
import { formatMoney } from '@/lib/money'
import { can, PERMISSIONS } from '@/lib/rbac'
import { requirePagePermission } from '@/server/auth/guard'
import { requireRestaurant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Compare periods' }

/**
 * Variance analysis (acCal.md §8): what changed, and a plain sentence saying
 * why it might have. Every "actual" comes from the same engines the hub
 * uses; the only stored "expected" is the food-cost target.
 */
export default async function VariancePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const user = await requirePagePermission(
    PERMISSIONS.ACCOUNTING_VIEW,
    '/dashboard/accounting/reports/variance',
  )
  const restaurant = await requireRestaurant(user.restaurantId)
  const money = (value: number) => formatMoney(value, restaurant.currency)

  const params = await searchParams
  const str = (key: string) => (typeof params[key] === 'string' ? (params[key] as string) : '')
  const range = resolveRange({
    preset: str('preset') || 'THIS_MONTH',
    from: str('from'),
    to: str('to'),
    timeZone: restaurant.timezone,
  })
  const selection = await selectedBranch(user, params)
  const locations = await listLocations(user.restaurantId, selection.branchIds)

  const report = await getVarianceReport({
    restaurantId: user.restaurantId,
    range,
    branchIds: selection.branchIds,
    targetFoodCostBps: restaurant.targetFoodCostBps,
    money,
  })

  const show = (row: (typeof report.rows)[number], value: number) =>
    row.kind === 'percent' ? `${(value / 100).toFixed(1)}%` : money(value)

  return (
    <>
      <PageHeader
        title="Compare periods"
        description={`${range.label} ${report.comparisonLabel} (${report.previousLabel}). Every figure is the same one the other screens show.`}
        actions={
          <FoodCostTarget
            targetBps={restaurant.targetFoodCostBps}
            canEdit={can(user, PERMISSIONS.ACCOUNTING_CLOSE)}
          />
        }
      />
      <ReportFilters
        preset={range.preset}
        from={str('from')}
        to={str('to')}
        locations={locations}
        branchId={selection.branchId}
      />

      <div className="mt-4">
        <SectionCard title="What changed" description="Now against the period before it, with what the data says about why.">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[680px] text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="pb-2 pr-3 font-medium">Figure</th>
                  <th className="pb-2 pr-3 text-right font-medium">Before</th>
                  <th className="pb-2 pr-3 text-right font-medium">Now</th>
                  <th className="pb-2 pr-3 text-right font-medium">Change</th>
                  <th className="pb-2 font-medium">What it means</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {report.rows.map((row) => (
                  <tr key={row.title}>
                    <td className="py-2.5 pr-3 font-medium">{row.title}</td>
                    <td className="py-2.5 pr-3 text-right tabular-nums text-muted-foreground">
                      {show(row, row.previous)}
                    </td>
                    <td className="py-2.5 pr-3 text-right font-semibold tabular-nums">{show(row, row.current)}</td>
                    <td className="py-2.5 pr-3 text-right tabular-nums">
                      {row.delta === 0 ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        <span>
                          {row.delta > 0 ? '+' : '−'}
                          {show(row, Math.abs(row.delta))}
                          {row.changePercent !== null ? (
                            <span className="ml-1 text-xs text-muted-foreground">
                              ({row.changePercent > 0 ? '+' : ''}
                              {row.changePercent}%)
                            </span>
                          ) : null}
                        </span>
                      )}
                    </td>
                    <td className="py-2.5 text-xs text-muted-foreground">
                      {row.sentence}
                      {row.target ? (
                        <span className="mt-1 flex flex-wrap items-center gap-2">
                          <Badge variant={row.target.variance > 0 ? 'destructive' : 'secondary'}>
                            Expected {(row.target.expected / 100).toFixed(1)}% · Actual{' '}
                            {(row.target.actual / 100).toFixed(1)}% · Variance{' '}
                            {row.target.variance > 0 ? '+' : ''}
                            {(row.target.variance / 100).toFixed(1)}%
                          </Badge>
                          {row.target.variance > 0 ? (
                            <span>Every point above target is profit the kitchen is eating.</span>
                          ) : (
                            <span>At or under target.</span>
                          )}
                        </span>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SectionCard>
      </div>
    </>
  )
}
