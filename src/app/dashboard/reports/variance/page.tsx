import type { Metadata } from 'next'
import Link from 'next/link'

import { Badge } from '@/components/ui/badge'
import { EmptyState } from '@/components/ui/feedback'
import { LocalDateTime } from '@/components/local-time'
import { PageHeader, SectionCard, StatCard } from '@/features/dashboard/components/page-header'
import { PeriodPicker } from '@/features/dashboard/components/period-picker'
import { ExportMenu } from '@/features/reports/components/export-menu'
import { describeRange, resolveRange } from '@/features/reports/range'
import { getVarianceReport } from '@/features/inventory/variance-report'
import { scopeToOne, selectedBranch } from '@/features/dashboard/selected-branch'
import { formatMoney } from '@/lib/money'
import { can, PERMISSIONS } from '@/lib/rbac'
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
  const str = (key: string) => (typeof params[key] === 'string' ? (params[key] as string) : '')

  /*
   * One vocabulary for periods (correctionA.md §3).
   *
   * This page spoke `?days=<int>` through three hand-built links — the fourth
   * convention for "which period" in an app that already had three, and the
   * only one that could not express "yesterday" or a custom range. It reads
   * `?preset=` now, like the dashboard and the reports, and resolves through
   * the canonical `resolveRange` so its boundaries land on the restaurant's
   * midnight.
   *
   * `?days=` is still honoured. Those three links have been in people's
   * bookmarks and in the report's own paging since it shipped, and a dead
   * bookmark is a worse outcome than a line of translation.
   */
  const legacyDays = Number(str('days'))
  const legacyPreset =
    Number.isFinite(legacyDays) && legacyDays > 0
      ? legacyDays <= 7
        ? 'LAST_7'
        : legacyDays <= 30
          ? 'LAST_30'
          : 'LAST_90'
      : ''

  const range = resolveRange({
    preset: str('preset') || legacyPreset || 'LAST_30',
    from: str('from'),
    to: str('to'),
    timeZone: restaurant.timezone,
  })
  const periodLabel = describeRange(range)

  // The report still counts back in whole days; it is given the span the
  // resolved range actually covers rather than a second, separate number.
  const days = Math.max(1, Math.round((range.to.getTime() - range.from.getTime()) / 86_400_000))

  /*
   * Every other report scopes to the chosen location; this one did not, and it
   * is the report that says where stock went missing. A manager confined to
   * Kandy could read the whole group's shortfalls here, including the ones
   * their own site had nothing to do with.
   */
  const selection = await selectedBranch(user, params)
  const branchId = scopeToOne(selection)

  const report = await getVarianceReport({
    restaurantId: user.restaurantId,
    days,
    branchId,
    // So "wastage on the same day" means the same day to the people who
    // recorded it, rather than the same UTC day.
    timeZone: restaurant.timezone,
  })

  return (
    <>
      <PageHeader
        title="Stock variance"
        description="The gap between what the system held and what was actually on the shelf, from approved stock counts."
        actions={can(user, PERMISSIONS.REPORT_EXPORT) ? <ExportMenu type="variance" /> : null}
      />

      {/*
        The shared picker, in place of three hand-built links. It pushes with
        the client router rather than navigating — the note those links carried
        was that a bare <a> here tore down the whole application, socket and
        shell included, to change one number in the query string.
      */}
      <div className="mb-5">
        <PeriodPicker preset={range.preset} from={str('from')} to={str('to')} label={periodLabel} />
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
