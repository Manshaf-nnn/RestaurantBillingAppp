import 'server-only'

import type { CashDrawerSession, CashMovementType, Prisma } from '@prisma/client'

import type { UserRole } from '@prisma/client'

import { AppError, ForbiddenError, NotFoundError } from '@/lib/errors'
import { canAccessBranch } from '@/lib/rbac'
import { prisma, type TxClient } from '@/server/db/prisma'
import { ensureDefaultBranch, resolveBranchId } from '@/features/branches/service'
import { getApprovalPolicy } from '@/features/approvals/service'
import { MOVEMENT_TYPES, directionOf } from './movement-types'
import { nextSessionNumber, resolveRegisterId } from './registers'

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
 *   expected = openingFloat + cashSales + Σ(movement × direction)
 *
 * `cashSales` counts every CASH payment attributed to this session that was
 * actually collected — including ones later refunded, because that money did
 * physically enter this drawer. Refunds are never netted off the sale; they are
 * recorded as an explicit CASH_REFUND movement against whichever drawer is open
 * at the time the refund is given. That is the only rule that stays correct when
 * a bill is paid on the morning shift and refunded on the evening one, and it
 * means the drawer's paper trail matches the physical movement of notes.
 *
 * Each movement's sign comes from its type, in `movement-types.ts`, so there is
 * exactly one table deciding whether a bank deposit adds or subtracts.
 *
 * Expected cash is always recomputed from the session's own rows rather than
 * kept as a running total, so a late-arriving payment can never silently
 * desync the variance. It is snapshotted onto the row only at close, as the
 * record of what was expected at that moment.
 *
 * ── The petty cash tin is a second pile ─────────────────────────────────────
 *
 * `openingPettyCash` is not part of the float and never enters expected drawer
 * cash. An expense paid from the tin reduces the tin; one paid from the drawer
 * writes a PETTY_CASH_PAID movement and reduces the drawer. Moving money from
 * one to the other is a PETTY_FUND_TOPUP, which leaves the drawer and arrives in
 * the fund. Keeping them separate is what makes "the tin is Rs 3,000 short" a
 * different sentence from "the till is Rs 3,000 short".
 *
 * ── Two open sessions cannot happen ─────────────────────────────────────────
 *
 * Not because of a check here, but because `activeRegisterKey` and
 * `activeCashierKey` are unique columns holding an id while the session is open
 * and NULL afterwards. A read-then-write check — which is what this used to do —
 * lets two concurrent submits both pass before either writes.
 */

/** Cash payments that physically entered the drawer, refunded or not. */
const COLLECTED_CASH: Prisma.PaymentWhereInput = {
  method: 'CASH',
  status: { in: ['PAID', 'REFUNDED'] },
}

/** A session that is still taking money. */
const LIVE: Prisma.CashDrawerSessionWhereInput = { status: 'OPEN' }

export interface DrawerTotals {
  openingFloat: number
  cashSales: number
  /** Everything that added cash, by type and in total. */
  cashIn: number
  cashOut: number
  byType: Partial<Record<CashMovementType, number>>
  expectedCash: number
  /** Non-cash takings for the same session — context at close, not drawer cash. */
  cardSales: number
  otherSales: number
  salesCount: number
  /** The petty cash tin, which is not drawer cash. */
  openingPettyCash: number
  pettyCashSpent: number
  pettyCashToppedUp: number
  pettyCashBalance: number
}

export interface DrawerMovementRow {
  id: string
  type: CashMovementType
  amount: number
  /** What it does to the drawer: negative for money leaving. */
  signedAmount: number
  reason: string
  reference: string | null
  createdAt: Date
  createdByName: string | null
}

export interface DrawerSummary extends DrawerTotals {
  session: CashDrawerSession
  movements: DrawerMovementRow[]
}

// ── open ─────────────────────────────────────────────────────────────────────

