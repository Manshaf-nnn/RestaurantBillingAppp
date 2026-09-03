import type { Metadata } from 'next'

import { AskTheNumbers } from '@/features/accounting/components/ask-the-numbers'
import { ExplainPopover } from '@/features/accounting/components/explain-popover'
import { InfoTip } from '@/features/accounting/components/info-tip'
import { buildExplanations } from '@/features/accounting/explain'
import { getAccountingHub } from '@/features/accounting/hub'
import { getApprovalsInboxCount } from '@/features/accounting/inbox'
import { runIntegrityChecks } from '@/features/accounting/integrity'
import { buildNumbersAnswers } from '@/features/accounting/questions'
import { PageHeader, SectionCard, StatCard } from '@/features/dashboard/components/page-header'
import { scopeToOne, selectedBranch } from '@/features/dashboard/selected-branch'
import { ReportFilters } from '@/features/reports/components/report-filters'
import { comparisonLabel, customRange, previousRange, resolveRange } from '@/features/reports/range'
import { listLocations } from '@/features/transfers/queries'
import { formatMoney, type CurrencyCode } from '@/lib/money'
import { PERMISSIONS } from '@/lib/rbac'
import { requirePagePermission } from '@/server/auth/guard'
import { requireRestaurant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Accounting' }

/**
 * The accountant's dashboard (accountsds.md §2): the financial summary for a
 * restaurant, branch and period — every figure composed from the same engines
 * the reports use, every card linking to the screen that explains it.
 *
 * Revenue ≠ payments ≠ purchases ≠ COGS ≠ expenses ≠ cash. The cards keep
 * those apart on purpose; the day this page averages them into one number is
 * the day it stops being an accounting screen.
 */
export default async function AccountingHubPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const user = await requirePagePermission(PERMISSIONS.ACCOUNTING_VIEW, '/dashboard/accounting')
  const restaurant = await requireRestaurant(user.restaurantId)
  const money = (value: number) => formatMoney(value, restaurant.currency)

  const params = await searchParams
  const str = (key: string) => (typeof params[key] === 'string' ? (params[key] as string) : '')
  const range = resolveRange({
    preset: str('preset') || 'TODAY',
    from: str('from'),
    to: str('to'),
    timeZone: restaurant.timezone,
  })
  const selection = await selectedBranch(user, params)
  const branchId = scopeToOne(selection)
  const branchIds = branchId ? [branchId] : selection.branchIds
  const locations = await listLocations(user.restaurantId, selection.branchIds)

  const prev = previousRange(range)
  const [hub, prevHub, inbox, integrity] = await Promise.all([
    getAccountingHub({ restaurantId: user.restaurantId, range, branchIds }),
    getAccountingHub({
      restaurantId: user.restaurantId,
      range: customRange(prev.from, prev.to, restaurant.timezone),
      branchIds,
    }),
    getApprovalsInboxCount(user.restaurantId, branchIds),
    runIntegrityChecks(user.restaurantId),
  ])
  const issueErrors = integrity.checks.filter((check) => check.status === 'ERROR').length
  const issueWarnings = integrity.checks.filter((check) => check.status === 'WARNING').length
  const explain = buildExplanations(hub, money)
  const answers = buildNumbersAnswers({
    hub,
    prevHub,
    integrity,
    money,
    comparisonLabel: comparisonLabel(range),
  })
  const currency = restaurant.currency as CurrencyCode

  return (
    <>
      <PageHeader
        title="Accounting"
        description={`${range.label} · ${restaurant.name} — every number here clicks through to the record explaining it.`}
      />
      <ReportFilters
        preset={range.preset}
        from={str('from')}
        to={str('to')}
        locations={locations}
        branchId={branchId}
      />

      <h2 className="mb-2 mt-5 text-sm font-semibold text-muted-foreground">What we sold</h2>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Net sales" info={<InfoTip term="netSales" />} value={money(hub.sales.netSales)} tone="primary" hint={`gross ${money(hub.sales.grossSales)}`} href="/dashboard/reports/sales" explain={<ExplainPopover explanation={explain.netSales} currency={currency} />} />
        <StatCard label="Discounts" value={money(hub.sales.discounts)} hint="coupons, manual, loyalty" href="/dashboard/reports/sales" />
        <StatCard label="Refunds" value={money(hub.sales.refunds)} href="/dashboard/reports/sales" />
        <StatCard label="Total billed" value={money(hub.sales.totalBilled)} hint={`incl. ${money(hub.sales.tax)} tax · ${money(hub.sales.serviceCharge)} service`} href="/dashboard/invoices" />
      </div>

      <h2 className="mb-2 mt-6 text-sm font-semibold text-muted-foreground">What we collected — money in, not revenue</h2>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Collected" info={<InfoTip term="collected" />} value={money(hub.collections.collected)} tone="success" hint={`refunded ${money(hub.collections.refunded)} · tips ${money(hub.sales.tips)}`} href="/dashboard/reports/sales" explain={<ExplainPopover explanation={explain.collected} currency={currency} />} />
        {hub.collections.byMethod.slice(0, 2).map((row) => (
          <StatCard key={row.method} label={row.label} value={money(row.amount)} href="/dashboard/reports/sales" />
        ))}
        <StatCard label="Receivables" info={<InfoTip term="receivables" />} value={money(hub.collections.outstanding)} tone={hub.collections.outstanding > 0 ? 'warning' : 'default'} hint="billed, not yet collected" href="/dashboard/invoices" explain={<ExplainPopover explanation={explain.receivables} currency={currency} />} />
      </div>

      <h2 className="mb-2 mt-6 text-sm font-semibold text-muted-foreground">What it cost — purchases are not COGS</h2>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="COGS" info={<InfoTip term="cogs" />} value={money(hub.profit.cogs)} hint="what the sold food's ingredients cost" href="/dashboard/reports/profit" explain={<ExplainPopover explanation={explain.cogs} currency={currency} />} />
        <StatCard label="Gross profit" info={<InfoTip term="grossProfit" />} value={money(hub.profit.grossProfit)} tone="success" hint={hub.profit.grossMarginPercent !== null ? `${hub.profit.grossMarginPercent}% margin` : undefined} href="/dashboard/reports/profit" explain={<ExplainPopover explanation={explain.grossProfit} currency={currency} />} />
        <StatCard label="Goods received" info={<InfoTip term="purchases" />} value={money(hub.purchasing.receivedValue)} hint="stock bought this period — not COGS" href="/dashboard/reports/purchasing" />
        <StatCard label="Expenses paid" value={money(hub.expenses.paid)} hint={hub.expenses.pendingApproval > 0 ? `${money(hub.expenses.pendingApproval)} awaiting approval` : 'rent, salaries, utilities…'} href="/dashboard/accounting/expenses" />
      </div>

      <h2 className="mb-2 mt-6 text-sm font-semibold text-muted-foreground">What we owe and hold</h2>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Supplier payables" info={<InfoTip term="payables" />} value={money(hub.purchasing.payablesOutstanding)} tone={hub.purchasing.payablesOutstanding > 0 ? 'warning' : 'default'} href="/dashboard/accounting/payables" explain={<ExplainPopover explanation={explain.payables} currency={currency} />} />
        <StatCard label="Suppliers paid" value={money(hub.purchasing.supplierPaymentsPaid)} hint="this period" href="/dashboard/accounting/payments" />
        <StatCard label="Stock on hand" info={<InfoTip term="inventoryValue" />} value={money(hub.inventory.stockValueNow)} hint={`waste this period ${money(hub.inventory.wasteValue)}`} href="/dashboard/reports/reconciliation" />
        <StatCard label="Cash difference" info={<InfoTip term="cashDifference" />} value={money(hub.cash.drawerVariance)} tone={hub.cash.drawerVariance === 0 ? 'default' : 'destructive'} hint={`${hub.cash.drawersClosed} drawer(s) closed`} href="/dashboard/reports/cash-drawer" explain={<ExplainPopover explanation={explain.cashDifference} currency={currency} />} />
      </div>

      <h2 className="mb-2 mt-6 text-sm font-semibold text-muted-foreground">What needs your attention</h2>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Pending approvals"
          value={inbox.count}
          tone={inbox.count > 0 ? 'warning' : 'default'}
          hint={
            inbox.count > 0
              ? `${money(inbox.amount)} asked for · ${inbox.byQueue.map((row) => `${row.count} ${row.queue.toLowerCase()}`).join(' · ')}`
              : 'nothing waiting on a decision'
          }
          href="/dashboard/accounting/approvals"
        />
        <StatCard
          label="Issues"
          value={issueErrors > 0 || issueWarnings > 0 ? `${issueErrors} critical · ${issueWarnings} warnings` : 'All clear'}
          tone={issueErrors > 0 ? 'destructive' : issueWarnings > 0 ? 'warning' : 'success'}
          hint={`${integrity.checks.length} checks ran just now`}
          href="/dashboard/accounting/reconciliation"
        />
      </div>

      {hub.expenses.byCategory.length > 0 ? (
        <div className="mt-6">
          <SectionCard title="Expenses by category" description="Paid in the period.">
            <ul className="grid gap-1.5 text-sm sm:grid-cols-2">
              {hub.expenses.byCategory.map((row) => (
                <li key={row.category} className="flex justify-between rounded-lg border px-3 py-2">
                  <span>{row.category}</span>
                  <span className="font-semibold tabular-nums">{money(row.amount)}</span>
                </li>
              ))}
            </ul>
          </SectionCard>
        </div>
      ) : null}

      <div className="mt-6">
        <AskTheNumbers answers={answers} />
      </div>
    </>
  )
}
