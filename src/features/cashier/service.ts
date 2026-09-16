import 'server-only'

import type { Order } from '@prisma/client'

import { AppError, NotFoundError } from '@/lib/errors'
import { computeTotals, derivePaymentStatus } from '@/features/orders/pricing'
import { rowStatusFromCounters } from '@/features/orders/progress'
import { assertPeriodOpen } from '@/features/accounting/service'
import { reconcileIfDepleted, reconcileOrderDepletion } from '@/features/inventory/depletion'
import { nextCounterValue } from '@/server/db/counters'
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
    select: { currency: true, loyaltyPointValue: true },
  })

  const totals = computeTotals({
    lines: order.items,
    taxRateBps: order.taxRateBps,
    serviceChargeBps: order.serviceChargeBps,
    // The bill's own rule, snapshotted at placement like the rates above.
    // Reading the restaurant's CURRENT setting here meant flipping the switch
    // in Settings silently repriced every open bill on the next recompute.
    taxInclusive: order.taxInclusive,
    // The order already stores what was actually granted; a discount is not
    // re-evaluated here, only re-applied, and it is clamped to the new subtotal
    // by computeTotals so a split can never leave a discount larger than the bill.
    couponDiscount: order.couponDiscount,
    manualDiscount: order.manualDiscount,
    loyaltyDiscount: order.loyaltyDiscount,
    tipAmount: order.tipAmount,
    currency: restaurant.currency,
    // Must match how the bill was priced at checkout, which rounds the grand
    // total to the nearest major unit. Recomputing without it made splitting or
    // merging change what the guest owes by up to a rupee, and meant a split
    // followed by a merge did not return the original total.
    roundTotal: true,
  })

  /*
   * A bill that shrank can no longer absorb everything that was taken off it.
   * `computeTotals` clamps the loyalty and coupon discounts to the new
   * subtotal — right for the bill, and silently wrong for the guest, whose
   * points were debited at placement and whose coupon was counted as used.
   * Whatever the clamp removed goes back where it came from, the way
   * `cancelOrder` returns everything on a cancellation.
   */
  const loyaltyLost = order.loyaltyDiscount - totals.loyaltyDiscount
  if (loyaltyLost > 0 && order.customerId && restaurant.loyaltyPointValue > 0) {
    const returned = Math.round(loyaltyLost / restaurant.loyaltyPointValue)
    if (returned > 0) {
      await tx.customer.update({
        where: { id: order.customerId },
        data: { loyaltyPoints: { increment: returned } },
      })
      await tx.loyaltyEntry.create({
        data: {
          restaurantId: order.restaurantId,
          customerId: order.customerId,
          orderId: order.id,
          points: returned,
          kind: 'RETURNED',
          note: `${order.orderNumber} reduced — ${returned} points it no longer needed were returned`,
        },
      })
    }
  }
  if (order.couponDiscount > totals.couponDiscount) {
    // The redemption records what the coupon actually took off this bill.
    await tx.couponRedemption.updateMany({
      where: { orderId: order.id },
      data: { amount: totals.couponDiscount },
    })
  }

  return tx.order.update({
    where: { id: orderId },
    data: {
      subtotal: totals.subtotal,
      discountTotal: totals.discountTotal,
      couponDiscount: totals.couponDiscount,
      manualDiscount: totals.manualDiscount,
      loyaltyDiscount: totals.loyaltyDiscount,
      serviceCharge: totals.serviceCharge,
      taxTotal: totals.taxTotal,
      tipAmount: totals.tipAmount,
      roundingAdj: totals.roundingAdj,
      grandTotal: totals.grandTotal,
      // Derived from the money, never left as it was: a bill that grew past
      // what was collected is PARTIAL again, whatever it said before.
      paymentStatus: derivePaymentStatus({
        paidTotal: order.paidTotal,
        grandTotal: totals.grandTotal,
        tipAmount: totals.tipAmount,
        current: order.paymentStatus,
      }),
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
        // A split bill is the same sitting at the same table — it belongs to
        // the branch the original did, not to whoever happens to be splitting.
        branchId: order.branchId,
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
        taxInclusive: order.taxInclusive,
        /*
         * The same sitting, the same table, the same guest — a split is the
         * bill divided, not a new customer. Without these the half could not
         * be found from the guest's phone (no guestSessionId), fell out of
         * the sitting's own total (no tableSessionId), and printed with no
         * table number.
         */
        channel: order.channel,
        tableNumber: order.tableNumber,
        tableSessionId: order.tableSessionId,
        guestSessionId: order.guestSessionId,
        guestCount: order.guestCount,
        notes: order.notes,
        couponId: order.couponId,
        servedById: order.servedById,
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

      /*
       * The plates already made stay with the original, first (abc.md §6).
       *
       * Three burgers with two prepared and one of those served, one burger
       * moving: the original keeps both prepared plates and the served one,
       * the moved line starts from nothing. Kept-first is what keeps
       * `served ≤ prepared ≤ quantity` true on BOTH rows whatever the split —
       * the database would refuse the write otherwise — and each row's status
       * is re-read from its own counters, so a split never shows a plate as
       * ready that has not been made.
       */
      const keptPrepared = Math.min(item.preparedQty, keptQty)
      const keptServed = Math.min(item.servedQty, keptPrepared)
      const movedPrepared = item.preparedQty - keptPrepared
      const movedServed = item.servedQty - keptServed
      const keptStatus = rowStatusFromCounters({
        quantity: keptQty, preparedQty: keptPrepared, servedQty: keptServed, status: item.status,
      })
      const movedStatus = rowStatusFromCounters({
        quantity: movedQty, preparedQty: movedPrepared, servedQty: movedServed,
        status: item.status === 'SERVED' || item.status === 'READY' ? 'PREPARING' : item.status,
      })

      await tx.orderItem.update({
        where: { id: item.id },
        data: {
          quantity: keptQty, lineTotal: unit * keptQty,
          preparedQty: keptPrepared, servedQty: keptServed, status: keptStatus,
        },
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
          optionsTotal: item.optionsTotal,
          notes: item.notes,
          status: movedStatus,
          preparedQty: movedPrepared,
          servedQty: movedServed,
          costPrice: item.costPrice,
          /*
           * The pinned recipe follows the food.
           *
           * Without this the moved remainder resolves against whatever recipe is
           * active *now*, so a recipe changed since the kitchen accepted the bill
           * would make the reconcile below post a real stock movement caused by
           * nothing but somebody splitting a bill.
           */
          recipeId: item.recipeId,
          isVeg: item.isVeg,
          prepTimeMinutes: item.prepTimeMinutes,
        },
      })
    }

    await rebalanceDepletion(tx, order.restaurantId, [order.id, target.id])

    /*
     * The discounts travel with the food, pro-rata by what each side is now
     * worth. They used to stay on the source in full: split a discounted bill
     * and the target was re-billed at list price while the source kept a
     * discount sized for food it no longer holds — the two halves stopped
     * summing to the original the moment anything was taken off it. Rounding
     * remainders stay on the source, so the sum is conserved to the minor unit.
     */
    if (order.couponDiscount > 0 || order.manualDiscount > 0 || order.loyaltyDiscount > 0) {
      const [sourceSub, targetSub] = await Promise.all([
        tx.orderItem.aggregate({
          where: { orderId: order.id, status: { not: 'CANCELLED' } },
          _sum: { lineTotal: true },
        }),
        tx.orderItem.aggregate({
          where: { orderId: target.id, status: { not: 'CANCELLED' } },
          _sum: { lineTotal: true },
        }),
      ])
      const sourceValue = sourceSub._sum.lineTotal ?? 0
      const targetValue = targetSub._sum.lineTotal ?? 0
      const combined = sourceValue + targetValue
      if (combined > 0 && targetValue > 0) {
        const share = targetValue / combined
        const targetCoupon = Math.round(order.couponDiscount * share)
        const targetManual = Math.round(order.manualDiscount * share)
        const targetLoyalty = Math.round(order.loyaltyDiscount * share)
        // `discountTotal` is set alongside the split it is the sum of — the
        // `orders_discount_split` CHECK (discountTotal = coupon + manual) is
        // evaluated per statement, so leaving it stale here would fail before
        // the recalculate below could put it right. Loyalty is not part of it.
        await tx.order.update({
          where: { id: target.id },
          data: {
            couponDiscount: targetCoupon,
            manualDiscount: targetManual,
            loyaltyDiscount: targetLoyalty,
            discountTotal: targetCoupon + targetManual,
          },
        })
        await tx.order.update({
          where: { id: order.id },
          data: {
            couponDiscount: order.couponDiscount - targetCoupon,
            manualDiscount: order.manualDiscount - targetManual,
            loyaltyDiscount: order.loyaltyDiscount - targetLoyalty,
            discountTotal: (order.couponDiscount - targetCoupon) + (order.manualDiscount - targetManual),
          },
        })
      }
    }

    const source = await recalculateOrderTotals(tx, order.id)
    const updatedTarget = await recalculateOrderTotals(tx, target.id)

    return { source, target: updatedTarget }
  })
}