/** The caller's currently open drawer, if any. */
export async function getOpenDrawer(
  restaurantId: string,
  userId: string,
): Promise<CashDrawerSession | null> {
  return prisma.cashDrawerSession.findFirst({
    where: { restaurantId, openedById: userId, ...LIVE },
    orderBy: { openedAt: 'desc' },
  })
}

/** Whatever is open on a given till, whoever opened it. */
export async function getOpenDrawerForRegister(
  registerId: string,
): Promise<CashDrawerSession | null> {
  return prisma.cashDrawerSession.findFirst({
    where: { registerId, ...LIVE },
    orderBy: { openedAt: 'desc' },
  })
}

/**
 * Start a drawer session.
 *
 * The two "already open" refusals come from unique-index violations rather than
 * from a prior read, so two submits landing in the same millisecond cannot both
 * succeed. The error code is recovered from which key clashed.
 */
export async function openDrawer(params: {
  restaurantId: string
  userId: string
  branchId?: string | null
  registerId?: string | null
  userBranchId?: string | null
  openingFloat: number
  openingPettyCash?: number
  note?: string | null
}): Promise<CashDrawerSession> {
  if (params.openingFloat < 0) {
    throw new AppError('Opening float cannot be negative', 400, 'DRAWER_BAD_FLOAT')
  }
  if ((params.openingPettyCash ?? 0) < 0) {
    throw new AppError('Opening petty cash cannot be negative', 400, 'DRAWER_BAD_PETTY')
  }

  const branchId = await resolveBranchId({
    restaurantId: params.restaurantId,
    requestedBranchId: params.branchId,
    userBranchId: params.userBranchId,
  })
  const registerId = await resolveRegisterId({
    restaurantId: params.restaurantId,
    branchId,
    requestedRegisterId: params.registerId,
  })

  const now = new Date()

  /*
   * Two things can collide here and they are not the same failure: the session
   * number (a sequence, retry with the next one) and the two open-session keys
   * (a real conflict, tell the person why). Three attempts is plenty for the
   * sequence; a fourth means something else is wrong.
   */
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await prisma.cashDrawerSession.create({
        data: {
          restaurantId: params.restaurantId,
          branchId,
          registerId,
          sessionNumber: await nextSessionNumber(params.restaurantId, now),
          openedById: params.userId,
          openingFloat: params.openingFloat,
          openingPettyCash: params.openingPettyCash ?? 0,
          openingNote: params.note?.trim() || null,
          activeRegisterKey: registerId,
          activeCashierKey: params.userId,
        },
      })
    } catch (error) {
      const target = uniqueTarget(error)

      if (target?.includes('sessionNumber')) continue

      if (target?.includes('activeCashierKey') || target?.includes('activeRegisterKey')) {
        /*
         * Before refusing, check the lock is real.
         *
         * A key only means "open" while the row it sits on is. Anything that
         * ends a session without going through `closeDrawer` — a data fix, a
         * repair script, a future code path nobody has written yet — leaves a
         * key on a CLOSED row, and a till locked by a session that finished
         * last Tuesday is a counter nobody can work at and a support call
         * nobody can diagnose from the message.
         *
         * So a stale key is released and the open retried once. A live one
         * still refuses, which is the whole point of the constraint.
         */
        if (await releaseStaleKeys(registerId, params.userId)) continue

        /*
         * Which message, decided from the data rather than from `target`.
         *
         * Postgres names whichever index it happened to hit first, and when a
         * cashier tries to reopen the till they are already standing at, both
         * are violated. "Somebody else has this till open" would then be the
         * likeliest thing they read, about their own drawer, which sends them
         * looking for a colleague who does not exist. Their own drawer wins.
         */
        const own = await prisma.cashDrawerSession.findFirst({
          where: { restaurantId: params.restaurantId, openedById: params.userId, ...LIVE },
          select: { id: true },
        })
        if (own) {
          throw new AppError(
            'You already have an open drawer. Close it before opening another.',
            409,
            'DRAWER_ALREADY_OPEN',
          )
        }
        throw new AppError(
          'Somebody else already has this till open. They need to close or hand it over first.',
          409,
          'REGISTER_ALREADY_OPEN',
        )
      }

      throw error
    }
  }

  throw new AppError('Could not start a drawer session, try again', 409, 'DRAWER_OPEN_RACE')
}

