import type { Metadata } from 'next'
import Link from 'next/link'
import { ArrowLeft, FileText } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/feedback'
import { PageHeader } from '@/features/dashboard/components/page-header'
import { ExportMenu } from '@/features/reports/components/export-menu'
import {
  PrintButton,
  TransferReportToolbar,
} from '@/features/transfers/components/transfer-report-toolbar'
import { listTransferLines, type TransferLineRow } from '@/features/transfers/queries'
import { branchNameFor, selectedBranch } from '@/features/dashboard/selected-branch'
import { resolveRange } from '@/features/reports/range'
import { PERMISSIONS, can, visibleBranchIds } from '@/lib/rbac'
import { requirePagePermission } from '@/server/auth/guard'
import { prisma } from '@/server/db/prisma'
import { requireRestaurant } from '@/server/db/tenant'
import { formatDate, formatDateTime } from '@/lib/datetime'
import { formatMoney } from '@/lib/money'
import { roundQty } from '@/lib/quantity'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Transfer report' }

const STATUS_LABEL: Record<string, string> = {
  REQUESTED: 'Requested',
  APPROVED: 'Approved',
  DISPATCHED: 'In transit',
  IN_TRANSIT: 'In transit',
  RECEIVED: 'Received',
  COMPLETED: 'Completed',
  REJECTED: 'Rejected',
  CANCELLED: 'Cancelled',
}

/**
 * Everything that moved between locations, line by line.
 *
 * ── Why a report and not a bigger export ────────────────────────────────────
 *
 * The Transfers board answers "where is transfer TR-00121". It cannot answer
 * "what actually moved last month, who signed for it, and what went missing" —
 * that is a question about lines, not about transfers, and the old Export
 * button handed back transfer headers with no items, no people beyond the
 * requester and no variance at all.
 *
 * So the row here is the LINE, with its transfer's people and dates grouped
 * above it. Read on screen, printed, or taken away as CSV or Excel through the
 * same `/api/reports/export?type=transfers`, which runs this same query behind
 * the same permission.
 *
 * ── The figures match the screen you came from ──────────────────────────────
 *
 * The filters are the board's filters, by the same parameter names, resolved
 * through the same `transferBoardWhere`. Walking from the board to the report
 * carries them across, and `ExportMenu` forwards the URL verbatim — so the
 * screen, the paper and the file are three renderings of one query rather than
 * three queries that have to be kept in step.
 */
