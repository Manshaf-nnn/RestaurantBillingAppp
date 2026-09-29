import type { Metadata } from 'next'

import { PageHeader } from '@/features/dashboard/components/page-header'
import { ExportMenu } from '@/features/reports/components/export-menu'
import { ReportFilters } from '@/features/reports/components/report-filters'
import { DeliveryReportView } from '@/features/orders/components/delivery-report-view'
import { getDeliveryReport } from '@/features/orders/delivery-report'
import { previousRange, resolveRange } from '@/features/reports/range'
import { listLocations } from '@/features/transfers/queries'
import { localeForCurrency, type CurrencyCode } from '@/lib/money'
import { PERMISSIONS, can } from '@/lib/rbac'
import { scopeToOne, selectedBranch } from '@/features/dashboard/selected-branch'
import { requirePagePermission } from '@/server/auth/guard'
import { requireRestaurant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Delivery report' }

/**
 * Delivery report — deliveries, sales, time to the door, cash collected at
 * the door, and where they went. Laid out exactly as the Inventory and Sales
 * reports are. Behind REPORT_SALES: it is money, and the desk itself is used
 * by riders who hold only the status permission.
 */
export default async function DeliveryReportPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const user = await requirePagePermission(PERMISSIONS.REPORT_SALES, '/dashboard/reports/delivery')
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

  const data = await getDeliveryReport({
    restaurantId: user.restaurantId,
    branchIds: chosen ? [chosen] : selection.branchIds,
    from: range.from,
    to: range.to,
    previous: previousRange(range),
    timeZone: restaurant.timezone,
  })

  const locale = restaurant.locale === 'en' ? localeForCurrency(restaurant.currency) : restaurant.locale
  const branchLabel = chosen ? (locations.find((l) => l.id === chosen)?.name ?? 'One location') : 'All branches'

  return (
    <>
      <PageHeader
        title="Delivery Report"
        description="Track your deliveries, sales, time to the door and cash collected across all branches."
        actions={can(user, PERMISSIONS.REPORT_EXPORT) ? <ExportMenu type="deliveries" /> : null}
      />
      <div className="mb-4">
        <ReportFilters preset={range.preset} from={str('from')} to={str('to')} locations={locations} branchId={chosen} />
      </div>
      <DeliveryReportView
        data={data}
        currency={restaurant.currency as CurrencyCode}
        locale={locale}
        rangeLabel={range.label}
        branchLabel={branchLabel}
        timeZone={restaurant.timezone}
      />
    </>
  )
}
