import 'server-only'

import type { StockMovementType, StockUnit } from '@prisma/client'

import { NotFoundError } from '@/lib/errors'
import { prisma } from '@/server/db/prisma'

/**
 * One item's stock history.
 *
 * Every row carries where it came from, so a balance can always be explained.
 * `sourceHref` turns the reference into a link the reader can follow — an order
 * number back to the bill, a purchase back to the delivery, a stock count back
 * to the sheet that was approved.
 */

export interface HistoryRow {
  id: string
  type: StockMovementType
  /** Signed, in the item's base unit. */
  quantity: number
  /** As it was entered, e.g. 500 with unit GRAM. */
  quantityEntered: number | null
  enteredUnit: StockUnit | null
  balanceAfter: number | null
  unitCost: number
  reason: string | null
  notes: string | null
  actorName: string | null
  createdAt: string
  sourceLabel: string | null
  sourceHref: string | null
}

export interface ItemHistory {
  item: {
    id: string
    name: string
    sku: string | null
    unit: StockUnit
    quantity: number
    reorderLevel: number
    minStock: number
    maxStock: number | null
    costPerUnit: number
    lastPurchaseCost: number | null
    branchName: string | null
    locationName: string | null
    /*
     * The rest of what an item is. The detail page could show a balance and a
     * ledger and could not answer "what unit is this bought in, who supplies
     * it, when did we add it" — so the one screen named after the item told you
     * less about it than the row you clicked to get there.
     */
    category: string | null
    barcode: string | null
    purchaseUnit: string | null
    unitsPerPurchaseUnit: number | null
    supplierId: string | null
    supplierName: string | null
    storageArea: string | null
    expiryDate: string | null
    trackBatches: boolean
    trackExpiry: boolean
    isActive: boolean
    createdAt: string
    updatedAt: string
  }
  /** Where this item physically sits, per location. */
  stockByLocation: Array<{
    branchId: string
    branchName: string
    available: number
    reserved: number
    inTransit: number
  }>
  /** What it has been bought for, most recent first. */
  purchases: Array<{
    receiptId: string | null
    receiptNumber: string | null
    purchaseId: string
    purchaseNumber: string
    supplierName: string | null
    receivedAt: string
    quantity: number
    unit: string | null
    unitCost: number
    lineTotal: number
  }>
  rows: HistoryRow[]
  /** Sum of the ledger, for comparison against the cached balance. */
  ledgerTotal: number
}

