'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'

import { runAction, runSafe, type ActionResult } from '@/lib/action'
import { PERMISSIONS } from '@/lib/rbac'
import { AUDIT_ACTIONS, audit } from '@/server/audit'
import { assertRecordBranch, requirePermission } from '@/server/auth/guard'
import { prisma } from '@/server/db/prisma'
import { decideApproval, withdrawApproval } from './service'
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
      })
      await audit({
        restaurantId: user.restaurantId, branchId: request.branchId, userId: user.id,
        actorName: user.name, action: AUDIT_ACTIONS.APPROVAL_DECIDED,
        entity: 'ApprovalRequest', entityId: request.id,
        // Old status and new, because §4 asks the log to answer what changed
        // and not merely what it ended up as.
        before: { status: request.previousStatus },
        after: { status: request.status, kind: request.kind, note: data.note || null },
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
    const user = await requirePermission(PERMISSIONS.DASHBOARD_VIEW)
    const request = await withdrawApproval({
      restaurantId: user.restaurantId,
      approvalId,
      userId: user.id,
    })
    revalidatePath('/dashboard/approvals')
    return { status: request.status }
  })
}
