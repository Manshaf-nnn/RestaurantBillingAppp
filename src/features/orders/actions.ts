'use server'

import { revalidatePath } from 'next/cache'

import { runAction, runSafe, type ActionResult } from '@/lib/action'
import { AppError, NotFoundError } from '@/lib/errors'
import { PERMISSIONS } from '@/lib/rbac'
import { AUDIT_ACTIONS, audit } from '@/server/audit'
import { requirePermission, requireTenantUser } from '@/server/auth/guard'
import { getOrCreateGuestSessionId } from '@/server/auth/session'
import { prisma } from '@/server/db/prisma'
import { resolvePublicTenant } from '@/server/db/tenant'
import { notify } from '@/server/notifications'
import { realtime } from '@/server/realtime/emitter'
import { enforceRateLimit } from '@/server/security/rate-limit'
import {
  applyDiscountSchema,
  cancelOrderSchema,
  placeOrderSchema,
  serviceRequestSchema,
  staffOrderSchema,
  tableEntrySchema,
  updateGuestOrderItemsSchema,
  updateItemStatusSchema,
  updateOrderStatusSchema,
} from './schema'
import {
  buildDraft,
  cancelOrder as cancelOrderService,
  placeOrder as placeOrderService,
  updateOrderStatus as updateOrderStatusService,
} from './service'
import { computeTotals, estimatePrepMinutes } from './pricing'

// ── guest surface ────────────────────────────────────────────────────────────

/** Validates the table number typed on the QR landing screen. */
export async function resolveTable(
  input: unknown,
  slug?: string,
): Promise<ActionResult<{ tableId: string; tableNumber: string; label: string | null }>> {
  return runAction(tableEntrySchema, input, async (data) => {
    const restaurant = await resolvePublicTenant(slug)
    if (!restaurant) throw new NotFoundError('Restaurant')

    const table = await prisma.restaurantTable.findFirst({
      where: {
        restaurantId: restaurant.id,
        number: data.tableNumber.toUpperCase(),
        isActive: true,
      },
      select: { id: true, number: true, label: true, status: true },
    })

    if (!table) {
      throw new AppError(
        `Table ${data.tableNumber} was not found. Please check the number on your table.`,
        404,
        'TABLE_NOT_FOUND',
      )
    }
    if (table.status === 'OUT_OF_SERVICE') {
      throw new AppError('This table is not in service. Please ask our staff for help.', 409, 'TABLE_CLOSED')
    }

    return { tableId: table.id, tableNumber: table.number, label: table.label }
  })
}

/** Live re-price of the guest cart — the checkout summary calls this. */
export async function quoteCart(
  input: { items: Array<{ foodId: string; quantity: number; optionIds: string[] }>; couponCode?: string; phone?: string },
  slug?: string,
) {
  return runSafe(async () => {
    const restaurant = await resolvePublicTenant(slug)
    if (!restaurant) throw new NotFoundError('Restaurant')

    let customerId: string | null = null
    if (input.phone) {
      const customer = await prisma.customer.findFirst({
        where: { restaurantId: restaurant.id, phone: input.phone },
        select: { id: true, loyaltyPoints: true },
      })
      customerId = customer?.id ?? null
    }

    const draft = await buildDraft({
      restaurantId: restaurant.id,
      items: input.items,
      couponCode: input.couponCode,
      customerId,
    })

    return {
      totals: draft.totals,
      couponCode: draft.couponCode,
      couponError: draft.couponError,
      estimatedMinutes: draft.estimatedMinutes,
      currency: restaurant.currency,
    }
  })
}

export async function placeGuestOrder(
  input: unknown,
  slug?: string,
): Promise<ActionResult<{ orderId: string; orderNumber: string }>> {
  return runAction(
    placeOrderSchema,
    input,
    async (data) => {
      await enforceRateLimit('placeOrder')

      const restaurant = await resolvePublicTenant(slug)
      if (!restaurant) throw new NotFoundError('Restaurant')

      const guestSessionId = await getOrCreateGuestSessionId()

      const order = await placeOrderService({
        restaurantId: restaurant.id,
        tableId: data.tableId,
        type: 'DINE_IN',
        customerName: data.customerName,
        customerPhone: data.customerPhone,
        customerEmail: data.customerEmail || null,
        guestCount: data.guestCount ?? null,
        notes: data.notes || null,
        items: data.items.map((item) => ({
          foodId: item.foodId,
          quantity: item.quantity,
          optionIds: item.optionIds,
          notes: item.notes || undefined,
        })),
        couponCode: data.couponCode || null,
        redeemPoints: data.redeemPoints,
        guestSessionId,
      })

      return { orderId: order.id, orderNumber: order.orderNumber }
    },
    'Order placed. The kitchen has it now.',
  )
}