export async function getItemHistory(params: {
  restaurantId: string
  itemId: string
  limit?: number
  /*
   * Which locations this reader may see. Null is unrestricted.
   *
   * An item is defined once for the whole restaurant, so the RECORD is not
   * branch-scoped and the page is rightly open to anyone with INVENTORY_VIEW.
   * What it holds, and what has happened to it, is per branch — and this page
   * was showing every branch's holdings and every branch's movements to a
   * site-scoped viewer.
   */
  branchIds?: string[] | null
}): Promise<ItemHistory> {
  const item = await prisma.inventoryItem.findFirst({
    where: { id: params.itemId, restaurantId: params.restaurantId },
    select: {
      id: true, name: true, sku: true, barcode: true, category: true, unit: true,
      quantity: true, reorderLevel: true, minStock: true, maxStock: true,
      costPerUnit: true, lastPurchaseCost: true,
      purchaseUnit: true, unitsPerPurchaseUnit: true,
      storageArea: true, expiryDate: true,
      trackBatches: true, trackExpiry: true, isActive: true,
      createdAt: true, updatedAt: true,
      supplierId: true,
      supplier: { select: { name: true } },
      branch: { select: { name: true } },
      location: { select: { name: true } },
    },
  })
  if (!item) throw new NotFoundError('Inventory item')

  const branchWhere = params.branchIds ? { branchId: { in: params.branchIds } } : {}

  const movements = await prisma.stockMovement.findMany({
    where: { itemId: item.id, restaurantId: params.restaurantId, ...branchWhere },
    orderBy: { createdAt: 'desc' },
    take: params.limit ?? 200,
    include: {
      user: { select: { name: true } },
      order: { select: { id: true, orderNumber: true } },
      purchase: { select: { id: true, number: true } },
      stockCount: { select: { id: true, reference: true } },
    },
  })

  const [sum, locationStock, receiptLines] = await Promise.all([
    prisma.stockMovement.aggregate({
      where: { itemId: item.id, restaurantId: params.restaurantId, ...branchWhere },
      _sum: { quantity: true },
    }),
    prisma.inventoryStock.findMany({
      where: { itemId: item.id, restaurantId: params.restaurantId, ...branchWhere },
      include: { branch: { select: { id: true, name: true } } },
    }),
    /*
     * Purchase history from what was actually RECEIVED, not what was ordered.
     * An order is a promise; a receipt is a fact, and the fact is what the
     * money and the stock followed.
     */
    prisma.goodsReceiptLine.findMany({
      where: {
        itemId: item.id,
        receipt: {
          restaurantId: params.restaurantId,
          // Every receipt records where it landed — the branch became required
          // in 20260903090000_branch_isolation_2, and older rows were
          // back-filled from their order — so there is no second arm to
          // consider any more.
          ...(params.branchIds ? { branchId: { in: params.branchIds } } : {}),
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
      include: {
        receipt: {
          select: {
            id: true,
            number: true,
            receivedAt: true,
            purchase: {
              select: { id: true, number: true, supplier: { select: { name: true } } },
            },
          },
        },
      },
    }),
  ])

  return {
    item: {
      id: item.id, name: item.name, sku: item.sku, unit: item.unit,
      quantity: item.quantity, reorderLevel: item.reorderLevel,
      minStock: item.minStock, maxStock: item.maxStock,
      costPerUnit: item.costPerUnit, lastPurchaseCost: item.lastPurchaseCost,
      branchName: item.branch?.name ?? null,
      category: item.category,
      barcode: item.barcode,
      purchaseUnit: item.purchaseUnit as string | null,
      unitsPerPurchaseUnit: item.unitsPerPurchaseUnit,
      supplierId: item.supplierId,
      supplierName: item.supplier?.name ?? null,
      storageArea: item.storageArea,
      expiryDate: item.expiryDate?.toISOString() ?? null,
      trackBatches: item.trackBatches,
      trackExpiry: item.trackExpiry,
      isActive: item.isActive,
      createdAt: item.createdAt.toISOString(),
      updatedAt: item.updatedAt.toISOString(),
      locationName: item.location?.name ?? null,
    },
    ledgerTotal: Math.round((sum._sum?.quantity ?? 0) * 1e6) / 1e6,
    stockByLocation: locationStock
      .map((row) => ({
        branchId: row.branch.id,
        branchName: row.branch.name,
        available: row.available,
        reserved: row.reserved,
        inTransit: row.inTransit,
      }))
      .sort((a, b) => b.available - a.available),
    purchases: receiptLines.map((line) => ({
      receiptId: line.receipt.id,
      receiptNumber: line.receipt.number,
      purchaseId: line.receipt.purchase.id,
      purchaseNumber: line.receipt.purchase.number,
      supplierName: line.receipt.purchase.supplier?.name ?? null,
      receivedAt: line.receipt.receivedAt.toISOString(),
      quantity: line.acceptedQty,
      unit: (line.unit ?? null) as string | null,
      unitCost: line.unitCost,
      lineTotal: Math.round(line.acceptedQty * line.unitCost),
    })),
    rows: movements.map((m) => {
      let sourceLabel: string | null = null
      let sourceHref: string | null = null

      if (m.order) {
        sourceLabel = m.order.orderNumber
        sourceHref = `/dashboard/orders/${m.order.id}`
      } else if (m.purchase) {
        sourceLabel = m.purchase.number ?? 'Purchase'
        // Was `/dashboard/purchases` — the list, not the order. Clicking the
        // number that caused a movement landed you on a page of every purchase
        // ever made and left you to find it.
        sourceHref = `/dashboard/purchases/${m.purchase.id}`
      } else if (m.stockCount) {
        sourceLabel = m.stockCount.reference
        sourceHref = `/dashboard/inventory/counts/${m.stockCount.id}`
      } else if (m.referenceType === 'StockTransfer' && m.referenceId) {
        sourceLabel = 'Transfer'
        sourceHref = `/dashboard/transfers/${m.referenceId}`
      } else if (m.referenceType === 'ProductionOrder' && m.referenceId) {
        sourceLabel = 'Production run'
        sourceHref = `/dashboard/production/${m.referenceId}`
      } else if (m.referenceType === 'Transfer' && m.referenceId) {
        sourceLabel = 'Transfer'
        sourceHref = `/dashboard/transfers/${m.referenceId}`
      }

      return {
        id: m.id,
        type: m.type,
        quantity: m.quantity,
        quantityEntered: m.quantityEntered,
        enteredUnit: m.enteredUnit,
        balanceAfter: m.balanceAfter,
        unitCost: m.unitCost,
        reason: m.reason,
        notes: m.notes,
        actorName: m.user?.name ?? null,
        createdAt: m.createdAt.toISOString(),
        sourceLabel,
        sourceHref,
      }
    }),
  }
}
