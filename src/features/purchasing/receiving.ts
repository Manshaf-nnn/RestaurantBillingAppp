import 'server-only'

import type { GoodsReceipt, StockUnit } from '@prisma/client'

import { AppError, NotFoundError } from '@/lib/errors'
import { prisma, guardLocks, type TxClient } from '@/server/db/prisma'
import { postMovement } from '@/features/inventory/ledger'
import { toBaseUnits } from '@/features/inventory/units'
import { RECEIVABLE_STATUSES, nextNumber, requirePurchase } from './service'

/**
 * Goods receiving.
 *
 * This is the only place a purchase order touches stock, and it is the reason
 * the order itself never does. Ordering 100 boxes says nothing about what is in
 * the store; receiving 90 of them does.
 *
 * ── Accepted vs rejected ────────────────────────────────────────────────────
 *
 * A delivery of 100 where 5 are spoiled is recorded as 95 accepted and 5
 * rejected. Only the accepted quantity is posted to the ledger — the rejected
 * goods were never ours, so putting them in and taking them out again would
 * invent two movements that never physically happened. The rejection is still
 * recorded against the line, so the supplier's reliability is visible later.
 *
 * ── Status ──────────────────────────────────────────────────────────────────
 *
 * The order's status is derived from its lines after every receipt rather than
 * set by hand: fully received on every line means RECEIVED, anything received
 * at all means PARTIALLY_RECEIVED. Deriving it means a corrected receipt cannot
 * leave the order claiming a state its own lines contradict.
 */

export interface ReceiveLineInput {
  purchaseItemId: string
  acceptedQty: number
  rejectedQty?: number
  /** Overrides the ordered cost when the supplier's invoice differs. */
  unitCost?: number
  rejectReason?: string | null
  batchNo?: string | null
  expiryDate?: Date | null
}

