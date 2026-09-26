import type { Metadata } from 'next'
import Link from 'next/link'

import { Badge } from '@/components/ui/badge'
import { ExportMenu } from '@/features/reports/components/export-menu'
import { ReportFilters } from '@/features/reports/components/report-filters'
import { DrillDown, DrillTable, Pager } from '@/features/reports/components/drill-down'
import { getInventoryReport } from '@/features/reports/inventory-report'
import { pageHref, paginate, readPaging } from '@/features/reports/inventory-drill'
import { resolveRange } from '@/features/reports/range'
import { listLocations } from '@/features/transfers/queries'
import { PERMISSIONS, can } from '@/lib/rbac'
import { cn } from '@/lib/utils'
import { scopeToOne, selectedBranch } from '@/features/dashboard/selected-branch'
import { requirePagePermission } from '@/server/auth/guard'
import { requireRestaurant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Low stock report' }

/**
 * Items below their reorder level, out of stock first.
 *
 * `?only=out` narrows to the ones that have actually run out — the link the
 * "Out of Stock Items" tile points at, so the tile and this page cannot
 * report different counts.
 */
export default async function LowStockReportPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const user = await requirePagePermission(
    PERMISSIONS.REPORT_INVENTORY,
    '/dashboard/reports/inventory/low-stock',
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
  const onlyOut = str('only') === 'out'

  /*
   * The full list, not the five the summary card shows. `getInventoryReport`
   * caps `lowStockItems` for the card; this page wants everything, so it
   * reads the same computation and re-filters rather than running a second,
   * subtly different query.
   */
  const data = await getInventoryReport({
    restaurantId: user.restaurantId,
    branchId: chosen,
    from: range.from,
    to: range.to,
  })
  const rows = data.lowStockItemsAll.filter((row) => (onlyOut ? row.outOfStock : true))
  const { page, perPage } = readPaging(p)
  const view = paginate(rows, page, perPage)

  return (
    <DrillDown
      title="Low Stock Items Report"
      description={
        onlyOut
          ? 'Items that have run out at this location.'
          : 'Items that are below their reorder level. Out of stock first — those are the ones that stop service.'
      }
      actions={can(user, PERMISSIONS.REPORT_EXPORT) ? <ExportMenu type="inventory" /> : null}
      filters={
        <div className="space-y-3">
          <ReportFilters
            preset={range.preset}
            from={str('from')}
            to={str('to')}
            locations={locations}
            branchId={chosen}
          />
          <div className="flex gap-1.5">
            <Link
              href={pageHref('/dashboard/reports/inventory/low-stock', { ...p, only: '' }, 1)}
              aria-current={onlyOut ? undefined : 'page'}
              className={cn(
                'rounded-full border px-3 py-1 text-xs font-medium',
                onlyOut ? 'text-muted-foreground hover:text-foreground' : 'border-primary bg-primary text-primary-foreground',
              )}
            >
              Low and out ({data.lowStockItemsAll.length})
            </Link>
            <Link
              href={pageHref('/dashboard/reports/inventory/low-stock', { ...p, only: 'out' }, 1)}
              aria-current={onlyOut ? 'page' : undefined}
              className={cn(
                'rounded-full border px-3 py-1 text-xs font-medium',
                onlyOut ? 'border-primary bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              Out of stock ({data.outOfStock.value})
            </Link>
          </div>
        </div>
      }
      footer={
        <Pager
          page={view.page}
          pageCount={view.pageCount}
          total={view.total}
          perPage={perPage}
          hrefFor={(n) => pageHref('/dashboard/reports/inventory/low-stock', p, n)}
        />
      }
    >
      <DrillTable
        isEmpty={view.rows.length === 0}
        empty={onlyOut ? 'Nothing has run out.' : 'Everything is above its reorder level.'}
        columns={[
          { label: '#' },
          { label: 'Item' },
          { label: 'Category' },
          { label: 'Current stock', align: 'right' },
          { label: 'Reorder level', align: 'right' },
          { label: 'Status' },
        ]}
      >
        {view.rows.map((row, index) => (
          <tr key={row.itemId}>
            <td className="px-4 py-3 text-muted-foreground">{(view.page - 1) * perPage + index + 1}</td>
            <td className="px-4 py-3">
              <Link href={`/dashboard/inventory/${row.itemId}`} className="font-medium hover:underline">
                {row.name}
              </Link>
            </td>
            <td className="px-4 py-3 text-muted-foreground">{row.category}</td>
            <td
              className={cn(
                'px-4 py-3 text-right font-medium tabular-nums',
                row.outOfStock ? 'text-destructive' : 'text-warning',
              )}
            >
              {row.quantity} {row.unit.toLowerCase()}
            </td>
            <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
              {row.reorderLevel} {row.unit.toLowerCase()}
            </td>
            <td className="px-4 py-3">
              {/* Never colour alone: the badge carries the word too. */}
              <Badge variant={row.outOfStock ? 'destructive' : 'warning'}>
                {row.outOfStock ? 'Out of stock' : 'Low'}
              </Badge>
            </td>
          </tr>
        ))}
      </DrillTable>
    </DrillDown>
  )
}
