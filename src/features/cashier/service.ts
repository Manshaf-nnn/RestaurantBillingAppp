import 'server-only'

import type { Order } from '@prisma/client'

import { AppError, NotFoundError } from '@/lib/errors'
import { computeTotals } from '@/features/orders/pricing'
import { prisma, type TxClient } from '@/server/db/prisma'

/**
 * Counter operations on an open bill: hold, resume, split and merge.
 *
 * These all move money around, so every one of them runs in a transaction and
 * re-derives totals from the order's own lines with the same `computeTotals`
 * used at checkout — never by adding or subtracting deltas. Splitting a bill
 * whose tax was rounded once must not leave the two halves adding up to a
 * different number than the original.
 *
 * A bill that has been paid is off limits to all of them: settle or refund
 * first. That is enforced here rather than in the UI so it holds however the
 * operation is reached.
 */

const OPEN_STATUSES = ['PENDING', 'ACCEPTED', 'PREPARING', 'READY', 'SERVED'] as const

interface ActorParams {
  restaurantId: string
  actorId?: string | null
  actorName?: string | null
}

/** Re-derive an order's money from its current lines and persist it. */
export async function recalculateOrderTotals(tx: TxClient, orderId: string): Promise<Order> {
  const order = await tx.order.findUniqueOrThrow({
    where: { id: orderId },
    include: { items: { where: { status: { not: 'CANCELLED' } }, select: { lineTotal: true } } },
  })

  const restaurant = await tx.restaurant.findUniqueOrThrow({
    where: { id: order.restaurantId },
    select: { taxInclusive: true, currency: true },
  })

  const totals = computeTotals({
    lines: order.items,
    taxRateBps: order.taxRateBps,
    serviceChargeBps: order.serviceChargeBps,
    taxInclusive: restaurant.taxInclusive,
    // The order already stores what was actually granted; a discount is not
    // re-evaluated here, only re-applied, and it is clamped to the new subtotal
    // by computeTotals so a split can never leave a discount larger than the bill.
    manualDiscount: order.discountTotal,
    loyaltyDiscount: order.loyaltyDiscount,
    tipAmount: order.tipAmount,
    currency: restaurant.currency,
    // Must match how the bill was priced at checkout, which rounds the grand
    // total to the nearest major unit. Recomputing without it made splitting or
    // merging change what the guest owes by up to a rupee, and meant a split
    // followed by a merge did not return the original total.
    roundTotal: true,
  })

  return tx.order.update({
    where: { id: orderId },
    data: {
      subtotal: totals.subtotal,
      discountTotal: totals.discountTotal,
      loyaltyDiscount: totals.loyaltyDiscount,
      serviceCharge: totals.serviceCharge,
      taxTotal: totals.taxTotal,
      tipAmount: totals.tipAmount,
      roundingAdj: totals.roundingAdj,
      grandTotal: totals.grandTotal,
    },
  })
}

async function loadOpenBill(restaurantId: string, orderId: string) {
  const order = await prisma.order.findFirst({
    where: { id: orderId, restaurantId },
    include: { items: true },
  })
  if (!order) throw new NotFoundError('Bill')
  if (order.status === 'CANCELLED') {
    throw new AppError('That bill was cancelled', 409, 'ORDER_CANCELLED')
  }
  return order
}

// ── hold / resume ────────────────────────────────────────────────────────────

/**
 * Park a bill. It leaves the active queue but keeps its items, its table and
 * its order number, so resuming is a single tap with nothing re-entered.
 */
export async function holdBill(
  params: ActorParams & { orderId: string; reason?: string | null },
): Promise<Order> {
  const order = await loadOpenBill(params.restaurantId, params.orderId)

  if (order.paymentStatus === 'PAID') {
    throw new AppError('This bill is already paid', 409, 'ORDER_PAID')
  }
  if (order.heldAt) return order

  return prisma.order.update({
    where: { id: order.id },
    data: {
      heldAt: new Date(),
      holdReason: params.reason?.trim() || null,
      events: {
        create: {
          status: order.status,
          note: params.reason?.trim() ? `Held — ${params.reason.trim()}` : 'Bill held',
          actorId: params.actorId ?? null,
          actorName: params.actorName ?? null,
        },
      },
    },
  })
}

/** Bring a parked bill back to the counter queue. */
export async function resumeBill(params: ActorParams & { orderId: string }): Promise<Order> {
  const order = await loadOpenBill(params.restaurantId, params.orderId)
  if (!order.heldAt) return order

  return prisma.order.update({
    where: { id: order.id },
    data: {
      heldAt: null,
      holdReason: null,
      events: {
        create: {
          status: order.status,
          note: 'Bill resumed',
          actorId: params.actorId ?? null,
          actorName: params.actorName ?? null,
        },
      },
    },
  })
}

// ── split ────────────────────────────────────────────────────────────────────

