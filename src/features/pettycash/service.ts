import 'server-only'

import type { PettyCashRequest, PettyCashSource, PettyCashStatus, UserRole } from '@prisma/client'

import { AppError, ForbiddenError, NotFoundError } from '@/lib/errors'
import { formatMoney } from '@/lib/money'
import { canAccessBranch } from '@/lib/rbac'
import { guardLocks, prisma, type TxClient } from '@/server/db/prisma'
import { getApprovalPolicy } from '@/features/approvals/service'
import { resolveBranchId } from '@/features/branches/service'

/**
 * Petty cash: small things bought with cash, and the trail that makes that
 * acceptable.
 *
 * ── Two piles of money, not one ─────────────────────────────────────────────
 *
 * The petty cash fund is a tin with its own opening balance, recorded on the
 * drawer session as `openingPettyCash`. It is not part of the float and never
 * enters expected drawer cash. That separation is the whole control: "the tin
 * is short" and "the till is short" are different sentences with different
 * people to ask, and folding them together loses both.
 *
 * An expense therefore has to say which tin it came out of — `paidFrom`:
 *
 *   PETTY_FUND   reduces the fund. The drawer is untouched.
 *   DRAWER       writes a PETTY_CASH_PAID movement and reduces expected drawer
 *                cash. Nothing comes off the fund, because nothing left it.
 *
 * Moving money between the two is neither of these; it is a PETTY_FUND_TOPUP
 * movement on the drawer, recorded by the drawer service.
 *
 * ── Four states, and why not six ────────────────────────────────────────────
 *
 *   DRAFT → PENDING → APPROVED → PAID     plus REJECTED and CANCELLED
 *
 * A first draft of this reaches for
 * DRAFT → REQUESTED → PENDING APPROVAL → APPROVED → PAID → RECORDED, and two of
 * those pairs are the same state. A submitted request *is* pending approval —
 * nothing distinguishes REQUESTED from PENDING APPROVAL, and no code could ever
 * branch on the difference. RECORDED is not a state at all but the effect of
 * PAID: `pay` writes the ledger row and the drawer movement inside one
 * transaction, so paid-but-unrecorded cannot exist to be represented. Every
 * state that nothing can observe is one more place for a request to get stuck.
 *
 * The rule that matters survives untouched: **only PAID moves money.**
 *
 * ── Why this is not an ApprovalRequest ──────────────────────────────────────
 *
 * The approval engine's contract is that a request never mutates the thing it
 * describes — the payload says what *would* happen and the caller applies it
 * after approval. A petty cash request has a life after approval: it gets paid,
 * it gets a receipt number, it belongs to a drawer session. It is the domain
 * object, not a note about one. Routing it through ApprovalRequest would split
 * a single thing across two tables, and `decideApproval` has no hook to apply a
 * decision anyway. The rule worth borrowing — approver ≠ requester — is
 * borrowed.
 */

export const PETTY_CASH_CATEGORIES = [
  'Ingredients',
  'Cleaning',
  'Transport',
  'Repairs',
  'Printing',
  'Utilities',
  'Staff welfare',
  'Other',
] as const

export interface PettyActor {
  id: string
  role: UserRole
  branchId?: string | null
  canApprove: boolean
}

/** Money still in the tin for a session. */
export interface PettyCashBalance {
  opening: number
  toppedUp: number
  spent: number
  /** Approved but not yet handed over — committed, not gone. */
  committed: number
  balance: number
}

// ── raising one ──────────────────────────────────────────────────────────────

export async function createRequest(params: {
  restaurantId: string
  branchId?: string | null
  userBranchId?: string | null
  category: string
  description: string
  amount: number
  reference?: string | null
  paidFrom?: PettyCashSource
  userId: string
  /** Save without submitting. */
  draft?: boolean
}): Promise<PettyCashRequest> {
  if (params.amount <= 0) {
    throw new AppError('Amount must be more than zero', 400, 'PETTY_BAD_AMOUNT')
  }
  const description = params.description.trim()
  if (description.length < 2) {
    throw new AppError('Say what the money was for', 400, 'PETTY_NO_DESCRIPTION')
  }
  const category = params.category.trim() || 'Other'

  const branchId = await resolveBranchId({
    restaurantId: params.restaurantId,
    requestedBranchId: params.branchId,
    userBranchId: params.userBranchId,
  })

  return prisma.pettyCashRequest.create({
    data: {
      restaurantId: params.restaurantId,
      branchId,
      category,
      description,
      amount: params.amount,
      reference: params.reference?.trim() || null,
      paidFrom: params.paidFrom ?? 'PETTY_FUND',
      status: params.draft ? 'DRAFT' : 'PENDING',
      requestedById: params.userId,
    },
  })
}

