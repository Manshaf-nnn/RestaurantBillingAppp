import type { Metadata } from 'next'
import Link from 'next/link'

import { InfoTip } from '@/features/accounting/components/info-tip'
import { getLedger } from '@/features/ledger/queries'
import { getProfitReport } from '@/features/reports/profit'
import { PageHeader, SectionCard } from '@/features/dashboard/components/page-header'
import { selectedBranch } from '@/features/dashboard/selected-branch'
import { ReportFilters } from '@/features/reports/components/report-filters'
import { resolveRange } from '@/features/reports/range'
import { listLocations } from '@/features/transfers/queries'
import { formatMoney } from '@/lib/money'
import { PERMISSIONS } from '@/lib/rbac'
import { requirePagePermission } from '@/server/auth/guard'
import { requireRestaurant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Accounting reports' }

const LINKS = [
  { href: '/dashboard/accounting/ledger', label: 'Journal & trial balance', hint: 'Every entry, and the account totals it produces.' },
  { href: '/dashboard/accounting/ledger?tab=cash', label: 'Cash book', hint: 'Physical cash in and out, with a running balance.' },
  { href: '/dashboard/accounting/ledger?tab=position', label: 'Financial position', hint: 'What the business holds, owes and has left over.' },
  { href: '/dashboard/accounting/reports/variance', label: 'Compare periods', hint: 'This period against the last, with reasons.' },
  { href: '/dashboard/reports/sales', label: 'Sales', hint: 'Revenue by day, method and branch.' },
  { href: '/dashboard/reports/profit', label: 'Menu profitability', hint: 'Item by item: cost, profit and margin.' },
  { href: '/dashboard/reports/purchasing', label: 'Purchases', hint: 'What was bought and received.' },
  { href: '/dashboard/reports/inventory', label: 'Inventory', hint: 'Stock on hand and its value.' },
  { href: '/dashboard/reports/cash-drawer', label: 'Cash drawers', hint: 'Sessions, counts and differences.' },
  { href: '/dashboard/accounting/payables', label: 'Supplier payables', hint: 'Who is owed, and for how long.' },
  { href: '/dashboard/accounting/reconciliation', label: 'Checks', hint: 'Identities, per-bill payments and issues.' },
  { href: '/dashboard/audit-logs', label: 'Audit trail', hint: 'Who changed what, and when.' },
]

/**
 * The report centre (acCal.md §15): one page that leads everywhere, with the
 * P&L — the statement an accountant reaches for first — rendered in place.
 */
export default async function AccountingReportsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const user = await requirePagePermission(PERMISSIONS.ACCOUNTING_VIEW, '/dashboard/accounting/reports')
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

  const [ledger, profit] = await Promise.all([
    getLedger({ restaurantId: user.restaurantId, range, branchIds: selection.branchIds }),
    getProfitReport({ restaurantId: user.restaurantId, range, branchIds: selection.branchIds }),
  ])
  const pnl = ledger.profitAndLoss

  const ranked = [...profit.byItem].filter((row) => row.quantity >= 5 && row.revenue > 0)
  const mostProfitable = [...ranked].sort((a, b) => b.grossProfit - a.grossProfit)[0]
  const lowestMargin = [...ranked].sort(
    (a, b) => (a.grossMarginPercent ?? 0) - (b.grossMarginPercent ?? 0),
  )[0]

  const row = (label: string, amount: number, options: { strong?: boolean; minus?: boolean } = {}) => (
    <li
      key={label}
      className={`flex justify-between gap-4 py-2 ${options.strong ? 'border-t font-semibold' : ''}`}
    >
      <span>{label}</span>
      <span className="tabular-nums">
        {options.minus ? '− ' : ''}
        {money(amount)}
      </span>
    </li>
  )

  return (
    <>
      <PageHeader
        title="Reports"
        description={`${range.label} · every report an accountant needs, in one place.`}
      />
      <ReportFilters
        preset={range.preset}
        from={str('from')}
        to={str('to')}
        locations={locations}
        branchId={selection.branchId}
      />

      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        <SectionCard
          title="Profit & loss"
          description="Built from the same records as every other screen. It counts the costs TableFlow records — not loans, rent arrears or anything never entered."
        >
          <ul className="text-sm">
            {row('Sales', pnl.revenue.grossSales)}
            {row('Discounts given', pnl.revenue.discounts, { minus: true })}
            {row('Refunds', pnl.revenue.refunds, { minus: true })}
            {row('Net sales', pnl.revenue.netSales, { strong: true })}
            {row('Ingredient cost (COGS)', pnl.cogs, { minus: true })}
            {row('Gross profit', pnl.grossProfit, { strong: true })}
            {pnl.revenue.serviceCharge !== 0 ? row('Service charge', pnl.revenue.serviceCharge) : null}
            {pnl.expenses.map((expense) => row(expense.label, expense.amount, { minus: true }))}
            {row('Operating profit', pnl.operatingProfit, { strong: true })}
          </ul>
          <p className="mt-2 text-xs text-muted-foreground">
            {pnl.marginPercent !== null
              ? `${pnl.marginPercent}% of net sales is left after the costs on record.`
              : 'No sales in this period.'}{' '}
            <InfoTip term="grossProfit" />
          </p>
        </SectionCard>

        <div className="space-y-5">
          {mostProfitable || lowestMargin ? (
            <SectionCard title="Menu profitability" description="Items with at least 5 sold in the period.">
              <div className="grid gap-3 sm:grid-cols-2">
                {mostProfitable ? (
                  <div className="rounded-lg border p-3">
                    <p className="text-xs font-medium text-muted-foreground">Most profitable</p>
                    <p className="mt-1 font-semibold">{mostProfitable.label}</p>
                    <p className="text-sm text-muted-foreground">
                      {money(mostProfitable.grossProfit)} profit ·{' '}
                      {mostProfitable.grossMarginPercent ?? '—'}% margin
                    </p>
                  </div>
                ) : null}
                {lowestMargin ? (
                  <div className="rounded-lg border p-3">
                    <p className="text-xs font-medium text-muted-foreground">Lowest margin</p>
                    <p className="mt-1 font-semibold">{lowestMargin.label}</p>
                    <p className="text-sm text-muted-foreground">
                      {lowestMargin.grossMarginPercent ?? '—'}% margin · {money(lowestMargin.grossProfit)} profit
                    </p>
                  </div>
                ) : null}
              </div>
              {profit.coverage.percentCovered < 90 ? (
                <p className="mt-3 text-xs text-muted-foreground">
                  Only {profit.coverage.percentCovered}% of revenue has a recipe behind it, so these rankings
                  cover part of the menu. Add recipes to the rest for a full picture.
                </p>
              ) : null}
              <Link
                href="/dashboard/reports/profit"
                className="mt-3 inline-block text-sm font-medium text-primary underline-offset-2 hover:underline"
              >
                Every item →
              </Link>
            </SectionCard>
          ) : null}

          <SectionCard title="All reports" description="Each opens with the dates you picked above.">
            <ul className="grid gap-1.5 text-sm sm:grid-cols-2">
              {LINKS.map((link) => (
                <li key={link.href}>
                  <Link href={link.href} className="block rounded-lg border px-3 py-2 hover:bg-muted/50">
                    <span className="font-medium">{link.label}</span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">{link.hint}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </SectionCard>
        </div>
      </div>
    </>
  )
}
