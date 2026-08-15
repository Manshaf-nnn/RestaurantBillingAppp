'use server'

import { revalidatePath } from 'next/cache'

import { runAction, type ActionResult } from '@/lib/action'
import { PERMISSIONS } from '@/lib/rbac'
import { AUDIT_ACTIONS, audit } from '@/server/audit'
import { requirePermission } from '@/server/auth/guard'
import { realtime } from '@/server/realtime/emitter'
import { toOrderPayload } from '@/features/orders/service'
import { holdBillSchema, mergeBillsSchema, resumeBillSchema, splitBillSchema } from './schema'
import { holdBill, mergeBills, resumeBill, splitBill } from './service'

/** Counter screens that must reflect a bill moving. */
function revalidateCounter() {
  revalidatePath('/cashier')
  revalidatePath('/dashboard/orders')
  revalidatePath('/waiter')
}

/** Push the updated bill to every station watching it. */
async function broadcast(orderId: string, restaurantId: string) {
  const payload = await toOrderPayload(orderId)
  if (payload) realtime.orderUpdated(restaurantId, payload)
}

export async function holdBillAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction(
    holdBillSchema,
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.PAYMENT_COLLECT)

      const order = await holdBill({
        restaurantId: user.restaurantId,
        orderId: data.orderId,
        reason: data.reason || null,
        actorId: user.id,
        actorName: user.name,
      })

      await audit({
        restaurantId: user.restaurantId,
        userId: user.id,
        actorName: user.name,
        action: AUDIT_ACTIONS.ORDER_HELD,
        entity: 'Order',
        entityId: order.id,
        after: { orderNumber: order.orderNumber, reason: data.reason || null },
      })

      await broadcast(order.id, user.restaurantId)
      revalidateCounter()
      return { id: order.id }
    },
    'Bill held.',
  )
}

export async function resumeBillAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction(
    resumeBillSchema,
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.PAYMENT_COLLECT)

      const order = await resumeBill({
        restaurantId: user.restaurantId,
        orderId: data.orderId,
        actorId: user.id,
        actorName: user.name,
      })

      await audit({
        restaurantId: user.restaurantId,
        userId: user.id,
        actorName: user.name,
        action: AUDIT_ACTIONS.ORDER_RESUMED,
        entity: 'Order',
        entityId: order.id,
        after: { orderNumber: order.orderNumber },
      })

      await broadcast(order.id, user.restaurantId)
      revalidateCounter()
      return { id: order.id }
    },
    'Bill resumed.',
  )
}

export async function splitBillAction(
  input: unknown,
): Promise<ActionResult<{ sourceId: string; targetId: string; targetNumber: string }>> {
  return runAction(
    splitBillSchema,
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.PAYMENT_COLLECT)

      const { source, target } = await splitBill({
        restaurantId: user.restaurantId,
        orderId: data.orderId,
        selections: data.selections,
        actorId: user.id,
        actorName: user.name,
      })

      await audit({
        restaurantId: user.restaurantId,
        userId: user.id,
        actorName: user.name,
        action: AUDIT_ACTIONS.ORDER_SPLIT,
        entity: 'Order',
        entityId: source.id,
        before: { orderNumber: source.orderNumber },
        after: { splitInto: target.orderNumber, movedLines: data.selections.length },
      })

      await broadcast(source.id, user.restaurantId)
      await broadcast(target.id, user.restaurantId)
      revalidateCounter()

      return { sourceId: source.id, targetId: target.id, targetNumber: target.orderNumber }
    },
    'Bill split.',
  )
}

export async function mergeBillsAction(
  input: unknown,
): Promise<ActionResult<{ targetId: string; targetNumber: string }>> {
  return runAction(
    mergeBillsSchema,
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.PAYMENT_COLLECT)

      const target = await mergeBills({
        restaurantId: user.restaurantId,
        targetId: data.targetId,
        sourceIds: data.sourceIds,
        actorId: user.id,
        actorName: user.name,
      })

      await audit({
        restaurantId: user.restaurantId,
        userId: user.id,
        actorName: user.name,
        action: AUDIT_ACTIONS.ORDER_MERGED,
        entity: 'Order',
        entityId: target.id,
        after: { orderNumber: target.orderNumber, merged: data.sourceIds.length },
      })

      await broadcast(target.id, user.restaurantId)
      for (const id of data.sourceIds) await broadcast(id, user.restaurantId)
      revalidateCounter()

      return { targetId: target.id, targetNumber: target.orderNumber }
    },
    'Bills merged.',
  )
}
