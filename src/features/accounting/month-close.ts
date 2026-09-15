import 'server-only'

import { customRange, startOfDay } from '@/features/reports/range'
import { getPaymentReconciliation } from '@/features/payments/reconciliation'
import { buildJournal } from '@/features/ledger/journal'
import { foldTrialBalance } from '@/features/ledger/queries'
import { prisma } from '@/server/db/prisma'
import { localBucket, utc } from '@/server/db/sql-time'
import { getApprovalsInboxCount } from './inbox'
import { runIntegrityChecks } from './integrity'

/**
 * Month-end close (acCal.md §13): the checklist an accountant works down
 * before locking a month, and the readiness figure that says how far along
 * they are.
 *
 * Every item asks a question of the real records — none of them is a
 * tick-box a person can set. Closing itself reuses the existing
 * `closePeriod`, so a sealed month behaves exactly like any sealed range.
 */

export interface ChecklistItem {
  key: string
  label: string
  done: boolean
  /** How many things stand in the way, when that is a countable thing. */
  count: number
  detail: string
  href: string
}

export interface MonthCloseChecklist {
  month: { from: Date; to: Date; label: string }
  items: ChecklistItem[]
  readyPercent: number
  /** Already sealed? Then the screen offers reopen, not close. */
  closedPeriodId: string | null
}

