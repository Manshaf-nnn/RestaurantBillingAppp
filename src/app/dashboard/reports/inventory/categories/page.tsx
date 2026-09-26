import type { Metadata } from 'next'

import { ExportMenu } from '@/features/reports/components/export-menu'
import { ReportFilters } from '@/features/reports/components/report-filters'
import { DrillDown, DrillTable, Pager } from '@/features/reports/components/drill-down'
import { getInventoryReport } from '@/features/reports/inventory-report'
import { pageHref, paginate, readPaging } from '@/features/reports/inventory-drill'
import { resolveRange } from '@/features/reports/range'
import { listLocations } from '@/features/transfers/queries'
import { formatMoney } from '@/lib/money'
import { PERMISSIONS, can } from '@/lib/rbac'
import { scopeToOne, selectedBranch } from '@/features/dashboard/selected-branch'
import { requirePagePermission } from '@/server/auth/guard'
import { requireRestaurant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Category inventory report' }

/** Stock value grouped by category — the donut, at full length. */
export default async function CategoryInventoryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const user = await requirePagePermission(
    PERMISSIONS.REPORT_INVENTORY,
    '/dashboard/reports/inventory/categories',
  )
  const restaurant = await requireRestaurant(user.restaurantId)
  const p = await searchParams
  const str = (k: string) => (typeof p[k] === 'string' ? (p[k] as string) : '')
  const range = resolveRange({
    preset: str('preset') || 'LAST_30',
    from: str('from'),
    to: str('to'),
    timeZone: restaurant.timezone,
  })
  const selection = await selectedBranch(user, p)
  const locations = await listLocations(user.restaurantId, selection.branchIds)
  const chosen = scopeToOne(selection)

  const data = await getInventoryReport({
    restaurantId: user.restaurantId,
    branchId: chosen,
    from: range.from,
    to: range.to,
  })
  const { page, perPage } = readPaging(p)
  const view = paginate(data.byCategory, page, perPage)
  const money = (m: number) => formatMoney(m, restaurant.currency)

  return (
    <DrillDown
      title="Category Inventory Report"
      description={`View stock summary for each category · ${range.label}`}
      actions={can(user, PERMISSIONS.REPORT_EXPORT) ? <ExportMenu type="inventory" /> : null}
      filters={
        <ReportFilters
          preset={range.preset}
          from={str('from')}
          to={str('to')}
          locations={locations}
          branchId={chosen}
        />
      }
      footer={
        <Pager
          page={view.page}
          pageCount={view.pageCount}
          total={view.total}
          perPage={perPage}
          hrefFor={(n) => pageHref('/dashboard/reports/inventory/categories', p, n)}
        />
      }
    >
      <DrillTable
        isEmpty={view.rows.length === 0}
        empty="Nothing in stock, so there is nothing to group."
        columns={[
          { label: '#' },
          { label: 'Category' },
          { label: 'Items', align: 'right' },
          { label: 'Stock quantity', align: 'right' },
          { label: 'Stock value', align: 'right' },
          { label: '% of total', align: 'right' },
        ]}
      >
        {view.rows.map((row, index) => (
          <tr key={row.category}>
            <td className="px-4 py-3 text-muted-foreground">{(view.page - 1) * perPage + index + 1}</td>
            <td className="px-4 py-3 font-medium">{row.category}</td>
            <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">{row.items}</td>
            <td className="px-4 py-3 text-right tabular-nums">{row.quantity}</td>
            <td className="px-4 py-3 text-right font-medium tabular-nums">{money(row.value)}</td>
            <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
              {(row.share * 100).toFixed(1)}%
            </td>
          </tr>
        ))}
      </DrillTable>
    </DrillDown>
  )
}