/** Send a draft for approval. */
export async function submitRequest(params: {
  restaurantId: string
  requestId: string
  userId: string
  actor: PettyActor
}): Promise<PettyCashRequest> {
  const request = await requireRequest(params.restaurantId, params.requestId, params.actor)
  if (request.status !== 'DRAFT') {
    throw new AppError('That request has already been sent', 409, 'PETTY_NOT_DRAFT')
  }
  if (request.requestedById && request.requestedById !== params.userId && !params.actor.canApprove) {
    throw new ForbiddenError('Only the person who wrote it can send it')
  }
  return prisma.pettyCashRequest.update({
    where: { id: request.id },
    data: { status: 'PENDING' },
  })
}

// ── deciding ─────────────────────────────────────────────────────────────────

/**
 * Approve or reject.
 *
 * Above `pettyCashApprovalAbove` the approver must be somebody other than the
 * person who asked. Below it, a manager buying a bag of cleaning cloths does
 * not need to find a second manager — the control is proportionate to the
 * money, which is the only way a control gets followed rather than
 * circumvented.
 */
export async function decideRequest(params: {
  restaurantId: string
  requestId: string
  approve: boolean
  note?: string | null
  userId: string
  actor: PettyActor
}): Promise<PettyCashRequest> {
  if (!params.actor.canApprove) {
    throw new ForbiddenError('You cannot approve petty cash')
  }

  const request = await requireRequest(params.restaurantId, params.requestId, params.actor)
  if (request.status !== 'PENDING') {
    throw new AppError('That request has already been decided', 409, 'PETTY_DECIDED')
  }

  const policy = await getApprovalPolicy(params.restaurantId)
  const needsSecondPerson =
    policy.pettyCashApprovalAbove > 0 && request.amount >= policy.pettyCashApprovalAbove
  if (needsSecondPerson && request.requestedById === params.userId) {
    throw new AppError(
      'Somebody else has to approve an amount this size',
      403,
      'PETTY_SELF_APPROVAL',
    )
  }

  return prisma.pettyCashRequest.update({
    where: { id: request.id },
    data: {
      status: params.approve ? 'APPROVED' : 'REJECTED',
      decidedById: params.userId,
      decidedAt: new Date(),
      decisionNote: params.note?.trim() || null,
    },
  })
}

/** Withdraw your own request before anybody rules on it. */
export async function cancelRequest(params: {
  restaurantId: string
  requestId: string
  userId: string
  actor: PettyActor
}): Promise<PettyCashRequest> {
  const request = await requireRequest(params.restaurantId, params.requestId, params.actor)
  if (request.status !== 'PENDING' && request.status !== 'DRAFT') {
    throw new AppError('That request has already been decided', 409, 'PETTY_DECIDED')
  }
  if (request.requestedById !== params.userId && !params.actor.canApprove) {
    throw new ForbiddenError('Only the person who asked can withdraw it')
  }
  return prisma.pettyCashRequest.update({
    where: { id: request.id },
    data: { status: 'CANCELLED' },
  })
}

// ── paying ───────────────────────────────────────────────────────────────────

/**
 * Hand over the cash.
 *
 * The one step that moves money, and the only one. Everything happens in a
 * single transaction: the request flips to PAID, it is attached to the drawer
 * session it was paid against, and a DRAWER payment writes its movement. That
 * is what makes a separate "recorded" state unnecessary — there is no window in
 * which a request is paid and the ledger does not know.
 *
 * A PETTY_FUND payment cannot exceed what is in the tin. Overspending a fund
 * silently is how a fund stops meaning anything.
 */
