import type { Metadata } from 'next'

import { PageHeader } from '@/features/dashboard/components/page-header'
import { ExportMenu } from '@/features/reports/components/export-menu'
import { ReportFilters } from '@/features/reports/components/report-filters'
import { ReservationReportView } from '@/features/floor/components/reservation-report-view'
import { getReservationReport } from '@/features/floor/reservation-report'
import { previousRange, resolveRange } from '@/features/reports/range'
import { listLocations } from '@/features/transfers/queries'
import { localeForCurrency } from '@/lib/money'
import { PERMISSIONS, can } from '@/lib/rbac'
import { scopeToOne, selectedBranch } from '@/features/dashboard/selected-branch'
import { requirePagePermission } from '@/server/auth/guard'
import { requireRestaurant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Reservations report' }

/**
 * Reservations report — how many bookings, for how many people, how many
 * were kept, cancelled or never arrived, and where and when they fall.
 * Same layout and filters as every other report; behind the same permission
 * as the diary it summarises.
 */
export default async function ReservationsReportPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const user = await requirePagePermission(PERMISSIONS.RESERVATION_MANAGE, '/dashboard/reports/reservations')
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

  const data = await getReservationReport({
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
        title="Reservations Report"
        description="Bookings taken, guests expected, and how many were kept, cancelled or never arrived."
        actions={can(user, PERMISSIONS.REPORT_EXPORT) ? <ExportMenu type="reservations" /> : null}
      />
      <div className="mb-4">
        <ReportFilters preset={range.preset} from={str('from')} to={str('to')} locations={locations} branchId={chosen} />
      </div>
      <ReservationReportView data={data} locale={locale} rangeLabel={range.label} branchLabel={branchLabel} timeZone={restaurant.timezone} />
    </>
  )
}
