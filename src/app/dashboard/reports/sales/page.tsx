import type { Metadata } from 'next'

import { PageHeader, StatCard } from '@/features/dashboard/components/page-header'
import { ReportFilters } from '@/features/reports/components/report-filters'
import { ReportTable } from '@/features/reports/components/report-table'
import { resolveRange } from '@/features/reports/range'
import { getSalesReport, getPaymentsReport } from '@/features/reports/sales'
import { listLocations } from '@/features/transfers/queries'
import { formatMoney } from '@/lib/money'
import { PERMISSIONS, visibleBranchIds } from '@/lib/rbac'
import { requirePagePermission } from '@/server/auth/guard'
import { requireRestaurant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Sales report' }

export default async function SalesReportPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const user = await requirePagePermission(PERMISSIONS.REPORT_VIEW, '/dashboard/reports/sales')
  const restaurant = await requireRestaurant(user.restaurantId)
  const money = (m: number) => formatMoney(m, restaurant.currency)

  const p = await searchParams
  const str = (k: string) => (typeof p[k] === 'string' ? (p[k] as string) : '')
  const range = resolveRange({ preset: str('preset') || 'TODAY', from: str('from'), to: str('to') })

  // A user confined to a location can only ever report on that location, and a
  // branch id in the URL cannot widen it.
  const allowed = visibleBranchIds({ role: user.role, branchId: user.branchId })
  const locations = (await listLocations(user.restaurantId)).filter(
    (l) => allowed === null || allowed.includes(l.id),
  )
  const requested = str('branch')
  const chosen = requested && locations.some((l) => l.id === requested) ? requested : null
  const branchIds = chosen ? [chosen] : allowed

  const [sales, payments] = await Promise.all([
    getSalesReport({ restaurantId: user.restaurantId, range, branchIds }),
    getPaymentsReport({ restaurantId: user.restaurantId, range, branchIds }),
  ])
  const t = sales.totals

  return (
    <>
      <PageHeader title="Sales" description={`${range.label} · ${restaurant.name}`} />
      <ReportFilters
        preset={range.preset}
        from={str('from')}
        to={str('to')}
        locations={locations}
        branchId={chosen}
      />

      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Gross sales" value={money(t.grossSales)} />
        <StatCard label="Net sales" value={money(t.netSales)} hint="after discounts and refunds, before tax" />
        <StatCard label="Orders" value={String(t.orders)} />
        <StatCard label="Average order" value={money(t.averageOrderValue)} />
      </div>

      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Discounts" value={money(t.discounts)} />
        <StatCard label="Refunds" value={money(t.refunds)} />
        <StatCard label="Tax collected" value={money(t.tax)} hint="not the restaurant's money" />
        <StatCard label="Service charge" value={money(t.serviceCharge)} />
      </div>

      {payments.cashDiscrepancy !== 0 && payments.drawersClosed > 0 && (
        <div className="mb-6 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-300">
          Cash drawers over this period were {payments.cashDiscrepancy > 0 ? 'over' : 'short'} by{' '}
          <strong>{money(Math.abs(payments.cashDiscrepancy))}</strong> across {payments.drawersClosed}{' '}
          closed {payments.drawersClosed === 1 ? 'drawer' : 'drawers'}. This is reported separately from
          takings — a till that was short still took what it took.
        </div>
      )}

      <div className="space-y-5">
        <ReportTable
          title="By payment method"
          columns={[
            { key: 'label', label: 'Method' },
            { key: 'count', label: 'Payments', align: 'right' },
            { key: 'amount', label: 'Amount', align: 'right', format: (r) => money(Number(r.amount)) },
            { key: 'share', label: 'Share', align: 'right', format: (r) => `${r.share}%` },
          ]}
          rows={payments.byMethod as unknown as Array<Record<string, unknown>>}
          filename={`payments-${range.preset.toLowerCase()}`}
        />

        <ReportTable
          title="By item"
          description="Top 50 by revenue."
          columns={[
            { key: 'label', label: 'Item' },
            { key: 'quantity', label: 'Sold', align: 'right' },
            { key: 'sales', label: 'Revenue', align: 'right', format: (r) => money(Number(r.sales)) },
          ]}
          rows={sales.byItem as unknown as Array<Record<string, unknown>>}
          filename={`sales-by-item-${range.preset.toLowerCase()}`}
        />

        <ReportTable
          title="By category"
          columns={[
            { key: 'label', label: 'Category' },
            { key: 'orders', label: 'Lines', align: 'right' },
            { key: 'sales', label: 'Revenue', align: 'right', format: (r) => money(Number(r.sales)) },
          ]}
          rows={sales.byCategory as unknown as Array<Record<string, unknown>>}
          filename={`sales-by-category-${range.preset.toLowerCase()}`}
        />

        {sales.byBranch.length > 1 && (
          <ReportTable
            title="By location"
            columns={[
              { key: 'label', label: 'Location' },
              { key: 'orders', label: 'Orders', align: 'right' },
              { key: 'sales', label: 'Revenue', align: 'right', format: (r) => money(Number(r.sales)) },
            ]}
            rows={sales.byBranch as unknown as Array<Record<string, unknown>>}
            filename={`sales-by-location-${range.preset.toLowerCase()}`}
          />
        )}

        {sales.byEmployee.length > 0 && (
          <ReportTable
            title="By employee"
            description="Orders entered by each member of staff."
            columns={[
              { key: 'label', label: 'Employee' },
              { key: 'orders', label: 'Orders', align: 'right' },
              { key: 'sales', label: 'Revenue', align: 'right', format: (r) => money(Number(r.sales)) },
            ]}
            rows={sales.byEmployee as unknown as Array<Record<string, unknown>>}
            filename={`sales-by-employee-${range.preset.toLowerCase()}`}
          />
        )}

        <ReportTable
          title="By hour"
          description="When the money comes in — useful for rostering."
          columns={[
            { key: 'label', label: 'Hour' },
            { key: 'orders', label: 'Orders', align: 'right' },
            { key: 'sales', label: 'Revenue', align: 'right', format: (r) => money(Number(r.sales)) },
          ]}
          rows={sales.byHour as unknown as Array<Record<string, unknown>>}
          filename={`sales-by-hour-${range.preset.toLowerCase()}`}
        />

        <ReportTable
          title="By day"
          columns={[
            { key: 'label', label: 'Day' },
            { key: 'orders', label: 'Orders', align: 'right' },
            { key: 'sales', label: 'Revenue', align: 'right', format: (r) => money(Number(r.sales)) },
          ]}
          rows={sales.byDay as unknown as Array<Record<string, unknown>>}
          filename={`sales-by-day-${range.preset.toLowerCase()}`}
        />
      </div>
    </>
  )
}
