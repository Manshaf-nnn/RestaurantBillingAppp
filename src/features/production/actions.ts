'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'

import { runAction, type ActionResult } from '@/lib/action'
import { PERMISSIONS } from '@/lib/rbac'
import { AUDIT_ACTIONS, audit } from '@/server/audit'
import { assertBranchAccess, requirePermission } from '@/server/auth/guard'
import {
  completeProduction, createProductionOrder, createProductionSpec, setProductionStatus,
} from './service'

const UNITS = ['KG', 'GRAM', 'LITRE', 'ML', 'PIECE', 'PACK', 'BOTTLE', 'DOZEN', 'BOX'] as const
const REASONS = ['PRODUCTION_LOSS', 'DAMAGED', 'INGREDIENT_SHORTAGE', 'QUALITY_ISSUE', 'OTHER'] as const

/** Define what one batch consumes and produces. */
export async function createProductionSpecAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction(
    z.object({
      name: z.string().trim().min(2, 'Name the recipe').max(80),
      outputItemId: z.string().min(1, 'Choose what it produces'),
      outputQty: z.coerce.number().positive('One batch must produce more than zero'),
      shelfLifeDays: z.coerce.number().int().min(0).max(3650).optional(),
      items: z.array(z.object({
        itemId: z.string().min(1),
        quantity: z.coerce.number().positive(),
        unit: z.enum(UNITS).optional(),
      })).min(1, 'Add at least one raw material'),
    }),
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.PRODUCTION_MANAGE)
      const spec = await createProductionSpec({ restaurantId: user.restaurantId, ...data })
      revalidatePath('/dashboard/production')
      return { id: spec.id }
    },
    'Production recipe saved.',
  )
}

export async function createProductionOrderAction(
  input: unknown,
): Promise<ActionResult<{ id: string; number: string }>> {
  return runAction(
    z.object({
      branchId: z.string().min(1, 'Choose the production house'),
      specId: z.string().min(1, 'Choose what to make'),
      plannedQty: z.coerce.number().positive('Plan at least one batch'),
      notes: z.string().trim().max(300).optional().or(z.literal('')),
    }),
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.PRODUCTION_MANAGE)
      await assertBranchAccess(user, data.branchId)
      const order = await createProductionOrder({
        restaurantId: user.restaurantId, branchId: data.branchId, specId: data.specId,
        plannedQty: data.plannedQty, notes: data.notes || null, userId: user.id,
      })
      await audit({
        restaurantId: user.restaurantId, branchId: data.branchId, userId: user.id, actorName: user.name,
        action: AUDIT_ACTIONS.PRODUCTION_CREATED, entity: 'ProductionOrder', entityId: order.id,
        after: { number: order.number, planned: data.plannedQty },
      })
      revalidatePath('/dashboard/production')
      return { id: order.id, number: order.number }
    },
    'Production run created.',
  )
}

export async function setProductionStatusAction(input: unknown): Promise<ActionResult<{ status: string }>> {
  return runAction(
    z.object({
      orderId: z.string().min(1),
      status: z.enum(['PLANNED', 'APPROVED', 'IN_PROGRESS', 'CANCELLED']),
    }),
    input,
    async (data) => {
      // Approving commits ingredients; a separate permission from planning.
      const needed = data.status === 'APPROVED' ? PERMISSIONS.PRODUCTION_APPROVE : PERMISSIONS.PRODUCTION_MANAGE
      const user = await requirePermission(needed)
      const order = await setProductionStatus({
        restaurantId: user.restaurantId, orderId: data.orderId, status: data.status, userId: user.id,
      })
      revalidatePath('/dashboard/production')
      return { status: order.status }
    },
    'Run updated.',
  )
}

/**
 * Finish a run: raw materials leave, finished goods appear, cost is worked out.
 * The only step here that moves stock.
 */
export async function completeProductionAction(
  input: unknown,
): Promise<ActionResult<{ produced: number; unitCost: number; variance: number }>> {
  return runAction(
    z.object({
      orderId: z.string().min(1),
      actualQty: z.coerce.number().min(0),
      varianceReason: z.enum(REASONS).optional(),
      varianceNote: z.string().trim().max(200).optional().or(z.literal('')),
      batchNumber: z.string().trim().max(60).optional().or(z.literal('')),
    }),
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.PRODUCTION_MANAGE)
      const result = await completeProduction({
        restaurantId: user.restaurantId, orderId: data.orderId, actualQty: data.actualQty,
        varianceReason: data.varianceReason ?? null, varianceNote: data.varianceNote || null,
        batchNumber: data.batchNumber || null, userId: user.id,
      })
      await audit({
        restaurantId: user.restaurantId, userId: user.id, actorName: user.name,
        action: AUDIT_ACTIONS.PRODUCTION_COMPLETED, entity: 'ProductionOrder', entityId: data.orderId,
        after: {
          produced: result.producedQty, cost: result.totalCost,
          unitCost: result.unitCost, variance: result.variance, batch: result.batchNumber,
        },
      })
      revalidatePath('/dashboard/production')
      revalidatePath('/dashboard/inventory')
      return { produced: result.producedQty, unitCost: result.unitCost, variance: result.variance }
    },
    'Production complete — stock updated.',
  )
}