export async function receiveGoods(params: {
  restaurantId: string
  purchaseId: string
  lines: ReceiveLineInput[]
  supplierRef?: string | null
  /** The date on the supplier's invoice, when it was entered. */
  invoiceDate?: Date | null
  notes?: string | null
  /*
   * Where this delivery actually landed, when it is not where the order said.
   *
   * The destination used to be taken from `po.branchId` with no way to say
   * otherwise, so a van diverted to another site could not be recorded
   * truthfully — the stock went onto the wrong shelf in the books and the
   * difference surfaced weeks later as a variance nobody could account for.
   * Null keeps the ordinary behaviour: receive where the order said.
   */
  branchId?: string | null
  locationId?: string | null
  userId?: string | null
  /**
   * One id per submission, minted by the screen. The over-receipt check
   * below stops FOUR deliveries of 50 landing against a 50-unit order; it
   * does nothing about the SAME delivery of 50 posted twice when the total
   * still fits — a double-tap put the stock in twice and credited the
   * supplier twice. The replay read inside the lock is what stops that.
   */
  clientRequestId?: string | null
}): Promise<{
  receipt: GoodsReceipt
  status: string
  posted: number
  /**
   * Where the delivery differed from the order, per line, for the audit row
   * and the confirmation. A variance is never silent: it is recorded on the
   * receipt line, shown on the GRN, and named here.
   */
  variances: Array<{
    itemId: string
    name: string
    orderedUnitCost: number
    unitCost: number
    /** Signed, as a fraction of the ordered price: 0.015 is 1.5% dearer. */
    priceVariance: number
  }>
}> {
  const po = await requirePurchase(params.restaurantId, params.purchaseId)

  /*
   * A whitelist, not a blacklist. Receiving is the only thing in purchasing
   * that touches stock, so the question is "may stock move for this order",
   * and the answer is yes for exactly the approved states. A draft, a request
   * still being decided, one sent back or refused, one closed or cancelled —
   * none of them is an authority to put goods on the shelf.
   */
  if (po.status === 'CANCELLED') {
    throw new AppError('That order was cancelled', 409, 'PO_CANCELLED')
  }
  if (po.status === 'CLOSED') {
    throw new AppError('That order is closed — nothing more can be received against it', 409, 'PO_CLOSED')
  }
  // RECEIVED is let through to the line checks on purpose: every line is
  // already complete, so anything sent is refused as over-receipt — naming
  // the item and the quantity, which is the more useful answer.
  if (po.status !== 'RECEIVED' && !RECEIVABLE_STATUSES.includes(po.status)) {
    throw new AppError(
      'Approve the order before receiving against it',
      409,
      'PO_NOT_APPROVED',
    )
  }
  if (params.lines.length === 0) {
    throw new AppError('Nothing to receive', 400, 'RECEIPT_EMPTY')
  }

  /*
   * A retry is answered before anything is checked against the order.
   *
   * The over-receipt check below reads what has ALREADY been received — which,
   * after the first attempt landed, includes this very delivery. So a retry of
   * a receipt that completed a line used to be refused as "more than ordered",
   * an error about a delivery that had in fact succeeded. The read inside the
   * lock further down still guards the race; this one makes the honest answer
   * come first.
   */
  if (params.clientRequestId) {
    const already = await prisma.goodsReceipt.findFirst({
      where: { restaurantId: params.restaurantId, clientRequestId: params.clientRequestId },
    })
    if (already) return { receipt: already, status: po.status, posted: 0, variances: [] }
  }

  // Resolved once, here, so every line of this receipt lands in the same place
  // and the receipt itself records where that was.
  const destinationBranchId = params.branchId ?? po.branchId
  const destinationLocationId = params.branchId
    ? params.locationId ?? null
    : params.locationId ?? po.locationId

  if (params.branchId) {
    const branch = await prisma.branch.findFirst({
      where: { id: params.branchId, restaurantId: params.restaurantId, deletedAt: null },
      select: { id: true },
    })
    if (!branch) throw new NotFoundError('Location')
  }

  const items = await prisma.purchaseItem.findMany({
    where: { purchaseId: po.id },
    include: { item: true },
  })
  const byId = new Map(items.map((i) => [i.id, i]))

  for (const line of params.lines) {
    const purchaseItem = byId.get(line.purchaseItemId)
    if (!purchaseItem) throw new NotFoundError('Purchase line')

    const accepted = line.acceptedQty ?? 0
    const rejected = line.rejectedQty ?? 0
    if (accepted < 0 || rejected < 0) {
      throw new AppError('Quantities cannot be negative', 400, 'RECEIPT_NEGATIVE')
    }
    if (accepted === 0 && rejected === 0) continue

    // Over-receipt is refused rather than absorbed: it usually means a typo or
    // a delivery against the wrong order, and silently accepting it would put
    // stock in that nobody ordered.
    const alreadyHandled = purchaseItem.receivedQty + purchaseItem.rejectedQty
    if (alreadyHandled + accepted + rejected > purchaseItem.quantity + 1e-6) {
      throw new AppError(
        `${purchaseItem.item.name}: that is more than the ${purchaseItem.quantity} ordered`,
        400,
        'RECEIPT_OVER',
      )
    }
  }

  return prisma.$transaction(async (tx) => {
    // Lock the order and re-check inside the transaction. The validation above
    // runs on data read before this point, so on its own it is only advisory:
    // four simultaneous deliveries of 50 against a 50-unit order each saw an
    // empty order and each posted, receiving 200. Re-reading the received
    // quantities under a lock is what makes the refusal actually hold.
    await guardLocks(tx)
    await tx.$queryRaw`
      SELECT id FROM purchases
      WHERE id = ${po.id} AND "restaurantId" = ${params.restaurantId}
      FOR UPDATE
    `
    // Inside the fence: the purchase row is locked, so a retry of a receipt
    // that already posted is answered with it, and two taps in one instant
    // serialise on the lock rather than both passing this read.
    if (params.clientRequestId) {
      const already = await tx.goodsReceipt.findFirst({
        where: { restaurantId: params.restaurantId, clientRequestId: params.clientRequestId },
      })
      if (already) return { receipt: already, status: po.status, posted: 0, variances: [] }
    }
    const current = await tx.purchaseItem.findMany({
      where: { purchaseId: po.id },
      include: { item: { select: { name: true } } },
    })
    const handledById = new Map(current.map((l) => [l.id, l.receivedQty + l.rejectedQty]))

    for (const line of params.lines) {
      const already = handledById.get(line.purchaseItemId) ?? 0
      const ordered = current.find((l) => l.id === line.purchaseItemId)?.quantity ?? 0
      const incoming = (line.acceptedQty ?? 0) + (line.rejectedQty ?? 0)
      if (already + incoming > ordered + 1e-6) {
        throw new AppError(
          `${current.find((l) => l.id === line.purchaseItemId)?.item.name ?? 'That item'}: that is more than the ${ordered} ordered`,
          400,
          'RECEIPT_OVER',
        )
      }
    }

    const number = await nextNumber(tx, params.restaurantId, 'GRN', 'receipt')

    const receipt = await tx.goodsReceipt.create({
      data: {
        restaurantId: params.restaurantId,
        purchaseId: po.id,
        number,
        supplierRef: params.supplierRef?.trim() || null,
        invoiceDate: params.invoiceDate ?? null,
        notes: params.notes?.trim() || null,
        branchId: destinationBranchId,
        locationId: destinationLocationId,
        receivedById: params.userId ?? null,
        clientRequestId: params.clientRequestId ?? null,
      },
    })

    let posted = 0
    const variances: Array<{
      itemId: string
      name: string
      orderedUnitCost: number
      unitCost: number
      priceVariance: number
    }> = []

    for (const line of params.lines) {
      const purchaseItem = byId.get(line.purchaseItemId)!
      const accepted = line.acceptedQty ?? 0
      const rejected = line.rejectedQty ?? 0
      if (accepted === 0 && rejected === 0) continue

      const unit = (purchaseItem.unit ?? purchaseItem.item.unit) as StockUnit
      const unitCost = line.unitCost ?? purchaseItem.unitCost
      if (unitCost !== purchaseItem.unitCost) {
        variances.push({
          itemId: purchaseItem.itemId,
          name: purchaseItem.item.name,
          orderedUnitCost: purchaseItem.unitCost,
          unitCost,
          priceVariance:
            purchaseItem.unitCost > 0 ? (unitCost - purchaseItem.unitCost) / purchaseItem.unitCost : 0,
        })
      }

      await tx.goodsReceiptLine.create({
        data: {
          receiptId: receipt.id,
          purchaseItemId: purchaseItem.id,
          itemId: purchaseItem.itemId,
          acceptedQty: accepted,
          rejectedQty: rejected,
          unit,
          unitCost,
          rejectReason: line.rejectReason?.trim() || null,
          batchNo: line.batchNo?.trim() || null,
          expiryDate: line.expiryDate ?? null,
        },
      })

      await tx.purchaseItem.update({
        where: { id: purchaseItem.id },
        data: {
          receivedQty: { increment: accepted },
          rejectedQty: { increment: rejected },
        },
      })

      if (accepted > 0) {
        // Cost is quoted per purchase unit but the ledger keeps everything in
        // base units, so the per-unit cost has to be converted alongside the
        // quantity or the weighted average would be wrong by the pack size.
        const acceptedBase = toBaseUnits(accepted, unit, purchaseItem.item)
        const costPerBase = acceptedBase > 0 ? Math.round((accepted * unitCost) / acceptedBase) : unitCost

        /*
         * A tracked item delivered without a supplier lot number still needs
         * one, or its stock cannot be traced at all. Falling back to the GRN
         * is honest — that is genuinely which delivery it came from.
         */
        const batchNo =
          line.batchNo?.trim().toUpperCase() ||
          `${receipt.number}-${purchaseItem.item.sku ?? purchaseItem.itemId.slice(-4).toUpperCase()}`

        const movement = await postMovement(tx, {
          restaurantId: params.restaurantId,
          itemId: purchaseItem.itemId,
          type: 'PURCHASE',
          quantity: accepted,
          enteredUnit: unit,
          unitCost: costPerBase,
          /*
           * The exact value, not the rounded per-base cost times the base
           * quantity. 100 kg at 123.45/kg is 12,345.00 on the invoice and the
           * GRN journal; at 12/g (12.345 rounded) the ledger booked 12,000.00
           * and the stock valuation disagreed with the payable that created
           * it by 2.8% on every receipt — far worse on cheap bulk goods.
           */
          totalValue: accepted * unitCost,
          reason: `Received on ${receipt.number}`,
          referenceType: 'Purchase',
          referenceId: po.id,
          purchaseId: po.id,
          branchId: destinationBranchId,
          locationId: destinationLocationId,
          batchNo,
          expiryDate: line.expiryDate ?? null,
          userId: params.userId,
        })

        /*
         * The layer was created by `postMovement` above, from the exact
         * invoice value it was given.
         *
         * This used to call `upsertBatch` as well. Since the ledger started
         * creating layers that would make TWO for one delivery — and it handed
         * over the rounded per-base price, so the layer was worth something
         * different from the movement that created it: 650 paid for 1,000 g
         * became 1 a gram and the layer claimed 1,000, a 54% overstatement.
         * One layer, one value, one source.
         */
        const batch = await tx.stockBatch.findFirst({
          where: {
            restaurantId: params.restaurantId,
            itemId: purchaseItem.itemId,
            branchId: destinationBranchId,
            batchNo,
          },
          orderBy: { createdAt: 'desc' },
          select: { id: true, batchNo: true },
        })
        if (batch) {
          await tx.stockMovement.update({
            where: { id: movement.movement.id },
            data: { batchId: batch.id, batchNo: batch.batchNo },
          })
        }

        await tx.purchasePriceHistory.create({
          data: {
            restaurantId: params.restaurantId,
            itemId: purchaseItem.itemId,
            supplierId: po.supplierId,
            unitCost: costPerBase,
            quantity: acceptedBase,
            unit: purchaseItem.item.unit,
            receiptId: receipt.id,
          },
        })

        posted += 1
      }
    }

    // Derive the order's status from its own lines.
    const refreshed = await tx.purchaseItem.findMany({
      where: { purchaseId: po.id },
      select: { quantity: true, receivedQty: true, rejectedQty: true },
    })
    const complete = refreshed.every((l) => l.receivedQty + l.rejectedQty >= l.quantity - 1e-6)
    const anything = refreshed.some((l) => l.receivedQty > 0 || l.rejectedQty > 0)
    const status = complete ? 'RECEIVED' : anything ? 'PARTIALLY_RECEIVED' : po.status

    await tx.purchase.update({
      where: { id: po.id },
      data: { status, ...(complete ? { receivedAt: new Date() } : {}) },
    })

    return { receipt, status, posted, variances }
  })
}

