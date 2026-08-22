import 'server-only'

import type { CashDrawerSession, CashMovementType, Prisma } from '@prisma/client'

import type { UserRole } from '@prisma/client'

import { AppError, ForbiddenError, NotFoundError } from '@/lib/errors'
import { canAccessBranch } from '@/lib/rbac'
import { prisma, type TxClient } from '@/server/db/prisma'
import { ensureDefaultBranch, resolveBranchId } from '@/features/branches/service'

/**
 * Cashier cash-drawer sessions: open with a float, move cash in and out, close
 * against a physical count.
 *
 * This is deliberately separate from StaffShift. A staff shift is attendance —
 * who was working, and when. A drawer session is money accountability — what
 * cash a named person was responsible for and whether it balanced at the end.
 * One person can work a shift without ever touching cash, and one drawer can
 * outlive a shift change, so collapsing the two loses the thing an owner
 * actually wants to know when the till is short.
 *
 * ── How expected cash is derived ────────────────────────────────────────────
 *
 *   expected = openingFloat + cashSales + cashIn − cashOut
 *
 * `cashSales` counts every CASH payment attributed to this session that was
 * actually collected — including ones later refunded, because that money did
 * physically enter this drawer. Refunds are never netted off the sale; they are
 * recorded as an explicit CASH_OUT movement against whichever drawer is open at
 * the time the refund is given. That is the only rule that stays correct when a
 * bill is paid on the morning shift and refunded on the evening one, and it
 * means the drawer's paper trail matches the physical movement of notes.
 *
 * Expected cash is always recomputed from the session's own rows rather than
 * kept as a running total, so a late-arriving payment can never silently
 * desync the variance. It is snapshotted onto the row only at close, as the
 * record of what was expected at that moment.
 */

/** Cash payments that physically entered the drawer, refunded or not. */
const COLLECTED_CASH: Prisma.PaymentWhereInput = {
  method: 'CASH',
  status: { in: ['PAID', 'REFUNDED'] },
}

export interface DrawerTotals {
  openingFloat: number
  cashSales: number
  cashIn: number
  cashOut: number
  expectedCash: number
  /** Non-cash takings for the same session — context at close, not drawer cash. */
  cardSales: number
  otherSales: number
  salesCount: number
}

export interface DrawerSummary extends DrawerTotals {
  session: CashDrawerSession
  movements: Array<{
    id: string
    type: CashMovementType
    amount: number
    reason: string
    createdAt: Date
    createdByName: string | null
  }>
}

// ── open ─────────────────────────────────────────────────────────────────────

/** The caller's currently open drawer, if any. */
export async function getOpenDrawer(
  restaurantId: string,
  userId: string,
): Promise<CashDrawerSession | null> {
  return prisma.cashDrawerSession.findFirst({
    where: { restaurantId, openedById: userId, status: 'OPEN' },
    orderBy: { openedAt: 'desc' },
  })
}

/**
 * Start a drawer session.
 *
 * Refuses a second open drawer for the same person: two open drawers make the
 * question "which drawer did this cash go into?" unanswerable, which defeats
 * the point of counting one.
 */
export async function openDrawer(params: {
  restaurantId: string
  userId: string
  branchId?: string | null
  userBranchId?: string | null
  openingFloat: number
  note?: string | null
}): Promise<CashDrawerSession> {
  if (params.openingFloat < 0) {
    throw new AppError('Opening float cannot be negative', 400, 'DRAWER_BAD_FLOAT')
  }

  const existing = await getOpenDrawer(params.restaurantId, params.userId)
  if (existing) {
    throw new AppError(
      'You already have an open drawer. Close it before opening another.',
      409,
      'DRAWER_ALREADY_OPEN',
    )
  }

  const branchId = await resolveBranchId({
    restaurantId: params.restaurantId,
    requestedBranchId: params.branchId,
    userBranchId: params.userBranchId,
  })

  return prisma.cashDrawerSession.create({
    data: {
      restaurantId: params.restaurantId,
      branchId,
      openedById: params.userId,
      openingFloat: params.openingFloat,
      openingNote: params.note?.trim() || null,
    },
  })
}

// ── movements ────────────────────────────────────────────────────────────────

