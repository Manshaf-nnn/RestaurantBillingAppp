import type { Metadata } from 'next'
import Link from 'next/link'
import type { OutgoingPaymentKind, OutgoingPaymentStatus, PaymentMethod } from '@prisma/client'
import { ArrowLeft } from 'lucide-react'

import { PageHeader, SectionCard, StatCard } from '@/features/dashboard/components/page-header'
import { selectedBranch } from '@/features/dashboard/selected-branch'
import { getMoneyOutReport, type MoneyOutBreakdown } from '@/features/outgoing-payments/report'
import { METHOD_LABELS } from '@/features/payments/destinations'
import { ReportFilters } from '@/features/reports/components/report-filters'
import { ReportTable } from '@/features/reports/components/report-table'
import { resolveRange } from '@/features/reports/range'
import { listLocations } from '@/features/transfers/queries'
import { formatMoney, localeForCurrency } from '@/lib/money'
import { PERMISSIONS } from '@/lib/rbac'
import { requirePagePermission } from '@/server/auth/guard'
import { prisma } from '@/server/db/prisma'
import { requireRestaurant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Money out report' }

const STATUS_LABEL: Record<OutgoingPaymentStatus, string> = {
  DRAFT: 'Draft',
  SUBMITTED: 'Waiting for approval',
  APPROVED: 'Approved, not paid',
  REJECTED: 'Rejected',
  PAID: 'Paid',
  REVERSED: 'Reversed',
  CANCELLED: 'Cancelled',
}
const KIND_LABEL: Record<OutgoingPaymentKind, string> = {
  SUPPLIER: 'Supplier payment',
  EXPENSE: 'Business expense',
}
/** The methods a payment out can be raised with, in the order the form lists them. */
const METHODS: PaymentMethod[] = ['BANK_TRANSFER', 'CHEQUE', 'CASH', 'CARD', 'QR', 'ONLINE', 'WALLET']

/**
 * Where the money went: every payment out in a period, who it was paid to,
 * how, from which account, and who raised, approved and paid it.
 *
 * Lives under Money out rather than among the sales reports because it is
 * the same book read back — whoever may see the worklist may see its report.
 */
export default async function MoneyOutReportPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const user = await requirePagePermission(
    PERMISSIONS.ACCOUNTING_VIEW,
    '/dashboard/accounting/payments/report',
  )
  const restaurant = await requireRestaurant(user.restaurantId)
  const locale = restaurant.locale === 'en' ? localeForCurrency(restaurant.currency) : restaurant.locale
  const money = (minor: number) => formatMoney(minor, restaurant.currency, locale)

  const p = await searchParams
  const str = (k: string) => (typeof p[k] === 'string' ? (p[k] as string) : '')

  const range = resolveRange({
    preset: str('preset') || 'THIS_MONTH',
    from: str('from'),
    to: str('to'),
    timeZone: restaurant.timezone,
  })
  const selection = await selectedBranch(user, p)

  const status = str('status') in STATUS_LABEL ? (str('status') as OutgoingPaymentStatus) : null
  const kind = str('kind') in KIND_LABEL ? (str('kind') as OutgoingPaymentKind) : null
  const method = METHODS.includes(str('method') as PaymentMethod) ? (str('method') as PaymentMethod) : null

  const [locations, accounts] = await Promise.all([
    listLocations(user.restaurantId, selection.branchIds),
    // Retired accounts too: a payment made from one still has to be findable.
    prisma.paymentAccount.findMany({
      where: { restaurantId: user.restaurantId },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
  ])
  const accountId =
    str('account') === 'none' || accounts.some((account) => account.id === str('account'))
      ? str('account')
      : null

  const report = await getMoneyOutReport({
    restaurantId: user.restaurantId,
    from: range.from,
    to: range.to,
    branchIds: selection.branchIds,
    status,
    kind,
    method,
    accountId,
  })
  const t = report.totals
  const date = (value: Date) =>
    new Intl.DateTimeFormat('en-CA', { timeZone: restaurant.timezone }).format(value)

  const selectClass = 'h-10 rounded-md border bg-background px-3 text-sm'

  return (
    <>
      <Link
        href="/dashboard/accounting/payments"
        className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground print:hidden"
      >
        <ArrowLeft className="h-4 w-4" />
        Money out
      </Link>
      <PageHeader
        title="Money out report"
        description={`${range.label} · ${restaurant.name} — every payment out, by the date the money moved.`}
      />
      <ReportFilters
        preset={range.preset}
        from={str('from')}
        to={str('to')}
        locations={locations}
        branchId={selection.branchId}
      />

      {/*
        A plain GET form: each choice is a URL param, so the filtered view is
        bookmarkable and the server re-reads it. The date range and location
        ride along as hidden fields so choosing a status does not reset them.
      */}
      <form method="get" className="mb-6 flex flex-wrap items-end gap-3 print:hidden">
        {(['preset', 'from', 'to', 'branch'] as const).map((key) =>
          str(key) ? <input key={key} type="hidden" name={key} value={str(key)} /> : null,
        )}
        <label className="grid gap-1 text-xs font-medium text-muted-foreground">
          Status
          <select name="status" defaultValue={status ?? ''} className={selectClass}>
            <option value="">Any status</option>
            {Object.entries(STATUS_LABEL).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-xs font-medium text-muted-foreground">
          Type
          <select name="kind" defaultValue={kind ?? ''} className={selectClass}>
            <option value="">Suppliers and expenses</option>
            {Object.entries(KIND_LABEL).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-xs font-medium text-muted-foreground">
          Paid by
          <select name="method" defaultValue={method ?? ''} className={selectClass}>
            <option value="">Any method</option>
            {METHODS.map((value) => (
              <option key={value} value={value}>{METHOD_LABELS[value] ?? value}</option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-xs font-medium text-muted-foreground">
          Paid from
          <select name="account" defaultValue={accountId ?? ''} className={selectClass}>
            <option value="">Any account</option>
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>{account.name}</option>
            ))}
            <option value="none">Not specified</option>
          </select>
        </label>
        <button type="submit" className="h-10 rounded-md border bg-background px-4 text-sm font-medium hover:bg-muted">
          Apply
        </button>
      </form>

      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Paid out" value={money(t.paidOut)} hint={`${t.paidCount} payment(s) that left the business`} />
        <StatCard label="To suppliers" value={money(t.supplier)} />
        <StatCard label="Business expenses" value={money(t.expense)} />
        <StatCard label="Reversed" value={money(t.reversed)} hint={`${t.reversedCount} paid, then undone — not in "paid out"`} />
      </div>
      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Approved, not paid yet" value={money(t.approvedUnpaid)} hint={`${t.approvedCount} payment(s)`} />
        <StatCard label="Waiting for approval" value={money(t.waiting)} hint={`${t.waitingCount} payment(s)`} />
      </div>

      <div className="mb-6 grid gap-4 md:grid-cols-2">
        <Breakdown title="Who it went to" rows={report.byPaidTo} money={money} />
        <Breakdown
          title="How it was paid"
          rows={report.byMethod.map((row) => ({ ...row, label: METHOD_LABELS[row.method] ?? row.method }))}
          money={money}
        />
        <Breakdown title="Which account it came from" rows={report.byAccount} money={money} />
        <Breakdown title="By location" rows={report.byBranch} money={money} />
      </div>

      <ReportTable
        title="Every payment"
        description="All payments dated in this period, whatever happened to them. A reversal is listed as money coming back."
        filename={`money-out-${range.preset.toLowerCase()}`}
        currency={restaurant.currency}
        locale={locale}
        columns={[
          { key: 'date', label: 'Date' },
          { key: 'number', label: 'Number' },
          { key: 'kindLabel', label: 'Type' },
          { key: 'paidTo', label: 'Paid to' },
          { key: 'description', label: 'For' },
          { key: 'amount', label: 'Amount', align: 'right', format: 'money' },
          { key: 'methodLabel', label: 'Paid by' },
          { key: 'payFromName', label: 'Paid from', fallback: '—' },
          { key: 'reference', label: 'Reference / cheque no.', fallback: '—' },
          { key: 'purchaseNumber', label: 'Purchase order', fallback: '—' },
          { key: 'branchName', label: 'Location' },
          { key: 'raisedByName', label: 'Raised by' },
          { key: 'approvedByName', label: 'Approved by', fallback: '—' },
          { key: 'paidByName', label: 'Paid by (person)', fallback: '—' },
          { key: 'paidOn', label: 'Paid on', fallback: '—' },
          { key: 'statusLabel', label: 'Status' },
          { key: 'decisionNote', label: 'Note', fallback: '—' },
        ]}
        rows={report.rows.map((row) => ({
          ...row,
          date: date(row.paymentDate),
          paidOn: row.paidAt ? date(row.paidAt) : null,
          kindLabel: row.isReversal ? 'Reversal' : KIND_LABEL[row.kind],
          methodLabel: METHOD_LABELS[row.method] ?? row.method,
          statusLabel: row.isReversal ? 'Reversal — money back' : STATUS_LABEL[row.status],
        }))}
        empty="No payments out are dated in this period."
      />
    </>
  )
}

/** One "paid out, split by …" card. Only money that actually left is in it. */
function Breakdown({
  title,
  rows,
  money,
}: {
  title: string
  rows: MoneyOutBreakdown[]
  money: (minor: number) => string
}) {
  return (
    <SectionCard title={title}>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing was paid out in this period.</p>
      ) : (
        <ul className="divide-y text-sm">
          {rows.map((row) => (
            <li key={row.label} className="flex items-center justify-between gap-3 py-2">
              <span className="min-w-0 truncate">
                {row.label}
                <span className="ml-2 text-xs text-muted-foreground">{row.count}</span>
              </span>
              <span className="font-medium tabular-nums">{money(row.amount)}</span>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  )
}