export default async function TransferReportPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const user = await requirePagePermission(PERMISSIONS.TRANSFER_VIEW, '/dashboard/transfers/report')
  const params = await searchParams
  const restaurant = await requireRestaurant(user.restaurantId)

  const one = (key: string) => {
    const value = params[key]
    return typeof value === 'string' && value.trim() ? value.trim() : null
  }

  const selection = await selectedBranch(user, params)
  const reach = visibleBranchIds(user)
  const branchIds = selection.branchId ? [selection.branchId] : reach

  /*
   * One period, resolved once, in the restaurant's own timezone.
   *
   * The board compares dates by pasting `T00:00:00.000Z` onto them, which is
   * midnight in UTC and not midnight anywhere a restaurant is. A report is
   * entirely about its period, so it goes through the canonical resolver and
   * hands the query instants — and the export reads the same parameters and
   * resolves them the same way, so the file covers exactly this.
   */
  const dated = Boolean(one('from') || one('to') || one('preset'))
  const range = dated
    ? resolveRange({
        preset: one('preset') ?? 'CUSTOM',
        from: one('from'),
        to: one('to'),
        timeZone: restaurant.timezone,
      })
    : null

  const filter = {
    search: one('search') ?? undefined,
    fromBranchId: one('fromBranch'),
    toBranchId: one('toBranch'),
    status: one('status'),
    itemId: one('item'),
    ...(range ? { fromAt: range.from, toAt: range.to } : {}),
  }

  const [report, branchName, branches, items] = await Promise.all([
    listTransferLines({ restaurantId: user.restaurantId, branchIds, filter }),
    branchNameFor(user.restaurantId, selection.branchId),
    prisma.branch.findMany({
      where: {
        restaurantId: user.restaurantId,
        deletedAt: null,
        isActive: true,
        ...(reach === null ? {} : { id: { in: reach } }),
      },
      select: { id: true, name: true },
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
    }),
    prisma.inventoryItem.findMany({
      where: { restaurantId: user.restaurantId },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
      take: 500,
    }),
  ])

  const when = (value: string | null) =>
    value
      ? formatDateTime(value, { locale: restaurant.locale, timeZone: restaurant.timezone })
      : '—'
  const money = (cents: number) => formatMoney(cents, restaurant.currency)

  // One block per transfer, lines in order beneath it.
  const groups: Array<{ head: TransferLineRow; lines: TransferLineRow[] }> = []
  for (const row of report.rows) {
    const last = groups[groups.length - 1]
    if (last && last.head.transferId === row.transferId) last.lines.push(row)
    else groups.push({ head: row, lines: [row] })
  }

  const day = (value: Date) =>
    formatDate(value, { locale: restaurant.locale, timeZone: restaurant.timezone })
  const period = range ? `${day(range.from)} – ${day(range.to)}` : 'All time'

  return (
    <>
      <PageHeader
        title="Transfer report"
        branch={branchName}
        icon={<FileText className="size-6" />}
        description={`${period} · ${restaurant.name}`}
        actions={
          <>
            <Button asChild variant="ghost" size="sm" className="no-print">
              <Link href="/dashboard/transfers">
                <ArrowLeft /> Back to transfers
              </Link>
            </Button>
            <PrintButton />
            {can(user, PERMISSIONS.REPORT_EXPORT) ? (
              <span className="no-print">
                <ExportMenu type="transfers" label="Download" disabled={report.rows.length === 0} />
              </span>
            ) : null}
          </>
        }
      />

      <div className="print-sheet space-y-4">
        {/*
          The heading only paper needs. On screen the PageHeader above already
          says all of this; on paper that header is stripped by `@media print`,
          and a report with no title and no period is not a document.
        */}
        <div className="print-only mb-4 border-b pb-3">
          <p className="text-lg font-bold">{restaurant.name} — Transfer report</p>
          <p className="text-sm">
            {period}
            {branchName ? ` · ${branchName}` : ''}
          </p>
          <p className="text-xs">
            Printed {formatDateTime(new Date(), { locale: restaurant.locale, timeZone: restaurant.timezone })}
          </p>
        </div>

        {/* ── The figures ─────────────────────────────────────────────────── */}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <Figure label="Transfers" value={String(report.totals.transfers)} hint="In this period" />
          <Figure label="Lines" value={String(report.totals.lines)} hint="Items moved" />
          <Figure
            label="Qty received"
            value={String(roundQty(report.totals.receivedQty))}
            hint={`of ${roundQty(report.totals.sentQty)} sent`}
          />
          <Figure label="Value" value={money(report.totals.value)} hint="At cost" />
          <Figure
            label="Variance lines"
            value={String(report.totals.varianceLines)}
            hint="Short, damaged or refused"
            tone={report.totals.varianceLines > 0 ? 'destructive' : 'muted'}
          />
        </div>

        <TransferReportToolbar branches={branches} items={items} />

        {report.truncated ? (
          <p className="no-print rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning">
            Showing the first {report.totals.transfers} transfers. Narrow the date range to see the rest.
          </p>
        ) : null}

        {/* ── The transfers ───────────────────────────────────────────────── */}
        {groups.length === 0 ? (
          <div className="rounded-xl border bg-card p-6 shadow-soft">
            <EmptyState
              icon={<FileText className="size-8" />}
              title="Nothing moved in this period"
              description="Try a wider date range, or clear the filters."
            />
          </div>
        ) : (
          <div className="space-y-4">
            {groups.map(({ head, lines }) => (
              <section key={head.transferId} className="overflow-hidden rounded-xl border bg-card shadow-soft">
                <header className="border-b bg-muted/40 px-4 py-3">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <p className="font-semibold tabular-nums">
                      {head.number}
                      <span className="ml-2 font-normal text-muted-foreground">
                        {head.fromName} → {head.toName}
                      </span>
                    </p>
                    <p className="text-sm font-medium">{STATUS_LABEL[head.status] ?? head.status}</p>
                  </div>

                  {/*
                    The whole chain of custody, which is the question the old
                    export could not answer: who asked, who approved, who put it
                    on the van, who signed for it, and when each of those was.
                  */}
                  <dl className="mt-2 grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2 lg:grid-cols-4">
                    <Party label="Requested" who={head.requestedByName} at={when(head.requestedAt)} />
                    <Party label="Approved" who={head.approvedByName} at={when(head.approvedAt)} />
                    <Party label="Dispatched" who={head.dispatchedByName} at={when(head.dispatchedAt)} />
                    <Party label="Received" who={head.receivedByName} at={when(head.receivedAt)} />
                  </dl>

                  {head.rejectReason ? (
                    <p className="mt-2 text-xs text-destructive">
                      <span className="font-medium">Rejected:</span> {head.rejectReason}
                    </p>
                  ) : null}
                  {head.notes ? (
                    <p className="mt-1 text-xs text-muted-foreground">
                      <span className="font-medium">Note:</span> {head.notes}
                    </p>
                  ) : null}
                </header>

                <div className="overflow-x-auto">
                  <table className="w-full min-w-[48rem] text-sm">
                    <thead>
                      <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                        <th className="px-4 py-2 font-medium">Item</th>
                        <th className="px-4 py-2 text-right font-medium">Requested</th>
                        <th className="px-4 py-2 text-right font-medium">Sent</th>
                        <th className="px-4 py-2 text-right font-medium">Received</th>
                        <th className="px-4 py-2 text-right font-medium">Variance</th>
                        <th className="px-4 py-2 font-medium">Reason</th>
                        <th className="px-4 py-2 text-right font-medium">Value</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {lines.map((line) => {
                        const short = line.variance !== null && line.variance < -1e-6
                        return (
                          <tr key={line.lineId}>
                            <td className="px-4 py-2">
                              {line.itemName}
                              <span className="ml-1 text-xs text-muted-foreground">({line.unit})</span>
                            </td>
                            <td className="px-4 py-2 text-right tabular-nums">{roundQty(line.requestedQty)}</td>
                            {/* An em dash, not a zero: not yet sent is not "nil sent". */}
                            <td className="px-4 py-2 text-right tabular-nums">
                              {line.sentQty === null ? '—' : roundQty(line.sentQty)}
                            </td>
                            <td className="px-4 py-2 text-right tabular-nums">
                              {line.receivedQty === null ? '—' : roundQty(line.receivedQty)}
                            </td>
                            <td
                              className={`px-4 py-2 text-right tabular-nums ${short ? 'font-medium text-destructive' : ''}`}
                            >
                              {line.variance === null ? '—' : roundQty(line.variance)}
                            </td>
                            <td className="px-4 py-2 text-xs text-muted-foreground">
                              {line.varianceReason
                                ? `${line.varianceReason.replaceAll('_', ' ').toLowerCase()}${line.varianceNote ? ` — ${line.varianceNote}` : ''}`
                                : '—'}
                            </td>
                            <td className="px-4 py-2 text-right tabular-nums">{money(line.lineValue)}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </section>
            ))}
          </div>
        )}
      </div>
    </>
  )
}

function Figure({
  label,
  value,
  hint,
  tone = 'muted',
}: {
  label: string
  value: string
  hint: string
  tone?: 'muted' | 'destructive'
}) {
  return (
    <div className="rounded-xl border bg-card p-4 shadow-soft">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p
        className={`mt-1 text-2xl font-bold tabular-nums ${tone === 'destructive' ? 'text-destructive' : ''}`}
      >
        {value}
      </p>
      <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>
    </div>
  )
}

function Party({ label, who, at }: { label: string; who: string | null; at: string }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd>
        {who ?? '—'}
        <span className="block text-muted-foreground">{at}</span>
      </dd>
    </div>
  )
}
