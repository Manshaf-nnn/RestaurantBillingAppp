'use server'

import { revalidatePath } from 'next/cache'

import { resolvePublicBranch } from '@/features/branches/public-branch'
import { actingBranchId } from '@/features/dashboard/selected-branch'
import { reconcileOrderDepletion } from '@/features/inventory/depletion'
import { runAction, runSafe, type ActionResult } from '@/lib/action'
import { AppError, NotFoundError } from '@/lib/errors'
import { PERMISSIONS } from '@/lib/rbac'
import { AUDIT_ACTIONS, audit } from '@/server/audit'
import { assertRecordBranch, requirePermission, requireTenantUser } from '@/server/auth/guard'
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
  quoteCartSchema,
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
import { readOptions } from './queries'

// ── guest surface ────────────────────────────────────────────────────────────

/** Validates the table number typed on the QR landing screen. */
/**
 * Turn the number on the table card into a table, at the branch that was
 * scanned.
 *
 * ── The bug this fixes ──────────────────────────────────────────────────────
 *
 * The lookup was `{ restaurantId, number, isActive }` — no branch. Table
 * numbers restart per branch (`@@unique([restaurantId, branchId, number])`), so
 * "1" exists at every location and `findFirst` returned an arbitrary one: in
 * practice the oldest row, which is the main branch's. A guest who scanned
 * Branch 01's code and typed 1 was seated at MAIN's table 1, `placeOrder` took
 * the branch from the table, and the ticket printed in Main's kitchen. That is
 * the reported bug, and this is where it started.
 *
 * `branchCode` is what the QR carried in `?b=`. It is passed explicitly where
 * the page has it and falls back to the `ros_b` cookie the middleware wrote —
 * the cookie matters because a guest moves from the landing screen to the menu
 * to the cart and only the first of those carries the query string.
 */
export async function resolveTable(
  input: unknown,
  slug?: string,
  branchCode?: string | null,
): Promise<
  ActionResult<{
    tableId: string
    tableNumber: string
    label: string | null
    /**
     * The branch this table is at, returned so the rest of the guest's visit
     * carries it explicitly. The cart is reached by navigation, long after the
     * QR's `?b=` has gone, and a cookie is not something to bet an order on.
     */
    branchCode: string
    branchName: string
    openBill: { orders: number; itemCount: number; outstanding: number } | null
  }>
> {
  return runAction(tableEntrySchema, input, async (data) => {
    const restaurant = await resolvePublicTenant(slug)
    if (!restaurant) throw new NotFoundError('Restaurant')

    // Unauthenticated and cheap to call in a loop, so it gets the same venue-IP
    // ceiling as its siblings. Its own guests hit it once per sitting.
    await enforceRateLimit('publicRead')

    const branch = await resolvePublicBranch(restaurant.id, branchCode ?? null)
    if (!branch) throw new NotFoundError('Location')

    const table = await prisma.restaurantTable.findFirst({
      where: {
        restaurantId: restaurant.id,
        branchId: branch.id,
        number: data.tableNumber.toUpperCase(),
        isActive: true,
      },
      select: { id: true, number: true, label: true, status: true },
    })

    if (!table) {
      /*
       * Names THIS branch, never the other one.
       *
       * The first version said "Table 2 is at Main Branch, not Branch 02",
       * which is friendlier for the honest case — somebody scanned the wrong
       * poster — and is also an enumeration oracle: this action is
       * unauthenticated, so anyone could walk the numbers and learn the table
       * layout of every branch in the business. Saying which branch the guest
       * IS at keeps the useful half; saying which branch they are not at gives
       * away someone else's floor.
       */
      throw new AppError(
        'This table is not available. Please check the number on your table.',
        404,
        'TABLE_NOT_FOUND',
      )
    }
    if (table.status === 'OUT_OF_SERVICE') {
      throw new AppError('This table is not in service. Please ask our staff for help.', 409, 'TABLE_CLOSED')
    }

    // A table can already be mid-service: an earlier round from the same party,
    // or a previous group whose bill has not been settled. Either way the guest
    // should be told, because their order joins that bill rather than starting a
    // fresh one — and the total they eventually see will include it.
    const openOrders = await prisma.order.findMany({
      where: {
        restaurantId: restaurant.id,
        tableId: table.id,
        status: { notIn: ['COMPLETED', 'CANCELLED'] },
        paymentStatus: { in: ['UNPAID', 'PARTIAL'] },
      },
      select: { grandTotal: true, paidTotal: true, items: { select: { quantity: true } } },
    })

    const openBill = openOrders.length
      ? {
          orders: openOrders.length,
          itemCount: openOrders.reduce(
            (sum, order) => sum + order.items.reduce((n, item) => n + item.quantity, 0),
            0,
          ),
          outstanding: openOrders.reduce(
            (sum, order) => sum + Math.max(0, order.grandTotal - order.paidTotal),
            0,
          ),
        }
      : null

    return {
      tableId: table.id,
      tableNumber: table.number,
      label: table.label,
      branchCode: branch.code,
      branchName: branch.name,
      openBill,
    }
  })
}

