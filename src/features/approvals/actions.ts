'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import type { StockUnit } from '@prisma/client'

import { runAction, runSafe, type ActionResult } from '@/lib/action'
import { PERMISSIONS, can, visibleBranchIds } from '@/lib/rbac'
import { AUDIT_ACTIONS, audit } from '@/server/audit'
import { assertBranchAccess, assertRecordBranch, requirePermission } from '@/server/auth/guard'
import { prisma } from '@/server/db/prisma'
import { ForbiddenError, NotFoundError } from '@/lib/errors'
import {
  RESTAURANT_WIDE,
  decideApproval,
  getApprovalDetail,
  getApprovalPolicy,
  getApprovalPolicyStamp,
  saveApprovers,
  whyCannotApprove,
  withdrawApproval,
} from './service'
import { DECIDE_PERMISSION } from './permissions'
import type { ApprovalDetailPayload } from './types'
import { approveTransfer, closeTransfer } from '@/features/transfers/service'
import { adjustStock } from '@/features/inventory/operations'

/**
 * Rule on a request (recorrection.md §1).
 *
 * Three gates, in order: `approvals.view` to be at the desk at all; the
 * branch guard, so a manager confined to Kandy cannot decide Jaffna's; and
 * the permission for the KIND of request — `transfer.approve` for a
 * transfer, `payment.refund` for a refund — because deciding one is a
 * deferred act of that kind. See `DECIDE_PERMISSION` for why this replaced
 * `settings.manage`.
 *
 * Whether the approver LIST applies, and whether this is the decider's own
 * request, is the service's business; it is told whether the decider is
 * confined, because an owner who works across every location is bound by no
 * branch's list.
 */