/**
 * Put stock back in step after order lines have moved between bills.
 *
 * ── The bug this exists to close ────────────────────────────────────────────
 *
 * Depletion is idempotent per ORDER: `OrderStockDepletion` is keyed
 * `@@unique([orderId, itemId])` and records how much has already been taken.
 * Splitting and merging re-parent `OrderItem` rows and used to leave that record
 * behind, so the arithmetic silently broke both ways:
 *
 *   · split — the source still claimed to have deducted for lines it no longer
 *     has, and the target deducted them again on its next status change. Five
 *     burgers' worth of buns came out of stock for three burgers.
 *   · merge — the source's rows were orphaned at a non-zero quantity for ever
 *     against a bill with no items, and the raw CANCELLED update below bypasses
 *     `cancelOrder`, so nothing ever gave them back.
 *
 * Reconciling is declarative — it computes want-minus-have per item — so running
 * it on every affected order after the move is enough. A source left with no
 * lines wants nothing and gets everything returned, which is why no `releaseAll`
 * special case is needed here.
 */
async function rebalanceDepletion(
  tx: TxClient,
  restaurantId: string,
  orderIds: string[],
): Promise<void> {
  const ids = [...new Set(orderIds)]

  /*
   * Only if something has actually been deducted.
   *
   * `reconcileOrderDepletion` pays no attention to order status, so running it
   * on a bill the kitchen has not accepted would take the whole thing out of
   * stock hours early. Whichever bill later reaches ACCEPTED deducts correctly
   * on its own.
   */
  const applied = await tx.orderStockDepletion.count({ where: { orderId: { in: ids } } })
  if (applied === 0) return

  // Ascending id order. Each reconcile takes `FOR UPDATE` on its own order, so
  // two merges over overlapping bills would deadlock in an arbitrary order.
  for (const orderId of [...ids].sort()) {
    await reconcileOrderDepletion(tx, { restaurantId, orderId })
  }
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
  /*
   * From the counter, not from COUNT(*): two concurrent splits of one bill
   * counted the same existing suffixes and both minted `-B`, and the loser
   * surfaced a raw unique-constraint failure. The counter is seeded from what
   * already exists the first time a root is split, so numbering continues
   * where it left off; after that the counter is the arbiter.
   */
  const key = `split:${root}`
  const existing = await tx.order.count({
    where: { restaurantId, orderNumber: { startsWith: `${root}-` } },
  })
  await tx.$executeRaw`
    INSERT INTO "restaurant_counters" ("restaurantId", "key", "value")
    VALUES (${restaurantId}, ${key}, ${existing})
    ON CONFLICT ("restaurantId", "key") DO NOTHING
  `
  const index = (await nextCounterValue(tx, restaurantId, key)) - 1
  // 'A' is the first split; wrap to a numeric suffix past 26 rather than break.
  const suffix = index < 26 ? String.fromCharCode(65 + index) : String(index + 1)
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
  // Same rule as voiding: a bill with money on it does not change shape.
  if (target.paidTotal > 0) {
    throw new AppError('The bill being merged into has a payment on it — refund it first', 409, 'ORDER_PAID')
  }

  const sources = await prisma.order.findMany({
    where: {
      id: { in: sourceIds },
      restaurantId: params.restaurantId,
      status: { in: [...OPEN_STATUSES] },
    },
    include: { items: true, redemptions: true },
  })

  if (sources.length !== sourceIds.length) {
    throw new AppError('One of those bills is no longer open', 409, 'MERGE_UNAVAILABLE')
  }
  const paid = sources.find((source) => source.paymentStatus !== 'UNPAID')
  if (paid) {
    throw new AppError(`${paid.orderNumber} already has a payment against it`, 409, 'ORDER_PAID')
  }

  // Signed books do not quietly change (§59) — void and discount already
  // asked; merging reshapes every bill involved and asks too.
  await assertPeriodOpen(prisma, params.restaurantId, target.placedAt, 'This bill')
  for (const source of sources) {
    await assertPeriodOpen(prisma, params.restaurantId, source.placedAt, source.orderNumber)
  }

  return prisma.$transaction(async (tx) => {
    for (const source of sources) {
      await tx.orderItem.updateMany({
        where: { orderId: source.id },
        data: { orderId: target.id },
      })

      /*
       * The coupon follows its food. Zeroing the source left its redemption
       * row pointing at a cancelled bill — the coupon's own take (AUDIT C5)
       * recorded against nothing — and `usedCount` counting a use that the
       * merged bill then carried again. One row per (coupon, bill): when the
       * target already redeemed the same coupon, the two become one with the
       * amounts added, and the coupon is used once, not twice.
       */
      for (const redemption of source.redemptions) {
        const onTarget = await tx.couponRedemption.findFirst({
          where: { orderId: target.id, couponId: redemption.couponId },
          select: { id: true },
        })
        if (onTarget) {
          await tx.couponRedemption.update({
            where: { id: onTarget.id },
            data: { amount: { increment: redemption.amount } },
          })
          await tx.couponRedemption.delete({ where: { id: redemption.id } })
          await tx.coupon.update({
            where: { id: redemption.couponId },
            data: { usedCount: { decrement: 1 } },
          })
        } else {
          await tx.couponRedemption.update({
            where: { id: redemption.id },
            data: { orderId: target.id },
          })
        }
      }

      /*
       * The source is set CANCELLED directly rather than through `cancelOrder`,
       * which is deliberate: an absorbed bill is not a cancelled one, and
       * `cancelOrder` would free the table and touch refunds. But that also
       * means nothing here returns the stock it had deducted — `rebalanceDepletion`
       * below is what does, once every line has moved.
       */
      await tx.order.update({
        where: { id: source.id },
        data: {
          status: 'CANCELLED',
          cancelledAt: new Date(),
          cancelReason: `Merged into ${target.orderNumber}`,
          mergedIntoId: target.id,
          subtotal: 0,
          discountTotal: 0,
          couponDiscount: 0,
          manualDiscount: 0,
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

    await rebalanceDepletion(tx, params.restaurantId, [
      target.id,
      ...sources.map((source) => source.id),
    ])

    /*
     * The absorbed bills' discounts come along with their food. Zeroing the
     * sources (above) without moving their discounts meant merging two
     * discounted bills quietly re-billed one of them at list price.
     */
    const absorbedCoupon = sources.reduce((sum, source) => sum + source.couponDiscount, 0)
    const absorbedManual = sources.reduce((sum, source) => sum + source.manualDiscount, 0)
    const absorbedLoyalty = sources.reduce((sum, source) => sum + source.loyaltyDiscount, 0)
    if (absorbedCoupon > 0 || absorbedManual > 0 || absorbedLoyalty > 0) {
      await tx.order.update({
        where: { id: target.id },
        data: {
          couponDiscount: { increment: absorbedCoupon },
          manualDiscount: { increment: absorbedManual },
          // "discountTotal is their sum, always" — and the database now
          // checks it on every write, so it moves in the same statement.
          discountTotal: { increment: absorbedCoupon + absorbedManual },
          loyaltyDiscount: { increment: absorbedLoyalty },
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

  // Signed books do not quietly change (§59).
  await assertPeriodOpen(prisma, params.restaurantId, order.placedAt)

  /*
   * ANY money on the bill, not only a settled one. A PARTIAL bill could be
   * voided below what had already been collected, and the overpayment then
   * appeared in no report, produced no refund and showed on no screen — the
   * rule `cancelOrder` already applies, brought here.
   */
  if (order.paidTotal > 0) {
    throw new AppError('This bill has money on it — refund the payment before voiding a line', 409, 'ORDER_PAID')
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

    /*
     * Put the ingredients back.
     *
     * Voiding a line only marked it CANCELLED and recalculated the money; the
     * stock it had already consumed stayed consumed. A busy counter voiding
     * mistakes all evening quietly drained the ledger against food that was
     * never served, and the loss looked like theft or wastage rather than a bug.
     *
     * `resolveOrderConsumption` ignores cancelled lines, so reconciling here
     * computes the new desired total and returns exactly the difference.
     */
    const stock = await reconcileIfDepleted(tx, {
      restaurantId: order.restaurantId,
      orderId: order.id,
      userId: params.actorId ?? null,
    })

    const updated = await recalculateOrderTotals(tx, order.id)
    return { order: updated, itemName: item.name, lineTotal: item.lineTotal, stock }
  })
}
