'use server'

import { revalidatePath } from 'next/cache'

import { runAction, type ActionResult } from '@/lib/action'
import { PERMISSIONS } from '@/lib/rbac'
import { AUDIT_ACTIONS, audit } from '@/server/audit'
import { assertBranchAccess, requirePermission } from '@/server/auth/guard'
import { AppError, NotFoundError } from '@/lib/errors'
import { cancelOrder, updateOrderStatus } from '@/features/orders/service'
import { prisma } from '@/server/db/prisma'
import { planRouting } from './routing'
import {
  acceptOrderSchema,
  rejectOrderSchema,
  assignAllDishesSchema,
  reassignItemSchema,
  setOrderPrioritySchema,
  deleteStationSchema,
  saveStationSchema,
  setStationActiveSchema,
} from './schema'
import {
  assignAllDishesToStation,
  deleteStation,
  requireStation,
  saveStation,
  setStationActive,
} from './service'

/** Create or edit a kitchen section, and say who works it. */
export async function saveStationAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction(
    saveStationSchema,
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.KITCHEN_STATION_MANAGE)
      // A section belongs to a location, so managing one is managing that
      // location — the permission alone never asked which.
      await assertBranchAccess(user, data.branchId)

      const station = await saveStation({
        restaurantId: user.restaurantId,
        stationId: data.stationId,
        branchId: data.branchId,
        name: data.name,
        description: data.description || null,
        printerName: data.printerName || null,
        sortOrder: data.sortOrder,
        staffIds: data.staffIds,
      })

      await audit({
        restaurantId: user.restaurantId,
        branchId: data.branchId,
        userId: user.id,
        actorName: user.name,
        action: AUDIT_ACTIONS.KITCHEN_STATION_SAVED,
        entity: 'KitchenStation',
        entityId: station.id,
        after: { name: station.name, staff: data.staffIds.length },
      })

      revalidatePath(`/dashboard/locations/${data.branchId}/kitchen-stations`)
      revalidatePath('/kitchen')
      return { id: station.id }
    },
    'Section saved.',
  )
}

/** Retire a section, or bring it back. Never deletes — old tickets point at it. */
export async function setStationActiveAction(
  input: unknown,
): Promise<ActionResult<{ id: string; isActive: boolean }>> {
  return runAction(
    setStationActiveSchema,
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.KITCHEN_STATION_MANAGE)
      const existing = await requireStation({
        restaurantId: user.restaurantId,
        stationId: data.stationId,
      })
      await assertBranchAccess(user, existing.branchId)

      const station = await setStationActive({
        restaurantId: user.restaurantId,
        stationId: data.stationId,
        isActive: data.isActive,
      })

      await audit({
        restaurantId: user.restaurantId,
        branchId: station.branchId,
        userId: user.id,
        actorName: user.name,
        action: AUDIT_ACTIONS.KITCHEN_STATION_RETIRED,
        entity: 'KitchenStation',
        entityId: station.id,
        before: { isActive: existing.isActive },
        after: { isActive: station.isActive },
      })

      revalidatePath(`/dashboard/locations/${station.branchId}/kitchen-stations`)
      revalidatePath('/kitchen')
      return { id: station.id, isActive: station.isActive }
    },
    'Section updated.',
  )
}

/** Remove a section that has never cooked anything. */
export async function deleteStationAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction(
    deleteStationSchema,
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.KITCHEN_STATION_MANAGE)
      const station = await requireStation({
        restaurantId: user.restaurantId,
        stationId: data.stationId,
      })
      await assertBranchAccess(user, station.branchId)

      await deleteStation({ restaurantId: user.restaurantId, stationId: data.stationId })

      revalidatePath(`/dashboard/locations/${station.branchId}/kitchen-stations`)
      return { id: data.stationId }
    },
    'Section removed.',
  )
}

/**
 * Send this branch's whole menu to one section.
 *
 * The switch-on shortcut. Creating a first section makes every dish unmapped at
 * once, and an unmapped dish stops the kitchen accepting the order it is on —
 * so without this the feature is unusable the moment it is turned on.
 */
