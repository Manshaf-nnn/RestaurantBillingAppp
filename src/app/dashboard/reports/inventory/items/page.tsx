import type { Metadata } from 'next'
import Link from 'next/link'

import { ExportMenu } from '@/features/reports/components/export-menu'
import { ReportFilters } from '@/features/reports/components/report-filters'
import { DrillDown, DrillTable, Pager } from '@/features/reports/components/drill-down'
import { listItemInventory } from '@/features/reports/inventory-report'
import { pageHref, paginate, readPaging } from '@/features/reports/inventory-drill'
import { resolveRange } from '@/features/reports/range'
import { listLocations } from '@/features/transfers/queries'
import { formatMoney } from '@/lib/money'
import { PERMISSIONS, can } from '@/lib/rbac'
import { scopeToOne, selectedBranch } from '@/features/dashboard/selected-branch'
import { requirePagePermission } from '@/server/auth/guard'
import { requireRestaurant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Item inventory report' }

/** Opening → in → out → closing, per item, for the chosen window. */
export default async function ItemInventoryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const user = await requirePagePermission(
    PERMISSIONS.REPORT_INVENTORY,
    '/dashboard/reports/inventory/items',
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

  const all = await listItemInventory({
    restaurantId: user.restaurantId,
    branchId: chosen,
    from: range.from,
    to: range.to,
  })
  const { page, perPage } = readPaging(p)
  const view = paginate(all, page, perPage)
  const money = (m: number) => formatMoney(m, restaurant.currency)

  return (
    <DrillDown
      title="Item Inventory Report"
      description={`View current stock, usage and value for each inventory item · ${range.label}`}
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
          hrefFor={(n) => pageHref('/dashboard/reports/inventory/items', p, n)}
        />
      }
    >
      <DrillTable
        isEmpty={view.rows.length === 0}
        empty="No active items at this location."
        columns={[
          { label: '#' },
          { label: 'Item' },
          { label: 'Category' },
          { label: 'Opening stock', align: 'right' },
          { label: 'Stock in', align: 'right' },
          { label: 'Stock out', align: 'right' },
          { label: 'Closing stock', align: 'right' },
          { label: 'Value', align: 'right' },
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
            <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
              {row.opening} {row.unit.toLowerCase()}
            </td>
            <td className="px-4 py-3 text-right tabular-nums text-success">
              {row.stockIn ? `${row.stockIn} ${row.unit.toLowerCase()}` : '—'}
            </td>
            <td className="px-4 py-3 text-right tabular-nums text-warning">
              {row.stockOut ? `${row.stockOut} ${row.unit.toLowerCase()}` : '—'}
            </td>
            <td className="px-4 py-3 text-right font-medium tabular-nums">
              {row.closing} {row.unit.toLowerCase()}
            </td>
            <td className="px-4 py-3 text-right font-medium tabular-nums">{money(row.value)}</td>
          </tr>
        ))}
      </DrillTable>
    </DrillDown>
  )
}