/**
 * Record cash added to or taken out of an open drawer.
 *
 * A reason is mandatory. An unexplained movement is indistinguishable from
 * theft at close, so the field that makes the log worth keeping is required
 * rather than optional.
 */
export async function recordCashMovement(params: {
  restaurantId: string
  sessionId: string
  type: CashMovementType
  amount: number
  reason: string
  userId: string
  actor: DrawerActor
}) {
  if (params.amount <= 0) {
    throw new AppError('Amount must be more than zero', 400, 'MOVEMENT_BAD_AMOUNT')
  }
  const reason = params.reason.trim()
  if (!reason) throw new AppError('Give a reason for this movement', 400, 'MOVEMENT_NO_REASON')

  const session = await requireOpenSession(params.restaurantId, params.sessionId, params.actor)

  return prisma.cashMovement.create({
    data: {
      sessionId: session.id,
      type: params.type,
      amount: params.amount,
      reason,
      createdById: params.userId,
    },
  })
}

/**
 * Record a cash refund against whichever drawer is open, so the till still
 * balances after money is handed back. Silent when no drawer is open — a
 * refund must never be blocked by bookkeeping — and the audit log still
 * carries the refund itself.
 */
export async function recordRefundAgainstOpenDrawer(params: {
  tx: TxClient
  restaurantId: string
  userId: string
  amount: number
  orderNumber: string
}): Promise<void> {
  const open = await params.tx.cashDrawerSession.findFirst({
    where: { restaurantId: params.restaurantId, openedById: params.userId, status: 'OPEN' },
    orderBy: { openedAt: 'desc' },
    select: { id: true },
  })
  if (!open) return

  await params.tx.cashMovement.create({
    data: {
      sessionId: open.id,
      type: 'CASH_OUT',
      amount: params.amount,
      reason: `Cash refund — ${params.orderNumber}`,
      createdById: params.userId,
    },
  })
}

// ── totals ───────────────────────────────────────────────────────────────────

/** Recompute a session's money from its own payments and movements. */
export async function computeDrawerTotals(sessionId: string): Promise<DrawerTotals> {
  const session = await prisma.cashDrawerSession.findUnique({
    where: { id: sessionId },
    select: { openingFloat: true },
  })
  if (!session) throw new NotFoundError('Drawer session')

  const [cash, byMethod, movements] = await Promise.all([
    prisma.payment.aggregate({
      where: { cashDrawerSessionId: sessionId, ...COLLECTED_CASH },
      _sum: { amount: true },
      _count: true,
    }),
    prisma.payment.groupBy({
      by: ['method'],
      where: { cashDrawerSessionId: sessionId, status: { in: ['PAID', 'REFUNDED'] } },
      _sum: { amount: true },
      _count: true,
    }),
    prisma.cashMovement.groupBy({
      by: ['type'],
      where: { sessionId },
      _sum: { amount: true },
    }),
  ])

  const sumOf = (type: CashMovementType) =>
    movements.find((m) => m.type === type)?._sum.amount ?? 0

  const cashSales = cash._sum?.amount ?? 0
  const cashIn = sumOf('CASH_IN')
  const cashOut = sumOf('CASH_OUT')

  const cardSales = byMethod.find((m) => m.method === 'CARD')?._sum.amount ?? 0
  const otherSales = byMethod
    .filter((m) => m.method !== 'CARD' && m.method !== 'CASH')
    .reduce((total, m) => total + (m._sum.amount ?? 0), 0)

  return {
    openingFloat: session.openingFloat,
    cashSales,
    cashIn,
    cashOut,
    expectedCash: session.openingFloat + cashSales + cashIn - cashOut,
    cardSales,
    otherSales,
    salesCount: byMethod.reduce((total, m) => total + m._count, 0),
  }
}

/** Everything the close screen and the X-report need. */
export async function getDrawerSummary(
  restaurantId: string,
  sessionId: string,
): Promise<DrawerSummary> {
  const session = await prisma.cashDrawerSession.findFirst({
    where: { id: sessionId, restaurantId },
  })
  if (!session) throw new NotFoundError('Drawer session')

  const [totals, movements] = await Promise.all([
    computeDrawerTotals(sessionId),
    prisma.cashMovement.findMany({
      where: { sessionId },
      orderBy: { createdAt: 'asc' },
      include: { createdBy: { select: { name: true } } },
    }),
  ])

  return {
    ...totals,
    session,
    movements: movements.map((m) => ({
      id: m.id,
      type: m.type,
      amount: m.amount,
      reason: m.reason,
      createdAt: m.createdAt,
      createdByName: m.createdBy?.name ?? null,
    })),
  }
}

