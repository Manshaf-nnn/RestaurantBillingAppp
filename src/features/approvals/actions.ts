'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'

import { runAction, runSafe, type ActionResult } from '@/lib/action'
import { PERMISSIONS, can } from '@/lib/rbac'
import { AUDIT_ACTIONS, audit } from '@/server/audit'
import { assertBranchAccess, assertRecordBranch, requirePermission } from '@/server/auth/guard'
import { prisma } from '@/server/db/prisma'
import { ForbiddenError } from '@/lib/errors'
import type { Prisma } from '@prisma/client'
import {
  RESTAURANT_WIDE,
  decideApproval,
  getApprovalDetail,
  getApprovalPolicy,
  whyCannotApprove,
  withdrawApproval,
} from './service'
import type { ApprovalDetailPayload } from './types'
import { approveTransfer, closeTransfer } from '@/features/transfers/service'

/**
 * Deciding an approval is gated on SETTINGS_MANAGE — in practice an owner or
 * admin. Deliberately not MANAGER: the point of the step is that someone above
 * the person who asked signs it off, and managers are frequently the ones
 * asking.
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
        // using it — an owner working the queue normally must still be
        // refused their own request, or the override stops being visible.
        force: z.boolean().optional(),
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
      const user = await requirePermission(PERMISSIONS.SETTINGS_MANAGE)

      /*
       * Whose request this is, before deciding it.
       *
       * This action scoped by restaurant alone, so a manager confined to one
       * branch could approve another branch's refund — the permission was
       * checked and the location never was. `assertRecordBranch` returns early
       * on a null branchId, so a restaurant-wide request stays decidable by
       * everyone who holds the permission.
       */
      const target = await prisma.approvalRequest.findFirst({
        where: { id: data.approvalId, restaurantId: user.restaurantId },
        select: { branchId: true },
      })
      await assertRecordBranch(user, target, 'approval request')

      const request = await decideApproval({
        restaurantId: user.restaurantId,
        approvalId: data.approvalId,
        approve: data.approve,
        userId: user.id,
        note: data.note || null,
        mayForce: can(user, PERMISSIONS.APPROVALS_FORCE),
        force: data.force,
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
          note: data.note || null,
          ...(request.forced ? { forced: true } : {}),
        },
      })

      await applyDecision(request, user, data.note || null)

      revalidatePath('/dashboard/approvals')
      revalidatePath('/dashboard/transfers')
      return { status: request.status }
    },
    'Decision recorded.',
  )
}

/**
 * Carry the decision through to the thing it was about.
 *
 * `ApprovalRequest.payload` is documented as "what to apply if approved", and
 * until now nothing applied anything — the row's status changed and the world
 * did not. For a stock transfer that would have meant the owner pressing
 * Approve and the transfer sitting exactly where it was, waiting for a second
 * approval from the branch, which is not what the owner just did.
 *
 * So the owner's decision IS the decision: approving moves the transfer to
 * APPROVED and reserves the source's stock; rejecting closes it with the
 * owner's note as the reason. The branch's own Approve button stays for
 * same-branch moves, which never reach this queue.
 *
 * Failures here are logged and swallowed deliberately. The decision has already
 * been recorded and audited; if reserving stock fails — someone emptied the
 * shelf while the request sat in the queue — the right outcome is a decided
 * request and a transfer that can be retried, not a 500 that loses the ruling.
 */
async function applyDecision(
  request: { id: string; kind: string; status: string; entity: string; entityId: string | null },
  user: { restaurantId: string; id: string; name: string },
  note: string | null,
) {
  if (request.kind !== 'STOCK_TRANSFER' || !request.entityId) return

  try {
    if (request.status === 'APPROVED') {
      await approveTransfer({
        restaurantId: user.restaurantId,
        transferId: request.entityId,
        userId: user.id,
      })
    } else if (request.status === 'REJECTED') {
      await closeTransfer({
        restaurantId: user.restaurantId,
        transferId: request.entityId,
        status: 'REJECTED',
        reason: note || 'Rejected by the owner',
        userId: user.id,
      })
    }
  } catch (error) {
    console.error(
      `[approvals] decision on ${request.id} recorded, but the transfer could not be moved:`,
      error,
    )
  }
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

      // A branch id from the client is a branch id like any other.
      if (data.branchId) {
        await assertBranchAccess(user, data.branchId)
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
            select: { id: true, name: true, role: true, permissions: true, staffRole: { select: { permissions: true, isActive: true } } },
          })
        : []

      if (staff.length !== unique.length) {
        throw new ForbiddenError('One of those people is not a member of your staff')
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

      const key = data.branchId || RESTAURANT_WIDE
      const policy = await getApprovalPolicy(user.restaurantId)
      const next = { ...(policy.approvers ?? {}), [key]: unique }

      await prisma.restaurant.update({
        where: { id: user.restaurantId },
        data: {
          approvalPolicy: {
            ...policy,
            approvers: next,
          } as unknown as Prisma.InputJsonValue,
        },
      })

      await audit({
        restaurantId: user.restaurantId,
        branchId: data.branchId || null,
        userId: user.id,
        actorName: user.name,
        action: AUDIT_ACTIONS.APPROVAL_ACCESS_SET,
        entity: 'Restaurant',
        entityId: user.restaurantId,
        before: { approvers: policy.approvers?.[key] ?? [] },
        after: { approvers: unique },
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
      const { request, history } = await getApprovalDetail({
        restaurantId: user.restaurantId,
        approvalId: data.approvalId,
      })
      await assertRecordBranch(user, { branchId: request.branchId }, 'approval request')

      const policy = await getApprovalPolicy(user.restaurantId)
      const mayForce = can(user, PERMISSIONS.APPROVALS_FORCE)
      /*
       * Why they cannot decide it NORMALLY — computed with `mayForce: false`
       * on purpose. The dialog needs to know there is a rule in the way even
       * when this viewer is allowed to override it, or the override button
       * has nothing to explain itself with.
       */
      const refusal = whyCannotApprove({
        policy,
        request,
        userId: user.id,
        mayForce: false,
      })

      const payload = (request.payload ?? {}) as Record<string, unknown>
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
        reference: request.entityId ? `${request.entity} ${request.entityId.slice(0, 8)}` : null,
        details,
        history: history.map((entry) => ({
          id: entry.id,
          action: entry.action,
          actorName: entry.actorName ?? 'Someone',
          createdAt: entry.createdAt.toISOString(),
          entity: entry.entity,
        })),
        blockedReason: refusal?.message ?? null,
        mayForce,
      }
    },
  )
}
