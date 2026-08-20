import type { Metadata } from 'next'
import { Info } from 'lucide-react'

import { PageHeader, StatCard } from '@/features/dashboard/components/page-header'
import { ReportFilters } from '@/features/reports/components/report-filters'
import { ReportTable } from '@/features/reports/components/report-table'
import { resolveRange } from '@/features/reports/range'
import { getBranchComparison, getProfitReport } from '@/features/reports/profit'
import { listLocations } from '@/features/transfers/queries'
import { formatMoney } from '@/lib/money'
import { PERMISSIONS, visibleBranchIds } from '@/lib/rbac'
import { requirePagePermission } from '@/server/auth/guard'
import { requireRestaurant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Gross profit' }

export default async function ProfitReportPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const user = await requirePagePermission(PERMISSIONS.REPORT_VIEW, '/dashboard/reports/profit')
  const restaurant = await requireRestaurant(user.restaurantId)
  const money = (m: number) => formatMoney(m, restaurant.currency)

  const p = await searchParams
  const str = (k: string) => (typeof p[k] === 'string' ? (p[k] as string) : '')
  const range = resolveRange({ preset: str('preset') || 'THIS_MONTH', from: str('from'), to: str('to') })

  const allowed = visibleBranchIds({ role: user.role, branchId: user.branchId })
  const locations = (await listLocations(user.restaurantId)).filter(
    (l) => allowed === null || allowed.includes(l.id),
  )
  const requested = str('branch')
  const chosen = requested && locations.some((l) => l.id === requested) ? requested : null
  const branchIds = chosen ? [chosen] : allowed

  const [profit, comparison] = await Promise.all([
    getProfitReport({ restaurantId: user.restaurantId, range, branchIds }),
    getBranchComparison({ restaurantId: user.restaurantId, range, branchIds }),
  ])
  const t = profit.totals

  return (
    <>
      {/* The title says gross, and so does the banner. This figure is routinely
          mistaken for take-home pay, and the mistake is expensive. */}
      <PageHeader title="Gross profit" description={`${range.label} · ${restaurant.name}`} />
      <ReportFilters
        preset={range.preset}
        from={str('from')}
        to={str('to')}
        locations={locations}
        branchId={chosen}
      />

      <div className="mb-5 flex gap-2 rounded-lg border border-border bg-muted/40 p-3 text-sm">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <p className="text-muted-foreground">{profit.disclaimer}</p>
      </div>

      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Revenue" value={money(t.revenue)} />
        <StatCard label="Cost of ingredients" value={money(t.cogs)} />
        <StatCard label="Gross profit" value={money(t.grossProfit)} />
        <StatCard
          label="Food cost"
          value={t.foodCostPercent === null ? '—' : `${t.foodCostPercent}%`}
          hint={t.grossMarginPercent === null ? undefined : `${t.grossMarginPercent}% gross margin`}
        />
      </div>

      {profit.coverage.linesWithoutRecipe > 0 && (
        <div className="mb-6 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-300">
          {profit.coverage.percentCovered}% of sold lines have a known ingredient cost.{' '}
          <strong>{money(profit.coverage.revenueWithoutRecipe)}</strong> of revenue came from dishes with
          no recipe, so the real food cost is higher than shown. Add recipes to those dishes to close
          the gap.
        </div>
      )}

      <div className="space-y-5">
        {comparison.rows.length > 1 && (
          <ReportTable
            title="Branch comparison"
            description="Every location side by side, best gross profit first."
            columns={[
              { key: 'name', label: 'Location' },
              { key: 'orders', label: 'Orders', align: 'right' },
              { key: 'sales', label: 'Sales', align: 'right', format: (r) => money(Number(r.sales)) },
              { key: 'cogs', label: 'Ingredients', align: 'right', format: (r) => money(Number(r.cogs)) },
              { key: 'grossProfit', label: 'Gross profit', align: 'right', format: (r) => money(Number(r.grossProfit)) },
              { key: 'grossMarginPercent', label: 'Margin', align: 'right', format: (r) => r.grossMarginPercent === null ? '—' : `${r.grossMarginPercent}%` },
              { key: 'wastage', label: 'Wastage', align: 'right', format: (r) => money(Number(r.wastage)) },
            ]}
            rows={comparison.rows as unknown as Array<Record<string, unknown>>}
            filename={`branch-comparison-${range.preset.toLowerCase()}`}
          />
        )}

        <ReportTable
          title="Gross profit by item"
          description="Worst margin sits at the bottom — those are the dishes to reprice or re-cost."
          columns={[
            { key: 'label', label: 'Item' },
            { key: 'quantity', label: 'Sold', align: 'right' },
            { key: 'revenue', label: 'Revenue', align: 'right', format: (r) => money(Number(r.revenue)) },
            { key: 'cogs', label: 'Cost', align: 'right', format: (r) => money(Number(r.cogs)) },
            { key: 'grossProfit', label: 'Gross profit', align: 'right', format: (r) => money(Number(r.grossProfit)) },
            { key: 'foodCostPercent', label: 'Food cost', align: 'right', format: (r) => r.foodCostPercent === null ? '—' : `${r.foodCostPercent}%` },
          ]}
          rows={profit.byItem as unknown as Array<Record<string, unknown>>}
          filename={`gross-profit-by-item-${range.preset.toLowerCase()}`}
        />

        <ReportTable
          title="Gross profit by category"
          columns={[
            { key: 'label', label: 'Category' },
            { key: 'revenue', label: 'Revenue', align: 'right', format: (r) => money(Number(r.revenue)) },
            { key: 'cogs', label: 'Cost', align: 'right', format: (r) => money(Number(r.cogs)) },
            { key: 'grossProfit', label: 'Gross profit', align: 'right', format: (r) => money(Number(r.grossProfit)) },
            { key: 'grossMarginPercent', label: 'Margin', align: 'right', format: (r) => r.grossMarginPercent === null ? '—' : `${r.grossMarginPercent}%` },
          ]}
          rows={profit.byCategory as unknown as Array<Record<string, unknown>>}
          filename={`gross-profit-by-category-${range.preset.toLowerCase()}`}
        />
      </div>
    </>
  )
}
