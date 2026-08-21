'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'

import { runAction, type ActionResult } from '@/lib/action'
import { PERMISSIONS } from '@/lib/rbac'
import { resolveStockLocation } from '@/features/branches/service'
import { AUDIT_ACTIONS, audit } from '@/server/audit'
import { assertBranchAccess, requirePermission } from '@/server/auth/guard'
import { recordWastage, reviewWastage } from './wastage'

const UNITS = ['KG', 'GRAM', 'LITRE', 'ML', 'PIECE', 'PACK', 'BOTTLE', 'DOZEN', 'BOX'] as const
const REASONS = [
  'EXPIRED', 'SPOILED', 'BURNT', 'DAMAGED', 'DROPPED',
  'PREPARATION', 'CUSTOMER_RETURN', 'OTHER',
] as const

/*
 * Not exported. A 'use server' module may only export async functions — Next
 * turns every export into a callable server reference, and a Zod object is not
 * callable. Exporting this threw "A 'use server' file can only export async
 * functions, found object" on the FIRST call into the module, so every action
 * in this file failed with a bare digest and nothing was ever written.
 */
const wastageSchema = z.object({
  itemId: z.string().min(1, 'Choose an item'),
  quantity: z.coerce.number().positive('Quantity must be more than zero').max(1_000_000),
  unit: z.enum(UNITS).optional(),
  reason: z.enum(REASONS),
  reasonNote: z.string().trim().max(200).optional().or(z.literal('')),
  notes: z.string().trim().max(300).optional().or(z.literal('')),
  photoUrl: z.string().trim().max(400).optional().or(z.literal('')),
  branchId: z.string().min(1).optional().or(z.literal('')),
  locationId: z.string().min(1).optional().or(z.literal('')),
  batchId: z.string().min(1).optional().or(z.literal('')),
})

/**
 * Record wastage.
 *
 * Gated on INVENTORY_WASTAGE, which kitchen staff hold — the person who burnt
 * the tray is the person who should write it down, while they still remember
 * why. Approving it is a different permission held by managers.
 */
export async function recordWastageAction(
  input: unknown,
): Promise<ActionResult<{ id: string; costValue: number }>> {
  return runAction(wastageSchema, input, async (data) => {
    const user = await requirePermission(PERMISSIONS.INVENTORY_WASTAGE)
    await assertBranchAccess(user, data.branchId || null)

    const record = await recordWastage({
      restaurantId: user.restaurantId,
      itemId: data.itemId,
      quantity: data.quantity,
      unit: data.unit,
      reason: data.reason,
      reasonNote: data.reasonNote || null,
      notes: data.notes || null,
      photoUrl: data.photoUrl || null,
      branchId: await resolveStockLocation({
        restaurantId: user.restaurantId,
        requestedBranchId: data.branchId,
        userBranchId: user.branchId,
      }),
      locationId: data.locationId || null,
      batchId: data.batchId || null,
      userId: user.id,
    })

    await audit({
      restaurantId: user.restaurantId, userId: user.id, actorName: user.name,
      action: AUDIT_ACTIONS.STOCK_WASTAGE, entity: 'WastageRecord', entityId: record.id,
      after: {
        itemId: data.itemId, quantity: record.quantity,
        reason: data.reason, value: record.costValue,
      },
    })

    revalidatePath('/dashboard/inventory/wastage')
    revalidatePath('/dashboard/inventory')
    return { id: record.id, costValue: record.costValue }
  }, 'Wastage recorded.')
}

export async function reviewWastageAction(
  input: unknown,
): Promise<ActionResult<{ status: string }>> {
  return runAction(
    z.object({
      wastageId: z.string().min(1),
      approve: z.boolean(),
      note: z.string().trim().max(200).optional().or(z.literal('')),
    }),
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.INVENTORY_WASTAGE_APPROVE)
      const record = await reviewWastage({
        restaurantId: user.restaurantId,
        wastageId: data.wastageId,
        approve: data.approve,
        userId: user.id,
        note: data.note || null,
      })
      await audit({
        restaurantId: user.restaurantId, userId: user.id, actorName: user.name,
        action: AUDIT_ACTIONS.STOCK_WASTAGE, entity: 'WastageRecord', entityId: record.id,
        after: { status: record.status, note: data.note || null },
      })
      revalidatePath('/dashboard/inventory/wastage')
      return { status: record.status }
    },
    'Reviewed.',
  )
}
