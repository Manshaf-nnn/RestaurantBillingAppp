import 'server-only'

import type { ApprovalKind, ApprovalRequest, ApprovalStatus, Prisma } from '@prisma/client'

import { AppError, NotFoundError } from '@/lib/errors'
import { prisma } from '@/server/db/prisma'

/**
 * Approval workflow for sensitive actions.
 *
 * Some actions are legitimate but worth a second pair of eyes: a large refund,
 * a deep discount, a stock adjustment that writes off value. Rather than
 * forbidding them outright — which just teaches staff to work around the system
 * — they are allowed, but recorded and routed to someone who can say yes.
 *
 * ── Nothing happens until approved ──────────────────────────────────────────
 *
 * A request never mutates the thing it is about. The payload describes what
 * *would* be done, and the caller applies it only after approval. Otherwise
 * "pending" and "done" become the same state, and the control is theatre.
 *
 * ── Thresholds are per restaurant ───────────────────────────────────────────
 *
 * Rs 10,000 is a rounding error to one owner and a day's takings to another,
 * so the limits live on the restaurant with sensible defaults rather than being
 * hardcoded.
 */

export interface ApprovalPolicy {
  /** Refunds at or above this need approval, minor units. 0 disables. */
  refundAbove: number
  /** Discounts at or above this need approval, minor units. */
  discountAbove: number
  /** Stock adjustments whose value is at or above this need approval. */
  adjustmentValueAbove: number
  /** Purchase orders at or above this need approval on top of the normal flow. */
  purchaseAbove: number
  /** Turn the whole mechanism off for a restaurant that does not want it. */
  enabled: boolean

  /*
   * ── The cash controls ─────────────────────────────────────────────────────
   *
   * These do not go through ApprovalRequest — a drawer's status is already its
   * state, and a petty cash request has a life after approval that the approval
   * table has no vocabulary for. They live here because this is where an owner
   * already comes to say "how much is worth a second pair of eyes", and one
   * screen answering that question is better than three.
   */

  /** A drawer counted this far from expected stops for a manager. 0 disables. */
  cashVarianceAbove: number
  /**
   * Petty cash at or above this must be approved by somebody other than the
   * person who raised it. Below it, an approver may sign their own.
   */
  pettyCashApprovalAbove: number
  /**
   * Whether a till operator has to open a drawer before they can work.
   *
   * On by default, because an unattributed cash sale is money nobody can be
   * asked about. Off is for an operation that genuinely takes no cash, where
   * the gate would be a locked door with nothing behind it.
   */
  requireCashierSession: boolean
}

const DEFAULT_POLICY: ApprovalPolicy = {
  enabled: true,
  refundAbove: 10_000_00,
  discountAbove: 5_000_00,
  adjustmentValueAbove: 10_000_00,
  purchaseAbove: 100_000_00,
  cashVarianceAbove: 500_00,
  pettyCashApprovalAbove: 2_000_00,
  requireCashierSession: true,
}

export async function getApprovalPolicy(restaurantId: string): Promise<ApprovalPolicy> {
  const restaurant = await prisma.restaurant.findUnique({
    where: { id: restaurantId },
    select: { approvalPolicy: true },
  })
  const stored = restaurant?.approvalPolicy as Partial<ApprovalPolicy> | null
  return { ...DEFAULT_POLICY, ...(stored ?? {}) }
}

/**
 * Whether an action needs signing off.
 *
 * Returns false when the mechanism is disabled or the threshold is zero, so a
 * restaurant that does not want approvals is never blocked by one.
 */
export async function needsApproval(params: {
  restaurantId: string
  kind: ApprovalKind
  amount: number
}): Promise<boolean> {
  const policy = await getApprovalPolicy(params.restaurantId)
  if (!policy.enabled) return false

  const threshold =
    params.kind === 'REFUND' ? policy.refundAbove
      : params.kind === 'DISCOUNT' ? policy.discountAbove
        : params.kind === 'STOCK_ADJUSTMENT' ? policy.adjustmentValueAbove
          : params.kind === 'PURCHASE_ORDER' ? policy.purchaseAbove
            : 0

  if (threshold <= 0) return false
  return Math.abs(params.amount) >= threshold
}

export async function requestApproval(params: {
  restaurantId: string
  branchId?: string | null
  kind: ApprovalKind
  entity: string
  entityId?: string | null
  amount?: number
  reason: string
  payload?: Prisma.InputJsonValue
  userId?: string | null
}): Promise<ApprovalRequest> {
  if (params.reason.trim().length < 2) {
    throw new AppError('Give a reason for the request', 400, 'APPROVAL_NO_REASON')
  }

  // One open request per thing, or an impatient user creates five and a manager
  // approves the same refund repeatedly.
  const existing = await prisma.approvalRequest.findFirst({
    where: {
      restaurantId: params.restaurantId,
      entity: params.entity,
      entityId: params.entityId ?? null,
      kind: params.kind,
      status: 'PENDING',
    },
  })
  if (existing) return existing

  return prisma.approvalRequest.create({
    data: {
      restaurantId: params.restaurantId,
      branchId: params.branchId ?? null,
      kind: params.kind,
      entity: params.entity,
      entityId: params.entityId ?? null,
      amount: params.amount ?? null,
      reason: params.reason.trim(),
      payload: params.payload ?? undefined,
      requestedById: params.userId ?? null,
      status: 'PENDING',
    },
  })
}