/** First and last instant of a calendar month in the restaurant's own time. */
export function monthBounds(
  month: string,
  timeZone: string,
): { from: Date; to: Date; label: string; dateFrom: Date; dateTo: Date } {
  const [yearText, monthText] = month.split('-')
  const year = Number(yearText)
  const monthIndex = Number(monthText) - 1
  /*
   * The restaurant's month, not UTC's. `timeZone` was accepted here and never
   * read, so a Colombo April ran from 05:30 on the 1st to 05:30 on May 1st —
   * and the checklist, the journal, the reconciliation and the seal all used
   * that window. Noon UTC on the first is inside the local first day in every
   * zone, so its local midnight is the month's first instant; the next
   * month's first instant, less a millisecond, is the last.
   */
  const from = startOfDay(new Date(Date.UTC(year, monthIndex, 1, 12)), timeZone)
  const to = new Date(startOfDay(new Date(Date.UTC(year, monthIndex + 1, 1, 12)), timeZone).getTime() - 1)
  /*
   * Business dates — `DailyClose.businessDate`, a statement line's date — are
   * calendar dates stored at UTC midnight. They are compared against the
   * calendar month, never against the instant range above, or a zone west of
   * UTC would lose the first of every month.
   */
  const dateFrom = new Date(Date.UTC(year, monthIndex, 1))
  const dateTo = new Date(Date.UTC(year, monthIndex + 1, 1) - 1)
  const label = new Intl.DateTimeFormat('en', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(dateFrom)
  return { from, to, label, dateFrom, dateTo }
}

export async function getMonthCloseChecklist(params: {
  restaurantId: string
  month: string
  timeZone: string
  branchIds?: string[] | null
}): Promise<MonthCloseChecklist> {
  const { restaurantId, month, timeZone, branchIds } = params
  const bounds = monthBounds(month, timeZone)
  const range = customRange(bounds.from, bounds.to, timeZone)
  const money = (minor: number) => String(minor)

  const [tradingDays, closes, openDrawers, integrity, inbox, paymentRecon, bankLines, journal, sealed] =
    await Promise.all([
      // Days that saw any trading at all — a quiet day needs no close.
      // In the restaurant's own calendar: `DATE("placedAt")` truncated in UTC
      // and the bounds were bound as timestamptz, both of which the rest of
      // the reporting code stopped doing long ago — this was the one raw
      // query left doing either.
      prisma.$queryRaw<Array<{ day: string }>>`
        SELECT DISTINCT to_char(${localBucket('day', '"placedAt"', timeZone)}, 'YYYY-MM-DD') AS day
        FROM orders
        WHERE "restaurantId" = ${restaurantId}
          AND status <> 'CANCELLED'
          AND "placedAt" >= ${utc(bounds.from)} AND "placedAt" <= ${utc(bounds.to)}
      `,
      prisma.dailyClose.findMany({
        where: { restaurantId, businessDate: { gte: bounds.dateFrom, lte: bounds.dateTo } },
        select: { businessDate: true },
      }),
      prisma.cashDrawerSession.count({
        where: {
          restaurantId,
          status: { in: ['OPEN', 'PENDING_REVIEW'] },
          openedAt: { lte: bounds.to },
          ...(branchIds ? { branchId: { in: branchIds } } : {}),
        },
      }),
      runIntegrityChecks(restaurantId),
      getApprovalsInboxCount(restaurantId, branchIds),
      getPaymentReconciliation({ restaurantId, range, branchIds, money }),
      prisma.bankStatementLine.count({
        where: { restaurantId, status: 'UNMATCHED', lineDate: { gte: bounds.dateFrom, lte: bounds.dateTo } },
      }),
      buildJournal({ restaurantId, range, branchIds }),
      prisma.accountingPeriod.findFirst({
        where: {
          restaurantId,
          status: 'CLOSED',
          periodStart: { lte: bounds.from },
          periodEnd: { gte: bounds.to },
        },
        select: { id: true },
      }),
    ])

  const closedDays = new Set(closes.map((row) => row.businessDate.toISOString().slice(0, 10)))
  const unclosedDays = tradingDays
    .map((row) => row.day)
    .filter((day) => !closedDays.has(day))

  const errors = integrity.checks.filter((check) => check.status === 'ERROR')
  const trial = foldTrialBalance(journal)

  const items: ChecklistItem[] = [
    {
      key: 'days',
      label: 'Every trading day signed off',
      done: unclosedDays.length === 0,
      count: unclosedDays.length,
      detail:
        unclosedDays.length === 0
          ? 'Every day that took money has been closed.'
          : `${unclosedDays.length} day(s) still open: ${unclosedDays.slice(0, 5).join(', ')}${unclosedDays.length > 5 ? '…' : ''}`,
      href: '/dashboard/reports/daily-close',
    },
    {
      key: 'drawers',
      label: 'All cash drawers closed and reviewed',
      done: openDrawers === 0,
      count: openDrawers,
      detail:
        openDrawers === 0
          ? 'No drawer from this month is still open or awaiting a signature.'
          : `${openDrawers} drawer(s) still open or waiting for a variance review.`,
      href: '/dashboard/cash-drawer',
    },
    {
      key: 'integrity',
      label: 'No critical issues',
      done: errors.length === 0,
      count: errors.length,
      detail:
        errors.length === 0
          ? 'The books agree with themselves.'
          : `${errors.length} check(s) are failing: ${errors.map((row) => row.label).join('; ')}`,
      href: '/dashboard/accounting/reconciliation?tab=issues',
    },
    {
      key: 'approvals',
      label: 'Nothing waiting for a decision',
      done: inbox.count === 0,
      count: inbox.count,
      detail:
        inbox.count === 0
          ? 'Every request has been decided.'
          : `${inbox.count} request(s) still pending across ${inbox.byQueue.length} queue(s).`,
      href: '/dashboard/accounting/approvals',
    },
    {
      key: 'payments',
      label: 'Payments reconciled',
      done: paymentRecon.counts.MISMATCH === 0,
      count: paymentRecon.counts.MISMATCH,
      detail:
        paymentRecon.counts.MISMATCH === 0
          ? 'Every bill agrees with its payment records.'
          : `${paymentRecon.counts.MISMATCH} bill(s) disagree with their payments.`,
      href: '/dashboard/accounting/reconciliation?tab=payments',
    },
    {
      key: 'bank',
      label: 'Bank statement matched',
      done: bankLines === 0,
      count: bankLines,
      detail:
        bankLines === 0
          ? 'No unmatched bank lines for this month.'
          : `${bankLines} statement line(s) still unmatched.`,
      href: '/dashboard/accounting/reconciliation?tab=bank',
    },
    {
      key: 'journals',
      label: 'Journals balanced',
      done: trial.balanced,
      count: trial.balanced ? 0 : 1,
      detail: trial.balanced
        ? 'Debits equal credits for the month.'
        : 'The trial balance does not balance — this must be investigated before closing.',
      href: '/dashboard/accounting/ledger?tab=trial',
    },
  ]

  const doneCount = items.filter((item) => item.done).length
  return {
    month: bounds,
    items,
    readyPercent: Math.round((doneCount / items.length) * 100),
    closedPeriodId: sealed?.id ?? null,
  }
}
