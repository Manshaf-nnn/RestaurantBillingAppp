import 'server-only'

import type { CashDrawerStatus, PettyCashStatus, Prisma } from '@prisma/client'

import { prisma } from '@/server/db/prisma'
import { directionOf } from '@/features/cashdrawer/movement-types'
import { getUnattributedCash, getUnrecordedRefunds } from '@/features/cashdrawer/service'
import type { DateRange } from './range'

/**
 * The cash drawer and petty cash reports.
 *
 * ── Which date a session is filtered on ─────────────────────────────────────
 *
 * `openedAt`. A drawer belongs to the shift that started it, so a session
 * opened at 6pm on Friday and closed at 2am on Saturday is Friday's — which is
 * how the people who worked it would describe it, and how the takings will be
 * banked. Filtering on `closedAt` would silently drop every session still open
 * at the moment the report is run, and those are exactly the ones a manager
 * checking mid-service wants to see.
 *
 * ── Why the totals are built from the rows ──────────────────────────────────
 *
 * Every figure at the top of the report is summed from the same session list
 * the table shows, narrowed by the same filters. The way a report becomes
 * untrustworthy is a header built by a different query from the body: they
 * disagree at some edge, nobody can say which is right, and the whole page
 * stops being evidence.
 *
 * The two aggregate queries are grouped, not per-session: a hundred sessions
 * must not be a hundred round trips.
 *
 * ── Unattributed cash ───────────────────────────────────────────────────────
 *
 * Cash taken while no drawer was open belongs to no session and appears in no
 * per-session total. It is reported anyway, on its own line, because money that
 * falls outside every total is the one number a reconciliation report must not
 * be quiet about.
 */

export interface CashDrawerFilters {
  restaurantId: string
  range: DateRange
  /** `null` is unrestricted; `[]` is confined with nowhere to look. */
  branchIds?: string[] | null
  branchId?: string | null
  registerId?: string | null
  cashierId?: string | null
  status?: CashDrawerStatus | null
}

export interface CashSessionRow {
  id: string
  sessionNumber: string
  branchName: string
  registerName: string
  cashierName: string
  closedByName: string | null
  reviewedByName: string | null
  openedAt: Date
  closedAt: Date | null
  status: CashDrawerStatus
  openingFloat: number
  openingPettyCash: number
  cashSales: number
  nonCashSales: number
  cashIn: number
  cashOut: number
  refunds: number
  pettyCashPaid: number
  drops: number
  bankDeposits: number
  expectedCash: number
  countedCash: number | null
  variance: number | null
  varianceReason: string | null
}

export interface CashDrawerReport {
  rows: CashSessionRow[]
  totals: {
    openingCash: number
    cashSales: number
    nonCashPayments: number
    cashIn: number
    cashOut: number
    pettyCashExpenses: number
    refunds: number
    cashDrops: number
    bankDeposits: number
    expectedClosing: number
    actualClosing: number
    cashShort: number
    cashOver: number
    openSessions: number
    inReviewSessions: number
    closedSessions: number
  }
  /** Cash taken while no drawer was open. */
  unattributed: { amount: number; count: number }
  /** Cash handed back while no drawer was open. */
  unrecordedRefunds: { amount: number; count: number }
}

function scope(filters: CashDrawerFilters): Prisma.CashDrawerSessionWhereInput {
  return {
    restaurantId: filters.restaurantId,
    openedAt: { gte: filters.range.from, lte: filters.range.to },
    ...(filters.branchIds ? { branchId: { in: filters.branchIds } } : {}),
    ...(filters.branchId ? { branchId: filters.branchId } : {}),
    ...(filters.registerId ? { registerId: filters.registerId } : {}),
    ...(filters.cashierId ? { openedById: filters.cashierId } : {}),
    ...(filters.status ? { status: filters.status } : {}),
  }
}

