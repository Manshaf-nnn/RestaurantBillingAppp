import 'server-only'

import type { ApprovalKind, ApprovalRequest, ApprovalStatus, Prisma } from '@prisma/client'

import { AppError, NotFoundError } from '@/lib/errors'
import { prisma } from '@/server/db/prisma'
import { AUDIT_ACTIONS, audit } from '@/server/audit'

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

  /**
   * Who may sign off requests, per location (correctionA.md §9).
   *
   * Keyed by branch id, with {@link RESTAURANT_WIDE} for the requests that
   * belong to no single site. A location with no entry — or an empty one —
   * falls back to "anyone holding `approvals.view` who can see it", which is
   * how every restaurant behaves today and must keep behaving until an owner
   * decides otherwise. An opt-in control that silently locks the queue the
   * moment it ships is a control nobody survives enabling.
   *
   * Stored here rather than as a new table or a new permission: the owner is
   * already on this screen setting thresholds, the restaurant row is already
   * loaded to read them, and a per-branch list of people is not a *permission*
   * — it is a routing rule. `permissionsFor` stays the one answer to "what may
   * this person do"; this answers "and is this particular queue theirs".
   */
  approvers?: Record<string, string[]>
}

/** The key under {@link ApprovalPolicy.approvers} for restaurant-wide requests. */
export const RESTAURANT_WIDE = '__all__'

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

  const request = await prisma.approvalRequest.create({
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

  /*
   * Raising a request is an event worth recording (stockMa.md's audit list).
   *
   * `AUDIT_ACTIONS.APPROVAL_REQUESTED` had been declared and never emitted, so
   * the trail began at the DECISION: the detail dialog's history — which reads
   * `entity: 'ApprovalRequest'` — could not say when a request was raised or by
   * whom, and "show me everything ever asked for" returned nothing.
   *
   * Emitted here rather than at the four call sites so every kind is covered
   * by one line and none can be forgotten. A dedupe returns early above, so a
   * retry writes no second row.
   */
  await audit({
    restaurantId: params.restaurantId,
    branchId: params.branchId ?? null,
    userId: params.userId ?? null,
    action: AUDIT_ACTIONS.APPROVAL_REQUESTED,
    entity: 'ApprovalRequest',
    entityId: request.id,
    after: {
      kind: params.kind,
      of: params.entity,
      ofId: params.entityId ?? null,
      amount: params.amount ?? null,
      reason: request.reason,
      ...(params.payload &&
      typeof params.payload === 'object' &&
      !Array.isArray(params.payload)
        ? (params.payload as Record<string, unknown>)
        : {}),
    },
  })

  return request
}

/**
 * Whether this person is on the approver list for the location a request
 * belongs to (correctionA.md §9).
 *
 * `null` means "no list configured here", which is not the same as "nobody" —
 * it is the state every restaurant starts in and most will stay in, and it
 * must read as "the permission alone is enough".
 */
export function approversFor(
  policy: ApprovalPolicy,
  branchId: string | null,
): string[] | null {
  const list = policy.approvers?.[branchId ?? RESTAURANT_WIDE]
  return list && list.length > 0 ? list : null
}

/**
 * May this person rule on this request?
 *
 * Two independent gates, and they answer different questions:
 *
 *   · the permission — `approvals.view` — says they may work this queue at all,
 *     and is checked by the action before this is reached;
 *   · the approver list says this location's decisions are theirs.
 *
 * Returns the reason it is refused rather than a bare false, because "you are
 * not an approver for Kandy" and "you cannot approve your own request" send
 * somebody to two completely different people to fix it.
 */
export function whyCannotApprove(params: {
  policy: ApprovalPolicy
  request: Pick<ApprovalRequest, 'branchId' | 'requestedById'>
  userId: string
  /**
   * `visibleBranchIds(user) === null` — an owner, admin or group manager.
   *
   * recorrection.md §1: "Main admin can approve/reject ANY request." So a
   * per-location approver list never binds an unconfined user. It exists to
   * say which of a *branch's* staff may sign for that branch; it was never
   * meant to be a way of locking the owner out of their own restaurant — and
   * the first version of this did exactly that, with no override control on
   * the screen where it happened.
   */
  unconfined: boolean
}): { code: 'APPROVAL_SELF' | 'APPROVAL_NOT_APPROVER'; message: string } | null {
  const { policy, request, userId, unconfined } = params

  /*
   * The self-rule comes first and applies to everyone, because the answer to
   * "may I sign my own request" is not "yes" for anybody — for an unconfined
   * user it is "yes, and it will be recorded as an override", which is
   * `decideApproval`'s call to make, not this function's. This function only
   * says whether a rule is in the way.
   */
  if (request.requestedById && request.requestedById === userId) {
    return {
      code: 'APPROVAL_SELF',
      message: 'You cannot approve your own request',
    }
  }

  if (unconfined) return null

  const approvers = approversFor(policy, request.branchId)
  if (approvers && !approvers.includes(userId)) {
    return {
      code: 'APPROVAL_NOT_APPROVER',
      message: 'You are not an approver for this location',
    }
  }

  return null
}

/**
 * Rule on a request.
 *
 * The approver must not be the requester. Self-approval turns a two-person
 * control into a formality, and it is the single thing this whole mechanism
 * exists to prevent.
 *
 * ── Except when somebody has to break the glass (correctionA.md §9) ────────
 *
 * There is a real operational case the rule above cannot survive: the owner is
 * the only person on site, raises a request, and there is nobody else to sign
 * it. Refusing outright does not produce a second pair of eyes — it produces a
 * workaround, which is worse than a recorded override because nothing records
 * a workaround.
 *
 * So `force` exists, it is gated on its own permission, and it never happens
 * quietly: `forcedBy` is written on the row, the caller audits it as its own
 * action, and the queue and the detail view both mark the decision as forced
 * for as long as the record exists. An override nobody can see afterwards is
 * indistinguishable from no control at all.
 */
export async function decideApproval(params: {
  restaurantId: string
  approvalId: string
  approve: boolean
  userId: string
  note?: string | null
  /** Holder of `approvals.force`. Checked by the action, honoured here. */
  mayForce?: boolean
  /** Whether they actually asked to override, rather than merely being able to. */
  force?: boolean
  /** `visibleBranchIds(user) === null`. See `whyCannotApprove`. */
  unconfined?: boolean
  /**
   * What approving or rejecting DOES, run in the same transaction as the
   * status change so the two cannot disagree. The caller supplies it because
   * the consequence belongs to another domain (a transfer's reserve) and this
   * module must not import it.
   */
  apply?: (tx: Prisma.TransactionClient) => Promise<void>
  // `previousStatus` rides along so the caller can audit what changed; the
  // row itself cannot say what it used to be once it has been written.
}): Promise<ApprovalRequest & { previousStatus: ApprovalStatus; forced: boolean }> {
  const request = await prisma.approvalRequest.findFirst({
    where: { id: params.approvalId, restaurantId: params.restaurantId },
  })
  if (!request) throw new NotFoundError('Approval request')
  if (request.status !== 'PENDING') {
    throw new AppError('That request has already been decided', 409, 'APPROVAL_DECIDED')
  }
  /*
   * The approver list and the self-rule, in one place (correctionA.md §9).
   *
   * `force` only counts when the caller actually holds the permission AND
   * asked for it. Being able to override is not the same as overriding — an
   * owner working the queue normally must still be refused their own request,
   * or the override becomes the default and stops being visible.
   */
  const policy = await getApprovalPolicy(params.restaurantId)

  /*
   * Was a rule actually in the way? Asked FIRST, with the override ignored,
   * because "forced" has to mean "this broke a rule" and not "somebody passed
   * a flag".
   *
   * The first cut of this set `forcedAt` whenever the flag arrived from
   * somebody who held the permission — so an owner ticking Override on a
   * request they could already decide got a permanent red "overridden" badge
   * on an ordinary approval. A badge that appears on decisions that broke
   * nothing is a badge people learn to skip, which costs exactly the ones that
   * did.
   */
  const blocked = whyCannotApprove({
    policy,
    request,
    userId: params.userId,
    unconfined: params.unconfined ?? false,
  })

  /*
   * Two ways through a rule that is in the way, and both leave a mark.
   *
   * An unconfined user signing their own request needs no extra click
   * (recorrection.md §1 lists it as simply allowed) — but it is still the
   * two-person rule being bypassed, so it is recorded as forced exactly as if
   * they had pressed Override. The badge and the audit filter stay honest;
   * only the friction is gone.
   *
   * Anybody else needs the permission AND to have asked for it. Holding
   * `approvals.force` is not using it: a confined approver working the queue
   * normally must still be refused their own request, or the override becomes
   * the default and stops being visible.
   */
  const selfByUnconfined = blocked?.code === 'APPROVAL_SELF' && params.unconfined === true
  const forced = Boolean(blocked && (selfByUnconfined || (params.force && params.mayForce)))
  if (blocked && !forced) throw new AppError(blocked.message, 403, blocked.code)
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
  const after = await prisma.$transaction(async (tx) => {
    const decided = await tx.approvalRequest.updateMany({
      where: { id: request.id, restaurantId: params.restaurantId, status: 'PENDING' },
      data: {
        status: params.approve ? 'APPROVED' : 'REJECTED',
        decidedById: params.userId,
        decidedAt: new Date(),
        decisionNote: params.note?.trim() || null,
        // Stamped on the row, not left to the audit log, so the queue and the
        // detail view can mark it for as long as the record exists.
        forcedAt: forced ? new Date() : null,
      },
    })
    if (decided.count === 0) {
      throw new AppError('That request has already been decided', 409, 'APPROVAL_DECIDED')
    }

    /*
     * The consequence, inside the same transaction (recorrection.md §1).
     *
     * The caller used to apply the decision AFTER this returned, in a
     * try/catch that logged and swallowed. So when reserving the stock failed
     * — the shelf was emptied while the request sat in the queue — the
     * request read APPROVED, the transfer still read REQUESTED, and the
     * only record of the gap was a line in a server log nobody reads. Now a
     * failed consequence rolls the decision back and the decider is told,
     * which is the only outcome that leaves the two records agreeing.
     */
    if (params.apply) await params.apply(tx)

    return tx.approvalRequest.findUniqueOrThrow({ where: { id: request.id } })
  })
  // Both rows, because the caller audits before/after and cannot reconstruct
  // `before` once the write has happened (bill.md §4). `forced` rides along so
  // the caller can audit the override as its own action rather than as an
  // ordinary approval that happens to have an unusual approver.
  return Object.assign(after, { previousStatus: request.status, forced })
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

export interface ApprovalFilters {
  status?: ApprovalStatus
  kind?: ApprovalKind
  requestedById?: string
  /** Where the request originates. For a transfer, the source location. */
  fromBranchId?: string
  /** Where it is going. Only a transfer has one. */
  toBranchId?: string
  from?: Date
  to?: Date
}

export async function listApprovals(params: {
  restaurantId: string
  branchIds?: string[] | null
  limit?: number
} & ApprovalFilters) {
  return prisma.approvalRequest.findMany({
    where: {
      restaurantId: params.restaurantId,
      ...(params.status ? { status: params.status } : {}),
      ...(params.kind ? { kind: params.kind } : {}),
      ...(params.requestedById ? { requestedById: params.requestedById } : {}),
      ...(params.from || params.to
        ? {
            requestedAt: {
              ...(params.from ? { gte: params.from } : {}),
              ...(params.to ? { lte: params.to } : {}),
            },
          }
        : {}),
      /*
       * Everything narrowing this query goes in one AND, not several keys
       * competing for `OR`. The visibility clause below is already an OR, and
       * a second one written as a sibling key would replace it rather than
       * combine with it — which is how a filter turns into a way to see more
       * rather than fewer rows.
       */
      AND: [
        /*
         * A restaurant-wide request has `branchId: null`, and filtering on
         * `branchId: { in: [...] }` alone dropped every one of them — so a
         * branch manager could never see the requests that concern everybody.
         * `inbox.ts` already had this right.
         */
        ...(params.branchIds
          ? [{ OR: [{ branchId: { in: params.branchIds } }, { branchId: null }] }]
          : []),

        /*
         * ── From and To, and why they are not symmetrical ─────────────────
         *
         * §9 wants both directions filterable and combinable: From = Kandy
         * shows what Kandy is giving up, To = Jaffna what Jaffna is receiving,
         * and the two together the single lane between them.
         *
         * `branchId` IS the origin — `transfers/actions.ts` sets it to the
         * source branch deliberately, "because approval reserves the source's
         * stock and it is the source that gives something up". So From is a
         * plain indexed column.
         *
         * The destination exists only inside the transfer's payload. Filtering
         * it as JSON rather than adding a column is the deliberate choice: the
         * rows already carry it, so history filters correctly from the first
         * deploy with no backfill, and this is a decision queue — bounded by
         * how much a human can rule on — not a ledger that needs the index.
         */
        ...(params.fromBranchId ? [{ branchId: params.fromBranchId }] : []),
        ...(params.toBranchId
          ? [{ payload: { path: ['toBranchId'], equals: params.toBranchId } }]
          : []),
      ],
    },
    orderBy: { requestedAt: 'desc' },
    take: params.limit ?? 50,
    include: {
      requestedBy: { select: { id: true, name: true } },
      decidedBy: { select: { name: true } },
      branch: { select: { id: true, name: true } },
    },
  })
}

/**
 * One request, with everything needed to rule on it (correctionA.md §9).
 *
 * §9 asks that nobody approve or reject before they can open and inspect the
 * whole thing, which means this has to carry the audit trail as well as the
 * row: the payload says what *would* happen, and the audit says what has
 * already been done to it and by whom. A decision made from a one-line summary
 * is the two-person control performed rather than exercised.
 */
export async function getApprovalDetail(params: {
  restaurantId: string
  approvalId: string
}) {
  const request = await prisma.approvalRequest.findFirst({
    where: { id: params.approvalId, restaurantId: params.restaurantId },
    include: {
      requestedBy: { select: { id: true, name: true, email: true } },
      decidedBy: { select: { id: true, name: true } },
      branch: { select: { id: true, name: true } },
    },
  })
  if (!request) throw new NotFoundError('Approval request')

  /*
   * The record itself, when it is a transfer (recorrection.md §1).
   *
   * "View Details must open inside the Approval tab. Do NOT redirect to the
   * Transfer tab." The request row carries a reason string and a line COUNT;
   * what somebody rules on is which items, how many, from where to where. That
   * lives on the StockTransfer, so it is joined here rather than sending the
   * reader to another page to find it.
   */
  const transfer =
    request.entity === 'StockTransfer' && request.entityId
      ? await prisma.stockTransfer.findFirst({
          where: { id: request.entityId, restaurantId: params.restaurantId },
          select: {
            number: true,
            status: true,
            fromBranchId: true,
            fromBranch: { select: { name: true } },
            toBranch: { select: { name: true } },
            lines: {
              select: {
                id: true,
                itemId: true,
                requestedQty: true,
                item: { select: { name: true, unit: true } },
              },
            },
          },
        })
      : null

  /*
   * The record itself, when it is a purchase request. Same reasoning as the
   * transfer above: the approver rules on which items, how many, at what
   * price, for which site — and should not be sent to the Purchasing tab to
   * find out.
   */
  const purchase =
    request.entity === 'Purchase' && request.entityId
      ? await prisma.purchase.findFirst({
          where: { id: request.entityId, restaurantId: params.restaurantId },
          select: {
            id: true,
            number: true,
            status: true,
            priority: true,
            total: true,
            notes: true,
            expectedAt: true,
            branch: { select: { name: true } },
            supplier: { select: { name: true } },
            items: {
              select: {
                id: true,
                quantity: true,
                unit: true,
                unitCost: true,
                lineTotal: true,
                item: { select: { name: true, unit: true } },
              },
            },
          },
        })
      : null

  /*
   * The trail for this request AND for the record it is about. An approval on
   * its own says "somebody said yes"; the entity's history says what that yes
   * did, which is the question a reader actually has.
   */
  const history = await prisma.auditLog.findMany({
    where: {
      restaurantId: params.restaurantId,
      OR: [
        { entity: 'ApprovalRequest', entityId: request.id },
        ...(request.entityId
          ? [{ entity: request.entity, entityId: request.entityId }]
          : []),
      ],
    },
    orderBy: { createdAt: 'desc' },
    take: 50,
    select: {
      id: true,
      action: true,
      actorName: true,
      createdAt: true,
      entity: true,
    },
  })

  return { request, history, transfer, purchase }
}

/** The restaurant row's `updatedAt`, read BEFORE the policy so `saveApprovers` can insist nothing moved. */
export async function getApprovalPolicyStamp(restaurantId: string): Promise<Date> {
  const row = await prisma.restaurant.findUniqueOrThrow({
    where: { id: restaurantId },
    select: { updatedAt: true },
  })
  return row.updatedAt
}

/**
 * Store one location's approver list (correctionA.md §9).
 *
 * ── Compare-and-swap on the restaurant row (recorrection.md §1) ────────────
 *
 * The policy is one JSON column holding every location's list, so saving
 * Kandy's approvers is read-the-whole-thing, change-one-key, write-the-whole-
 * thing. Two managers saving two branches at the same moment both read the
 * same JSON and the second write silently undid the first. The caller reads
 * the row's `updatedAt` first (`getApprovalPolicyStamp`), then this reads the
 * policy and writes it back only if the stamp still matches; if anything
 * touched the row in between — this form or any other setting — the loser is
 * told to reload rather than told nothing.
 *
 * Who may write which key is the action's business; this only makes the
 * write safe.
 */
export async function saveApprovers(params: {
  restaurantId: string
  /** A branch id, or `RESTAURANT_WIDE`. */
  key: string
  approverIds: string[]
  expectedUpdatedAt: Date
}): Promise<{ before: string[]; after: string[] }> {
  const policy = await getApprovalPolicy(params.restaurantId)
  const before = policy.approvers?.[params.key] ?? []
  const next = { ...(policy.approvers ?? {}), [params.key]: params.approverIds }

  const written = await prisma.restaurant.updateMany({
    where: { id: params.restaurantId, updatedAt: params.expectedUpdatedAt },
    data: {
      approvalPolicy: { ...policy, approvers: next } as unknown as Prisma.InputJsonValue,
    },
  })
  if (written.count === 0) {
    throw new AppError(
      'Somebody else changed the approval settings just now. Reload and try again.',
      409,
      'APPROVAL_POLICY_CHANGED',
    )
  }
  return { before, after: params.approverIds }
}
