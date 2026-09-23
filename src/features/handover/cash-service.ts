import 'server-only'

import type { CashHandover, Prisma, UserRole } from '@prisma/client'

import { AppError, ForbiddenError, NotFoundError } from '@/lib/errors'
import { canAccessBranch, reachOf } from '@/lib/rbac'
import { prisma } from '@/server/db/prisma'
import {
  computeDrawerTotals,
  requireOpenSession,
  varianceNeedsReview,
  type DrawerActor,
} from '@/features/cashdrawer/service'
import { nextSessionNumber } from '@/features/cashdrawer/registers'
import { sanitiseCounts, totalFromCounts } from '@/features/cashdrawer/denominations'
import { getFundBalance } from '@/features/pettycash/service'

/**
 * Passing the till from one cashier to the next.
 *
 * ── Why the session ends rather than changing hands ─────────────────────────
 *
 * The obvious design is to move `openedById` to the next person and carry on.
 * It is wrong, and it is wrong in the exact place the feature exists to serve:
 * at close, the drawer is Rs 500 short and the session names two people. Which
 * of them is short? A drawer session's entire purpose is to make that question
 * answerable, and a session with two owners cannot.
 *
 * So a handover **closes** the outgoing session — counted, variance recorded,
 * explained if it does not balance, exactly like any other close — and the
 * counted amount becomes the **opening float** of a new session for the
 * incoming cashier. Every rupee is inside exactly one accountable session at
 * every moment, and the `CashHandover` row links the two so the chain of
 * custody reads straight through.
 *
 * ── Why acceptance is separate ──────────────────────────────────────────────
 *
 * The incoming cashier confirms what they were handed before they own it. If
 * they never do, the till simply has no open session — the safe state, and a
 * visible one. If they disagree with the count they decline, and the outgoing
 * session is already closed with the outgoing cashier's own number on it, which
 * is the honest record of a disputed handover.
 *
 * ── Branches ────────────────────────────────────────────────────────────────
 *
 * A handover cannot cross one, and not because of a check bolted on the end:
 * the new session inherits branch and register from the old one, and the
 * incoming cashier has to pass `canAccessBranch` for that branch. There is no
 * field to tamper with.
 */

export type HandoverActor = DrawerActor

/**
 * Who a till can be handed to.
 *
 * One list, read by both the candidate query and the action that accepts a
 * posted id — the pair that drifted apart would be a dropdown that filters and
 * a server that does not.
 */
export const HANDOVER_ROLES = new Set<UserRole>([
  'POS',
  // The retired name (staff.A.md §10). A till open across the deploy must
  // still be handed on, and the person holding it may not have signed in since.
  'CASHIER',
  'MANAGER',
  'ADMIN',
  'OWNER',
])

/**
 * Count the drawer, close it, and offer it to the next cashier.
 *
 * ── The count is notes and coins, and the variance is worked out after ────
 *
 * The till screens post a denomination map, never a total: the sum is the
 * server's, and so is the comparison. What the system expected is not shown
 * to the person counting until the count is committed (shifthandover.md
 * "Cash drawer — critical") — the same rule as `closeDrawer`, for the same
 * reason: a count taken with the target in view is not a count.
 *
 * DELIBERATE behaviour change 2026-09 (shifthandover.md §Cash drawer): no
 * variance reason is demanded here any more. The cashier cannot explain a gap
 * they have not been shown. Over the threshold the session still stops in
 * PENDING_REVIEW, exactly as a normal close does, and the explanation is the
 * reviewer's to record. `countedAmount` stays accepted for callers that
 * already hold a total (the API, the tests).
 */
