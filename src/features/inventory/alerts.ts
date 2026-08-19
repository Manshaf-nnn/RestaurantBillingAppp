import 'server-only'

import type { StockAlertLevel } from '@prisma/client'

import { prisma } from '@/server/db/prisma'

/**
 * Stock alerts and the inventory value figure.
 *
 * Levels are derived on read rather than stored, because they are a pure
 * function of the current balance and the item's own thresholds. Storing them
 * would mean a background job had to keep them fresh, and a stale "in stock"
 * badge is worse than no badge.
 */

export interface StockAlert {
  itemId: string
  name: string
  level: StockAlertLevel
  quantity: number
  reorderLevel: number
  minStock: number
  maxStock: number | null
  unit: string
  branchName: string | null
  locationName: string | null
}

/**
 * Classify one item.
 *
 * Order matters: a negative balance is reported as out of stock rather than
 * low, and overstock is only meaningful when a par level has been set.
 */
export function levelFor(item: {
  quantity: number
  reorderLevel: number
  minStock: number
  maxStock: number | null
}): StockAlertLevel | null {
  if (item.quantity <= 0) return 'OUT_OF_STOCK'
  const floor = Math.max(item.reorderLevel, item.minStock)
  if (floor > 0 && item.quantity <= floor) return 'LOW_STOCK'
  if (item.maxStock && item.maxStock > 0 && item.quantity > item.maxStock) return 'OVERSTOCK'
  return null
}

export async function listStockAlerts(params: {
  restaurantId: string
  branchId?: string | null
}): Promise<StockAlert[]> {
  const items = await prisma.inventoryItem.findMany({
    where: {
      restaurantId: params.restaurantId,
      isActive: true,
      ...(params.branchId ? { branchId: params.branchId } : {}),
    },
    select: {
      id: true,
      name: true,
      quantity: true,
      reorderLevel: true,
      minStock: true,
      maxStock: true,
      unit: true,
      branch: { select: { name: true } },
      location: { select: { name: true } },
    },
  })

  const alerts: StockAlert[] = []
  for (const item of items) {
    const level = levelFor(item)
    if (!level) continue
    alerts.push({
      itemId: item.id,
      name: item.name,
      level,
      quantity: item.quantity,
      reorderLevel: item.reorderLevel,
      minStock: item.minStock,
      maxStock: item.maxStock,
      unit: item.unit,
      branchName: item.branch?.name ?? null,
      locationName: item.location?.name ?? null,
    })
  }

  // Out of stock first — that is the one that stops service.
  const rank: Record<StockAlertLevel, number> = { OUT_OF_STOCK: 0, LOW_STOCK: 1, OVERSTOCK: 2 }
  return alerts.sort((a, b) => rank[a.level] - rank[b.level] || a.name.localeCompare(b.name))
}

export interface InventorySummary {
  totalItems: number
  outOfStock: number
  lowStock: number
  overstock: number
  /** Sum of quantity × average cost, in minor units. */
  inventoryValue: number
}

/**
 * Headline inventory figures.
 *
 * Value uses the weighted average cost the ledger maintains, and ignores
 * negative balances — a negative quantity is a bookkeeping problem, not a
 * negative asset, and letting it subtract would understate the real holding.
 */
export async function getInventorySummary(params: {
  restaurantId: string
  branchId?: string | null
}): Promise<InventorySummary> {
  const items = await prisma.inventoryItem.findMany({
    where: {
      restaurantId: params.restaurantId,
      isActive: true,
      ...(params.branchId ? { branchId: params.branchId } : {}),
    },
    select: {
      quantity: true,
      costPerUnit: true,
      reorderLevel: true,
      minStock: true,
      maxStock: true,
    },
  })

  let outOfStock = 0
  let lowStock = 0
  let overstock = 0
  let inventoryValue = 0

  for (const item of items) {
    const level = levelFor(item)
    if (level === 'OUT_OF_STOCK') outOfStock += 1
    else if (level === 'LOW_STOCK') lowStock += 1
    else if (level === 'OVERSTOCK') overstock += 1

    if (item.quantity > 0) inventoryValue += item.quantity * item.costPerUnit
  }

  return {
    totalItems: items.length,
    outOfStock,
    lowStock,
    overstock,
    inventoryValue: Math.round(inventoryValue),
  }
}
