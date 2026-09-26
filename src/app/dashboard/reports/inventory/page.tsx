import type { Metadata } from 'next'

import { PageHeader } from '@/features/dashboard/components/page-header'
import { ExportMenu } from '@/features/reports/components/export-menu'
import { ReportFilters } from '@/features/reports/components/report-filters'
import { InventoryReportView } from '@/features/reports/components/inventory-report-view'
import { getInventoryReport } from '@/features/reports/inventory-report'
import { resolveRange } from '@/features/reports/range'
import { listLocations } from '@/features/transfers/queries'
import { localeForCurrency, type CurrencyCode } from '@/lib/money'
import { PERMISSIONS, can } from '@/lib/rbac'
import { scopeToOne, selectedBranch } from '@/features/dashboard/selected-branch'
import { requirePagePermission } from '@/server/auth/guard'
import { requireRestaurant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Inventory reports' }

/**
 * Inventory Reports — stock usage, movement and value.
 *
 * Five figures, then value over time beside where that value sits, then the
 * three questions a manager actually opens this for: what is being used, what
 * is running out, and what moved. Each of the three leads to a drill-down
 * that is the same data at full length.
 *
 * Every figure comes from `getInventoryReport`, which reads the FIFO layers
 * for value and the ledger for movement — so this screen cannot disagree with
 * Stock Overview, the GRN or the variance report.
 */
export default async function InventoryReportPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const user = await requirePagePermission(PERMISSIONS.REPORT_INVENTORY, '/dashboard/reports/inventory')
  const restaurant = await requireRestaurant(user.restaurantId)

  const p = await searchParams
  const str = (k: string) => (typeof p[k] === 'string' ? (p[k] as string) : '')
  const range = resolveRange({
    preset: str('preset') || 'LAST_30',
    from: str('from'),
    to: str('to'),
    timeZone: restaurant.timezone,
  })

  /*
   * Resolved through the shared helper so the top-bar switcher and this
   * page's own picker always agree, and so a remembered choice survives
   * arriving here from the nav rather than from a link carrying `?branch=`.
   */
  const selection = await selectedBranch(user, p)
  const locations = await listLocations(user.restaurantId, selection.branchIds)
  const chosen = scopeToOne(selection)

  const data = await getInventoryReport({
    restaurantId: user.restaurantId,
    branchId: chosen,
    from: range.from,
    to: range.to,
  })

  const locale =
    restaurant.locale === 'en' ? localeForCurrency(restaurant.currency) : restaurant.locale
  const branchLabel = chosen
    ? locations.find((l) => l.id === chosen)?.name ?? 'One location'
    : 'All branches'

  return (
    <>
      <PageHeader
        title="Inventory Reports"
        description="Track your stock usage, movement, and value across all branches."
        actions={can(user, PERMISSIONS.REPORT_EXPORT) ? <ExportMenu type="inventory" /> : null}
      />
      <div className="mb-4">
        <ReportFilters
          preset={range.preset}
          from={str('from')}
          to={str('to')}
          locations={locations}
          branchId={chosen}
        />
      </div>
      <InventoryReportView
        data={data}
        currency={restaurant.currency as CurrencyCode}
        locale={locale}
        rangeLabel={range.label}
        branchLabel={branchLabel}
      />
    </>
  )
}