export async function requestHandover(params: {
  restaurantId: string
  sessionId: string
  toUserId: string
  /** Minor units, when the caller already has a total. */
  countedAmount?: number | null
  /** Face value in minor units → how many. What the till screens post. */
  counts?: Record<string, number> | null
  varianceReason?: string | null
  note?: string | null
  userId: string
  actor: HandoverActor
}): Promise<CashHandover> {
  if (params.toUserId === params.userId) {
    throw new AppError('Hand over to somebody else', 400, 'HANDOVER_SELF')
  }

  const session = await requireOpenSession(params.restaurantId, params.sessionId, params.actor)

  const restaurant = await prisma.restaurant.findUniqueOrThrow({
    where: { id: params.restaurantId },
    select: { currency: true },
  })
  const counted =
    params.counts && Object.keys(params.counts).length > 0
      ? sanitiseCounts(restaurant.currency, params.counts)
      : null
  const countedAmount = counted
    ? totalFromCounts(restaurant.currency, counted)
    : params.countedAmount ?? null
  if (countedAmount === null) {
    throw new AppError('Count the drawer first', 400, 'HANDOVER_NO_COUNT')
  }
  if (countedAmount < 0) {
    throw new AppError('Counted cash cannot be negative', 400, 'HANDOVER_BAD_COUNT')
  }

  const incoming = await prisma.user.findFirst({
    where: {
      id: params.toUserId,
      restaurantId: params.restaurantId,
      isActive: true,
      deletedAt: null,
    },
    select: { id: true, role: true, branchId: true },
  })
  if (!incoming) throw new NotFoundError('Cashier')

  /*
   * They have to be able to work a till.
   *
   * `listHandoverCandidates` already filters the dropdown by role, but the
   * action took any active user in the restaurant — so a posted id could hand
   * the drawer to a kitchen porter, opening a session in the name of somebody
   * who cannot reach the screen to close it. The till would then be held by a
   * person with no way to release it.
   */
  if (!HANDOVER_ROLES.has(incoming.role)) {
    throw new AppError(
      'That person does not work a till',
      403,
      'HANDOVER_NOT_A_CASHIER',
    )
  }

  /*
   * The incoming cashier has to be able to reach this branch. Without this a
   * handover is a way to hand another site's till to somebody who works
   * nowhere near it — and every branch check downstream reads the new session,
   * which would then agree that they belong there.
   */
  if (!canAccessBranch(reachOf(incoming), session.branchId)) {
    throw new AppError(
      'That person does not work at this location',
      403,
      'HANDOVER_CROSSES_BRANCH',
    )
  }

  /*
   * ── No two handovers in flight at once (correctionA.md §11) ─────────────
   *
   * Nothing stopped a second one being raised, and both failure shapes are
   * bad in the same way — two people each believing the till is coming to
   * them:
   *
   *   · the same session offered twice, so whichever cashier accepts first
   *     takes the drawer and the other is left holding a request that will
   *     refuse when they press accept, after they have walked over;
   *   · the same person offered two different tills, and accepting either
   *     opens a session in their name that blocks the other.
   *
   * Checked before the counts are computed so the refusal is cheap, and the
   * accept path still re-checks under its own guards — this is the message,
   * not the lock.
   */
  const conflicting = await prisma.cashHandover.findFirst({
    where: {
      restaurantId: params.restaurantId,
      status: 'PENDING',
      OR: [{ fromSessionId: session.id }, { toUserId: params.toUserId }],
    },
    include: { toUser: { select: { name: true } } },
  })
  if (conflicting) {
    throw new AppError(
      conflicting.fromSessionId === session.id
        ? `This till is already being handed to ${conflicting.toUser?.name ?? 'somebody'}. Cancel that first.`
        : 'That person already has a till waiting for them to accept.',
      409,
      'HANDOVER_ALREADY_PENDING',
    )
  }

  const reason = params.varianceReason?.trim() || null

  return prisma.$transaction(async (tx) => {
    /*
     * The session row is locked before the expected figure is read, so a sale
     * landing between "compute" and "close" cannot make the snapshot describe
     * a drawer that no longer exists. `updateMany` with the status in the
     * WHERE is the second lock: a close racing this one matches no row.
     */
    await tx.$queryRaw`SELECT "id" FROM "cash_drawer_sessions" WHERE "id" = ${session.id} FOR UPDATE`
    const totals = await computeDrawerTotals(session.id, tx)
    const variance = countedAmount - totals.expectedCash

    /*
     * A handover is a close, so it stops for review on the same threshold.
     * The till is released either way, so the next person is never held up
     * by somebody else's shortfall.
     */
    const needsReview = await varianceNeedsReview(params.restaurantId, variance)

    const closed = await tx.cashDrawerSession.updateMany({
      where: { id: session.id, status: 'OPEN' },
      data: {
        status: needsReview ? 'PENDING_REVIEW' : 'CLOSED',
        closedAt: new Date(),
        closedById: params.userId,
        countedCash: countedAmount,
        expectedCash: totals.expectedCash,
        variance,
        varianceReason: reason,
        ...(counted ? { closingCounts: counted as Prisma.InputJsonValue } : {}),
        closingNote: params.note?.trim() || `Handed over to another cashier`,
        activeRegisterKey: null,
        activeCashierKey: null,
      },
    })
    if (closed.count === 0) {
      throw new AppError('That drawer is no longer open', 409, 'DRAWER_NOT_OPEN')
    }

    return tx.cashHandover.create({
      data: {
        restaurantId: params.restaurantId,
        branchId: session.branchId,
        registerId: session.registerId,
        fromSessionId: session.id,
        fromUserId: params.userId,
        toUserId: incoming.id,
        expectedAmount: totals.expectedCash,
        countedAmount,
        variance,
        note: params.note?.trim() || null,
      },
    })
  })
}