export async function assignAllDishesAction(
  input: unknown,
): Promise<ActionResult<{ count: number }>> {
  return runAction(
    assignAllDishesSchema,
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.KITCHEN_STATION_MANAGE)
      const station = await requireStation({
        restaurantId: user.restaurantId,
        stationId: data.stationId,
      })
      await assertBranchAccess(user, station.branchId)

      const count = await assignAllDishesToStation({
        restaurantId: user.restaurantId,
        stationId: data.stationId,
        onlyUnassigned: data.onlyUnassigned,
      })

      revalidatePath(`/dashboard/locations/${station.branchId}/kitchen-stations`)
      revalidatePath('/dashboard/menu')
      return { count }
    },
    'Dishes assigned.',
  )
}

/**
 * Take an order onto the kitchen's books.
 *
 * ── Why the refusal lives here and not in the routing ───────────────────────
 *
 * §16 says an order must not be accepted while a dish on it has no section, and
 * that the message must name the dish. `routeOrderItems` cannot do that: it runs
 * inside `updateOrderStatus`, which has no user, no permission layer and no way
 * to put a sentence in front of anybody. So the check is here, it reads before
 * it writes, and only once it passes does the status flip.
 *
 * That order matters. Validating after the write would leave an order ACCEPTED
 * with items on no screen — the one state this feature must never reach.
 *
 * The kitchen queue shows the same warning on the ticket itself, so in practice
 * this refusal is the backstop rather than how anybody finds out.
 */
export async function acceptOrderAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction(
    acceptOrderSchema,
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.KITCHEN_ACCEPT)

      const order = await prisma.order.findFirst({
        where: { id: data.orderId, restaurantId: user.restaurantId },
        select: { id: true, branchId: true, status: true, orderNumber: true },
      })
      if (!order) throw new AppError('That order no longer exists', 404, 'ORDER_NOT_FOUND')
      await assertBranchAccess(user, order.branchId)

      if (order.status !== 'PENDING') {
        throw new AppError(
          `${order.orderNumber} has already been taken on`,
          409,
          'ORDER_ALREADY_ACCEPTED',
        )
      }

      // Read first. Nothing has been written at this point.
      const plan = await planRouting(prisma, {
        restaurantId: user.restaurantId,
        orderId: order.id,
      })
      if (plan.unmapped.length > 0) {
        const names = [...new Set(plan.unmapped.map((row) => row.name))]
        const list = names.slice(0, 3).join(', ')
        const rest = names.length > 3 ? ` and ${names.length - 3} more` : ''
        throw new AppError(
          `${list}${rest} ${names.length === 1 ? 'is' : 'are'} not assigned to a kitchen section here — set that on the menu first`,
          400,
          'ITEM_NO_STATION',
        )
      }

      await updateOrderStatus({
        restaurantId: user.restaurantId,
        orderId: order.id,
        status: 'ACCEPTED',
        actorId: user.id,
        actorName: user.name,
      })

      await audit({
        restaurantId: user.restaurantId,
        branchId: order.branchId,
        userId: user.id,
        actorName: user.name,
        action: AUDIT_ACTIONS.KITCHEN_ORDER_ACCEPTED,
        entity: 'Order',
        entityId: order.id,
        after: { number: order.orderNumber, routed: plan.assignments.length },
      })

      revalidatePath('/kitchen')
      return { id: order.id }
    },
    'Order accepted.',
  )
}

/**
 * Move a pending dish to a different section.
 *
 * ── Why this exists at all ──────────────────────────────────────────────────
 *
 * Routing is automatic and should stay that way. But an oven fails, a section
 * is swamped, somebody calls in sick — and §18 asks for a way out that is
 * controlled rather than a silent reroute to whatever is nearby. Every use is
 * written to the audit log with where it came from, where it went and why.
 *
 * Only before it is cooked. Once a dish is READY it has been made at the
 * section that made it, and rewriting that would put a lie in the reports.
 */
/**
 * Turn an order away, before the kitchen has taken it on.
 *
 * The reject button used to send `updateOrderStatus(CANCELLED)`, which skipped
 * everything `cancelOrder` exists for — no reason recorded, coupons and
 * loyalty never given back, the table never freed. Cancellation has exactly
 * one entry point now, and this is the kitchen's door to it.
 *
 * Gated by KITCHEN_ACCEPT — rejecting is the other half of accepting — and
 * only while the order is still PENDING. Once taken on, food is being cooked
 * and money may be moving: taking it off the books becomes a management
 * cancellation from the orders screen, with their permission and their reason.
 */
