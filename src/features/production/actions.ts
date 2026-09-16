'use server'

import { revalidatePath } from 'next/cache'

import { runAction, type ActionResult } from '@/lib/action'
import { PERMISSIONS } from '@/lib/rbac'
import { AUDIT_ACTIONS, audit } from '@/server/audit'
import { assertBranchAccess, requirePermission } from '@/server/auth/guard'
import { NotFoundError } from '@/lib/errors'
import { prisma } from '@/server/db/prisma'
import {
  cancelBatchSchema,
  completeBatchSchema,
  produceItemSchema,
  startBatchSchema,
} from './schema'
import { cancelBatch, completeBatch, produceItem, startBatch } from './service'
import type { ProduceItemResult, StartBatchResult } from './types'

/**
 * Make a prepared item (redesignkitchenjob.md).
 *
 * The one action this feature has. Everything the old flow exposed — create a
 * job, start it, cancel it, preview it, edit a make-ahead recipe — went with
 * the flow; the cost preview is computed on the screen from the same figures
 * the transaction re-reads.
 */
export async function produceItemAction(input: unknown): Promise<ActionResult<ProduceItemResult>> {
  return runAction(
    produceItemSchema,
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.PRODUCTION_MANAGE)
      await assertBranchAccess(user, data.branchId)

      const result = await produceItem({
        restaurantId: user.restaurantId,
        branchId: data.branchId,
        userId: user.id,
        clientRequestId: data.clientRequestId,
        output: data.output,
        ingredients: data.ingredients,
        waste: data.waste,
        notes: data.notes,
      })

      // A replay recorded nothing new, so it audits nothing new either.
      if (!result.replayed) {
        if (result.item.isNew) {
          await audit({
            restaurantId: user.restaurantId,
            branchId: data.branchId,
            userId: user.id,
            actorName: user.name,
            action: AUDIT_ACTIONS.INVENTORY_PREPARED_ITEM_CREATED,
            entity: 'InventoryItem',
            entityId: result.item.id,
            after: { name: result.item.name, unit: result.item.unit },
          })
        }
        await audit({
          restaurantId: user.restaurantId,
          branchId: data.branchId,
          userId: user.id,
          actorName: user.name,
          action: AUDIT_ACTIONS.PRODUCTION_COMPLETED,
          entity: 'ProductionOrder',
          entityId: result.orderId,
          after: {
            number: result.number,
            item: result.item.name,
            quantity: result.producedQty,
            unit: result.item.unit,
            totalCost: result.totalValue,
            unitCost: result.unitCost,
            consumed: result.consumed.map((l) => ({ item: l.name, quantity: l.quantity, value: l.value })),
            wasted: result.wasted.map((l) => ({ item: l.name, quantity: l.quantity, value: l.value })),
          },
        })
      }

      revalidatePath('/dashboard/production')
      revalidatePath('/dashboard/inventory')
      return result
    },
    undefined,
    'produceItem',
  )
}

/**
 * Create a prepared item — start its batch (recorrection.md §3).
 *
 * Nothing is deducted and nothing is costed here — see `startBatch`. The
 * permission is the one Mark Done asks for, because creating the batch and
 * finishing it are the same authority exercised at two moments.
 */
export async function startBatchAction(
  input: unknown,
): Promise<ActionResult<StartBatchResult>> {
  return runAction(
    startBatchSchema,
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.PRODUCTION_MANAGE)
      await assertBranchAccess(user, data.branchId)

      const batch = await startBatch({
        restaurantId: user.restaurantId,
        branchId: data.branchId,
        userId: user.id,
        clientRequestId: data.clientRequestId,
        plan: {
          name: data.output.name,
          quantity: data.output.quantity,
          unit: data.output.unit,
          itemId: data.output.itemId ?? null,
          ingredients: data.ingredients,
          waste: data.waste,
        },
        notes: data.notes,
      })

      // A replay created nothing, so it audits nothing.
      if (!batch.replayed) {
        if (batch.item.isNew) {
          await audit({
            restaurantId: user.restaurantId,
            branchId: data.branchId,
            userId: user.id,
            actorName: user.name,
            action: AUDIT_ACTIONS.INVENTORY_PREPARED_ITEM_CREATED,
            entity: 'InventoryItem',
            entityId: batch.item.id,
            after: { name: batch.item.name, unit: batch.item.unit },
          })
        }
        await audit({
          restaurantId: user.restaurantId,
          branchId: data.branchId,
          userId: user.id,
          actorName: user.name,
          action: AUDIT_ACTIONS.PRODUCTION_STARTED,
          entity: 'ProductionOrder',
          entityId: batch.id,
          after: {
            number: batch.number,
            item: batch.item.name,
            planned: data.output.quantity,
            unit: data.output.unit,
          },
        })
      }

      revalidatePath('/dashboard/production')
      revalidatePath('/dashboard/inventory')
      return batch
    },
    'Prepared item created.',
  )
}

/**
 * Mark a batch done, with the yield that actually came out.
 *
 * This is where the stock finally moves — through the same atomic transaction
 * the one-step flow uses, against the batch's own reference number.
 */
export async function completeBatchAction(
  input: unknown,
): Promise<ActionResult<ProduceItemResult>> {
  return runAction(
    completeBatchSchema,
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.PRODUCTION_MANAGE)

      /*
       * The batch's own branch decides, not one posted alongside. Reading the
       * row first and checking THAT is what stops somebody finishing another
       * location's batch by knowing its id.
       */
      const batch = await prisma.productionOrder.findFirst({
        where: { id: data.batchId, restaurantId: user.restaurantId },
        select: { branchId: true },
      })
      if (!batch) throw new NotFoundError('Batch')
      await assertBranchAccess(user, batch.branchId)

      const result = await completeBatch({
        restaurantId: user.restaurantId,
        batchId: data.batchId,
        userId: user.id,
        clientRequestId: data.clientRequestId,
        actualQuantity: data.actualQuantity,
        varianceReason: data.varianceReason ?? null,
        varianceNote: data.varianceNote,
        notes: data.notes,
      })

      if (!result.replayed) {
        await audit({
          restaurantId: user.restaurantId,
          branchId: batch.branchId,
          userId: user.id,
          actorName: user.name,
          action: AUDIT_ACTIONS.PRODUCTION_COMPLETED,
          entity: 'ProductionOrder',
          entityId: result.orderId,
          after: {
            number: result.number,
            actual: data.actualQuantity,
            reason: data.varianceReason ?? null,
          },
        })
      }

      revalidatePath('/dashboard/production')
      revalidatePath('/dashboard/inventory')
      return result
    },
    'Batch finished.',
  )
}

export async function cancelBatchAction(input: unknown): Promise<ActionResult<{ ok: true }>> {
  return runAction(
    cancelBatchSchema,
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.PRODUCTION_MANAGE)
      const batch = await prisma.productionOrder.findFirst({
        where: { id: data.batchId, restaurantId: user.restaurantId },
        select: { branchId: true, number: true },
      })
      if (!batch) throw new NotFoundError('Batch')
      await assertBranchAccess(user, batch.branchId)

      await cancelBatch({ restaurantId: user.restaurantId, batchId: data.batchId })

      await audit({
        restaurantId: user.restaurantId,
        branchId: batch.branchId,
        userId: user.id,
        actorName: user.name,
        action: AUDIT_ACTIONS.PRODUCTION_CANCELLED,
        entity: 'ProductionOrder',
        entityId: data.batchId,
        after: { number: batch.number },
      })

      revalidatePath('/dashboard/production')
      return { ok: true as const }
    },
    'Batch cancelled.',
  )
}
