import type { Metadata } from 'next'
import type { PettyCashStatus } from '@prisma/client'

import { PageHeader, StatCard } from '@/features/dashboard/components/page-header'
import { ReportFilters } from '@/features/reports/components/report-filters'
import { ReportTable } from '@/features/reports/components/report-table'
import { CashReportToolbar } from '@/features/reports/components/cash-report-toolbar'
import { resolveRange } from '@/features/reports/range'
import { getPettyCashReport } from '@/features/reports/cash'
import { PETTY_CASH_CATEGORIES } from '@/features/pettycash/service'
import { listLocations } from '@/features/transfers/queries'
import { formatMoney } from '@/lib/money'
import { PERMISSIONS } from '@/lib/rbac'
import { selectedBranch } from '@/features/dashboard/selected-branch'
import { requirePagePermission } from '@/server/auth/guard'
import { requireRestaurant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Petty cash report' }

const STATUSES = new Set<PettyCashStatus>([
  'DRAFT',
  'PENDING',
  'APPROVED',
  'PAID',
  'REJECTED',
  'CANCELLED',
])

const STATUS_LABEL: Record<PettyCashStatus, string> = {
  DRAFT: 'Draft',
  PENDING: 'Waiting',
  APPROVED: 'Approved',
  PAID: 'Paid',
  REJECTED: 'Rejected',
  CANCELLED: 'Withdrawn',
}

export default async function PettyCashReportPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const user = await requirePagePermission(
    PERMISSIONS.REPORT_CASH,
    '/dashboard/reports/petty-cash',
  )
  const restaurant = await requireRestaurant(user.restaurantId)
  const money = (m: number) => formatMoney(m, restaurant.currency)

  const p = await searchParams
  const str = (k: string) => (typeof p[k] === 'string' ? (p[k] as string) : '')

  const range = resolveRange({
    preset: str('preset') || 'THIS_MONTH',
    from: str('from'),
    to: str('to'),
    timeZone: restaurant.timezone,
  })

  const selection = await selectedBranch(user, p)
  const locations = await listLocations(user.restaurantId, selection.branchIds)

  const status = STATUSES.has(str('status') as PettyCashStatus)
    ? (str('status') as PettyCashStatus)
    : null

  const report = await getPettyCashReport({
    restaurantId: user.restaurantId,
    range,
    branchIds: selection.branchIds,
    branchId: selection.branchId || null,
    status,
    category: str('category') || null,
  })

  const t = report.totals

  const exportQuery = new URLSearchParams({
    type: 'petty',
    preset: range.preset,
    ...(str('from') ? { from: str('from') } : {}),
    ...(str('to') ? { to: str('to') } : {}),
    ...(selection.branchId ? { branch: selection.branchId } : {}),
    ...(status ? { status } : {}),
    ...(str('category') ? { category: str('category') } : {}),
  })

  return (
    <>
      <PageHeader title="Petty cash" description={`${range.label} · ${restaurant.name}`} />
      <ReportFilters
        preset={range.preset}
        from={str('from')}
        to={str('to')}
        locations={locations}
        branchId={selection.branchId}
      />
      <CashReportToolbar
        statuses={Object.entries(STATUS_LABEL).map(([value, label]) => ({ value, label }))}
        categories={[...PETTY_CASH_CATEGORIES]}
        exportQuery={exportQuery.toString()}
      />

      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Opening fund"
          value={money(t.openingBalance)}
          hint="every shift's starting tin in this period"
        />
        <StatCard label="Topped up" value={money(t.allocated)} hint="moved in from the drawer" />
        <StatCard label="Spent from the tin" value={money(t.spentFromFund)} />
        <StatCard label="Remaining" value={money(t.remaining)} />
      </div>

      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Waiting" value={`${t.pending} · ${money(t.pendingValue)}`} />
        <StatCard label="Approved" value={`${t.approved} · ${money(t.approvedValue)}`} />
        <StatCard label="Paid" value={String(t.paid)} />
        <StatCard label="Rejected" value={String(t.rejected)} />
      </div>

      {t.spentFromDrawer > 0 && (
        <div className="mb-6 rounded-lg border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
          A further <strong>{money(t.spentFromDrawer)}</strong> of petty cash was paid straight out
          of the till drawer rather than the tin. That money never entered the fund, so it is not in
          &ldquo;spent from the tin&rdquo; above — it comes off the drawer&rsquo;s expected cash on
          the{' '}
          <a href="/dashboard/reports/cash-drawer" className="underline underline-offset-2">
            cash drawer report
          </a>{' '}
          instead.
        </div>
      )}

      <ReportTable
        title="Petty cash ledger"
        description="Every request in this period, whatever happened to it."
        filename={`petty-cash-${range.preset.toLowerCase()}`}
        currency={restaurant.currency}
        columns={[
          { key: 'date', label: 'Date' },
          { key: 'branchName', label: 'Branch' },
          { key: 'category', label: 'Category' },
          { key: 'description', label: 'Description' },
          { key: 'amount', label: 'Amount', align: 'right', format: 'money' },
          { key: 'source', label: 'Paid from' },
          { key: 'requestedByName', label: 'Requested by', fallback: '—' },
          { key: 'decidedByName', label: 'Approved by', fallback: '—' },
          { key: 'statusLabel', label: 'Status' },
          { key: 'reference', label: 'Reference', fallback: '—' },
        ]}
        rows={report.rows.map((r) => ({
          ...r,
          date: r.requestedAt.toISOString().slice(0, 10),
          source: r.paidFrom === 'PETTY_FUND' ? 'Tin' : 'Drawer',
          statusLabel: STATUS_LABEL[r.status],
        }))}
        empty="No petty cash was raised in this period."
      />
    </>
  )
}