/**
 * Send accepted stock back to a supplier.
 *
 * Unlike rejecting on delivery, this stock was accepted, counted and costed, so
 * it leaves through the ledger as RETURN_TO_SUPPLIER.
 */
export async function createPurchaseReturn(params: {
  restaurantId: string
  supplierId?: string | null
  purchaseId?: string | null
  /**
   * Where the goods left from. Required, and it was missing entirely: the
   * return posted its ledger row with no branch, so `applyLocationDelta`
   * skipped it — the restaurant-wide quantity fell and no location's balance
   * moved. Reconciliation would report that as unexplained drift for ever.
   */
  branchId: string
  reason: string
  notes?: string | null
  lines: Array<{ itemId: string; quantity: number; unit?: StockUnit | null; unitCost?: number }>
  userId?: string | null
}) {
  if (params.reason.trim().length < 2) {
    throw new AppError('Give a reason for the return', 400, 'RETURN_NO_REASON')
  }
  if (params.lines.length === 0) {
    throw new AppError('Nothing to return', 400, 'RETURN_EMPTY')
  }

  const items = await prisma.inventoryItem.findMany({
    where: { id: { in: params.lines.map((l) => l.itemId) }, restaurantId: params.restaurantId },
  })
  if (items.length !== new Set(params.lines.map((l) => l.itemId)).size) {
    throw new NotFoundError('Inventory item')
  }
  const byId = new Map(items.map((i) => [i.id, i]))

  return prisma.$transaction(async (tx) => {
    const number = await nextNumber(tx, params.restaurantId, 'PRT', 'return')

    const record = await tx.purchaseReturn.create({
      data: {
        restaurantId: params.restaurantId,
        branchId: params.branchId,
        supplierId: params.supplierId ?? null,
        purchaseId: params.purchaseId ?? null,
        number,
        reason: params.reason.trim(),
        notes: params.notes?.trim() || null,
        createdById: params.userId ?? null,
        lines: {
          create: params.lines.map((l) => ({
            itemId: l.itemId,
            quantity: l.quantity,
            unit: l.unit ?? null,
            unitCost: l.unitCost ?? 0,
          })),
        },
      },
    })

    for (const line of params.lines) {
      const item = byId.get(line.itemId)!
      await postMovement(tx, {
        restaurantId: params.restaurantId,
        itemId: line.itemId,
        type: 'RETURN_TO_SUPPLIER',
        quantity: line.quantity,
        enteredUnit: line.unit ?? item.unit,
        reason: `Returned on ${number} — ${params.reason.trim()}`,
        referenceType: 'PurchaseReturn',
        referenceId: record.id,
        purchaseId: params.purchaseId ?? null,
        branchId: params.branchId,
        userId: params.userId,
        /*
         * Goods go back off the delivery they came in on (FIFO.md), so what
         * leaves inventory is what the supplier is about to credit. Without
         * this the return draws the oldest layer instead, and the difference
         * between that price and the invoice's books as a profit on sending
         * goods back. A return with no purchase named has nothing to prefer
         * and falls through to ordinary FIFO.
         */
        preferLayers: await layersFromPurchase(tx, {
          restaurantId: params.restaurantId,
          purchaseId: params.purchaseId ?? null,
          itemId: line.itemId,
        }),
      })
    }

    return record
  })
}