/**
 * Drop lock keys left behind on sessions that are no longer open.
 *
 * Returns true when something was actually released, so the caller knows a
 * retry is worth making rather than looping on a live conflict.
 */
async function releaseStaleKeys(registerId: string, userId: string): Promise<boolean> {
  const result = await prisma.cashDrawerSession.updateMany({
    where: {
      status: { not: 'OPEN' },
      OR: [{ activeRegisterKey: registerId }, { activeCashierKey: userId }],
    },
    data: { activeRegisterKey: null, activeCashierKey: null },
  })
  return result.count > 0
}

/** The `target` of a Prisma unique-constraint failure, or null if it is not one. */
function uniqueTarget(error: unknown): string[] | null {
  const e = error as { code?: string; meta?: { target?: unknown } }
  if (e?.code !== 'P2002') return null
  const target = e.meta?.target
  if (Array.isArray(target)) return target.map(String)
  if (typeof target === 'string') return [target]
  return []
}

// ── movements ────────────────────────────────────────────────────────────────

/**
 * Record cash added to or taken out of an open drawer.
 *
 * A reason is mandatory. An unexplained movement is indistinguishable from
 * theft at close, so the field that makes the log worth keeping is required
 * rather than optional.
 *
 * System-only types are refused here. A cash refund and a petty cash payment
 * are both written by the code that performs them; letting somebody post one by
 * hand as well would put the same rupees in the ledger twice.
 */
export async function recordCashMovement(params: {
  restaurantId: string
  sessionId: string
  type: CashMovementType
  amount: number
  reason: string
  reference?: string | null
  userId: string
  actor: DrawerActor
}) {
  if (params.amount <= 0) {
    throw new AppError('Amount must be more than zero', 400, 'MOVEMENT_BAD_AMOUNT')
  }
  if (!MOVEMENT_TYPES[params.type]?.manual) {
    throw new AppError(
      'That kind of movement is recorded by the system, not by hand',
      400,
      'MOVEMENT_NOT_MANUAL',
    )
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
      reference: params.reference?.trim() || null,
      createdById: params.userId,
    },
  })
}

/**
 * Record a cash refund against whichever drawer is open, so the till still
 * balances after money is handed back.
 *
 * ── When there is no drawer open ────────────────────────────────────────────
 *
 * This used to `return` silently the moment the refunder had no drawer of their
 * own, which meant the cash left the till and nothing anywhere recorded it —
 * the one outcome a reconciliation system exists to prevent. A refund must
 * still never be *blocked* by bookkeeping, so instead it falls back to any
 * drawer open at the same branch, which is where the notes physically came
 * from. That covers the ordinary case: a manager refunding while a cashier is
 * on the floor.
 *
 * ── When there is no drawer anywhere ────────────────────────────────────────
 *
 * An owner refunding after close still cannot be blocked, so the refund goes
 * ahead and writes no movement. What it must not do is vanish: the movement
 * carries `paymentId`, so `getUnrecordedRefunds` can ask which refunded cash
 * payments in a period produced no movement at all, and the cash drawer report
 * names the total. Money that left the building is then a figure somebody can
 * see rather than a silence.
 */
