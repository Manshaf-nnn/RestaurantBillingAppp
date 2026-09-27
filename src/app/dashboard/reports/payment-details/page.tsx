import type { Metadata } from 'next'

import { PageHeader } from '@/features/dashboard/components/page-header'
import { ExportMenu } from '@/features/reports/components/export-menu'
import { ReportFilters } from '@/features/reports/components/report-filters'
import { PaymentReportView } from '@/features/payments/components/payment-report-view'
import { getPaymentReport } from '@/features/payments/report'
import { previousRange, resolveRange } from '@/features/reports/range'
import { listLocations } from '@/features/transfers/queries'
import { localeForCurrency, type CurrencyCode } from '@/lib/money'
import { PERMISSIONS, can } from '@/lib/rbac'
import { scopeToOne, selectedBranch } from '@/features/dashboard/selected-branch'
import { requirePagePermission } from '@/server/auth/guard'
import { requireRestaurant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Payment details report' }

/**
 * Payment details report — what came in, by which method, into which account,
 * and what was moved between accounts.
 *
 * Laid out exactly as the Inventory report is (five figures, the trend beside
 * the split, three summaries) and filtered by the same period and branch
 * picker, so every report in the product reads the same way.
 *
 * Behind ACCOUNT_VIEW, the permission that opens Payment details itself, and
 * narrowed inside `getPaymentReport` to the accounts the owner gave this
 * person — a report must not show the figures the owner withheld.
 */
export default async function PaymentDetailsReportPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const user = await requirePagePermission(PERMISSIONS.ACCOUNT_VIEW, '/dashboard/reports/payment-details')
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

  const data = await getPaymentReport({
    user,
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
        title="Payment Details Report"
        description="Track what you collected, by method and by account, and every deposit and transfer between accounts."
        actions={can(user, PERMISSIONS.REPORT_EXPORT) ? <ExportMenu type="payment-details" /> : null}
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
      <PaymentReportView
        data={data}
        currency={restaurant.currency as CurrencyCode}
        locale={locale}
        rangeLabel={range.label}
        branchLabel={branchLabel}
      />
    </>
  )
}