/**
 * Take the till on.
 *
 * Opens a session for the incoming cashier with the handed-over amount as its
 * float. The two unique keys still apply, so somebody who already has a drawer
 * open elsewhere is refused here rather than ending up accountable for two.
 */
export async function acceptHandover(params: {
  restaurantId: string
  handoverId: string
  userId: string
  actor: HandoverActor
}): Promise<{ handover: CashHandover; sessionId: string }> {
  const handover = await requireHandover(params.restaurantId, params.handoverId, params.actor)

  if (handover.status !== 'PENDING') {
    throw new AppError('That handover has already been settled', 409, 'HANDOVER_SETTLED')
  }
  if (handover.toUserId !== params.userId) {
    throw new ForbiddenError('That till was handed to somebody else')
  }

  const now = new Date()

  /*
   * The petty cash tin goes with the till.
   *
   * Without this the new session took the schema default of 0, so the notes
   * physically sitting in the tin vanished from the books at every shift
   * change: the outgoing cashier's fund read Rs 4,000, the incoming one's read
   * Rs 0, and the first expense of the evening was refused for want of a fund
   * that was in the drawer the whole time.
   *
   * Carried, not recounted. The handover counts the drawer because that is the
   * money changing hands; the tin's balance is a computed figure the ledger
   * already knows, and asking for a second count would invite a second variance
   * with nothing to compare it against.
   */
  const tin = await getFundBalance(params.restaurantId, handover.fromSessionId)

  /*
   * Three attempts, because two different things can collide here and only one
   * of them is worth telling somebody about.
   *
   * The session number is a sequence derived from the highest already issued,
   * so two handovers accepted in the same second pick the same one — a retry
   * with the next number is the whole fix, and reporting it as "you already
   * have a drawer open" (which the first version of this did, mapping every
   * P2002 to one message) would have sent people looking for a drawer that
   * does not exist.
   *
   * The two open-session keys are the real conflict, and they still refuse.
   */
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await prisma.$transaction(async (tx) => {
        const session = await tx.cashDrawerSession.create({
          data: {
            restaurantId: params.restaurantId,
            branchId: handover.branchId,
            registerId: handover.registerId,
            sessionNumber: await nextSessionNumber(params.restaurantId, now),
            openedById: params.userId,
            openingFloat: handover.countedAmount,
            openingPettyCash: tin.balance,
            openingNote: `Taken over from the previous shift`,
            activeRegisterKey: handover.registerId,
            activeCashierKey: params.userId,
          },
        })

        /*
         * The status is in the WHERE, so the transition is the lock: two people
         * accepting at once means the second matches no rows and rolls its
         * whole transaction back, session included. Without it both would open
         * a session and one would be orphaned on a till it does not hold.
         */
        const settled = await tx.cashHandover.updateMany({
          where: { id: handover.id, status: 'PENDING' },
          data: { status: 'ACCEPTED', toSessionId: session.id, acceptedAt: now },
        })
        if (settled.count === 0) {
          throw new AppError('That handover has already been settled', 409, 'HANDOVER_SETTLED')
        }

        const fresh = await tx.cashHandover.findUniqueOrThrow({ where: { id: handover.id } })
        return { handover: fresh, sessionId: session.id }
      })
    } catch (error) {
      const e = error as { code?: string; meta?: { target?: unknown } }
      if (e.code !== 'P2002') throw error

      const target = Array.isArray(e.meta?.target) ? e.meta.target.map(String) : []
      if (target.includes('sessionNumber')) continue

      throw new AppError(
        'You already have a drawer open. Close it before taking this one on.',
        409,
        'DRAWER_ALREADY_OPEN',
      )
    }
  }

  throw new AppError('Could not take the till on, try again', 409, 'HANDOVER_RACE')
}

