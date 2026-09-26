import type { Metadata } from 'next'
import Link from 'next/link'

import { LocalDateTime } from '@/components/local-time'
import { Badge } from '@/components/ui/badge'
import { ExportMenu } from '@/features/reports/components/export-menu'
import { ReportFilters } from '@/features/reports/components/report-filters'
import { DrillDown, DrillTable, Pager } from '@/features/reports/components/drill-down'
import {
  MOVEMENT_LABELS,
  listMovementDetails,
  type MovementBucket,
} from '@/features/reports/inventory-report'
import { pageHref, paginate, readPaging } from '@/features/reports/inventory-drill'
import { resolveRange } from '@/features/reports/range'
import { listLocations } from '@/features/transfers/queries'
import { formatMoney } from '@/lib/money'
import { PERMISSIONS, can } from '@/lib/rbac'
import { cn } from '@/lib/utils'
import { scopeToOne, selectedBranch } from '@/features/dashboard/selected-branch'
import { requirePagePermission } from '@/server/auth/guard'
import { requireRestaurant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Stock movement report' }

const BUCKETS: MovementBucket[] = ['IN', 'OUT', 'TRANSFER', 'ADJUSTMENT']

const TONE: Record<MovementBucket, 'success' | 'warning' | 'info' | 'secondary'> = {
  IN: 'success',
  OUT: 'warning',
  TRANSFER: 'info',
  ADJUSTMENT: 'secondary',
}

/** Every movement in the window, newest first. The ledger, read plainly. */
export default async function StockMovementReportPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const user = await requirePagePermission(
    PERMISSIONS.REPORT_INVENTORY,
    '/dashboard/reports/inventory/movements',
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
  const bucket = BUCKETS.includes(str('bucket') as MovementBucket)
    ? (str('bucket') as MovementBucket)
    : null

  const all = await listMovementDetails({
    restaurantId: user.restaurantId,
    branchId: chosen,
    from: range.from,
    to: range.to,
    bucket,
    limit: 500,
  })
  const { page, perPage } = readPaging(p)
  const view = paginate(all, page, perPage)
  const money = (m: number) => formatMoney(m, restaurant.currency)

  return (
    <DrillDown
      title="Stock Movement Report"
      description={`Detailed history of all inventory movements · ${range.label}`}
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
          <div className="flex flex-wrap gap-1.5">
            <Link
              href={pageHref('/dashboard/reports/inventory/movements', { ...p, bucket: '' }, 1)}
              aria-current={bucket ? undefined : 'page'}
              className={cn(
                'rounded-full border px-3 py-1 text-xs font-medium',
                bucket ? 'text-muted-foreground hover:text-foreground' : 'border-primary bg-primary text-primary-foreground',
              )}
            >
              All movements
            </Link>
            {BUCKETS.map((value) => (
              <Link
                key={value}
                href={pageHref('/dashboard/reports/inventory/movements', { ...p, bucket: value }, 1)}
                aria-current={bucket === value ? 'page' : undefined}
                className={cn(
                  'rounded-full border px-3 py-1 text-xs font-medium',
                  bucket === value
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {MOVEMENT_LABELS[value]}
              </Link>
            ))}
          </div>
        </div>
      }
      footer={
        <Pager
          page={view.page}
          pageCount={view.pageCount}
          total={view.total}
          perPage={perPage}
          hrefFor={(n) => pageHref('/dashboard/reports/inventory/movements', p, n)}
        />
      }
    >
      <DrillTable
        isEmpty={view.rows.length === 0}
        empty="Nothing moved in this period."
        columns={[
          { label: 'Date & time' },
          { label: 'Type' },
          { label: 'Item' },
          { label: 'Qty', align: 'right' },
          { label: 'Unit cost', align: 'right' },
          { label: 'Total value', align: 'right' },
          { label: 'Reference' },
        ]}
      >
        {view.rows.map((row) => (
          <tr key={row.id}>
            <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">
              <LocalDateTime value={row.at} />
            </td>
            <td className="px-4 py-3">
              {/* The bucket in words and colour; the raw type underneath, so
                  a reader can tell a sale from a wastage within "Stock Out". */}
              <Badge variant={TONE[row.bucket]}>{MOVEMENT_LABELS[row.bucket]}</Badge>
              <span className="mt-0.5 block text-[11px] text-muted-foreground">
                {row.type.replace(/_/g, ' ').toLowerCase()}
              </span>
            </td>
            <td className="px-4 py-3">
              <Link href={`/dashboard/inventory/${row.itemId}`} className="font-medium hover:underline">
                {row.itemName}
              </Link>
              {row.branchName ? (
                <span className="mt-0.5 block text-[11px] text-muted-foreground">{row.branchName}</span>
              ) : null}
            </td>
            <td className="px-4 py-3 text-right tabular-nums">
              {row.quantity} {row.unit.toLowerCase()}
            </td>
            <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
              {money(row.unitCost)}
            </td>
            <td className="px-4 py-3 text-right font-medium tabular-nums">{money(row.value)}</td>
            <td className="px-4 py-3 text-muted-foreground">{row.reference ?? '—'}</td>
          </tr>
        ))}
      </DrillTable>
    </DrillDown>
  )
}