export async function payRequest(params: {
  restaurantId: string
  requestId: string
  sessionId: string
  userId: string
  actor: PettyActor
}): Promise<PettyCashRequest> {
  if (!params.actor.canApprove) {
    throw new ForbiddenError('You cannot pay out petty cash')
  }

  const request = await requireRequest(params.restaurantId, params.requestId, params.actor)
  if (request.status !== 'APPROVED') {
    throw new AppError('Only an approved request can be paid', 409, 'PETTY_NOT_APPROVED')
  }

  const session = await prisma.cashDrawerSession.findFirst({
    where: { id: params.sessionId, restaurantId: params.restaurantId },
    select: { id: true, branchId: true, status: true },
  })
  if (!session) throw new NotFoundError('Drawer session')
  if (session.status !== 'OPEN') {
    throw new AppError('That drawer is not open', 409, 'DRAWER_CLOSED')
  }
  if (session.branchId !== request.branchId) {
    throw new AppError(
      'That request belongs to another location’s petty cash',
      403,
      'PETTY_WRONG_BRANCH',
    )
  }

  return prisma.$transaction(async (tx) => {
    /*
     * ── Two different races, two different answers ──────────────────────────
     *
     * The first is one request paid twice — two clicks on "Pay out". Putting
     * the status in the UPDATE's WHERE makes the transition itself the lock:
     * the second `updateMany` matches no rows, and the same expense cannot
     * leave the till twice.
     *
     * The second is two *different* requests that each fit the tin but together
     * do not. Moving the balance check inside the transaction is not enough for
     * that one, and it is worth being precise about why: Postgres runs at READ
     * COMMITTED, so both transactions read the balance before either commits,
     * both see enough money, and the tin ends up negative. Written as a test
     * first, it failed exactly like that.
     *
     * So the session row is locked before the balance is read. The second
     * payment waits, re-reads after the first commits, and is correctly
     * refused. Same `FOR UPDATE` idiom the payment capture uses on the order.
     */
    /*
     * The lock is taken for BOTH kinds of payment, not just fund ones. A
     * drawer-paid expense races the close: `payRequest` reads status OPEN,
     * `closeDrawer` snapshots expected cash without the movement, and then the
     * movement lands on a session already counted — a variance created after
     * the count that produced it. Locking the session row makes the two
     * serialise, and the loser's status re-read below refuses.
     */
    await guardLocks(tx)
    await tx.$queryRaw`
      SELECT id FROM cash_drawer_sessions WHERE id = ${session.id} FOR UPDATE
    `
    const stillOpen = await tx.cashDrawerSession.findUnique({
      where: { id: session.id },
      select: { status: true },
    })
    if (stillOpen?.status !== 'OPEN') {
      throw new AppError('That drawer was closed while you were paying', 409, 'DRAWER_CLOSED')
    }

    if (request.paidFrom === 'PETTY_FUND') {
      const fund = await fundBalanceIn(tx, session.id)
      if (request.amount > fund) {
        /*
         * Formatted with the restaurant's own currency, not `/ 100`. The
         * shortcut would tell a JPY restaurant its ¥3,000 tin holds ¥30 — in
         * the one message whose entire job is to say how much is left. Read
         * only on the failing path, so the ordinary payment costs nothing.
         */
        const home = await tx.restaurant.findUnique({
          where: { id: params.restaurantId },
          select: { currency: true },
        })
        throw new AppError(
          `The petty cash tin only has ${formatMoney(fund, home?.currency ?? 'INR')} left. ` +
            `Top it up from the drawer first.`,
          409,
          'PETTY_FUND_SHORT',
        )
      }
    }

    const claimed = await tx.pettyCashRequest.updateMany({
      where: { id: request.id, status: 'APPROVED' },
      data: {
        status: 'PAID',
        sessionId: session.id,
        paidById: params.userId,
        paidAt: new Date(),
      },
    })
    if (claimed.count === 0) {
      throw new AppError('That request has already been paid', 409, 'PETTY_ALREADY_PAID')
    }
    const paid = await tx.pettyCashRequest.findUniqueOrThrow({ where: { id: request.id } })

    if (paid.paidFrom === 'DRAWER') {
      await tx.cashMovement.create({
        data: {
          sessionId: session.id,
          type: 'PETTY_CASH_PAID',
          amount: paid.amount,
          reason: `${paid.category} — ${paid.description}`,
          reference: paid.reference,
          pettyCashRequestId: paid.id,
          createdById: params.userId,
        },
      })
    }

    return paid
  })
}

// ── balances and listing ─────────────────────────────────────────────────────

