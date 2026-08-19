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
  }
  rows: HistoryRow[]
  /** Sum of the ledger, for comparison against the cached balance. */
  ledgerTotal: number
}

export async function getItemHistory(params: {
  restaurantId: string
  itemId: string
  limit?: number
}): Promise<ItemHistory> {
  const item = await prisma.inventoryItem.findFirst({
    where: { id: params.itemId, restaurantId: params.restaurantId },
    select: {
      id: true, name: true, sku: true, unit: true, quantity: true,
      reorderLevel: true, minStock: true, maxStock: true,
      costPerUnit: true, lastPurchaseCost: true,
      branch: { select: { name: true } },
      location: { select: { name: true } },
    },
  })
  if (!item) throw new NotFoundError('Inventory item')

  const movements = await prisma.stockMovement.findMany({
    where: { itemId: item.id, restaurantId: params.restaurantId },
    orderBy: { createdAt: 'desc' },
    take: params.limit ?? 200,
    include: {
      user: { select: { name: true } },
      order: { select: { id: true, orderNumber: true } },
      purchase: { select: { id: true, number: true } },
      stockCount: { select: { id: true, reference: true } },
    },
  })

  const sum = await prisma.stockMovement.aggregate({
    where: { itemId: item.id, restaurantId: params.restaurantId },
    _sum: { quantity: true },
  })

  return {
    item: {
      id: item.id, name: item.name, sku: item.sku, unit: item.unit,
      quantity: item.quantity, reorderLevel: item.reorderLevel,
      minStock: item.minStock, maxStock: item.maxStock,
      costPerUnit: item.costPerUnit, lastPurchaseCost: item.lastPurchaseCost,
      branchName: item.branch?.name ?? null,
      locationName: item.location?.name ?? null,
    },
    ledgerTotal: Math.round((sum._sum?.quantity ?? 0) * 1e6) / 1e6,
    rows: movements.map((m) => {
      let sourceLabel: string | null = null
      let sourceHref: string | null = null

      if (m.order) {
        sourceLabel = m.order.orderNumber
        sourceHref = `/dashboard/orders/${m.order.id}`
      } else if (m.purchase) {
        sourceLabel = m.purchase.number ?? 'Purchase'
        sourceHref = `/dashboard/purchases`
      } else if (m.stockCount) {
        sourceLabel = m.stockCount.reference
        sourceHref = `/dashboard/inventory/counts/${m.stockCount.id}`
      } else if (m.referenceType === 'Transfer' && m.referenceId) {
        sourceLabel = m.referenceId
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