export async function decideApprovalAction(
  input: unknown,
): Promise<ActionResult<{ status: string }>> {
  return runAction(
    z
      .object({
        approvalId: z.string().min(1),
        approve: z.boolean(),
        note: z.string().trim().max(200).optional().or(z.literal('')),
        // Asked for explicitly. Holding the permission is not the same as
        // using it — a confined approver working the queue normally must
        // still be refused their own request, or the override stops being
        // visible.
        force: z.boolean().optional(),
        /*
         * A stock transfer approved for LESS than was asked for.
         *
         * "You can have 30 of the 50" is the ordinary answer in a store room,
         * and without it the approver's only choices were to reserve stock
         * that is not there or to reject the whole request and make the branch
         * raise it again. Ignored for every other kind of request.
         *
         * Never more than was requested — the service refuses it and so does
         * the database, because approving more than a branch asked for is not
         * an approval, it is a different request.
         */
        approvedLines: z
          .array(
            z.object({
              lineId: z.string().cuid(),
              quantity: z.coerce.number().min(0).max(1_000_000),
            }),
          )
          .max(200)
          .optional(),
      })
      // A refusal has to carry its reason, and saying so on the FIELD gives
      // the person a message beside the box rather than a toast they have to
      // guess at. The service enforces it too, for callers that never see this.
      .superRefine((value, ctx) => {
        if (!value.approve && !value.note?.trim()) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['note'],
            message: 'Give a reason for rejecting this request',
          })
        }
      }),
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.APPROVALS_VIEW)

      /*
       * Whose request this is, and of what kind, before deciding it.
       *
       * `assertRecordBranch` returns early on a null branchId, so a
       * restaurant-wide request stays decidable by everyone in reach.
       */
      const target = await prisma.approvalRequest.findFirst({
        where: { id: data.approvalId, restaurantId: user.restaurantId },
        select: { kind: true, branchId: true, entityId: true, payload: true, requestedById: true, reason: true },
      })
      if (!target) throw new NotFoundError('Approval request')
      await assertRecordBranch(user, target, 'approval request')

      const needed = DECIDE_PERMISSION[target.kind]
      if (!can(user, needed)) {
        throw new ForbiddenError(
          'You can see this request, but deciding it needs the permission for that kind of request',
        )
      }

      const note = data.note || null
      const isTransfer = target.kind === 'STOCK_TRANSFER' && Boolean(target.entityId)
      /*
       * A stock adjustment somebody asked for rather than made (stockMa.md).
       * The request row IS the record — there is no half-written entity to
       * close — so only approval has a consequence; a refusal is the decision
       * plus its mandatory note.
       */
      const adjustment =
        target.kind === 'STOCK_ADJUSTMENT' && data.approve && target.branchId
          ? (target.payload as {
              reference?: string
              itemId?: string
              quantity?: number
              unit?: StockUnit | null
              direction?: 'IN' | 'OUT'
            } | null)
          : null

      const request = await decideApproval({
        restaurantId: user.restaurantId,
        approvalId: data.approvalId,
        approve: data.approve,
        userId: user.id,
        note,
        mayForce: can(user, PERMISSIONS.APPROVALS_FORCE),
        force: data.force,
        unconfined: visibleBranchIds(user) === null,
        /*
         * The decision IS the decision. Approving moves the transfer to
         * APPROVED and reserves the source's stock; rejecting closes it with
         * the decider's note as the reason. Inside the same transaction, so
         * a failed reserve rolls the ruling back and the decider sees why —
         * the previous shape recorded the ruling first and swallowed the
         * failure, which left an APPROVED request pointing at a REQUESTED
         * transfer with nothing but a server log to say so.
         */
        apply: adjustment?.itemId && adjustment.quantity && adjustment.direction
          ? async (tx) => {
              await adjustStock({
                restaurantId: user.restaurantId,
                branchId: target.branchId!,
                itemId: adjustment.itemId!,
                quantity: adjustment.quantity!,
                unit: adjustment.unit ?? undefined,
                direction: adjustment.direction!,
                reason: target.reason,
                reference: adjustment.reference ?? null,
                /*
                 * The ledger names the person who found the discrepancy, not
                 * the one who signed it off. Who signed it is on the approval
                 * itself (`decidedById`) and in the audit row below.
                 */
                userId: target.requestedById ?? user.id,
                tx,
              })
            }
          : isTransfer
          ? async (tx) => {
              if (data.approve) {
                await approveTransfer({
                  restaurantId: user.restaurantId,
                  transferId: target.entityId!,
                  userId: user.id,
                  approved: data.approvedLines,
                  tx,
                })
              } else {
                await closeTransfer({
                  restaurantId: user.restaurantId,
                  transferId: target.entityId!,
                  status: 'REJECTED',
                  reason: note || 'Rejected at the approvals desk',
                  userId: user.id,
                  tx,
                })
              }
            }
          : undefined,
      })

      await audit({
        restaurantId: user.restaurantId, branchId: request.branchId, userId: user.id,
        actorName: user.name,
        // An override is logged as an override (§9). Filtering this log for
        // every time the two-person rule was broken has to be one query, not
        // a reading of every approval ever made.
        action: request.forced ? AUDIT_ACTIONS.APPROVAL_FORCED : AUDIT_ACTIONS.APPROVAL_DECIDED,
        entity: 'ApprovalRequest', entityId: request.id,
        // Old status and new, because §4 asks the log to answer what changed
        // and not merely what it ended up as.
        before: { status: request.previousStatus },
        after: {
          status: request.status,
          kind: request.kind,
          note,
          ...(request.forced ? { forced: true } : {}),
        },
      })

      revalidatePath('/dashboard/approvals')
      revalidatePath('/dashboard/transfers')
      return { status: request.status }
    },
    'Decision recorded.',
  )
}

export async function withdrawApprovalAction(approvalId: string): Promise<ActionResult<{ status: string }>> {
  return runSafe(async () => {
    // APPROVALS_VIEW, which the registry sells for this feature — a custom
    // role with the dashboard on and approvals off could still withdraw.
    const user = await requirePermission(PERMISSIONS.APPROVALS_VIEW)
    const request = await withdrawApproval({
      restaurantId: user.restaurantId,
      approvalId,
      userId: user.id,
    })
    revalidatePath('/dashboard/approvals')
    return { status: request.status }
  })
}