/**
 * Refuse it.
 *
 * The outgoing session stays closed with the outgoing cashier's count on it —
 * that is the honest record. Declining says "I did not accept responsibility
 * for this", not "the money is elsewhere".
 */
export async function declineHandover(params: {
  restaurantId: string
  handoverId: string
  userId: string
  actor: HandoverActor
}): Promise<CashHandover> {
  const handover = await requireHandover(params.restaurantId, params.handoverId, params.actor)
  if (handover.status !== 'PENDING') {
    throw new AppError('That handover has already been settled', 409, 'HANDOVER_SETTLED')
  }
  if (handover.toUserId !== params.userId && !params.actor.canManageOthers) {
    throw new ForbiddenError('That till was handed to somebody else')
  }

  /*
   * Status in the WHERE, same as accept. A decline racing an accept would
   * otherwise overwrite ACCEPTED with DECLINED and leave a live session open
   * on a till the record says nobody took — the accepting cashier accountable
   * for money the paperwork says they refused.
   */
  const settled = await prisma.cashHandover.updateMany({
    where: { id: handover.id, status: 'PENDING' },
    data: { status: 'DECLINED' },
  })
  if (settled.count === 0) {
    throw new AppError('That handover has already been settled', 409, 'HANDOVER_SETTLED')
  }
  return prisma.cashHandover.findUniqueOrThrow({ where: { id: handover.id } })
}

/** Handovers waiting for this person to confirm. */
export async function listPendingForUser(restaurantId: string, userId: string) {
  return prisma.cashHandover.findMany({
    where: { restaurantId, toUserId: userId, status: 'PENDING' },
    orderBy: { createdAt: 'desc' },
    include: {
      fromUser: { select: { name: true } },
      branch: { select: { name: true } },
      register: { select: { name: true } },
      // The shift handover this till is part of, when there is one
      // (recorrection.md §2): those are accepted there, not here.
      shiftHandover: { select: { id: true } },
    },
  })
}

/**
 * Withdraw a handover nobody has accepted (recorrection.md §2).
 *
 * ── The cash is never in no session ─────────────────────────────────────────
 *
 * Requesting a handover CLOSES the outgoing session — the count is on it and
 * the till is released. Until now the only ways out of a pending handover
 * were accept and decline, and a decline left the counted cash belonging to
 * nobody: session closed, no new one opened, the notes still in the drawer.
 * The code even told people to "cancel that first" and offered no way to.
 *
 * Withdrawing re-opens a drawer for the outgoing cashier with the counted
 * amount as its float and the tin carried across — exactly what accepting
 * does for the incoming cashier, pointed the other way. The closed session
 * keeps its count; the chain of custody reads close → withdraw → re-open.
 *
 * The status is in the WHERE, as on accept and decline: a withdraw racing an
 * accept matches no row and rolls back, so a till cannot be both taken and
 * given back. The same two open-session keys apply, so a cashier who already
 * opened another drawer in the meantime is refused rather than made
 * accountable for two.
 */