export async function updateGuestOrderItems(
  input: unknown,
  slug?: string,
): Promise<ActionResult<{ orderId: string; grandTotal: number }>> {
  return runAction(
    updateGuestOrderItemsSchema,
    input,
    async (data) => {
      const restaurant = await resolvePublicTenant(slug)
      if (!restaurant) throw new NotFoundError('Restaurant')

      const guestSessionId = await getOrCreateGuestSessionId()
      const order = await prisma.order.findFirst({
        where: { id: data.orderId, restaurantId: restaurant.id, guestSessionId },
        include: {
          items: true,
          table: { select: { id: true, number: true } },
          restaurant: { select: { currency: true, taxInclusive: true, taxRateBps: true, serviceChargeBps: true } },
        },
      })

      if (!order) throw new NotFoundError('Order')
      if (['SERVED', 'COMPLETED', 'CANCELLED'].includes(order.status)) {
        throw new AppError('This order can no longer be changed.', 409, 'ORDER_LOCKED')
      }

      const orderItems = new Map(order.items.map((item) => [item.id, item]))
      const keep: Array<{ id: string; quantity: number; unitPrice: number; optionsTotal: number; prepTimeMinutes: number; lineTotal: number }> = []

      for (const patch of data.items) {
        const current = orderItems.get(patch.itemId)
        if (!current) continue
        const quantity = Math.max(0, Math.min(50, patch.quantity))
        if (quantity === 0) continue
        const lineTotal = (current.unitPrice + current.optionsTotal) * quantity
        keep.push({
          id: current.id,
          quantity,
          unitPrice: current.unitPrice,
          optionsTotal: current.optionsTotal,
          prepTimeMinutes: current.prepTimeMinutes,
          lineTotal,
        })
      }

      if (keep.length === 0) {
        throw new AppError('Your order must have at least one item.', 400, 'EMPTY_ORDER')
      }

      const totals = computeTotals({
        lines: keep.map((item) => ({ lineTotal: item.lineTotal })),
        taxRateBps: order.taxRateBps || order.restaurant.taxRateBps,
        serviceChargeBps: order.serviceChargeBps || order.restaurant.serviceChargeBps,
        taxInclusive: order.restaurant.taxInclusive,
        couponDiscount: order.discountTotal,
        loyaltyDiscount: order.loyaltyDiscount,
        currency: order.restaurant.currency,
        roundTotal: true,
      })

      await prisma.$transaction(async (tx) => {
        for (const patch of data.items) {
          const current = orderItems.get(patch.itemId)
          if (!current) continue
          const quantity = Math.max(0, Math.min(50, patch.quantity))
          if (quantity === 0) {
            await tx.orderItem.delete({ where: { id: current.id } })
            continue
          }

          const lineTotal = (current.unitPrice + current.optionsTotal) * quantity
          await tx.orderItem.update({
            where: { id: current.id },
            data: {
              quantity,
              lineTotal,
              status: current.status === 'CANCELLED' ? 'QUEUED' : current.status,
            },
          })
        }

        await tx.order.update({
          where: { id: order.id },
          data: {
            subtotal: totals.subtotal,
            discountTotal: order.discountTotal,
            loyaltyDiscount: order.loyaltyDiscount,
            taxTotal: totals.taxTotal,
            serviceCharge: totals.serviceCharge,
            roundingAdj: totals.roundingAdj,
            grandTotal: totals.grandTotal,
            estimatedMinutes: estimatePrepMinutes(
              keep.map((item) => ({ prepTimeMinutes: item.prepTimeMinutes, quantity: item.quantity })),
              0,
            ),
            events: {
              create: { status: order.status, note: 'Customer updated the order before it was served' },
            },
          },
        })
      })

      const refreshedOrder = await prisma.order.findFirst({
        where: { id: order.id, restaurantId: restaurant.id },
        include: { table: true, items: true },
      })

      if (refreshedOrder) {
        const payload = {
          id: refreshedOrder.id,
          orderNumber: refreshedOrder.orderNumber,
          status: refreshedOrder.status,
          type: refreshedOrder.type,
          tableId: refreshedOrder.tableId,
          tableNumber: refreshedOrder.table?.number ?? null,
          customerName: refreshedOrder.customerName,
          customerPhone: refreshedOrder.customerPhone,
          itemCount: refreshedOrder.items.reduce((total, item) => total + item.quantity, 0),
          grandTotal: refreshedOrder.grandTotal,
          notes: refreshedOrder.notes,
          placedAt: refreshedOrder.placedAt.toISOString(),
          estimatedMinutes: refreshedOrder.estimatedMinutes,
          items: refreshedOrder.items.map((item) => ({
            id: item.id,
            name: item.name,
            quantity: item.quantity,
            notes: item.notes,
            isVeg: item.isVeg,
            options: ((item.options as Array<{ groupName: string; name: string }> | null) ?? []).map((option) => ({
              groupName: option.groupName,
              name: option.name,
            })),
          })),
        }
        realtime.orderUpdated(restaurant.id, payload)
        realtime.orderStatus(restaurant.id, {
          orderId: refreshedOrder.id,
          orderNumber: refreshedOrder.orderNumber,
          status: refreshedOrder.status,
          tableId: refreshedOrder.tableId,
          tableNumber: refreshedOrder.table?.number ?? null,
          at: new Date().toISOString(),
        })
      }

      return { orderId: order.id, grandTotal: totals.grandTotal }
    },
    'Your order was updated.',
  )
}