/**
 * Choose who may sign off requests at a location (correctionA.md §9).
 *
 * ── Why this is a routing rule and not a permission ────────────────────────
 *
 * It would be tempting to mint `approvals.decide.kandy` and be done. That is a
 * second permission system — the thing Rolelogic and §7 both forbid — and it
 * grows a key per location forever. `approvals.view` still answers "may this
 * person work the approvals queue"; this answers "and are THIS location's
 * decisions theirs", which is routing, and it lives beside the thresholds the
 * owner is already setting on the same screen.
 *
 * ── The list is checked, not trusted ───────────────────────────────────────
 *
 * Every id is resolved against this restaurant's own active staff before it is
 * stored, and every one of them must actually hold `approvals.view` — naming
 * somebody who cannot open the queue produces a location whose approver list
 * is full and whose queue nobody can clear, which looks exactly like a bug in
 * the approvals system rather than a mistake in this form.
 *
 * An empty list is meaningful and is stored: it means "no list here", which
 * falls back to anyone with the permission. That is how every restaurant
 * behaves today and must keep behaving until an owner decides otherwise.
 *
 * ── Reach (recorrection.md §1) ──────────────────────────────────────────────
 *
 * A branch manager sets the list for their own branch and nobody else's.
 * The first cut checked the branch id when one was given and skipped the
 * check for the EMPTY key — which is the restaurant-wide list, the one that
 * applies everywhere. So the manager of one branch could rewrite the
 * approvers for the whole business. Now the global key needs an unconfined
 * actor, and every person named must be somebody within the actor's reach.
 */
export async function setApprovalAccessAction(
  input: unknown,
): Promise<ActionResult<{ branchId: string; approverIds: string[] }>> {
  return runAction(
    z.object({
      /** Empty means the restaurant-wide queue. */
      branchId: z.string().optional().or(z.literal('')),
      approverIds: z.array(z.string().min(1)).max(50),
    }),
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.APPROVALS_MANAGE)
      const reach = visibleBranchIds(user)

      if (data.branchId) {
        // A branch id from the client is a branch id like any other.
        await assertBranchAccess(user, data.branchId)
      } else if (reach !== null) {
        throw new ForbiddenError(
          'The approvers for every location can only be set by someone who works across every location',
        )
      }

      const unique = [...new Set(data.approverIds)]
      const staff = unique.length
        ? await prisma.user.findMany({
            where: {
              id: { in: unique },
              restaurantId: user.restaurantId,
              isActive: true,
              deletedAt: null,
            },
            select: {
              id: true, name: true, role: true, permissions: true, branchId: true,
              staffRole: { select: { permissions: true, isActive: true } },
            },
          })
        : []

      if (staff.length !== unique.length) {
        throw new ForbiddenError('One of those people is not a member of your staff')
      }

      // Somebody at a location the actor does not manage is not theirs to
      // appoint. A person with no location at all works everywhere and is.
      const beyondReach = reach
        ? staff.filter((member) => member.branchId && !reach.includes(member.branchId))
        : []
      if (beyondReach.length > 0) {
        throw new ForbiddenError(
          `${beyondReach.map((m) => m.name).join(', ')} work at a location you do not manage`,
        )
      }

      const cannotSee = staff.filter(
        (member) =>
          !can(
            {
              role: member.role,
              permissions: member.permissions,
              rolePermissions:
                member.staffRole && member.staffRole.isActive ? member.staffRole.permissions : null,
            },
            PERMISSIONS.APPROVALS_VIEW,
          ),
      )
      if (cannotSee.length > 0) {
        throw new ForbiddenError(
          `${cannotSee.map((m) => m.name).join(', ')} cannot open the approvals queue, so they cannot be an approver for it`,
        )
      }

      // Stamp first, then the policy: `saveApprovers` refuses the write if the
      // row moved in between, so two managers saving two branches at once
      // cannot undo each other.
      const key = data.branchId || RESTAURANT_WIDE
      const stamp = await getApprovalPolicyStamp(user.restaurantId)
      const saved = await saveApprovers({
        restaurantId: user.restaurantId,
        key,
        approverIds: unique,
        expectedUpdatedAt: stamp,
      })

      await audit({
        restaurantId: user.restaurantId,
        branchId: data.branchId || null,
        userId: user.id,
        actorName: user.name,
        action: AUDIT_ACTIONS.APPROVAL_ACCESS_SET,
        entity: 'Restaurant',
        entityId: user.restaurantId,
        before: { approvers: saved.before },
        after: { approvers: saved.after },
      })

      revalidatePath('/dashboard/approvals')
      return { branchId: key, approverIds: unique }
    },
    'Approvers saved.',
  )
}

/**
 * Everything needed to rule on one request (correctionA.md §9).
 *
 * A read through an action rather than props on the list, because the detail
 * carries the payload and the audit trail of the record it concerns — loading
 * that for every row of a fifty-row history would be fifty extra queries to
 * render a screen where at most one of them gets opened.
 *
 * The branch guard is the same one `decideApprovalAction` applies: somebody
 * confined to Kandy must not be able to read Jaffna's request by asking for
 * its id directly, and "read" is where that leak would happen — the decision
 * is already guarded, the reading of it was not.
 */