export async function getCashDrawerReport(
  filters: CashDrawerFilters,
): Promise<CashDrawerReport> {
  const sessions = await prisma.cashDrawerSession.findMany({
    where: scope(filters),
    orderBy: { openedAt: 'desc' },
    take: 1000,
    include: {
      openedBy: { select: { name: true } },
      closedBy: { select: { name: true } },
      reviewedBy: { select: { name: true } },
      branch: { select: { name: true } },
      register: { select: { name: true } },
    },
  })

  const ids = sessions.map((s) => s.id)

  const outsideScope = {
    restaurantId: filters.restaurantId,
    branchIds: filters.branchId ? [filters.branchId] : (filters.branchIds ?? null),
    from: filters.range.from,
    to: filters.range.to,
  }

  const [payments, movements, pettyPaid, unattributed, unrecordedRefunds] = await Promise.all([
    ids.length
      ? prisma.payment.groupBy({
          by: ['cashDrawerSessionId', 'method'],
          where: { cashDrawerSessionId: { in: ids }, status: { in: ['PAID', 'REFUNDED'] } },
          _sum: { amount: true },
        })
      : Promise.resolve([]),
    ids.length
      ? prisma.cashMovement.groupBy({
          by: ['sessionId', 'type'],
          where: { sessionId: { in: ids } },
          _sum: { amount: true },
        })
      : Promise.resolve([]),
    /*
     * Tin-paid expenses, which never appear as a movement — they left the fund,
     * not the drawer. Reported so "total petty cash expenses" means what it
     * says rather than "the half that happened to come out of the till".
     */
    ids.length
      ? prisma.pettyCashRequest.groupBy({
          by: ['sessionId'],
          where: { sessionId: { in: ids }, status: 'PAID', paidFrom: 'PETTY_FUND' },
          _sum: { amount: true },
        })
      : Promise.resolve([]),
    getUnattributedCash(outsideScope),
    getUnrecordedRefunds(outsideScope),
  ])

  const cashBySession = new Map<string, number>()
  const nonCashBySession = new Map<string, number>()
  for (const row of payments) {
    if (!row.cashDrawerSessionId) continue
    const amount = row._sum.amount ?? 0
    const target = row.method === 'CASH' ? cashBySession : nonCashBySession
    target.set(row.cashDrawerSessionId, (target.get(row.cashDrawerSessionId) ?? 0) + amount)
  }

  const moveBySession = new Map<string, Map<string, number>>()
  for (const row of movements) {
    const bucket = moveBySession.get(row.sessionId) ?? new Map<string, number>()
    bucket.set(row.type, (bucket.get(row.type) ?? 0) + (row._sum.amount ?? 0))
    moveBySession.set(row.sessionId, bucket)
  }

  const tinBySession = new Map<string, number>()
  for (const row of pettyPaid) {
    if (row.sessionId) tinBySession.set(row.sessionId, row._sum.amount ?? 0)
  }

  const rows: CashSessionRow[] = sessions.map((s) => {
    const moves = moveBySession.get(s.id) ?? new Map<string, number>()
    const at = (type: string) => moves.get(type) ?? 0

    let cashIn = 0
    let cashOut = 0
    for (const [type, amount] of moves) {
      if (directionOf(type as never) > 0) cashIn += amount
      else cashOut += amount
    }

    const cashSales = cashBySession.get(s.id) ?? 0

    return {
      id: s.id,
      sessionNumber: s.sessionNumber,
      branchName: s.branch?.name ?? '—',
      registerName: s.register?.name ?? '—',
      cashierName: s.openedBy?.name ?? 'Unknown',
      closedByName: s.closedBy?.name ?? null,
      reviewedByName: s.reviewedBy?.name ?? null,
      openedAt: s.openedAt,
      closedAt: s.closedAt,
      status: s.status,
      openingFloat: s.openingFloat,
      openingPettyCash: s.openingPettyCash,
      cashSales,
      nonCashSales: nonCashBySession.get(s.id) ?? 0,
      cashIn,
      cashOut,
      refunds: at('CASH_REFUND'),
      // Both tins: out of the drawer, and out of the fund.
      pettyCashPaid: at('PETTY_CASH_PAID') + (tinBySession.get(s.id) ?? 0),
      drops: at('CASH_DROP'),
      bankDeposits: at('BANK_DEPOSIT'),
      /*
       * Recomputed rather than read from the column: `expectedCash` is only
       * written at close, so an open session would report null and the period
       * total would silently exclude every till still running.
       */
      expectedCash: s.expectedCash ?? s.openingFloat + cashSales + cashIn - cashOut,
      countedCash: s.countedCash,
      variance: s.variance,
      varianceReason: s.varianceReason,
    }
  })

  const totals = rows.reduce(
    (acc, r) => {
      acc.openingCash += r.openingFloat
      acc.cashSales += r.cashSales
      acc.nonCashPayments += r.nonCashSales
      acc.cashIn += r.cashIn
      acc.cashOut += r.cashOut
      acc.pettyCashExpenses += r.pettyCashPaid
      acc.refunds += r.refunds
      acc.cashDrops += r.drops
      acc.bankDeposits += r.bankDeposits
      acc.expectedClosing += r.expectedCash
      acc.actualClosing += r.countedCash ?? 0
      if (r.variance !== null && r.variance < 0) acc.cashShort += Math.abs(r.variance)
      if (r.variance !== null && r.variance > 0) acc.cashOver += r.variance
      if (r.status === 'OPEN') acc.openSessions += 1
      else if (r.status === 'PENDING_REVIEW') acc.inReviewSessions += 1
      else acc.closedSessions += 1
      return acc
    },
    {
      openingCash: 0,
      cashSales: 0,
      nonCashPayments: 0,
      cashIn: 0,
      cashOut: 0,
      pettyCashExpenses: 0,
      refunds: 0,
      cashDrops: 0,
      bankDeposits: 0,
      expectedClosing: 0,
      actualClosing: 0,
      cashShort: 0,
      cashOver: 0,
      openSessions: 0,
      inReviewSessions: 0,
      closedSessions: 0,
    },
  )

  return { rows, totals, unattributed, unrecordedRefunds }
}