export async function createServiceRequest(
  input: unknown,
  slug?: string,
): Promise<ActionResult<{ id: string }>> {
  return runAction(
    serviceRequestSchema,
    input,
    async (data) => {
      await enforceRateLimit('serviceRequest')

      const restaurant = await resolvePublicTenant(slug)
      if (!restaurant) throw new NotFoundError('Restaurant')

      const table = await prisma.restaurantTable.findFirst({
        where: { id: data.tableId, restaurantId: restaurant.id, isActive: true },
      })
      if (!table) throw new NotFoundError('Table')

      // Collapse repeat taps within a short window into one open request.
      const existing = await prisma.serviceRequest.findFirst({
        where: {
          restaurantId: restaurant.id,
          tableId: table.id,
          type: data.type,
          status: 'OPEN',
          createdAt: { gt: new Date(Date.now() - 3 * 60 * 1000) },
        },
      })
      if (existing) return { id: existing.id }

      const request = await prisma.serviceRequest.create({
        data: {
          restaurantId: restaurant.id,
          tableId: table.id,
          type: data.type,
          note: data.note || null,
        },
      })

      realtime.serviceRequest(restaurant.id, {
        id: request.id,
        tableId: table.id,
        tableNumber: table.number,
        type: request.type,
        note: request.note,
        createdAt: request.createdAt.toISOString(),
      })

      await notify({
        restaurantId: restaurant.id,
        type: 'SERVICE_REQUEST',
        title: `Table ${table.number} needs ${data.type.toLowerCase().replace('_', ' ')}`,
        body: data.note || null,
        audience: 'WAITER',
        data: { tableId: table.id, tableNumber: table.number, requestId: request.id },
      })

      return { id: request.id }
    },
    'Our staff have been notified.',
  )
}

// ── staff surface ────────────────────────────────────────────────────────────

export async function updateOrderStatus(input: unknown): Promise<ActionResult<{ id: string; status: string }>> {
  return runAction(updateOrderStatusSchema, input, async (data) => {
    const user = await requirePermission(PERMISSIONS.ORDER_UPDATE_STATUS)

    const order = await updateOrderStatusService({
      restaurantId: user.restaurantId,
      orderId: data.orderId,
      status: data.status,
      note: data.note,
      estimatedMinutes: data.estimatedMinutes,
      actorId: user.id,
      actorName: user.name,
    })

    await audit({
      restaurantId: user.restaurantId,
      userId: user.id,
      actorName: user.name,
      action: AUDIT_ACTIONS.ORDER_STATUS,
      entity: 'Order',
      entityId: order.id,
      after: { status: data.status },
    })

    revalidatePath('/kitchen')
    revalidatePath('/waiter')
    revalidatePath('/dashboard/orders')

    return { id: order.id, status: order.status }
  })
}

export async function updateItemStatus(input: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction(updateItemStatusSchema, input, async (data) => {
    const user = await requirePermission(PERMISSIONS.ORDER_UPDATE_STATUS)

    const item = await prisma.orderItem.findFirst({
      where: { id: data.itemId, order: { id: data.orderId, restaurantId: user.restaurantId } },
      include: { order: { select: { status: true } } },
    })
    if (!item) throw new NotFoundError('Order item')

    await prisma.orderItem.update({ where: { id: item.id }, data: { status: data.status } })
    realtime.orderItemStatus(user.restaurantId, data.orderId, data.itemId, data.status)

    // Once the waiter serves the last outstanding item, the whole order is
    // served — move the order to SERVED so it clears from the kitchen/waiter
    // boards and the kitchen knows everything was delivered.
    if (data.status === 'SERVED' && item.order.status === 'READY') {
      const remaining = await prisma.orderItem.count({
        where: { orderId: data.orderId, status: { notIn: ['SERVED', 'CANCELLED'] } },
      })
      if (remaining === 0) {
        await updateOrderStatusService({
          restaurantId: user.restaurantId,
          orderId: data.orderId,
          status: 'SERVED',
          actorId: user.id,
          actorName: user.name,
        })
      }
    }

    return { id: item.id }
  })
}