/**
 * The tin's balance, read on a transaction client.
 *
 * A trimmed version of `getFundBalance` — just the number, none of the
 * committed/pending context the screen wants — so the check that guards a
 * payment happens on the same snapshot as the write it guards.
 */
async function fundBalanceIn(tx: TxClient, sessionId: string): Promise<number> {
  const [session, topUps, spent] = await Promise.all([
    tx.cashDrawerSession.findUnique({
      where: { id: sessionId },
      select: { openingPettyCash: true },
    }),
    tx.cashMovement.aggregate({
      where: { sessionId, type: 'PETTY_FUND_TOPUP' },
      _sum: { amount: true },
    }),
    tx.pettyCashRequest.aggregate({
      where: { sessionId, status: 'PAID', paidFrom: 'PETTY_FUND' },
      _sum: { amount: true },
    }),
  ])
  if (!session) throw new NotFoundError('Drawer session')
  return session.openingPettyCash + (topUps._sum.amount ?? 0) - (spent._sum.amount ?? 0)
}

/** What is left in one session's tin. */
export async function getFundBalance(
  restaurantId: string,
  sessionId: string,
): Promise<PettyCashBalance> {
  const session = await prisma.cashDrawerSession.findFirst({
    where: { id: sessionId, restaurantId },
    select: { openingPettyCash: true, branchId: true },
  })
  if (!session) throw new NotFoundError('Drawer session')

  const [topUps, spent, committed] = await Promise.all([
    prisma.cashMovement.aggregate({
      where: { sessionId, type: 'PETTY_FUND_TOPUP' },
      _sum: { amount: true },
    }),
    prisma.pettyCashRequest.aggregate({
      where: { sessionId, status: 'PAID', paidFrom: 'PETTY_FUND' },
      _sum: { amount: true },
    }),
    /*
     * Approved and not yet paid, at this branch. Not deducted from the balance
     * — the notes are still in the tin — but shown, because a cashier who does
     * not know Rs 4,000 is already promised will approve a fifth request they
     * cannot fund.
     */
    prisma.pettyCashRequest.aggregate({
      where: {
        restaurantId,
        branchId: session.branchId,
        status: 'APPROVED',
        paidFrom: 'PETTY_FUND',
      },
      _sum: { amount: true },
    }),
  ])

  const opening = session.openingPettyCash
  const toppedUp = topUps._sum.amount ?? 0
  const used = spent._sum.amount ?? 0

  return {
    opening,
    toppedUp,
    spent: used,
    committed: committed._sum.amount ?? 0,
    balance: opening + toppedUp - used,
  }
}

export async function listRequests(params: {
  restaurantId: string
  branchIds?: string[] | null
  branchId?: string | null
  status?: PettyCashStatus | null
  category?: string | null
  requestedById?: string | null
  from?: Date | null
  to?: Date | null
  limit?: number
}) {
  return prisma.pettyCashRequest.findMany({
    where: {
      restaurantId: params.restaurantId,
      ...(params.branchIds ? { branchId: { in: params.branchIds } } : {}),
      ...(params.branchId ? { branchId: params.branchId } : {}),
      ...(params.status ? { status: params.status } : {}),
      ...(params.category ? { category: params.category } : {}),
      ...(params.requestedById ? { requestedById: params.requestedById } : {}),
      ...(params.from || params.to
        ? {
            requestedAt: {
              ...(params.from ? { gte: params.from } : {}),
              ...(params.to ? { lte: params.to } : {}),
            },
          }
        : {}),
    },
    orderBy: { requestedAt: 'desc' },
    take: params.limit ?? 100,
    include: {
      requestedBy: { select: { name: true } },
      decidedBy: { select: { name: true } },
      paidBy: { select: { name: true } },
      branch: { select: { name: true } },
    },
  })
}

/**
 * Read a request this person may actually see.
 *
 * The branch check is not decoration: a request id is otherwise all it takes to
 * approve another site's spending, and the money would leave that site's tin.
 */
async function requireRequest(
  restaurantId: string,
  requestId: string,
  actor: PettyActor,
): Promise<PettyCashRequest> {
  const request = await prisma.pettyCashRequest.findFirst({
    where: { id: requestId, restaurantId },
  })
  if (!request) throw new NotFoundError('Petty cash request')

  if (!canAccessBranch({ role: actor.role, branchId: actor.branchId }, request.branchId)) {
    throw new ForbiddenError('That request belongs to another location')
  }
  return request
}