/**
 * The layers one purchase put on the shelf for one item, oldest first.
 *
 * Every inbound movement writes a `StockMovementLot` row naming the layer it
 * created, so the trail from a purchase order back to its own stock already
 * exists — this just walks it. Used by returns, which must take the goods back
 * off the delivery that brought them rather than off the front of the queue.
 *
 * A layer already drawn down to nothing is still listed: it costs nothing to
 * include and the allocator simply never sees it, because `lockedLayers` only
 * reads open ones. Filtering here would need a second query to find out.
 */
async function layersFromPurchase(
  tx: TxClient,
  params: { restaurantId: string; purchaseId: string | null; itemId: string },
): Promise<string[] | null> {
  if (!params.purchaseId) return null

  const rows = await tx.stockMovementLot.findMany({
    where: {
      restaurantId: params.restaurantId,
      batchId: { not: null },
      movement: {
        purchaseId: params.purchaseId,
        itemId: params.itemId,
        // Inbound only. The same purchase's own returns are outbound and their
        // lot rows name the layers they DREW, which would send a second return
        // back to a layer the first one already emptied.
        quantity: { gt: 0 },
      },
    },
    select: { batchId: true },
    orderBy: { createdAt: 'asc' },
  })

  const ids = [...new Set(rows.map((row) => row.batchId!).filter(Boolean))]
  return ids.length > 0 ? ids : null
}
