import type { Metadata } from 'next'
import Link from 'next/link'

import { Badge } from '@/components/ui/badge'
import { EmptyState } from '@/components/ui/feedback'
import { LocalDateTime } from '@/components/local-time'
import { PageHeader, SectionCard, StatCard } from '@/features/dashboard/components/page-header'
import { getVarianceReport } from '@/features/inventory/variance-report'
import { scopeToOne, selectedBranch } from '@/features/dashboard/selected-branch'
import { formatMoney } from '@/lib/money'
import { PERMISSIONS } from '@/lib/rbac'
import { requirePagePermission } from '@/server/auth/guard'
import { requireRestaurant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Stock variance' }

export default async function VarianceReportPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const user = await requirePagePermission(PERMISSIONS.REPORT_VARIANCE, '/dashboard/reports/variance')
  const restaurant = await requireRestaurant(user.restaurantId)
  const money = (m: number) => formatMoney(m, restaurant.currency)

  const params = await searchParams
  const raw = Number(typeof params.days === 'string' ? params.days : '')
  const days = Number.isFinite(raw) && raw > 0 && raw <= 365 ? raw : 30

  /*
   * Every other report scopes to the chosen location; this one did not, and it
   * is the report that says where stock went missing. A manager confined to
   * Kandy could read the whole group's shortfalls here, including the ones
   * their own site had nothing to do with.
   */
  const selection = await selectedBranch(user, params)
  const branchId = scopeToOne(selection)

  const report = await getVarianceReport({ restaurantId: user.restaurantId, days, branchId })

  return (
    <>
      <PageHeader
        title="Stock variance"
        description="The gap between what the system held and what was actually on the shelf, from approved stock counts."
      />

      {/*
        <Link>, not <a>. A bare anchor here tore down the whole application and
        rebuilt it — socket, shell and all — to change one number in the query
        string. That is the "it reloads by itself" people report.
      */}
      <div className="mb-5 flex gap-2">
        {[7, 30, 90].map((d) => (
          <Link
            key={d}
            href={`/dashboard/reports/variance?days=${d}${
              selection.branchId ? `&branch=${selection.branchId}` : ''
            }`}
            className={`rounded-lg border px-3 py-1.5 text-sm ${
              days === d ? 'border-primary bg-primary text-primary-foreground' : 'border-border hover:bg-muted'
            }`}
          >
            {d} days
          </Link>
        ))}
      </div>

      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Counts included" value={String(report.totals.countsIncluded)} />
        <StatCard label="Items off" value={String(report.totals.itemsWithVariance)} />
        <StatCard label="Total shortfall" value={money(report.totals.lossValue)} />
        <StatCard label="Unexplained" value={money(report.totals.unexplainedValue)} />
      </div>

      <SectionCard
        title="Variances"
        description="Biggest loss first. A shortfall with wastage recorded the same day is largely accounted for; one without is worth asking about."
      >
        {report.lines.length === 0 ? (
          <EmptyState
            title="No variances"
            description="Either nothing has been counted in this period, or every count matched exactly."
          />
        ) : (
          <div className="-mx-2 overflow-x-auto px-2">
            <table className="w-full min-w-[46rem] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="pb-2 pr-3 font-medium">Item</th>
                  <th className="pb-2 pr-3 text-right font-medium">Expected</th>
                  <th className="pb-2 pr-3 text-right font-medium">Actual</th>
                  <th className="pb-2 pr-3 text-right font-medium">Variance</th>
                  <th className="pb-2 pr-3 text-right font-medium">Value</th>
                  <th className="pb-2 pr-3 font-medium">Count</th>
                  <th className="pb-2 font-medium">Explained?</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {report.lines.map((line, i) => (
                  <tr key={`${line.itemId}-${i}`}>
                    <td className="py-2.5 pr-3">
                      <Link
                        href={`/dashboard/inventory/${line.itemId}`}
                        className="font-medium text-primary underline-offset-2 hover:underline"
                      >
                        {line.name}
                      </Link>
                      {line.notes && (
                        <span className="block text-xs text-muted-foreground">{line.notes}</span>
                      )}
                    </td>
                    <td className="py-2.5 pr-3 text-right tabular-nums text-muted-foreground">
                      {line.expected} {line.unit.toLowerCase()}
                    </td>
                    <td className="py-2.5 pr-3 text-right tabular-nums">
                      {line.actual} {line.unit.toLowerCase()}
                    </td>
                    <td
                      className={`py-2.5 pr-3 text-right font-medium tabular-nums ${
                        line.variance < 0
                          ? 'text-red-600 dark:text-red-400'
                          : 'text-amber-600 dark:text-amber-400'
                      }`}
                    >
                      {line.variance > 0 ? '+' : ''}{line.variance}
                    </td>
                    <td className="py-2.5 pr-3 text-right tabular-nums">{money(line.varianceValue)}</td>
                    <td className="py-2.5 pr-3 text-xs text-muted-foreground">
                      {line.countReference}
                      <span className="block"><LocalDateTime value={line.countedAt} /></span>
                    </td>
                    <td className="py-2.5">
                      {line.variance >= 0 ? (
                        <span className="text-xs text-muted-foreground">surplus</span>
                      ) : line.likelyExplained ? (
                        <Badge variant="secondary">wastage logged</Badge>
                      ) : (
                        <Badge variant="destructive">unexplained</Badge>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>
    </>
  )
}
