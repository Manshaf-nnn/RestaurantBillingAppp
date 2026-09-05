'use server'

import { revalidatePath } from 'next/cache'

import { runAction, type ActionResult } from '@/lib/action'
import { PERMISSIONS } from '@/lib/rbac'
import { AUDIT_ACTIONS, audit } from '@/server/audit'
import { assertBranchAccess, requirePermission } from '@/server/auth/guard'
import { produceItemSchema } from './schema'
import { produceItem } from './service'
import type { ProduceItemResult } from './types'

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