export async function approvalDetailAction(
  input: unknown,
): Promise<ActionResult<ApprovalDetailPayload>> {
  return runAction(
    z.object({ approvalId: z.string().min(1) }),
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.APPROVALS_VIEW)
      const { request, history, transfer } = await getApprovalDetail({
        restaurantId: user.restaurantId,
        approvalId: data.approvalId,
      })
      await assertRecordBranch(user, { branchId: request.branchId }, 'approval request')

      const policy = await getApprovalPolicy(user.restaurantId)
      const mayForce = can(user, PERMISSIONS.APPROVALS_FORCE)
      /*
       * Why they cannot decide it NORMALLY. The dialog needs to know there is
       * a rule in the way even when this viewer is allowed to override it, or
       * the override button has nothing to explain itself with. An unconfined
       * viewer is bound by no list, and their own request is allowed (and
       * marked) — so for them this is null.
       */
      const unconfined = visibleBranchIds(user) === null
      const refusal = whyCannotApprove({ policy, request, userId: user.id, unconfined })
      const selfByUnconfined = refusal?.code === 'APPROVAL_SELF' && unconfined

      const payload = (request.payload ?? {}) as Record<string, unknown>
      /*
       * What the sending location actually has free, per item.
       *
       * One read for the whole transfer rather than one per line. `available`
       * less `reserved`, because stock already held for another approved
       * transfer is spoken for and offering it here would let two approvals
       * promise the same kilo.
       */
      const freeAtSource = new Map<string, number>()
      if (transfer) {
        const rows = await prisma.inventoryStock.findMany({
          where: {
            restaurantId: user.restaurantId,
            branchId: transfer.fromBranchId,
            itemId: { in: transfer.lines.map((line) => line.itemId) },
          },
          select: { itemId: true, available: true, reserved: true },
        })
        for (const row of rows) {
          freeAtSource.set(
            row.itemId,
            (freeAtSource.get(row.itemId) ?? 0) + Math.max(0, row.available - row.reserved),
          )
        }
      }

      const details = Object.entries(payload)
        .filter(([, value]) => value !== null && typeof value !== 'object')
        .map(([key, value]) => ({
          // camelCase to words, so a payload key reads as a label.
          label: key.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase()),
          value: String(value),
        }))

      return {
        id: request.id,
        kind: request.kind,
        status: request.status,
        reason: request.reason,
        amount: request.amount,
        branchName: request.branch?.name ?? null,
        requestedByName: request.requestedBy?.name ?? 'Someone',
        requestedAt: request.requestedAt.toISOString(),
        decidedByName: request.decidedBy?.name ?? null,
        decidedAt: request.decidedAt?.toISOString() ?? null,
        decisionNote: request.decisionNote,
        forcedAt: request.forcedAt?.toISOString() ?? null,
        href:
          request.kind === 'STOCK_TRANSFER' && request.entityId
            ? `/dashboard/transfers/${request.entityId}`
            : null,
        // The document's own number where it has one, not an id slice.
        reference:
          transfer?.number ??
          (request.entityId ? `${request.entity} ${request.entityId.slice(0, 8)}` : null),
        details,
        history: history.map((entry) => ({
          id: entry.id,
          action: entry.action,
          actorName: entry.actorName ?? 'Someone',
          createdAt: entry.createdAt.toISOString(),
          entity: entry.entity,
        })),
        blockedReason: selfByUnconfined ? null : (refusal?.message ?? null),
        mayForce,
        transfer: transfer
          ? {
              number: transfer.number,
              status: transfer.status,
              fromBranchName: transfer.fromBranch.name,
              toBranchName: transfer.toBranch.name,
              lines: transfer.lines.map((line) => ({
                id: line.id,
                itemId: line.itemId,
                name: line.item.name,
                unit: line.item.unit,
                quantity: line.requestedQty,
                /*
                 * Free stock at the source — the approver's actual question.
                 * `available` less what is already reserved for another
                 * approved transfer, which is spoken for.
                 */
                available: Math.max(
                  0,
                  freeAtSource.get(line.itemId) ?? 0,
                ),
              })),
            }
          : null,
      }
    },
  )
}