export interface SplitSelection {
  /** OrderItem id to move to the new bill. */
  itemId: string
  /** How many of that line to move. Moving the whole line moves the row. */
  quantity: number
}

/**
 * Move selected items onto a new bill.
 *
 * Used when one table pays separately. A line can be split part-way — three of
 * four coffees — in which case the original row keeps the remainder and a new
 * row carries the moved quantity, each re-priced from the same unit price so
 * the two bills still sum to the original.
 */
export async function splitBill(
  params: ActorParams & { orderId: string; selections: SplitSelection[] },
): Promise<{ source: Order; target: Order }> {
  const order = await loadOpenBill(params.restaurantId, params.orderId)

  if (order.paymentStatus !== 'UNPAID') {
    throw new AppError('Only an unpaid bill can be split', 409, 'ORDER_NOT_UNPAID')
  }

  const active = order.items.filter((item) => item.status !== 'CANCELLED')
  const byId = new Map(active.map((item) => [item.id, item]))

  const moves = params.selections
    .map((selection) => ({ selection, item: byId.get(selection.itemId) }))
    .filter((entry): entry is { selection: SplitSelection; item: (typeof active)[number] } =>
      Boolean(entry.item) && entry.selection.quantity > 0,
    )

  if (moves.length === 0) {
    throw new AppError('Choose at least one item to move', 400, 'SPLIT_EMPTY')
  }
  for (const { selection, item } of moves) {
    if (selection.quantity > item.quantity) {
      throw new AppError(`Only ${item.quantity} × ${item.name} on this bill`, 400, 'SPLIT_TOO_MANY')
    }
  }

  // Refuse a split that would empty the original — that is a no-op, not a split.
  const movesEverything =
    moves.length === active.length &&
    moves.every(({ selection, item }) => selection.quantity === item.quantity)
  if (movesEverything) {
    throw new AppError('Leave at least one item on the original bill', 400, 'SPLIT_ALL')
  }

  return prisma.$transaction(async (tx) => {
    const orderNumber = await splitOrderNumber(tx, order.restaurantId, order.orderNumber)

    const target = await tx.order.create({
      data: {
        restaurantId: order.restaurantId,
        orderNumber,
        type: order.type,
        status: order.status,
        tableId: order.tableId,
        customerId: order.customerId,
        customerName: order.customerName,
        customerPhone: order.customerPhone,
        customerEmail: order.customerEmail,
        createdById: params.actorId ?? null,
        taxRateBps: order.taxRateBps,
        serviceChargeBps: order.serviceChargeBps,
        splitFromId: order.id,
        placedAt: order.placedAt,
        events: {
          create: {
            status: order.status,
            note: `Split from ${order.orderNumber}`,
            actorId: params.actorId ?? null,
            actorName: params.actorName ?? null,
          },
        },
      },
    })

    for (const { selection, item } of moves) {
      if (selection.quantity === item.quantity) {
        // Whole line moves across — keep the row so its history follows it.
        await tx.orderItem.update({
          where: { id: item.id },
          data: { orderId: target.id },
        })
        continue
      }

      // Partial move: shrink the original and create the moved remainder.
      const unit = Math.round(item.lineTotal / item.quantity)
      const movedQty = selection.quantity
      const keptQty = item.quantity - movedQty

      await tx.orderItem.update({
        where: { id: item.id },
        data: { quantity: keptQty, lineTotal: unit * keptQty },
      })

      await tx.orderItem.create({
        data: {
          orderId: target.id,
          foodId: item.foodId,
          name: item.name,
          imageUrl: item.imageUrl,
          unitPrice: item.unitPrice,
          quantity: movedQty,
          lineTotal: unit * movedQty,
          options: item.options ?? undefined,
          notes: item.notes,
          status: item.status,
          costPrice: item.costPrice,
          isVeg: item.isVeg,
          prepTimeMinutes: item.prepTimeMinutes,
        },
      })
    }

    const source = await recalculateOrderTotals(tx, order.id)
    const updatedTarget = await recalculateOrderTotals(tx, target.id)

    return { source, target: updatedTarget }
  })
}

/**
 * Bills split from `ORD-0007` become `ORD-0007-A`, `-B`, … so the relationship
 * is legible on a printed receipt without a lookup.
 */
async function splitOrderNumber(
  tx: TxClient,
  restaurantId: string,
  baseNumber: string,
): Promise<string> {
  const root = baseNumber.replace(/-[A-Z]$/, '')
  const existing = await tx.order.count({
    where: { restaurantId, orderNumber: { startsWith: `${root}-` } },
  })
  // 'A' is the first split; wrap to a numeric suffix past 26 rather than break.
  const suffix = existing < 26 ? String.fromCharCode(65 + existing) : String(existing + 1)
  return `${root}-${suffix}`
}

// ── merge ────────────────────────────────────────────────────────────────────