/** Live re-price of the guest cart — the checkout summary calls this. */
/**
 * Re-price the cart for the checkout summary.
 *
 * ── Why this takes a branch ─────────────────────────────────────────────────
 *
 * It did not, and `buildDraft` treats a missing branch as "no restriction"
 * (`branchOverrides` returns null). Two things followed, and a guest met both:
 * the menu showed the branch's price and this summary showed the restaurant's
 * base price; and a dish the branch does not sell quoted happily, then failed
 * at the last tap with "not on the menu here" — after the guest had typed
 * their name and phone.
 *
 * The value was already in hand: the cart holds `branchCode` beside the table,
 * and the very next action along passes it. This one dropped it.
 *
 * ── Why it is now validated and limited ─────────────────────────────────────
 *
 * This is an unauthenticated endpoint that fans out into a database query per
 * distinct dish, and it took its input raw — no schema, no cap, no rate limit,
 * while `placeOrderSchema` next door caps the cart at 60 lines. Prices were
 * never at risk (they are re-read from the row), but the fan-out was.
 */
export async function quoteCart(
  input: unknown,
  slug?: string,
  branchCode?: string | null,
) {
  return runAction(quoteCartSchema, input, async (data) => {
    const restaurant = await resolvePublicTenant(slug)
    if (!restaurant) throw new NotFoundError('Restaurant')

    await enforceRateLimit('quoteCartBurst')

    // Same rule as `placeGuestOrder`: a blank code means the cart never had
    // one, not that the guest asked for nothing.
    const asserted = branchCode?.trim() || null
    const branch = asserted ? await resolvePublicBranch(restaurant.id, asserted) : null

    let customerId: string | null = null
    if (data.phone) {
      const customer = await prisma.customer.findFirst({
        where: { restaurantId: restaurant.id, phone: data.phone },
        select: { id: true, loyaltyPoints: true },
      })
      customerId = customer?.id ?? null
    }

    const draft = await buildDraft({
      restaurantId: restaurant.id,
      items: data.items,
      couponCode: data.couponCode,
      customerId,
      // The same branch the menu was priced at, so the summary agrees with what
      // the guest was looking at a moment ago.
      branchId: branch?.id ?? null,
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
      const restaurant = await resolvePublicTenant(slug)
      if (!restaurant) throw new NotFoundError('Restaurant')

      const guestSessionId = await getOrCreateGuestSessionId()

      // Per phone, not per IP — a full dining room shares one wifi address, and
      // an IP-keyed limit would block everyone once a handful of tables ordered.
      await enforceRateLimit('placeOrder', `guest:${guestSessionId}`)
      // Backstop against someone cycling cookies from the same connection.
      await enforceRateLimit('placeOrderBurst')

      /*
       * The branch this guest scanned, passed explicitly.
       *
       * This read the `ros_b` cookie alone. A cookie is the right carrier for
       * the second and third page of a visit — only the first URL carries the
       * query string — but leaning on it for the order itself means any
       * browser that drops it silently files the order against the
       * restaurant's DEFAULT branch, with no error anywhere.
       *
       * `placeOrder` now refuses outright if this disagrees with the table's
       * own branch, rather than quietly preferring one.
       */
      /*
       * Only assert a branch if the guest's cart actually carries one.
       *
       * A blank code is now an error rather than a silent default, which is
       * right — but the cart is allowed not to have one (an older cart still in
       * localStorage from before the code was carried). In that case the TABLE
       * decides, which is `placeOrder`'s documented fallback and the more
       * truthful answer anyway: the guest is sitting at a specific table, and
       * that table knows its own branch.
       *
       * Passing a cookie-derived branch here instead would be worse than
       * useless — it could disagree with the table and trip the mismatch guard
       * on a perfectly ordinary order.
       */
      const asserted = data.branchCode?.trim() || null
      const branch = asserted ? await resolvePublicBranch(restaurant.id, asserted) : null

      const order = await placeOrderService({
        restaurantId: restaurant.id,
        branchId: branch?.id ?? null,
        tableId: data.tableId,
        type: 'DINE_IN',
        channel: 'QR',
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
        idempotencyKey: data.idempotencyKey || null,
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

        /*
         * The lines just changed, so what this order should have consumed
         * changed with them. Without this, a guest reducing two burgers to one
         * kept both sets of ingredients deducted — and because the order was
         * already accepted, nothing downstream ever reconciled it.
         */
        await reconcileOrderDepletion(tx, {
          restaurantId: restaurant.id,
          orderId: order.id,
        })

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
          branchId: refreshedOrder.branchId,
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
          branchId: refreshedOrder.branchId,
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

/**
 * A guest calls for water, plates or the bill.
 *
 * `branchCode` is the QR's `?b=`, for the same reason `resolveTable` takes it:
 * the table must be checked at the branch the guest is actually sitting in.
 * Without it this looked a table up by `{ id, restaurantId, isActive }` and
 * nothing else, so an anonymous caller anywhere could ring the call bell on any
 * table in any branch of the business — and `notify` below then routed it to
 * that branch's waiters, who would go and look.
 */
export async function createServiceRequest(
  input: unknown,
  slug?: string,
  branchCode?: string | null,
): Promise<ActionResult<{ id: string }>> {
  return runAction(
    serviceRequestSchema,
    input,
    async (data) => {
      const restaurant = await resolvePublicTenant(slug)
      if (!restaurant) throw new NotFoundError('Restaurant')

      // Keyed per phone for the same reason as placing an order: every table in
      // the room shares the venue's IP.
      const guestSessionId = await getOrCreateGuestSessionId()
      await enforceRateLimit('serviceRequest', `guest:${guestSessionId}`)
      await enforceRateLimit('serviceRequestBurst')

      const branch = await resolvePublicBranch(restaurant.id, branchCode ?? null)
      if (!branch) throw new NotFoundError('Location')

      const table = await prisma.restaurantTable.findFirst({
        where: {
          id: data.tableId,
          restaurantId: restaurant.id,
          // The branch the guest scanned. A table id from another branch is
          // simply not found here, which is the right answer to give someone
          // pasting one.
          branchId: branch.id,
          isActive: true,
        },
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
        // From the table, which is the only thing that knows — a service
        // request has no branch column of its own.
        branchId: table.branchId,
        tableNumber: table.number,
        type: request.type,
        note: request.note,
        createdAt: request.createdAt.toISOString(),
      })

      await notify({
        restaurantId: restaurant.id,
        // The table knows which building it is in.
        branchId: table.branchId,
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

/**
 * The branch an order belongs to.
 *
 * Read from the record before acting on it. Every one of these actions was
 * `{ id, restaurantId }` only, so a Kandy cashier could advance, cancel or
 * discount a Colombo order by pasting its id — and `Order.branchId` was sitting
 * right there, never consulted.
 */
async function orderBranch(restaurantId: string, orderId: string) {
  return prisma.order.findFirst({
    where: { id: orderId, restaurantId },
    select: { branchId: true },
  })
}

export async function updateOrderStatus(input: unknown): Promise<ActionResult<{ id: string; status: string }>> {
  return runAction(updateOrderStatusSchema, input, async (data) => {
    const user = await requirePermission(PERMISSIONS.ORDER_UPDATE_STATUS)
    await assertRecordBranch(user, await orderBranch(user.restaurantId, data.orderId), 'order')

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
    revalidatePath('/cashier')

    return { id: order.id, status: order.status }
  })
}

export async function updateItemStatus(input: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction(updateItemStatusSchema, input, async (data) => {
    const user = await requirePermission(PERMISSIONS.ORDER_UPDATE_STATUS)
    await assertRecordBranch(user, await orderBranch(user.restaurantId, data.orderId), 'order')

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
      // Cancelling returns stock to a branch's shelves, so it must be theirs.
      await assertRecordBranch(user, await orderBranch(user.restaurantId, data.orderId), 'order')

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

/**
 * The bill a till can print, straight back from placing the order.
 *
 * ── Why the totals must come from here ──────────────────────────────────────
 *
 * The POS knows a subtotal — `price × quantity` — and nothing else. No tax, no
 * service charge, no discount, no rounding. Its own screen says so: "Tax and
 * service charge are added on the bill." Printing that number would hand the
 * guest a total the restaurant does not charge, and the difference would show
 * up later as an unexplained gap between the till and the takings.
 *
 * `placeOrder` has already computed and persisted the real figures through
 * `computeTotals`. Returning them costs nothing — the order and its lines come
 * back from the insert — and it makes it impossible for the printed bill and
 * the database row to disagree, because they are the same numbers.
 */
export interface StaffOrderBill {
  orderId: string
  orderNumber: string
  placedAt: string
  tableNumber: string | null
  customerName: string
  items: Array<{
    name: string
    optionsLabel?: string
    quantity: number
    lineTotal: number
  }>
  subtotal: number
  discountTotal: number
  serviceCharge: number
  taxTotal: number
  grandTotal: number
}

export async function createStaffOrder(input: unknown): Promise<ActionResult<StaffOrderBill>> {
  return runAction(
    staffOrderSchema,
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.ORDER_CREATE)

      const order = await placeOrderService({
        restaurantId: user.restaurantId,
        tableId: data.tableId || null,
        type: data.type,
        // A counter sale is keyed in at the till; anything else a staff member
        // enters is attributed to staff rather than to the guest's own device.
        channel: data.type === 'COUNTER' ? 'COUNTER' : 'STAFF',
        /*
         * The location the till is working at.
         *
         * This was `user.branchId ?? null`. An owner has no home branch, so it
         * was null, and `placeOrder` fell through to the restaurant's DEFAULT
         * branch — an owner ringing up a takeaway while looking at Branch 01
         * filed it against Main. `actingBranchId` reads the branch the switcher
         * is showing, validated against what this user may reach.
         *
         * A table still decides where there is one, and now disagreeing with it
         * is an error rather than a silent override.
         */
        branchId: data.tableId ? null : await actingBranchId(user),
        // Falls back to whoever is signed in, so a waiter taking their own
        // order is attributed without having to pick themselves from a list.
        servedById: data.servedById || user.id,
        // A walk-in has no name to give; the bill still needs one to print.
        customerName: data.customerName?.trim() || 'Walk-in',
        customerPhone: data.customerPhone?.trim() || '',
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
      revalidatePath('/cashier')

      return {
        orderId: order.id,
        orderNumber: order.orderNumber,
        placedAt: order.placedAt.toISOString(),
        tableNumber: order.tableNumber,
        customerName: order.customerName,
        items: order.items.map((item) => ({
          name: item.name,
          // The same shape every other receipt uses — `readOptions` parses the
          // options JSON, and an empty selection becomes no label at all
          // rather than an empty line under the dish.
          optionsLabel:
            readOptions(item.options)
              .map((option) => option.name)
              .join(', ') || undefined,
          quantity: item.quantity,
          lineTotal: item.lineTotal,
        })),
        subtotal: order.subtotal,
        discountTotal: order.discountTotal,
        serviceCharge: order.serviceCharge,
        taxTotal: order.taxTotal,
        grandTotal: order.grandTotal,
      }
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
      await assertRecordBranch(user, await orderBranch(user.restaurantId, data.orderId), 'order')

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
    /*
     * Clearing a call bell is floor work, so it needs the floor permission —
     * this was `requireTenantUser()`, which is every signed-in account
     * including an accountant.
     */
    const user = await requirePermission(PERMISSIONS.WAITER_VIEW)

    const request = await prisma.serviceRequest.findFirst({
      where: { id: requestId, restaurantId: user.restaurantId },
      include: { table: { select: { branchId: true } } },
    })
    if (!request) throw new NotFoundError('Request')

    /*
     * And it must be their own floor. `ServiceRequest` has no branch column —
     * it reaches one through the table, which is how `getWaiterBoard` already
     * scopes the list. Without this a Branch 02 waiter could clear Main's bell
     * and the guest at Main would wait for someone who was never coming.
     */
    await assertRecordBranch(user, request.table, 'service request')

    await prisma.serviceRequest.update({
      where: { id: request.id },
      data: { status: 'RESOLVED', resolvedAt: new Date(), handledById: user.id },
    })

    realtime.serviceRequestResolved(user.restaurantId, request.id)
    revalidatePath('/waiter')
    return { id: request.id }
  }, 'Request cleared.')
}
