'use server'

import { revalidatePath } from 'next/cache'

import { runAction, type ActionResult } from '@/lib/action'
import { PERMISSIONS } from '@/lib/rbac'
import { AUDIT_ACTIONS, audit } from '@/server/audit'
import { assertRecordBranch, requirePermission } from '@/server/auth/guard'
import { prisma } from '@/server/db/prisma'
import { realtime } from '@/server/realtime/emitter'
import { toOrderPayload } from '@/features/orders/service'
import {
  acceptGuestOrderSchema,
  holdBillSchema,
  mergeBillsSchema,
  rejectGuestOrderSchema,
  resumeBillSchema,
  splitBillSchema,
  voidItemSchema,
} from './schema'
import {
  acceptGuestOrder,
  holdBill,
  mergeBills,
  rejectGuestOrder,
  resumeBill,
  splitBill,
  voidOrderItem,
} from './service'

/*
 * Whose shelves and whose till a bill belongs to.
 *
 * These five actions move money and stock between bills, and none of them
 * asked WHERE the bill lives — a cashier scoped to one branch could hold,
 * split, merge or void another branch's bills by id. Every other order action
 * already pins the record's branch; these are the same check, fail-closed.
 */
async function assertBillBranch(
  user: Parameters<typeof assertRecordBranch>[0],
  restaurantId: string,
  orderId: string,
): Promise<void> {
  const order = await prisma.order.findFirst({
    where: { id: orderId, restaurantId },
    select: { branchId: true },
  })
  await assertRecordBranch(user, order, 'order')
}

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
      await assertBillBranch(user, user.restaurantId, data.orderId)

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
      await assertBillBranch(user, user.restaurantId, data.orderId)

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
      await assertBillBranch(user, user.restaurantId, data.orderId)

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
      // Every bill in the merge, both directions — absorbing an out-of-branch
      // bill and feeding one into another branch's till are the same leak.
      await assertBillBranch(user, user.restaurantId, data.targetId)
      for (const sourceId of data.sourceIds) {
        await assertBillBranch(user, user.restaurantId, sourceId)
      }

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


/**
 * Void one line on an open bill.
 *
 * Gated on ORDER_CANCEL rather than PAYMENT_COLLECT: removing a dish a guest is
 * no longer being charged for is the same class of authority as cancelling the
 * bill, and is not something every cashier should be able to do unsupervised.
 */
export async function voidItemAction(
  input: unknown,
): Promise<ActionResult<{ orderId: string; grandTotal: number }>> {
  return runAction(
    voidItemSchema,
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.ORDER_CANCEL)
      await assertBillBranch(user, user.restaurantId, data.orderId)

      const { order, itemName, lineTotal } = await voidOrderItem({
        restaurantId: user.restaurantId,
        orderId: data.orderId,
        itemId: data.itemId,
        reason: data.reason,
        actorId: user.id,
        actorName: user.name,
      })

      await audit({
        restaurantId: user.restaurantId,
        userId: user.id,
        actorName: user.name,
        action: AUDIT_ACTIONS.ORDER_ITEM_VOIDED,
        entity: 'OrderItem',
        entityId: data.itemId,
        before: { name: itemName, lineTotal },
        after: { reason: data.reason, orderId: data.orderId, grandTotal: order.grandTotal },
      })

      revalidateCounter()
      await broadcast(order.id, user.restaurantId)
      return { orderId: order.id, grandTotal: order.grandTotal }
    },
    'Item voided.',
  )
}

// ── QR / online orders wait at the till (abc.md §5) ─────────────────────────

/**
 * Accept a guest order at the till.
 *
 * Gated on ORDER_ACCEPT — split from PAYMENT_COLLECT, so whoever takes money
 * has it and the kitchen and waiters (who hold ORDER_UPDATE_STATUS) do not.
 * The service opens the one gate `updateOrderStatus` has for a pending guest
 * order; from there the order is the kitchen's like any other.
 */
export async function acceptGuestOrderAction(
  input: unknown,
): Promise<ActionResult<{ id: string; orderNumber: string; status: string }>> {
  return runAction(
    acceptGuestOrderSchema,
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.ORDER_ACCEPT)
      await assertBillBranch(user, user.restaurantId, data.orderId)

      const { order, routed } = await acceptGuestOrder({
        restaurantId: user.restaurantId,
        orderId: data.orderId,
        actorId: user.id,
        actorName: user.name,
      })

      await audit({
        restaurantId: user.restaurantId,
        branchId: order.branchId,
        userId: user.id,
        actorName: user.name,
        action: AUDIT_ACTIONS.ORDER_ACCEPTED_AT_TILL,
        entity: 'Order',
        entityId: order.id,
        after: { number: order.orderNumber, channel: order.channel, routed },
      })

      revalidatePath('/cashier')
      revalidatePath('/cashier/pos')
      revalidatePath('/kitchen')
      revalidatePath('/waiter')
      revalidatePath('/dashboard/orders')
      return { id: order.id, orderNumber: order.orderNumber, status: order.status }
    },
    'Order accepted — sent to the kitchen.',
  )
}

/** Turn a guest order away at the till. A reason is required; the guest reads it. */
export async function rejectGuestOrderAction(
  input: unknown,
): Promise<ActionResult<{ id: string; orderNumber: string }>> {
  return runAction(
    rejectGuestOrderSchema,
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.ORDER_ACCEPT)
      await assertBillBranch(user, user.restaurantId, data.orderId)

      const order = await rejectGuestOrder({
        restaurantId: user.restaurantId,
        orderId: data.orderId,
        reason: data.reason,
        actorId: user.id,
        actorName: user.name,
      })

      await audit({
        restaurantId: user.restaurantId,
        branchId: order.branchId,
        userId: user.id,
        actorName: user.name,
        action: AUDIT_ACTIONS.ORDER_CANCELLED,
        entity: 'Order',
        entityId: order.id,
        after: { number: order.orderNumber, channel: order.channel, reason: data.reason, rejectedAtTill: true },
      })

      revalidatePath('/cashier')
      revalidatePath('/cashier/pos')
      revalidatePath('/dashboard/orders')
      return { id: order.id, orderNumber: order.orderNumber }
    },
    'Order rejected.',
  )
}