export async function recordRefundAgainstOpenDrawer(params: {
  tx: TxClient
  restaurantId: string
  branchId?: string | null
  userId: string
  amount: number
  orderNumber: string
  paymentId: string
}): Promise<void> {
  const open =
    (await params.tx.cashDrawerSession.findFirst({
      where: {
        restaurantId: params.restaurantId,
        openedById: params.userId,
        ...(params.branchId ? { branchId: params.branchId } : {}),
        status: 'OPEN',
      },
      orderBy: { openedAt: 'desc' },
      select: { id: true },
    })) ??
    (params.branchId
      ? await params.tx.cashDrawerSession.findFirst({
          where: { restaurantId: params.restaurantId, branchId: params.branchId, status: 'OPEN' },
          orderBy: { openedAt: 'desc' },
          select: { id: true },
        })
      : null)

  if (!open) return

  await params.tx.cashMovement.create({
    data: {
      sessionId: open.id,
      type: 'CASH_REFUND',
      amount: params.amount,
      reason: `Cash refund — ${params.orderNumber}`,
      paymentId: params.paymentId,
      createdById: params.userId,
    },
  })
}

/**
 * Cash refunds in a period that no drawer ever recorded.
 *
 * The counterpart to `getUnattributedCash`: that one finds money taken outside
 * a session, this one finds money handed back outside a session. Both exist
 * because a reconciliation report whose totals quietly omit a category is
 * worse than one that admits it — the figures look right and the cash is gone.
 *
 * Matched on the movement's `paymentId`, so it is an absence of a row rather
 * than a guess from timestamps.
 */
export async function getUnrecordedRefunds(params: {
  restaurantId: string
  branchIds?: string[] | null
  from: Date
  to: Date
}): Promise<{ amount: number; count: number }> {
  const result = await prisma.payment.aggregate({
    where: {
      restaurantId: params.restaurantId,
      method: 'CASH',
      status: 'REFUNDED',
      // The row is stamped when the refund is written, so this is when the
      // money went back over the counter.
      updatedAt: { gte: params.from, lte: params.to },
      cashMovements: { none: {} },
      ...(params.branchIds ? { order: { branchId: { in: params.branchIds } } } : {}),
    },
    _sum: { amount: true },
    _count: true,
  })
  return { amount: result._sum.amount ?? 0, count: result._count }
}

// ── totals ───────────────────────────────────────────────────────────────────

