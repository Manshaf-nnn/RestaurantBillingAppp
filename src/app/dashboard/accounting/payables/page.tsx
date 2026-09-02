import type { Metadata } from 'next'
import Link from 'next/link'

import { PageHeader, SectionCard, StatCard } from '@/features/dashboard/components/page-header'
import { selectedBranch } from '@/features/dashboard/selected-branch'
import { ReportFilters } from '@/features/reports/components/report-filters'
import { resolveRange } from '@/features/reports/range'
import { getPayablesStatement } from '@/features/suppliers/payables'
import { listLocations } from '@/features/transfers/queries'
import { formatMoney } from '@/lib/money'
import { PERMISSIONS } from '@/lib/rbac'
import { requirePagePermission } from '@/server/auth/guard'
import { requireRestaurant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Supplier payables' }

/**
 * The supplier statement (accountsds.md §4): opening, received, returned,
 * paid, closing — same arithmetic as the supplier ledger, over a period —
 * and aging that means real unpaid deliveries, oldest first.
 */
export default async function PayablesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const user = await requirePagePermission(PERMISSIONS.ACCOUNTING_VIEW, '/dashboard/accounting/payables')
  const restaurant = await requireRestaurant(user.restaurantId)
  const money = (value: number) => formatMoney(value, restaurant.currency)

  const params = await searchParams
  const str = (key: string) => (typeof params[key] === 'string' ? (params[key] as string) : '')
  const range = resolveRange({
    preset: str('preset') || 'THIS_MONTH',
    from: str('from'),
    to: str('to'),
    timeZone: restaurant.timezone,
  })
  const selection = await selectedBranch(user, params)
  const locations = await listLocations(user.restaurantId, selection.branchIds)

  const statement = await getPayablesStatement({
    restaurantId: user.restaurantId,
    range,
    branchIds: selection.branchIds,
  })

  return (
    <>
      <PageHeader
        title="Supplier payables"
        description={`${range.label} — the debt is made by deliveries (received × cost), retired by payments and returns. On-order is deliberately not owed yet.`}
      />
      <ReportFilters
        preset={range.preset}
        from={str('from')}
        to={str('to')}
        locations={locations}
        branchId={selection.branchId}
      />

      <div className="mb-5 mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Closing payable" value={money(statement.totals.closing)} tone={statement.totals.closing > 0 ? 'warning' : 'default'} />
        <StatCard label="Received this period" value={money(statement.totals.received)} />
        <StatCard label="Paid this period" value={money(statement.totals.paid)} href="/dashboard/accounting/payments" />
        <StatCard label="Overdue 90+ days" value={money(statement.totals.aging.d90plus)} tone={statement.totals.aging.d90plus > 0 ? 'destructive' : 'default'} />
      </div>

      <SectionCard title="Statement by supplier" description="Click a supplier for the full ledger: every delivery, return and payment.">
        {statement.rows.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            No supplier activity in this period.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[880px] text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="pb-2 pr-3 font-medium">Supplier</th>
                  <th className="pb-2 pr-3 text-right font-medium">Opening</th>
                  <th className="pb-2 pr-3 text-right font-medium">Received</th>
                  <th className="pb-2 pr-3 text-right font-medium">Returned</th>
                  <th className="pb-2 pr-3 text-right font-medium">Paid</th>
                  <th className="pb-2 pr-3 text-right font-medium">Closing</th>
                  <th className="pb-2 pr-3 text-right font-medium">0–30</th>
                  <th className="pb-2 pr-3 text-right font-medium">31–60</th>
                  <th className="pb-2 pr-3 text-right font-medium">61–90</th>
                  <th className="pb-2 text-right font-medium">90+</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {statement.rows.map((row) => (
                  <tr key={row.supplierId}>
                    <td className="max-w-[14rem] truncate py-2.5 pr-3">
                      <Link
                        href={`/dashboard/suppliers/${row.supplierId}`}
                        className="text-primary underline-offset-2 hover:underline"
                      >
                        {row.supplierName}
                      </Link>
                    </td>
                    <td className="py-2.5 pr-3 text-right tabular-nums text-muted-foreground">{money(row.opening)}</td>
                    <td className="py-2.5 pr-3 text-right tabular-nums">{money(row.received)}</td>
                    <td className="py-2.5 pr-3 text-right tabular-nums">{row.returned ? `− ${money(row.returned)}` : '—'}</td>
                    <td className="py-2.5 pr-3 text-right tabular-nums">{row.paid ? `− ${money(row.paid)}` : '—'}</td>
                    <td className="py-2.5 pr-3 text-right font-semibold tabular-nums">{money(row.closing)}</td>
                    <td className="py-2.5 pr-3 text-right tabular-nums text-muted-foreground">{row.aging.current ? money(row.aging.current) : '—'}</td>
                    <td className="py-2.5 pr-3 text-right tabular-nums text-muted-foreground">{row.aging.d31to60 ? money(row.aging.d31to60) : '—'}</td>
                    <td className="py-2.5 pr-3 text-right tabular-nums text-muted-foreground">{row.aging.d61to90 ? money(row.aging.d61to90) : '—'}</td>
                    <td className="py-2.5 text-right font-medium tabular-nums text-destructive">{row.aging.d90plus ? money(row.aging.d90plus) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>
    </>
  )
}
