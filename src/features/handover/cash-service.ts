import 'server-only'

import type { CashHandover, UserRole } from '@prisma/client'

import { AppError, ForbiddenError, NotFoundError } from '@/lib/errors'
import { canAccessBranch } from '@/lib/rbac'
import { prisma } from '@/server/db/prisma'
import {
  computeDrawerTotals,
  requireOpenSession,
  varianceNeedsReview,
  type DrawerActor,
} from '@/features/cashdrawer/service'
import { nextSessionNumber } from '@/features/cashdrawer/registers'
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

export interface HandoverActor extends DrawerActor {}

/**
 * Who a till can be handed to.
 *
 * One list, read by both the candidate query and the action that accepts a
 * posted id — the pair that drifted apart would be a dropdown that filters and
 * a server that does not.
 */
const HANDOVER_ROLES = new Set<UserRole>(['CASHIER', 'MANAGER', 'ADMIN', 'OWNER'])

/**
 * Count the drawer, close it, and offer it to the next cashier.
 *
 * The variance rule is the same as a normal close, deliberately: a handover is
 * a close, and letting it skip the explanation would make it the way to close a
 * short drawer without saying anything.
 */
export async function requestHandover(params: {
  restaurantId: string
  sessionId: string
  toUserId: string
  countedAmount: number
  varianceReason?: string | null
  note?: string | null
  userId: string
  actor: HandoverActor
}): Promise<CashHandover> {
  if (params.countedAmount < 0) {
    throw new AppError('Counted cash cannot be negative', 400, 'HANDOVER_BAD_COUNT')
  }
  if (params.toUserId === params.userId) {
    throw new AppError('Hand over to somebody else', 400, 'HANDOVER_SELF')
  }

  const session = await requireOpenSession(params.restaurantId, params.sessionId, params.actor)

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
  if (!canAccessBranch({ role: incoming.role, branchId: incoming.branchId }, session.branchId)) {
    throw new AppError(
      'That person does not work at this location',
      403,
      'HANDOVER_CROSSES_BRANCH',
    )
  }

  const totals = await computeDrawerTotals(session.id)
  const variance = params.countedAmount - totals.expectedCash

  /*
   * A handover is a close, so it stops for review on the same threshold.
   *
   * Without this, "Hand over" was the documented way round the variance
   * review: a cashier short by any amount could pass the till on and their
   * session would go straight to CLOSED, while the same count entered on the
   * Close screen would have waited for a manager. The till is released either
   * way, so the next person is never held up by somebody else's shortfall.
   */
  const needsReview = await varianceNeedsReview(params.restaurantId, variance)

  // Same rule as closing: only a gap big enough to matter has to be explained.
  const reason = params.varianceReason?.trim() || null
  if (needsReview && (!reason || reason.length < 2)) {
    throw new AppError(
      'That is a big enough difference to explain before handing the till on.',
      400,
      'DRAWER_NO_VARIANCE_REASON',
    )
  }

  return prisma.$transaction(async (tx) => {
    await tx.cashDrawerSession.update({
      where: { id: session.id },
      data: {
        status: needsReview ? 'PENDING_REVIEW' : 'CLOSED',
        closedAt: new Date(),
        closedById: params.userId,
        countedCash: params.countedAmount,
        expectedCash: totals.expectedCash,
        variance,
        varianceReason: reason,
        closingNote: params.note?.trim() || `Handed over to another cashier`,
        activeRegisterKey: null,
        activeCashierKey: null,
      },
    })

    return tx.cashHandover.create({
      data: {
        restaurantId: params.restaurantId,
        branchId: session.branchId,
        registerId: session.registerId,
        fromSessionId: session.id,
        fromUserId: params.userId,
        toUserId: incoming.id,
        expectedAmount: totals.expectedCash,
        countedAmount: params.countedAmount,
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
    },
  })
}

export async function listHandovers(params: {
  restaurantId: string
  branchIds?: string[] | null
  branchId?: string | null
  from?: Date | null
  to?: Date | null
  limit?: number
}) {
  return prisma.cashHandover.findMany({
    where: {
      restaurantId: params.restaurantId,
      ...(params.branchIds ? { branchId: { in: params.branchIds } } : {}),
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
    select: { id: true, name: true, role: true, branchId: true },
    orderBy: { name: 'asc' },
  })

  // Filtered here rather than in the query because "no branch" means every
  // branch, which a `branchId` predicate cannot express.
  return rows.filter((user) =>
    canAccessBranch({ role: user.role, branchId: user.branchId }, params.branchId),
  )
}

async function requireHandover(
  restaurantId: string,
  handoverId: string,
  actor: { role: UserRole; branchId?: string | null },
): Promise<CashHandover> {
  const handover = await prisma.cashHandover.findFirst({
    where: { id: handoverId, restaurantId },
  })
  if (!handover) throw new NotFoundError('Handover')

  if (!canAccessBranch({ role: actor.role, branchId: actor.branchId }, handover.branchId)) {
    throw new ForbiddenError('That handover belongs to another location')
  }
  return handover
}
