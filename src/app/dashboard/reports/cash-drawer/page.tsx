import type { Metadata } from 'next'
import type { CashDrawerStatus } from '@prisma/client'

import { PageHeader, StatCard } from '@/features/dashboard/components/page-header'
import { ReportFilters } from '@/features/reports/components/report-filters'
import { ReportTable } from '@/features/reports/components/report-table'
import { CashReportToolbar } from '@/features/reports/components/cash-report-toolbar'
import { resolveRange } from '@/features/reports/range'
import { getCashDrawerReport, getCashFilterOptions } from '@/features/reports/cash'
import { listLocations } from '@/features/transfers/queries'
import { formatMoney } from '@/lib/money'
import { PERMISSIONS } from '@/lib/rbac'
import { selectedBranch } from '@/features/dashboard/selected-branch'
import { requirePagePermission } from '@/server/auth/guard'
import { requireRestaurant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Cash drawer report' }

const STATUSES = new Set<CashDrawerStatus>(['OPEN', 'PENDING_REVIEW', 'CLOSED'])

/**
 * Every drawer session in a period, and what it did.
 *
 * The filters live in the URL, so a filtered report can be bookmarked, sent to
 * an accountant, and re-read by the server that narrows the query. The export
 * is a link carrying those same params rather than a button with a callback —
 * a Server Component cannot hand a function to a client one, which is exactly
 * why `ReportFilters`' own `onExport` prop has never been usable.
 */
export default async function CashDrawerReportPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const user = await requirePagePermission(
    PERMISSIONS.REPORT_CASH,
    '/dashboard/reports/cash-drawer',
  )
  const restaurant = await requireRestaurant(user.restaurantId)
  const money = (m: number) => formatMoney(m, restaurant.currency)

  const p = await searchParams
  const str = (k: string) => (typeof p[k] === 'string' ? (p[k] as string) : '')

  // The restaurant's timezone, not the server's: without it "today" ends 5½
  // hours early in Colombo and the last shift of the day lands in tomorrow.
  const range = resolveRange({
    preset: str('preset') || 'TODAY',
    from: str('from'),
    to: str('to'),
    timeZone: restaurant.timezone,
  })

  const selection = await selectedBranch(user, p)
  const locations = await listLocations(user.restaurantId, selection.branchIds)

  const status = STATUSES.has(str('status') as CashDrawerStatus)
    ? (str('status') as CashDrawerStatus)
    : null

  const [report, options] = await Promise.all([
    getCashDrawerReport({
      restaurantId: user.restaurantId,
      range,
      branchIds: selection.branchIds,
      branchId: selection.branchId || null,
      registerId: str('register') || null,
      cashierId: str('cashier') || null,
      status,
    }),
    getCashFilterOptions({ restaurantId: user.restaurantId, branchIds: selection.branchIds }),
  ])

  const t = report.totals

  const exportQuery = new URLSearchParams({
    type: 'drawers',
    preset: range.preset,
    ...(str('from') ? { from: str('from') } : {}),
    ...(str('to') ? { to: str('to') } : {}),
    ...(selection.branchId ? { branch: selection.branchId } : {}),
    ...(str('register') ? { register: str('register') } : {}),
    ...(str('cashier') ? { cashier: str('cashier') } : {}),
    ...(status ? { status } : {}),
  })

  return (
    <>
      <PageHeader title="Cash drawer" description={`${range.label} · ${restaurant.name}`} />
      <ReportFilters
        preset={range.preset}
        from={str('from')}
        to={str('to')}
        locations={locations}
        branchId={selection.branchId}
      />
      <CashReportToolbar
        cashiers={options.cashiers}
        registers={options.registers}
        statuses={[
          { value: 'OPEN', label: 'Open' },
          { value: 'PENDING_REVIEW', label: 'In review' },
          { value: 'CLOSED', label: 'Closed' },
        ]}
        exportQuery={exportQuery.toString()}
      />

      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {/*
          Named "floats issued", not "opening cash", because it is a sum of
          per-session figures and a handover chain reuses the same notes: a till
          handed on at Rs 60,000 opens the next session at Rs 60,000, and both
          land in this total. Calling it opening cash would invite somebody to
          read it as money the business put in.
        */}
        <StatCard
          label="Floats issued"
          value={money(t.openingCash)}
          hint="summed per session, so a handover counts the same notes twice"
        />
        <StatCard label="Cash sales" value={money(t.cashSales)} />
        <StatCard
          label="Non-cash payments"
          value={money(t.nonCashPayments)}
          hint="card, QR, online — never in the drawer"
        />
        <StatCard label="Expected closing" value={money(t.expectedClosing)} />
      </div>

      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Cash in" value={money(t.cashIn)} />
        <StatCard label="Cash out" value={money(t.cashOut)} />
        <StatCard label="Refunds" value={money(t.refunds)} />
        <StatCard label="Petty cash paid" value={money(t.pettyCashExpenses)} />
      </div>

      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Cash drops" value={money(t.cashDrops)} />
        <StatCard label="Bank deposits" value={money(t.bankDeposits)} />
        <StatCard label="Actual closing" value={money(t.actualClosing)} hint="counted, closed tills only" />
        <StatCard
          label="Short / over"
          value={`${money(t.cashShort)} / ${money(t.cashOver)}`}
          hint="never netted — a short till and an over one are two problems"
        />
      </div>

      <div className="mb-6 grid gap-3 sm:grid-cols-3">
        <StatCard label="Open now" value={String(t.openSessions)} />
        <StatCard label="Waiting for review" value={String(t.inReviewSessions)} />
        <StatCard label="Closed" value={String(t.closedSessions)} />
      </div>

      {report.unrecordedRefunds.count > 0 && (
        <div className="mb-6 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-300">
          <strong>{money(report.unrecordedRefunds.amount)}</strong> was refunded in cash across{' '}
          {report.unrecordedRefunds.count}{' '}
          {report.unrecordedRefunds.count === 1 ? 'payment' : 'payments'} while no drawer was open,
          so no till recorded the money going back out. The sessions below still show that cash as
          taken. It is usually somebody refunding after close.
        </div>
      )}

      {report.unattributed.count > 0 && (
        <div className="mb-6 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-300">
          <strong>{money(report.unattributed.amount)}</strong> of cash was taken across{' '}
          {report.unattributed.count}{' '}
          {report.unattributed.count === 1 ? 'payment' : 'payments'} while no drawer was open, so it
          belongs to no session above and no till can be counted against it. It is almost always
          somebody ringing up without starting a shift.
        </div>
      )}

      <ReportTable
        title="Drawer sessions"
        description="One row per shift — open the session number for every movement in it. Expected cash for an open till is live; for a closed one it is what was recorded at close. A blank variance means nobody counted."
        filename={`cash-drawers-${range.preset.toLowerCase()}`}
        currency={restaurant.currency}
        /*
         * A string template, never a callback — every caller here is a Server
         * Component and a function cannot cross into a client one
         * (`report-table.tsx:11-25`). `{id}` was already on every row and the
         * table simply never linked anywhere.
         */
        hrefTemplate="/dashboard/cash-drawer/{id}"
        columns={[
          { key: 'sessionNumber', label: 'Session' },
          { key: 'branchName', label: 'Branch' },
          { key: 'registerName', label: 'Till' },
          { key: 'cashierName', label: 'Opened by' },
          { key: 'closedByName', label: 'Closed by', fallback: '—' },
          { key: 'statusLabel', label: 'Status' },
          { key: 'openingFloat', label: 'Opening', align: 'right', format: 'money' },
          { key: 'cashSales', label: 'Cash sales', align: 'right', format: 'money' },
          { key: 'cashIn', label: 'In', align: 'right', format: 'money' },
          { key: 'cashOut', label: 'Out', align: 'right', format: 'money' },
          { key: 'refunds', label: 'Refunds', align: 'right', format: 'money' },
          { key: 'drops', label: 'Drops', align: 'right', format: 'money' },
          { key: 'expectedCash', label: 'Expected', align: 'right', format: 'money' },
          { key: 'countedCash', label: 'Counted', align: 'right', format: 'money', fallback: '—' },
          { key: 'variance', label: 'Variance', align: 'right', format: 'delta', fallback: 'Unknown' },
          { key: 'varianceReason', label: 'Why', fallback: '—' },
        ]}
        rows={report.rows.map((r) => ({
          ...r,
          statusLabel:
            r.status === 'OPEN'
              ? 'Open'
              : r.status === 'PENDING_REVIEW'
                ? 'In review'
                : r.closedOnBehalf
                  ? 'Closed by manager'
                  : 'Closed',
        }))}
        empty="No drawer was opened in this period."
      />
    </>
  )
}