export async function cancelOrder(input: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction(
    cancelOrderSchema,
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.ORDER_CANCEL)

      const order = await cancelOrderService({
        restaurantId: user.restaurantId,
        orderId: data.orderId,
        reason: data.reason,
        actorId: user.id,
        actorName: user.name,
      })

      await audit({
        restaurantId: user.restaurantId,
        userId: user.id,
        actorName: user.name,
        action: AUDIT_ACTIONS.ORDER_CANCELLED,
        entity: 'Order',
        entityId: order.id,
        after: { reason: data.reason },
      })

      revalidatePath('/dashboard/orders')
      revalidatePath('/kitchen')
      return { id: order.id }
    },
    'Order cancelled.',
  )
}

export async function createStaffOrder(input: unknown): Promise<ActionResult<{ orderId: string; orderNumber: string }>> {
  return runAction(
    staffOrderSchema,
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.ORDER_CREATE)

      const order = await placeOrderService({
        restaurantId: user.restaurantId,
        tableId: data.tableId || null,
        type: data.type,
        customerName: data.customerName,
        customerPhone: data.customerPhone,
        customerEmail: data.customerEmail || null,
        guestCount: data.guestCount ?? null,
        notes: data.notes || null,
        items: data.items.map((item) => ({
          foodId: item.foodId,
          quantity: item.quantity,
          optionIds: item.optionIds,
          notes: item.notes || undefined,
        })),
        couponCode: data.couponCode || null,
        manualDiscount: data.manualDiscount,
        redeemPoints: data.redeemPoints,
        createdById: user.id,
      })

      await audit({
        restaurantId: user.restaurantId,
        userId: user.id,
        actorName: user.name,
        action: AUDIT_ACTIONS.ORDER_PLACED,
        entity: 'Order',
        entityId: order.id,
        after: { orderNumber: order.orderNumber, total: order.grandTotal },
      })

      revalidatePath('/dashboard/orders')
      return { orderId: order.id, orderNumber: order.orderNumber }
    },
    'Order created.',
  )
}

export async function applyManualDiscount(input: unknown): Promise<ActionResult<{ grandTotal: number }>> {
  return runAction(
    applyDiscountSchema,
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.DISCOUNT_APPLY)

      const order = await prisma.order.findFirst({
        where: { id: data.orderId, restaurantId: user.restaurantId },
        include: { items: true, restaurant: { select: { currency: true, taxInclusive: true } } },
      })
      if (!order) throw new NotFoundError('Order')
      if (order.paymentStatus === 'PAID') {
        throw new AppError('This order is already paid', 409, 'ORDER_PAID')
      }

      const totals = computeTotals({
        lines: order.items.map((item) => ({ lineTotal: item.lineTotal })),
        taxRateBps: order.taxRateBps,
        serviceChargeBps: order.serviceChargeBps,
        taxInclusive: order.restaurant.taxInclusive,
        manualDiscount: data.amount,
        loyaltyDiscount: order.loyaltyDiscount,
        currency: order.restaurant.currency,
        roundTotal: true,
      })

      const updated = await prisma.order.update({
        where: { id: order.id },
        data: {
          discountTotal: totals.discountTotal,
          taxTotal: totals.taxTotal,
          serviceCharge: totals.serviceCharge,
          roundingAdj: totals.roundingAdj,
          grandTotal: totals.grandTotal,
        },
      })

      await audit({
        restaurantId: user.restaurantId,
        userId: user.id,
        actorName: user.name,
        action: AUDIT_ACTIONS.ORDER_DISCOUNT,
        entity: 'Order',
        entityId: order.id,
        before: { grandTotal: order.grandTotal },
        after: { grandTotal: updated.grandTotal, reason: data.reason },
      })

      revalidatePath(`/dashboard/orders/${order.id}`)
      revalidatePath('/cashier')
      return { grandTotal: updated.grandTotal }
    },
    'Discount applied.',
  )
}

export async function resolveServiceRequest(requestId: string): Promise<ActionResult<{ id: string }>> {
  return runSafe(async () => {
    const user = await requireTenantUser()

    const request = await prisma.serviceRequest.findFirst({
      where: { id: requestId, restaurantId: user.restaurantId },
    })
    if (!request) throw new NotFoundError('Request')

    await prisma.serviceRequest.update({
      where: { id: request.id },
      data: { status: 'RESOLVED', resolvedAt: new Date(), handledById: user.id },
    })

    realtime.serviceRequestResolved(user.restaurantId, request.id)
    revalidatePath('/waiter')
    return { id: request.id }
  }, 'Request cleared.')
}