// ── petty cash ───────────────────────────────────────────────────────────────

export interface PettyCashFilters {
  restaurantId: string
  range: DateRange
  branchIds?: string[] | null
  branchId?: string | null
  status?: PettyCashStatus | null
  category?: string | null
  requestedById?: string | null
}

export interface PettyReportRow {
  id: string
  requestedAt: Date
  branchName: string
  category: string
  description: string
  amount: number
  paidFrom: 'DRAWER' | 'PETTY_FUND'
  requestedByName: string | null
  decidedByName: string | null
  paidByName: string | null
  status: PettyCashStatus
  reference: string | null
}

export interface PettyCashReport {
  rows: PettyReportRow[]
  totals: {
    openingBalance: number
    allocated: number
    spentFromFund: number
    spentFromDrawer: number
    remaining: number
    pending: number
    approved: number
    rejected: number
    paid: number
    pendingValue: number
    approvedValue: number
  }
}

export async function getPettyCashReport(filters: PettyCashFilters): Promise<PettyCashReport> {
  const where: Prisma.PettyCashRequestWhereInput = {
    restaurantId: filters.restaurantId,
    requestedAt: { gte: filters.range.from, lte: filters.range.to },
    ...(filters.branchIds ? { branchId: { in: filters.branchIds } } : {}),
    ...(filters.branchId ? { branchId: filters.branchId } : {}),
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.category ? { category: filters.category } : {}),
    ...(filters.requestedById ? { requestedById: filters.requestedById } : {}),
  }

  const sessionScope: Prisma.CashDrawerSessionWhereInput = {
    restaurantId: filters.restaurantId,
    openedAt: { gte: filters.range.from, lte: filters.range.to },
    ...(filters.branchIds ? { branchId: { in: filters.branchIds } } : {}),
    ...(filters.branchId ? { branchId: filters.branchId } : {}),
  }

  /*
   * The fund figures ignore the category and status filters, and the row list
   * does not.
   *
   * That is not an inconsistency, it is the fix for one. "Remaining" is
   * opening + top-ups − spent, and the first two terms have no category to
   * filter by. Filtering only the third gave a page where choosing "Cleaning"
   * changed what was left in the tin — Rs 12,000 became Rs 19,000 because the
   * transport expenses had been filtered out of the subtraction but not out of
   * the balance. The tin holds what it holds whatever the reader is looking at.
   */
  /*
   * Scoped by the SESSION it was paid against, not by when it was raised.
   *
   * The opening balance and the top-ups are both per-session figures over
   * `sessionScope`, so the spend has to be measured across the same sessions or
   * the subtraction is between two different periods. A request raised on 30
   * September and paid on 1 October otherwise came off September's tin, which
   * it never touched, and October's balance overstated by the same amount.
   */
  const fundScope: Prisma.PettyCashRequestWhereInput = {
    status: 'PAID',
    session: sessionScope,
  }

  const [requests, opening, topUps, fundSpend] = await Promise.all([
    prisma.pettyCashRequest.findMany({
      where,
      orderBy: { requestedAt: 'desc' },
      take: 1000,
      include: {
        branch: { select: { name: true } },
        requestedBy: { select: { name: true } },
        decidedBy: { select: { name: true } },
        paidBy: { select: { name: true } },
      },
    }),
    /*
     * The funds handed out at the start of shifts in this period. Every session
     * establishes its own tin, so the period's opening balance is the sum of
     * them — not a single running figure, which no shift-based fund has.
     */
    prisma.cashDrawerSession.aggregate({
      where: sessionScope,
      _sum: { openingPettyCash: true },
    }),
    prisma.cashMovement.aggregate({
      where: { type: 'PETTY_FUND_TOPUP', session: sessionScope },
      _sum: { amount: true },
    }),
    prisma.pettyCashRequest.groupBy({
      by: ['paidFrom'],
      where: fundScope,
      _sum: { amount: true },
    }),
  ])

  const totals = {
    openingBalance: opening._sum.openingPettyCash ?? 0,
    allocated: topUps._sum.amount ?? 0,
    spentFromFund: 0,
    spentFromDrawer: 0,
    remaining: 0,
    pending: 0,
    approved: 0,
    rejected: 0,
    paid: 0,
    pendingValue: 0,
    approvedValue: 0,
  }

  // Counts describe the rows on screen, so they follow the filters.
  for (const r of requests) {
    if (r.status === 'PENDING') {
      totals.pending += 1
      totals.pendingValue += r.amount
    } else if (r.status === 'APPROVED') {
      totals.approved += 1
      totals.approvedValue += r.amount
    } else if (r.status === 'REJECTED') {
      totals.rejected += 1
    } else if (r.status === 'PAID') {
      totals.paid += 1
    }
  }

  // Spend describes the fund, so it does not — see `fundScope` above.
  for (const row of fundSpend) {
    const amount = row._sum.amount ?? 0
    if (row.paidFrom === 'PETTY_FUND') totals.spentFromFund += amount
    else totals.spentFromDrawer += amount
  }

  // Only fund spending reduces the fund. A drawer-paid expense came out of a
  // different pile and is reported beside this rather than inside it.
  totals.remaining = totals.openingBalance + totals.allocated - totals.spentFromFund

  return {
    rows: requests.map((r) => ({
      id: r.id,
      requestedAt: r.requestedAt,
      branchName: r.branch?.name ?? '—',
      category: r.category,
      description: r.description,
      amount: r.amount,
      paidFrom: r.paidFrom,
      requestedByName: r.requestedBy?.name ?? null,
      decidedByName: r.decidedBy?.name ?? null,
      paidByName: r.paidBy?.name ?? null,
      status: r.status,
      reference: r.reference,
    })),
    totals,
  }
}

/** Cashiers and tills that actually appear in the data, for the filter menus. */
export async function getCashFilterOptions(params: {
  restaurantId: string
  branchIds?: string[] | null
}) {
  const [cashiers, registers] = await Promise.all([
    /*
     * Only people who have actually opened a drawer somewhere this person can
     * see. Listing every cashier in the business would name the staff of sites
     * a branch manager has no visibility of, in a menu whose options would all
     * return nothing anyway.
     */
    prisma.user.findMany({
      where: {
        restaurantId: params.restaurantId,
        deletedAt: null,
        drawersOpened: {
          some: params.branchIds ? { branchId: { in: params.branchIds } } : {},
        },
      },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
    prisma.cashRegister.findMany({
      where: {
        restaurantId: params.restaurantId,
        ...(params.branchIds ? { branchId: { in: params.branchIds } } : {}),
      },
      select: { id: true, name: true, branch: { select: { name: true } } },
      orderBy: [{ branchId: 'asc' }, { sortOrder: 'asc' }],
    }),
  ])

  return {
    cashiers,
    registers: registers.map((r) => ({
      id: r.id,
      name: r.branch?.name ? `${r.branch.name} · ${r.name}` : r.name,
    })),
  }
}