export async function rejectOrderAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction(
    rejectOrderSchema,
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.KITCHEN_ACCEPT)

      const order = await prisma.order.findFirst({
        where: { id: data.orderId, restaurantId: user.restaurantId },
        select: { id: true, branchId: true, status: true, orderNumber: true },
      })
      if (!order) throw new AppError('That order no longer exists', 404, 'ORDER_NOT_FOUND')
      await assertBranchAccess(user, order.branchId)

      if (order.status !== 'PENDING') {
        throw new AppError(
          `${order.orderNumber} has already been taken on — it can only be cancelled from the orders screen`,
          409,
          'ORDER_ALREADY_ACCEPTED',
        )
      }

      const reason = data.reason?.trim() || 'Rejected by the kitchen'
      await cancelOrder({
        restaurantId: user.restaurantId,
        orderId: order.id,
        reason,
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
        after: { number: order.orderNumber, reason },
      })

      revalidatePath('/kitchen')
      revalidatePath('/dashboard/orders')
      return { id: order.id }
    },
    'Order rejected.',
  )
}

export async function reassignItemAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction(
    reassignItemSchema,
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.KITCHEN_REASSIGN)

      const item = await prisma.orderItem.findFirst({
        where: { id: data.itemId, order: { restaurantId: user.restaurantId } },
        select: {
          id: true, name: true, status: true, stationId: true, stationName: true,
          order: { select: { id: true, branchId: true, orderNumber: true } },
        },
      })
      if (!item) throw new AppError('That item no longer exists', 404, 'ITEM_NOT_FOUND')
      await assertBranchAccess(user, item.order.branchId)

      if (item.status !== 'QUEUED' && item.status !== 'PREPARING') {
        throw new AppError(
          `${item.name} is already ${item.status.toLowerCase()} — it cannot be moved now`,
          409,
          'ITEM_NOT_MOVABLE',
        )
      }

      // The destination must be a live section at the SAME branch. Without this
      // an id from the URL could push a dish onto another site's screen.
      const target = await prisma.kitchenStation.findFirst({
        where: {
          id: data.stationId,
          restaurantId: user.restaurantId,
          branchId: item.order.branchId,
          isActive: true,
        },
        select: { id: true, name: true },
      })
      if (!target) throw new NotFoundError('Kitchen section')

      await prisma.orderItem.update({
        where: { id: item.id },
        data: { stationId: target.id, stationName: target.name },
      })

      await audit({
        restaurantId: user.restaurantId,
        branchId: item.order.branchId,
        userId: user.id,
        actorName: user.name,
        action: AUDIT_ACTIONS.KITCHEN_ITEM_REASSIGNED,
        entity: 'OrderItem',
        entityId: item.id,
        before: { station: item.stationName, stationId: item.stationId },
        after: {
          station: target.name,
          stationId: target.id,
          order: item.order.orderNumber,
          dish: item.name,
          reason: data.reason || null,
        },
      })

      revalidatePath('/kitchen')
      return { id: item.id }
    },
    'Moved.',
  )
}

/**
 * Mark an order urgent, or put it back to normal.
 *
 * Sections sort by priority before waiting time, so this jumps a table up every
 * screen at once rather than needing to be said to each section in turn. Logged
 * with the previous value, because "who marked this urgent and why" is the
 * question somebody asks afterwards.
 */
export async function setOrderPriorityAction(
  input: unknown,
): Promise<ActionResult<{ id: string; priority: string }>> {
  return runAction(
    setOrderPrioritySchema,
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.KITCHEN_ACCEPT)

      const order = await prisma.order.findFirst({
        where: { id: data.orderId, restaurantId: user.restaurantId },
        select: { id: true, branchId: true, orderNumber: true, priority: true },
      })
      if (!order) throw new AppError('That order no longer exists', 404, 'ORDER_NOT_FOUND')
      await assertBranchAccess(user, order.branchId)

      const updated = await prisma.order.update({
        where: { id: order.id },
        data: { priority: data.priority },
      })

      await audit({
        restaurantId: user.restaurantId,
        branchId: order.branchId,
        userId: user.id,
        actorName: user.name,
        action: AUDIT_ACTIONS.ORDER_PRIORITY_CHANGED,
        entity: 'Order',
        entityId: order.id,
        before: { priority: order.priority },
        after: {
          priority: updated.priority,
          order: order.orderNumber,
          reason: data.reason || null,
        },
      })

      revalidatePath('/kitchen')
      return { id: order.id, priority: updated.priority as string }
    },
    'Priority updated.',
  )
}