/**
 * Rule on a request.
 *
 * The approver must not be the requester. Self-approval turns a two-person
 * control into a formality, and it is the single thing this whole mechanism
 * exists to prevent.
 */
export async function decideApproval(params: {
  restaurantId: string
  approvalId: string
  approve: boolean
  userId: string
  note?: string | null
  // `previousStatus` rides along so the caller can audit what changed; the
  // row itself cannot say what it used to be once it has been written.
}): Promise<ApprovalRequest & { previousStatus: ApprovalStatus }> {
  const request = await prisma.approvalRequest.findFirst({
    where: { id: params.approvalId, restaurantId: params.restaurantId },
  })
  if (!request) throw new NotFoundError('Approval request')
  if (request.status !== 'PENDING') {
    throw new AppError('That request has already been decided', 409, 'APPROVAL_DECIDED')
  }
  if (request.requestedById && request.requestedById === params.userId) {
    throw new AppError(
      'You cannot approve your own request',
      403,
      'APPROVAL_SELF',
    )
  }
  /*
   * Saying no has to say why (bill.md §3).
   *
   * An approval that was refused with no reason leaves the person who asked
   * with nothing to act on, and leaves the record unable to answer the only
   * question anyone asks later. Approving needs no essay — the approval IS the
   * answer — but a refusal without one is half a decision.
   */
  if (!params.approve && !params.note?.trim()) {
    throw new AppError('Give a reason for rejecting this request', 400, 'APPROVAL_NO_REASON')
  }

  /*
   * Compare-and-swap, not read-then-write.
   *
   * The check above and the write below used to be two separate statements
   * with no status predicate between them, so two managers opening the queue
   * at the same moment BOTH passed the check and both wrote: the second
   * silently overwrote the first's decision, and `applyDecision` ran twice —
   * which for a stock transfer means the same stock reserved twice. Putting
   * `status: 'PENDING'` in the WHERE makes the database the arbiter: exactly
   * one update touches a row, and the loser is told so.
   *
   * This is the same shape `outgoing-payments/service.ts` already uses.
   */
  const decided = await prisma.approvalRequest.updateMany({
    where: { id: request.id, restaurantId: params.restaurantId, status: 'PENDING' },
    data: {
      status: params.approve ? 'APPROVED' : 'REJECTED',
      decidedById: params.userId,
      decidedAt: new Date(),
      decisionNote: params.note?.trim() || null,
    },
  })
  if (decided.count === 0) {
    throw new AppError('That request has already been decided', 409, 'APPROVAL_DECIDED')
  }

  const after = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: request.id } })
  // Both rows, because the caller audits before/after and cannot reconstruct
  // `before` once the write has happened (bill.md §4).
  return Object.assign(after, { previousStatus: request.status })
}

/** Withdraw your own request before anyone rules on it. */
export async function withdrawApproval(params: {
  restaurantId: string
  approvalId: string
  userId: string
}): Promise<ApprovalRequest> {
  const request = await prisma.approvalRequest.findFirst({
    where: { id: params.approvalId, restaurantId: params.restaurantId },
  })
  if (!request) throw new NotFoundError('Approval request')
  if (request.status !== 'PENDING') {
    throw new AppError('That request has already been decided', 409, 'APPROVAL_DECIDED')
  }
  if (request.requestedById !== params.userId) {
    throw new AppError('Only the person who asked can withdraw it', 403, 'APPROVAL_NOT_YOURS')
  }
  // Both conditions in the WHERE, so "already decided" and "not yours" are
  // settled atomically rather than re-checked after the fact.
  const withdrawn = await prisma.approvalRequest.updateMany({
    where: {
      id: request.id,
      restaurantId: params.restaurantId,
      status: 'PENDING',
      requestedById: params.userId,
    },
    data: { status: 'WITHDRAWN' },
  })
  if (withdrawn.count === 0) {
    throw new AppError('That request has already been decided', 409, 'APPROVAL_DECIDED')
  }
  return prisma.approvalRequest.findUniqueOrThrow({ where: { id: request.id } })
}

/** Confirm an action was actually authorised before applying it. */
export async function assertApproved(params: {
  restaurantId: string
  entity: string
  entityId: string
  kind: ApprovalKind
}): Promise<void> {
  const approved = await prisma.approvalRequest.findFirst({
    where: {
      restaurantId: params.restaurantId,
      entity: params.entity,
      entityId: params.entityId,
      kind: params.kind,
      status: 'APPROVED',
    },
  })
  if (!approved) {
    throw new AppError(
      'This needs approval before it can go ahead',
      403,
      'APPROVAL_REQUIRED',
    )
  }
}

export async function listApprovals(params: {
  restaurantId: string
  status?: ApprovalStatus
  branchIds?: string[] | null
  limit?: number
}) {
  return prisma.approvalRequest.findMany({
    where: {
      restaurantId: params.restaurantId,
      ...(params.status ? { status: params.status } : {}),
      /*
       * A restaurant-wide request has `branchId: null`, and filtering on
       * `branchId: { in: [...] }` alone dropped every one of them — so a
       * branch manager could never see the requests that concern everybody.
       * `inbox.ts` already had this right.
       */
      ...(params.branchIds
        ? { OR: [{ branchId: { in: params.branchIds } }, { branchId: null }] }
        : {}),
    },
    orderBy: { requestedAt: 'desc' },
    take: params.limit ?? 50,
    include: {
      requestedBy: { select: { name: true } },
      decidedBy: { select: { name: true } },
      branch: { select: { name: true } },
    },
  })
}