// ── close ────────────────────────────────────────────────────────────────────

/**
 * Close a drawer against a physical count.
 *
 * The count is taken as given and the variance recorded rather than corrected:
 * a till that is short by 500 is a fact the owner needs to see, not an error to
 * round away. Expected cash is snapshotted here so the row still explains
 * itself years later even after the underlying orders are archived.
 */
export async function closeDrawer(params: {
  restaurantId: string
  sessionId: string
  countedCash: number
  note?: string | null
  userId: string
  actor: DrawerActor
}): Promise<{ session: CashDrawerSession; totals: DrawerTotals; variance: number }> {
  if (params.countedCash < 0) {
    throw new AppError('Counted cash cannot be negative', 400, 'DRAWER_BAD_COUNT')
  }

  await requireOpenSession(params.restaurantId, params.sessionId, params.actor)

  // Computed before the update so the snapshot reflects the session as counted.
  const totals = await computeDrawerTotals(params.sessionId)
  const variance = params.countedCash - totals.expectedCash

  const session = await prisma.cashDrawerSession.update({
    where: { id: params.sessionId },
    data: {
      status: 'CLOSED',
      closedAt: new Date(),
      closedById: params.userId,
      countedCash: params.countedCash,
      expectedCash: totals.expectedCash,
      variance,
      closingNote: params.note?.trim() || null,
    },
  })

  return { session, totals, variance }
}

// ── listing ──────────────────────────────────────────────────────────────────

export async function listDrawerSessions(params: {
  restaurantId: string
  branchId?: string | null
  userId?: string | null
  limit?: number
}) {
  return prisma.cashDrawerSession.findMany({
    where: {
      restaurantId: params.restaurantId,
      ...(params.branchId ? { branchId: params.branchId } : {}),
      ...(params.userId ? { openedById: params.userId } : {}),
    },
    orderBy: { openedAt: 'desc' },
    take: params.limit ?? 50,
    include: {
      openedBy: { select: { name: true } },
      closedBy: { select: { name: true } },
      branch: { select: { name: true } },
    },
  })
}

/**
 * Whoever is reaching for a drawer.
 *
 * `canManageOthers` is the CASH_DRAWER_MANAGE permission, resolved by the
 * caller: a cashier operates their own till, a manager reconciles the floor.
 */
export interface DrawerActor {
  id: string
  role: UserRole
  branchId?: string | null
  canManageOthers: boolean
}

/**
 * Find an open drawer this person is actually entitled to touch.
 *
 * It used to check the restaurant and nothing else, so a session id was the
 * only thing standing between any CASH_DRAWER_OPERATE holder and another
 * branch's till — they could add a cash-out to it, or close it against a count
 * they had not made. Both are money events with somebody else's name on them.
 *
 * Two questions, in order, because they have different answers:
 *
 *   where   `canAccessBranch` — is this till even in a building you work in
 *   whose   a cashier may only reach their own; a manager reconciles the floor
 */
async function requireOpenSession(
  restaurantId: string,
  sessionId: string,
  actor: DrawerActor,
): Promise<CashDrawerSession> {
  const session = await prisma.cashDrawerSession.findFirst({
    where: { id: sessionId, restaurantId },
  })
  if (!session) throw new NotFoundError('Drawer session')

  if (!canAccessBranch({ role: actor.role, branchId: actor.branchId }, session.branchId)) {
    throw new ForbiddenError('That drawer belongs to another location')
  }
  if (!actor.canManageOthers && session.openedById !== actor.id) {
    throw new ForbiddenError('That drawer was opened by someone else')
  }
  if (session.status !== 'OPEN') {
    throw new AppError('That drawer is already closed', 409, 'DRAWER_CLOSED')
  }
  return session
}

/** Used at open time so a restaurant that has never seen branches still works. */
export async function ensureBranchForDrawer(restaurantId: string): Promise<string> {
  const branch = await ensureDefaultBranch(restaurantId)
  return branch.id
}