export async function cancelHandover(params: {
  restaurantId: string
  handoverId: string
  userId: string
  actor: HandoverActor
}): Promise<{ handover: CashHandover; reopenedSessionId: string }> {
  const handover = await requireHandover(params.restaurantId, params.handoverId, params.actor)
  if (handover.status !== 'PENDING') {
    throw new AppError('That handover has already been settled', 409, 'HANDOVER_SETTLED')
  }
  if (handover.fromUserId !== params.userId && !params.actor.canManageOthers) {
    throw new ForbiddenError('Only the person who handed the till over, or a manager, can withdraw it')
  }

  const now = new Date()
  const tin = await getFundBalance(params.restaurantId, handover.fromSessionId)

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await prisma.$transaction(async (tx) => {
        const settled = await tx.cashHandover.updateMany({
          where: { id: handover.id, status: 'PENDING' },
          data: { status: 'CANCELLED' },
        })
        if (settled.count === 0) {
          throw new AppError('That handover has already been settled', 409, 'HANDOVER_SETTLED')
        }

        const session = await tx.cashDrawerSession.create({
          data: {
            restaurantId: params.restaurantId,
            branchId: handover.branchId,
            registerId: handover.registerId,
            sessionNumber: await nextSessionNumber(params.restaurantId, now),
            openedById: handover.fromUserId,
            openingFloat: handover.countedAmount,
            openingPettyCash: tin.balance,
            openingNote: 'Handover withdrawn — re-opened with the counted amount',
            activeRegisterKey: handover.registerId,
            activeCashierKey: handover.fromUserId,
          },
        })

        const fresh = await tx.cashHandover.findUniqueOrThrow({ where: { id: handover.id } })
        return { handover: fresh, reopenedSessionId: session.id }
      })
    } catch (error) {
      const e = error as { code?: string; meta?: { target?: unknown } }
      if (e.code !== 'P2002') throw error

      const target = Array.isArray(e.meta?.target) ? e.meta.target.map(String) : []
      if (target.includes('sessionNumber')) continue

      throw new AppError(
        'The till, or the cashier, already has a drawer open, so this handover cannot be withdrawn. Close that drawer first.',
        409,
        'HANDOVER_CANNOT_REOPEN',
      )
    }
  }

  throw new AppError('Could not withdraw the handover, try again', 409, 'HANDOVER_RACE')
}

export async function listHandovers(params: {
  restaurantId: string
  branchIds?: string[] | null
  branchId?: string | null
  from?: Date | null
  to?: Date | null
  limit?: number
  /**
   * Narrow to the handovers this person was part of (correctionA.md §11).
   *
   * §11 asks that "both users and authorized managers see the correct
   * handover history according to permissions". A manager reconciling a floor
   * needs everybody's; a cashier needs their own, and showing them the whole
   * branch's would publish who was short and by how much to everyone who
   * works there — which is a colleague's disciplinary matter, not shift
   * information.
   *
   * Undefined means no narrowing, which is the manager's view. The caller
   * decides, because whether somebody may see all of it is a permission
   * question and services do not read permissions.
   */
  participantId?: string
}) {
  return prisma.cashHandover.findMany({
    where: {
      restaurantId: params.restaurantId,
      ...(params.branchIds ? { branchId: { in: params.branchIds } } : {}),
      ...(params.participantId
        ? { OR: [{ fromUserId: params.participantId }, { toUserId: params.participantId }] }
        : {}),
      ...(params.branchId ? { branchId: params.branchId } : {}),
      ...(params.from || params.to
        ? {
            createdAt: {
              ...(params.from ? { gte: params.from } : {}),
              ...(params.to ? { lte: params.to } : {}),
            },
          }
        : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: params.limit ?? 50,
    include: {
      fromUser: { select: { name: true } },
      toUser: { select: { name: true } },
      branch: { select: { name: true } },
      register: { select: { name: true } },
    },
  })
}

/** Cashiers a till can be handed to: same branch, active, not you. */
export async function listHandoverCandidates(params: {
  restaurantId: string
  branchId: string
  excludeUserId: string
}) {
  const rows = await prisma.user.findMany({
    where: {
      restaurantId: params.restaurantId,
      isActive: true,
      deletedAt: null,
      id: { not: params.excludeUserId },
      role: { in: [...HANDOVER_ROLES] },
    },
    select: { id: true, name: true, role: true, branchId: true, branchAccess: { select: { branchId: true } } },
    orderBy: { name: 'asc' },
  })

  // Filtered here rather than in the query because "no branch" means every
  // branch, which a `branchId` predicate cannot express.
  return rows.filter((user) => canAccessBranch(reachOf(user), params.branchId))
}

async function requireHandover(
  restaurantId: string,
  handoverId: string,
  actor: { role: UserRole; branchId?: string | null; branchIds?: string[] | null },
): Promise<CashHandover> {
  const handover = await prisma.cashHandover.findFirst({
    where: { id: handoverId, restaurantId },
  })
  if (!handover) throw new NotFoundError('Handover')

  if (!canAccessBranch(actor, handover.branchId)) {
    throw new ForbiddenError('That handover belongs to another location')
  }
  return handover
}
