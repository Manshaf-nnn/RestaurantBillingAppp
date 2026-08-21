'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'

import { runAction, runSafe, type ActionResult } from '@/lib/action'
import { PERMISSIONS } from '@/lib/rbac'
import { AUDIT_ACTIONS, audit } from '@/server/audit'
import { requirePermission } from '@/server/auth/guard'
import { decideApproval, withdrawApproval } from './service'

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
    z.object({
      approvalId: z.string().min(1),
      approve: z.boolean(),
      note: z.string().trim().max(200).optional().or(z.literal('')),
    }),
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.SETTINGS_MANAGE)
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
        after: { status: request.status, kind: request.kind, note: data.note || null },
      })
      revalidatePath('/dashboard/approvals')
      return { status: request.status }
    },
    'Decision recorded.',
  )
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
