import type { Metadata } from 'next'
import Link from 'next/link'

import { getFinancialReconciliation } from '@/features/accounting/financial-reconciliation'
import { Badge } from '@/components/ui/badge'
import { PageHeader, SectionCard } from '@/features/dashboard/components/page-header'
import { selectedBranch } from '@/features/dashboard/selected-branch'
import { ReportFilters } from '@/features/reports/components/report-filters'
import { resolveRange } from '@/features/reports/range'
import { listLocations } from '@/features/transfers/queries'
import { PERMISSIONS } from '@/lib/rbac'
import { requirePagePermission } from '@/server/auth/guard'
import { requireRestaurant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Financial reconciliation' }

/**
 * §11: the money identities, checked live. Both sides of every equation come
 * from the module that owns it, so a mismatch means something is genuinely
 * wrong — not two screens computing differently.
 */
export default async function FinancialReconciliationPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const user = await requirePagePermission(
    PERMISSIONS.ACCOUNTING_VIEW,
    '/dashboard/accounting/reconciliation',
  )
  const restaurant = await requireRestaurant(user.restaurantId)

  const params = await searchParams
  const str = (key: string) => (typeof params[key] === 'string' ? (params[key] as string) : '')
  const range = resolveRange({
    preset: str('preset') || 'TODAY',
    from: str('from'),
    to: str('to'),
    timeZone: restaurant.timezone,
  })
  const selection = await selectedBranch(user, params)
  const locations = await listLocations(user.restaurantId, selection.branchIds)

  const report = await getFinancialReconciliation({
    restaurantId: user.restaurantId,
    range,
    branchIds: selection.branchIds,
  })

  const tone = (status: string) =>
    status === 'ERROR' ? 'destructive' : status === 'WARNING' ? 'outline' : 'secondary'

  return (
    <>
      <PageHeader
        title="Financial reconciliation"
        description={
          report.status === 'OK'
            ? 'Every identity holds. The books explain themselves.'
            : report.status === 'WARNING'
              ? 'The books balance, with items worth a look.'
              : 'Something does not balance — start with the red rows.'
        }
      />
      <ReportFilters
        preset={range.preset}
        from={str('from')}
        to={str('to')}
        locations={locations}
        branchId={selection.branchId}
      />

      <div className="mt-4 space-y-5">
        <SectionCard
          title="The identities"
          description="Both sides of each equation computed through the engines that own them, compared to the minor unit."
        >
          <ul className="divide-y text-sm">
            {report.identities.map((row) => (
              <li key={row.key} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  <Link href={row.href} className="font-medium text-primary underline-offset-2 hover:underline">
                    {row.label}
                  </Link>
                  <p className="mt-0.5 font-mono text-xs text-muted-foreground">{row.working}</p>
                </div>
                <Badge variant={tone(row.status)}>{row.status}</Badge>
              </li>
            ))}
          </ul>
        </SectionCard>

        <SectionCard
          title="Row-level integrity"
          description="The §115 checker: questions the database should never answer yes to, including the money-out workflow."
        >
          <ul className="grid gap-1.5 text-sm sm:grid-cols-2">
            {report.integrity.checks.map((check) => (
              <li key={check.key} className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
                <span className="min-w-0">
                  <span className="block truncate font-medium">{check.label}</span>
                  {check.status !== 'OK' ? (
                    <span className="block truncate text-xs text-muted-foreground" title={check.examples.join(', ')}>
                      {check.count} affected · e.g. {check.examples[0]}
                    </span>
                  ) : null}
                </span>
                <Badge variant={tone(check.status)}>{check.status}</Badge>
              </li>
            ))}
          </ul>
        </SectionCard>
      </div>
    </>
  )
}
