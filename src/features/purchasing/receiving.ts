import 'server-only'

import type { GoodsReceipt, StockUnit } from '@prisma/client'

import { AppError, NotFoundError } from '@/lib/errors'
import { prisma, guardLocks} from '@/server/db/prisma'
import { postMovement } from '@/features/inventory/ledger'
import { toBaseUnits } from '@/features/inventory/units'
import { upsertBatch } from '@/features/inventory/batches'
import { nextNumber, requirePurchase } from './service'

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
}): Promise<{ receipt: GoodsReceipt; status: string; posted: number }> {
  const po = await requirePurchase(params.restaurantId, params.purchaseId)

  if (po.status === 'CANCELLED') {
    throw new AppError('That order was cancelled', 409, 'PO_CANCELLED')
  }
  if (po.status === 'DRAFT' || po.status === 'PENDING_APPROVAL') {
    throw new AppError(
      'Approve the order before receiving against it',
      409,
      'PO_NOT_APPROVED',
    )
  }
  if (params.lines.length === 0) {
    throw new AppError('Nothing to receive', 400, 'RECEIPT_EMPTY')
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
        notes: params.notes?.trim() || null,
        branchId: destinationBranchId,
        locationId: destinationLocationId,
        receivedById: params.userId ?? null,
      },
    })

    let posted = 0

    for (const line of params.lines) {
      const purchaseItem = byId.get(line.purchaseItemId)!
      const accepted = line.acceptedQty ?? 0
      const rejected = line.rejectedQty ?? 0
      if (accepted === 0 && rejected === 0) continue

      const unit = (purchaseItem.unit ?? purchaseItem.item.unit) as StockUnit
      const unitCost = line.unitCost ?? purchaseItem.unitCost

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

        const movement = await postMovement(tx, {
          restaurantId: params.restaurantId,
          itemId: purchaseItem.itemId,
          type: 'PURCHASE',
          quantity: accepted,
          enteredUnit: unit,
          unitCost: costPerBase,
          reason: `Received on ${receipt.number}`,
          referenceType: 'Purchase',
          referenceId: po.id,
          purchaseId: po.id,
          branchId: destinationBranchId,
          locationId: destinationLocationId,
          batchNo: line.batchNo?.trim() || null,
          expiryDate: line.expiryDate ?? null,
          userId: params.userId,
        })

        // Batch-tracked items get a lot record so the stock can be traced back
        // to this delivery, and so expiry and FEFO have something to work with.
        // Without this the batch tables stay empty however many deliveries
        // arrive, and the expiry board is permanently blank.
        if (purchaseItem.item.trackBatches) {
          const batchNo =
            line.batchNo?.trim().toUpperCase() ||
            // A tracked item delivered without a supplier lot number still needs
            // one, or its stock cannot be traced at all. Falling back to the GRN
            // is honest — that is genuinely which delivery it came from.
            `${receipt.number}-${purchaseItem.item.sku ?? purchaseItem.itemId.slice(-4).toUpperCase()}`

          const batch = await upsertBatch(tx, {
            restaurantId: params.restaurantId,
            itemId: purchaseItem.itemId,
            batchNo,
            quantity: acceptedBase,
            unitCost: costPerBase,
            expiryDate: line.expiryDate ?? null,
            locationId: destinationLocationId,
            branchId: destinationBranchId,
          })

          await tx.stockMovement.update({
            where: { id: movement.movement.id },
            data: { batchId: batch.id, batchNo },
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

    return { receipt, status, posted }
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
        userId: params.userId,
      })
    }

    return record
  })
}
