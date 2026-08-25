import type { Metadata } from 'next'

import { PageHeader, StatCard } from '@/features/dashboard/components/page-header'
import { ReportFilters } from '@/features/reports/components/report-filters'
import { ReportTable } from '@/features/reports/components/report-table'
import { resolveRange } from '@/features/reports/range'
import { getInventorySummary, listStockAlerts } from '@/features/inventory/alerts'
import { getWastageReport } from '@/features/inventory/wastage'
import { listExpiringStock } from '@/features/inventory/batches'
import { getVarianceReport } from '@/features/inventory/variance-report'
import { listLocations } from '@/features/transfers/queries'
import { formatMoney } from '@/lib/money'
import { PERMISSIONS, can } from '@/lib/rbac'
import { scopeToOne, selectedBranch } from '@/features/dashboard/selected-branch'
import { requirePagePermission } from '@/server/auth/guard'
import { requireRestaurant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Inventory report' }

export default async function InventoryReportPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const user = await requirePagePermission(PERMISSIONS.REPORT_INVENTORY, '/dashboard/reports/inventory')
  const restaurant = await requireRestaurant(user.restaurantId)
  const money = (m: number) => formatMoney(m, restaurant.currency)

  const p = await searchParams
  const str = (k: string) => (typeof p[k] === 'string' ? (p[k] as string) : '')
  const range = resolveRange({ preset: str('preset') || 'LAST_30', from: str('from'), to: str('to') })

  /*
   * Resolved through the shared helper so the top-bar switcher and this page's
   * own picker always agree, and so a remembered choice survives arriving here
   * from the nav rather than from a link that carries `?branch=`.
   */
  const selection = await selectedBranch(user, p)
  const allowed = selection.branchIds
  const locations = await listLocations(user.restaurantId, allowed)
  const chosen = scopeToOne(selection)

  const days = Math.max(1, Math.ceil((range.to.getTime() - range.from.getTime()) / 86_400_000))

  const [summary, alerts, wastage, expiring, variance] = await Promise.all([
    getInventorySummary({ restaurantId: user.restaurantId, branchId: chosen }),
    listStockAlerts({ restaurantId: user.restaurantId, branchId: chosen }),
    getWastageReport({
      restaurantId: user.restaurantId,
      period: days <= 1 ? 'DAY' : days <= 7 ? 'WEEK' : 'MONTH',
      branchId: chosen,
      includeEmployees: can(user, PERMISSIONS.INVENTORY_WASTAGE_APPROVE),
    }),
    listExpiringStock({ restaurantId: user.restaurantId, branchId: chosen, periodDays: 30 }),
    getVarianceReport({
      restaurantId: user.restaurantId, days, branchId: chosen, timeZone: restaurant.timezone,
    }),
  ])

  return (
    <>
      <PageHeader title="Inventory" description={`${range.label} · ${restaurant.name}`} />
      <ReportFilters
        preset={range.preset}
        from={str('from')}
        to={str('to')}
        locations={locations}
        branchId={chosen}
      />

      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Stock value" value={money(summary.inventoryValue)} />
        <StatCard label="Out of stock" value={String(summary.outOfStock)} />
        <StatCard label="Low stock" value={String(summary.lowStock)} />
        <StatCard label="Wasted" value={money(wastage.totalValue)} />
      </div>

      {variance.totals.unexplainedValue > 0 && (
        <div className="mb-6 rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-800 dark:text-red-300">
          <strong>{money(variance.totals.unexplainedValue)}</strong> of stock went missing with no
          wastage recorded against it. That is the figure worth investigating — a shortfall with
          wastage logged the same day is largely accounted for.
        </div>
      )}

      <div className="space-y-5">
        <ReportTable
          currency={restaurant.currency}
          title="Needs attention"
          description="Out of stock first — those are the ones that stop service."
          columns={[
            { key: 'name', label: 'Item' },
            { key: 'level', label: 'Status', format: 'label' },
            { key: 'quantity', label: 'In stock', align: 'right', format: 'quantity', unitKey: 'unit' },
            { key: 'reorderLevel', label: 'Reorder at', align: 'right' },
            { key: 'branchName', label: 'Location', format: 'text' },
          ]}
          rows={alerts as unknown as Array<Record<string, unknown>>}
          hrefTemplate="/dashboard/inventory/{itemId}"
          filename="stock-alerts"
          empty="Everything is above its reorder level."
        />

        <ReportTable
          currency={restaurant.currency}
          title="Wastage by reason"
          columns={[
            { key: 'label', label: 'Reason' },
            { key: 'count', label: 'Records', align: 'right' },
            { key: 'value', label: 'Value', align: 'right', format: 'money' },
            { key: 'share', label: 'Share', align: 'right', format: 'percent' },
          ]}
          rows={wastage.byReason as unknown as Array<Record<string, unknown>>}
          filename="wastage-by-reason"
        />

        <ReportTable
          currency={restaurant.currency}
          title="Most wasted items"
          columns={[
            { key: 'name', label: 'Item' },
            { key: 'quantity', label: 'Quantity', align: 'right', format: 'quantity', unitKey: 'unit' },
            { key: 'value', label: 'Value', align: 'right', format: 'money' },
          ]}
          rows={wastage.topItems as unknown as Array<Record<string, unknown>>}
          hrefTemplate="/dashboard/inventory/{itemId}"
          filename="most-wasted-items"
        />

        <ReportTable
          currency={restaurant.currency}
          title="Stock count variance"
          description="What the system held versus what was counted, from approved stock takes."
          columns={[
            { key: 'name', label: 'Item' },
            { key: 'expected', label: 'Expected', align: 'right' },
            { key: 'actual', label: 'Counted', align: 'right' },
            { key: 'variance', label: 'Variance', align: 'right' },
            { key: 'varianceValue', label: 'Value', align: 'right', format: 'money' },
            { key: 'likelyExplained', label: 'Explained', format: 'boolean', trueLabel: 'wastage logged', falseLabel: 'unexplained' },
          ]}
          rows={variance.lines as unknown as Array<Record<string, unknown>>}
          hrefTemplate="/dashboard/inventory/{itemId}"
          filename="stock-variance"
          empty="No counts approved in this period."
        />

        <ReportTable
          currency={restaurant.currency}
          title="Expiring stock"
          description="Batches dated within 30 days, soonest first."
          columns={[
            { key: 'itemName', label: 'Item' },
            { key: 'batchNo', label: 'Batch' },
            { key: 'remainingQty', label: 'Remaining', align: 'right', format: 'quantity', unitKey: 'unit' },
            { key: 'daysLeft', label: 'Days left', align: 'right', format: 'text' },
            { key: 'valueAtRisk', label: 'At risk', align: 'right', format: 'money' },
          ]}
          rows={expiring as unknown as Array<Record<string, unknown>>}
          hrefTemplate="/dashboard/inventory/{itemId}"
          filename="expiring-stock"
          empty="Nothing expiring. Batch tracking must be on for an item to appear here."
        />
      </div>
    </>
  )
}