/**
 * Fold one or more bills into a target bill.
 *
 * Used when a table that ordered in separate rounds wants a single bill. The
 * sources keep their row and order number but are closed and marked as merged,
 * so the day's order history still shows what happened.
 */
export async function mergeBills(
  params: ActorParams & { targetId: string; sourceIds: string[] },
): Promise<Order> {
  const sourceIds = [...new Set(params.sourceIds)].filter((id) => id !== params.targetId)
  if (sourceIds.length === 0) {
    throw new AppError('Choose at least one other bill to merge in', 400, 'MERGE_EMPTY')
  }

  const target = await loadOpenBill(params.restaurantId, params.targetId)
  if (target.paymentStatus === 'PAID') {
    throw new AppError('The bill being merged into is already paid', 409, 'ORDER_PAID')
  }

  const sources = await prisma.order.findMany({
    where: {
      id: { in: sourceIds },
      restaurantId: params.restaurantId,
      status: { in: [...OPEN_STATUSES] },
    },
    include: { items: true },
  })

  if (sources.length !== sourceIds.length) {
    throw new AppError('One of those bills is no longer open', 409, 'MERGE_UNAVAILABLE')
  }
  const paid = sources.find((source) => source.paymentStatus !== 'UNPAID')
  if (paid) {
    throw new AppError(`${paid.orderNumber} already has a payment against it`, 409, 'ORDER_PAID')
  }

  return prisma.$transaction(async (tx) => {
    for (const source of sources) {
      await tx.orderItem.updateMany({
        where: { orderId: source.id },
        data: { orderId: target.id },
      })

      await tx.order.update({
        where: { id: source.id },
        data: {
          status: 'CANCELLED',
          cancelledAt: new Date(),
          cancelReason: `Merged into ${target.orderNumber}`,
          mergedIntoId: target.id,
          subtotal: 0,
          discountTotal: 0,
          loyaltyDiscount: 0,
          serviceCharge: 0,
          taxTotal: 0,
          tipAmount: 0,
          roundingAdj: 0,
          grandTotal: 0,
          events: {
            create: {
              status: 'CANCELLED',
              note: `Merged into ${target.orderNumber}`,
              actorId: params.actorId ?? null,
              actorName: params.actorName ?? null,
            },
          },
        },
      })
    }

    await tx.orderEvent.create({
      data: {
        orderId: target.id,
        status: target.status,
        note: `Merged in ${sources.map((source) => source.orderNumber).join(', ')}`,
        actorId: params.actorId ?? null,
        actorName: params.actorName ?? null,
      },
    })

    return recalculateOrderTotals(tx, target.id)
  })
}


// ── void an item ─────────────────────────────────────────────────────────────

/**
 * Void a single line on an open bill.
 *
 * The line is marked CANCELLED rather than deleted, so a dish that was rung up
 * by mistake, sent back, or comped still shows on the order's history and in
 * the audit trail. `recalculateOrderTotals` then re-derives the bill from the
 * surviving lines, which is what keeps a void from drifting the total the way
 * subtracting a delta would.
 *
 * Paid bills are refused: money has already changed hands, so the correct
 * instrument is a refund, not a quiet edit to what the guest was charged.
 */
export async function voidOrderItem(
  params: ActorParams & { orderId: string; itemId: string; reason: string },
): Promise<{ order: Order; itemName: string; lineTotal: number }> {
  const reason = params.reason.trim()
  if (reason.length < 2) {
    throw new AppError('Give a reason for voiding this item', 400, 'VOID_NO_REASON')
  }

  const order = await loadOpenBill(params.restaurantId, params.orderId)

  if (order.paymentStatus === 'PAID') {
    throw new AppError('This bill is paid — refund it instead of voiding a line', 409, 'ORDER_PAID')
  }

  const item = order.items.find((entry) => entry.id === params.itemId)
  if (!item) throw new NotFoundError('Item')
  if (item.status === 'CANCELLED') {
    throw new AppError('That item is already voided', 409, 'ITEM_ALREADY_VOID')
  }

  const active = order.items.filter((entry) => entry.status !== 'CANCELLED')
  if (active.length === 1) {
    throw new AppError(
      'That is the only item left — cancel the whole bill instead',
      400,
      'VOID_LAST_ITEM',
    )
  }

  return prisma.$transaction(async (tx) => {
    await tx.orderItem.update({
      where: { id: item.id },
      data: { status: 'CANCELLED' },
    })

    await tx.orderEvent.create({
      data: {
        orderId: order.id,
        status: order.status,
        note: `Voided ${item.quantity} × ${item.name} — ${reason}`,
        actorId: params.actorId ?? null,
        actorName: params.actorName ?? null,
      },
    })

    const updated = await recalculateOrderTotals(tx, order.id)
    return { order: updated, itemName: item.name, lineTotal: item.lineTotal }
  })
}