/** Recompute a session's money from its own payments and movements. */
export async function computeDrawerTotals(sessionId: string): Promise<DrawerTotals> {
  const session = await prisma.cashDrawerSession.findUnique({
    where: { id: sessionId },
    select: { openingFloat: true, openingPettyCash: true },
  })
  if (!session) throw new NotFoundError('Drawer session')

  const [cash, byMethod, movements, pettySpent] = await Promise.all([
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
    /*
     * Expenses paid out of the tin. A DRAWER-paid expense is deliberately not
     * counted here — it already left as a PETTY_CASH_PAID movement, and taking
     * it off the tin as well would charge the restaurant twice.
     */
    prisma.pettyCashRequest.aggregate({
      where: { sessionId, status: 'PAID', paidFrom: 'PETTY_FUND' },
      _sum: { amount: true },
    }),
  ])

  const byType: Partial<Record<CashMovementType, number>> = {}
  let cashIn = 0
  let cashOut = 0
  for (const row of movements) {
    const amount = row._sum.amount ?? 0
    byType[row.type] = amount
    if (directionOf(row.type) > 0) cashIn += amount
    else cashOut += amount
  }

  const cashSales = cash._sum?.amount ?? 0
  const cardSales = byMethod.find((m) => m.method === 'CARD')?._sum.amount ?? 0
  const otherSales = byMethod
    .filter((m) => m.method !== 'CARD' && m.method !== 'CASH')
    .reduce((total, m) => total + (m._sum.amount ?? 0), 0)

  const pettyCashToppedUp = byType.PETTY_FUND_TOPUP ?? 0
  const pettyCashSpent = pettySpent._sum.amount ?? 0

  return {
    openingFloat: session.openingFloat,
    cashSales,
    cashIn,
    cashOut,
    byType,
    expectedCash: session.openingFloat + cashSales + cashIn - cashOut,
    cardSales,
    otherSales,
    salesCount: byMethod.reduce((total, m) => total + m._count, 0),
    openingPettyCash: session.openingPettyCash,
    pettyCashSpent,
    pettyCashToppedUp,
    pettyCashBalance: session.openingPettyCash + pettyCashToppedUp - pettyCashSpent,
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
      signedAmount: directionOf(m.type) * m.amount,
      reason: m.reason,
      reference: m.reference,
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
 *
 * ── Two things this now insists on ──────────────────────────────────────────
 *
 * A reason, whenever the count does not match. The note used to be optional and
 * labelled "(optional)", which meant the single most useful sentence about the
 * shift — why it was short — was the one thing nobody had to write, and by the
 * following morning nobody could.
 *
 * And a manager, when the gap is large. Over `cashVarianceAbove` the session
 * stops at PENDING_REVIEW instead of CLOSED. It takes no more money in that
 * state, so the count it is holding cannot go stale while it waits.
 */
export async function closeDrawer(params: {
  restaurantId: string
  sessionId: string
  countedCash: number
  varianceReason?: string | null
  note?: string | null
  userId: string
  actor: DrawerActor
}): Promise<{
  session: CashDrawerSession
  totals: DrawerTotals
  variance: number
  needsReview: boolean
}> {
  if (params.countedCash < 0) {
    throw new AppError('Counted cash cannot be negative', 400, 'DRAWER_BAD_COUNT')
  }

  await requireOpenSession(params.restaurantId, params.sessionId, params.actor)

  // Computed before the update so the snapshot reflects the session as counted.
  const totals = await computeDrawerTotals(params.sessionId)
  const variance = params.countedCash - totals.expectedCash

  const reason = params.varianceReason?.trim() || null
  if (variance !== 0 && (!reason || reason.length < 2)) {
    throw new AppError(
      'Say why the drawer does not balance. It will not be remembered tomorrow.',
      400,
      'DRAWER_NO_VARIANCE_REASON',
    )
  }

  const needsReview = await varianceNeedsReview(params.restaurantId, variance)

  const session = await prisma.cashDrawerSession.update({
    where: { id: params.sessionId },
    data: {
      status: needsReview ? 'PENDING_REVIEW' : 'CLOSED',
      closedAt: new Date(),
      closedById: params.userId,
      countedCash: params.countedCash,
      expectedCash: totals.expectedCash,
      variance,
      varianceReason: reason,
      closingNote: params.note?.trim() || null,
      // Both released here: the till is free for the next person either way,
      // and a session under review is not taking money.
      activeRegisterKey: null,
      activeCashierKey: null,
    },
  })

  return { session, totals, variance, needsReview }
}

/**
 * Close a drawer the person who opened it walked away from.
 *
 * ── Why this needs to exist ─────────────────────────────────────────────────
 *
 * A cashier goes home without closing. The session stays OPEN, it keeps
 * `activeRegisterKey`, and the next cashier on that till is told "somebody else
 * already has this till open" with no route forward — the shift cannot start.
 * `releaseStaleKeys` cannot help: it only clears keys stranded on a session
 * that is already closed, and this one is genuinely open.
 *
 * ── Counted, or honestly not ────────────────────────────────────────────────
 *
 * `countedCash: null` means nobody counted it, and the variance is then `null`
 * — genuinely unknown. That distinction is the whole point. Closing at the
 * expected figure would record a variance of zero, which asserts the till
 * balanced when nobody looked, and would quietly write off exactly the
 * shortfall this system exists to surface.
 *
 * An uncounted close also skips the review threshold. There is no variance to
 * review, and parking it in PENDING_REVIEW would leave the till blocked — the
 * thing being fixed.
 *
 * The variance, where there is one, belongs to the cashier who opened the
 * session, not to the owner closing it. `openedById` is untouched; `closedById`
 * and `closedOnBehalf` record who actually did this.
 */
export async function forceCloseDrawer(params: {
  restaurantId: string
  sessionId: string
  /** What the owner counted, or null when they could not. */
  countedCash: number | null
  reason: string
  userId: string
  actor: DrawerActor
}): Promise<{ session: CashDrawerSession; totals: DrawerTotals; variance: number | null }> {
  if (!params.actor.canManageOthers) {
    throw new ForbiddenError('Only a manager can close somebody else’s drawer')
  }
  if (params.countedCash !== null && params.countedCash < 0) {
    throw new AppError('Counted cash cannot be negative', 400, 'DRAWER_BAD_COUNT')
  }

  const reason = params.reason.trim()
  if (reason.length < 2) {
    throw new AppError(
      'Say why you are closing somebody else’s drawer',
      400,
      'DRAWER_NO_FORCE_REASON',
    )
  }

  const session = await prisma.cashDrawerSession.findFirst({
    where: { id: params.sessionId, restaurantId: params.restaurantId },
  })
  if (!session) throw new NotFoundError('Drawer session')

  if (!canAccessBranch({ role: params.actor.role, branchId: params.actor.branchId }, session.branchId)) {
    throw new ForbiddenError('That drawer belongs to another location')
  }
  if (session.status !== 'OPEN') {
    throw new AppError('That drawer is not open', 409, 'DRAWER_CLOSED')
  }

  const totals = await computeDrawerTotals(session.id)
  const variance = params.countedCash === null ? null : params.countedCash - totals.expectedCash

  /*
   * A counted close still stops for review when the gap is large — an owner
   * finding a till Rs 5,000 short is exactly the case a second pair of eyes
   * exists for, and the till is released either way so nobody is held up.
   */
  const needsReview =
    variance !== null && (await varianceNeedsReview(params.restaurantId, variance))

  const closed = await prisma.cashDrawerSession.update({
    where: { id: session.id },
    data: {
      status: needsReview ? 'PENDING_REVIEW' : 'CLOSED',
      closedAt: new Date(),
      closedById: params.userId,
      closedOnBehalf: true,
      countedCash: params.countedCash,
      expectedCash: totals.expectedCash,
      variance,
      varianceReason: reason,
      closingNote:
        params.countedCash === null
          ? 'Closed by a manager without a count — the variance is unknown.'
          : null,
      activeRegisterKey: null,
      activeCashierKey: null,
    },
  })

  return { session: closed, totals, variance }
}

/** Every drawer open right now, wherever this person can see. */
export async function listOpenDrawers(params: {
  restaurantId: string
  /** `null` is unrestricted; `[]` is confined with nowhere to look. */
  branchIds?: string[] | null
  branchId?: string | null
}) {
  return prisma.cashDrawerSession.findMany({
    where: {
      restaurantId: params.restaurantId,
      status: 'OPEN',
      ...(params.branchIds ? { branchId: { in: params.branchIds } } : {}),
      ...(params.branchId ? { branchId: params.branchId } : {}),
    },
    orderBy: { openedAt: 'asc' },
    include: {
      openedBy: { select: { id: true, name: true } },
      branch: { select: { name: true } },
      register: { select: { name: true } },
    },
  })
}

/**
 * Is this gap big enough to need a manager?
 *
 * Exported because a handover is also a close, and it has to answer the same
 * question the same way. When the threshold lived inline in `closeDrawer`, a
 * cashier short by any amount could skip the review entirely by choosing "Hand
 * over" instead of "Close" — a control with a documented way around it, which
 * is worse than no control because everyone believes in it.
 */
export async function varianceNeedsReview(
  restaurantId: string,
  variance: number,
): Promise<boolean> {
  const policy = await getApprovalPolicy(restaurantId)
  return policy.cashVarianceAbove > 0 && Math.abs(variance) >= policy.cashVarianceAbove
}

/**
 * Sign off a drawer that stopped for review.
 *
 * The reviewer may not be the person who closed it. That is the single rule
 * that makes a review a control rather than a formality, and it is the same one
 * `decideApproval` enforces for approvals — borrowed here rather than routed
 * through ApprovalRequest, because a drawer's status is already its state and
 * the approval table has no way to apply a decision.
 *
 * The count itself is never edited. A drawer that was short stays short; what
 * the review records is that somebody with authority has seen it.
 */
export async function reviewDrawer(params: {
  restaurantId: string
  sessionId: string
  userId: string
  note?: string | null
  actor: DrawerActor
}): Promise<CashDrawerSession> {
  if (!params.actor.canManageOthers) {
    throw new ForbiddenError('Only a manager can sign off a drawer')
  }

  const session = await prisma.cashDrawerSession.findFirst({
    where: { id: params.sessionId, restaurantId: params.restaurantId },
  })
  if (!session) throw new NotFoundError('Drawer session')

  if (!canAccessBranch({ role: params.actor.role, branchId: params.actor.branchId }, session.branchId)) {
    throw new ForbiddenError('That drawer belongs to another location')
  }
  if (session.status !== 'PENDING_REVIEW') {
    throw new AppError('That drawer is not waiting for review', 409, 'DRAWER_NOT_IN_REVIEW')
  }
  if (session.closedById && session.closedById === params.userId) {
    throw new AppError(
      'Somebody else has to sign off a drawer you counted yourself',
      403,
      'DRAWER_SELF_REVIEW',
    )
  }

  return prisma.cashDrawerSession.update({
    where: { id: session.id },
    data: {
      status: 'CLOSED',
      reviewedById: params.userId,
      reviewedAt: new Date(),
      reviewNote: params.note?.trim() || null,
    },
  })
}

// ── listing ──────────────────────────────────────────────────────────────────

export async function listDrawerSessions(params: {
  restaurantId: string
  branchIds?: string[] | null
  branchId?: string | null
  registerId?: string | null
  userId?: string | null
  status?: CashDrawerSession['status'] | null
  from?: Date | null
  to?: Date | null
  limit?: number
}) {
  return prisma.cashDrawerSession.findMany({
    where: {
      restaurantId: params.restaurantId,
      // `[]` means "confined with nowhere to look" and must match nothing, so
      // the `in` is built from the list rather than skipped when it is empty.
      ...(params.branchIds ? { branchId: { in: params.branchIds } } : {}),
      ...(params.branchId ? { branchId: params.branchId } : {}),
      ...(params.registerId ? { registerId: params.registerId } : {}),
      ...(params.userId ? { openedById: params.userId } : {}),
      ...(params.status ? { status: params.status } : {}),
      ...(params.from || params.to
        ? {
            openedAt: {
              ...(params.from ? { gte: params.from } : {}),
              ...(params.to ? { lte: params.to } : {}),
            },
          }
        : {}),
    },
    orderBy: { openedAt: 'desc' },
    take: params.limit ?? 50,
    include: {
      openedBy: { select: { name: true } },
      closedBy: { select: { name: true } },
      reviewedBy: { select: { name: true } },
      branch: { select: { name: true } },
      register: { select: { name: true } },
    },
  })
}

/**
 * Cash taken in a period that belongs to no drawer session.
 *
 * Every unattributed rupee is one nobody can be asked about at close, so the
 * report names the amount rather than letting it quietly fall outside every
 * total. It is normally zero: a gated cashier always has a session open. It is
 * not zero when a manager rings something up without opening a till, and that
 * is exactly the case worth seeing.
 */
export async function getUnattributedCash(params: {
  restaurantId: string
  branchIds?: string[] | null
  from: Date
  to: Date
}): Promise<{ amount: number; count: number }> {
  const result = await prisma.payment.aggregate({
    where: {
      restaurantId: params.restaurantId,
      cashDrawerSessionId: null,
      createdAt: { gte: params.from, lte: params.to },
      ...COLLECTED_CASH,
      ...(params.branchIds ? { order: { branchId: { in: params.branchIds } } } : {}),
    },
    _sum: { amount: true },
    _count: true,
  })
  return { amount: result._sum.amount ?? 0, count: result._count }
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
export async function requireOpenSession(
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
  if (session.status === 'PENDING_REVIEW') {
    throw new AppError(
      'That drawer has been counted and is waiting for a manager',
      409,
      'DRAWER_IN_REVIEW',
    )
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
