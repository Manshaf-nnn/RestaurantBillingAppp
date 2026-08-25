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

/*
 * `levelFor` moved to `stock-level.ts` so client screens can use it too — this
 * module is `server-only`, and the stock list had written a second, wrong copy
 * of the rule for want of an import it could make. Re-exported so nothing that
 * imports it from here has to move.
 */
import { levelFor } from './stock-level'
export { alertThreshold, levelFor } from './stock-level'

export async function listStockAlerts(params: {
  restaurantId: string
  branchId?: string | null
}): Promise<StockAlert[]> {
  /*
   * `branchId` scopes the QUANTITY, not the item list.
   *
   * This filtered `InventoryItem.branchId` — the item's notional home, which no
   * screen has ever written, so it is null on every row. Selecting any location
   * therefore returned nothing, and the whole inventory report went blank the
   * moment somebody used the branch switcher.
   *
   * Third occurrence of this exact mistake: `purchasing/suggestions.ts` carries
   * the original post-mortem, `count-queries.ts` had it too, and it type-checks
   * cleanly every time. `scripts/no-item-branch-filter.ts` now fails on it.
   */
  const rows = await prisma.inventoryItem.findMany({
    where: { restaurantId: params.restaurantId, isActive: true },
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
      ...(params.branchId
        ? {
            locationStock: {
              where: { branchId: params.branchId },
              select: { available: true },
            },
          }
        : {}),
    },
  })

  // With a location chosen, "how much is there" is that location's shelves —
  // not the restaurant-wide cached total, which would report the warehouse's
  // sugar as sitting in every branch at once.
  const items = rows.map((item) => ({
    ...item,
    quantity: params.branchId
      ? ('locationStock' in item ? item.locationStock : []).reduce(
          (sum, row) => sum + row.available,
          0,
        )
      : item.quantity,
  }))

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
  // Same correction as `listStockAlerts` above: the location narrows the
  // quantity, never the item list.
  const rows = await prisma.inventoryItem.findMany({
    where: { restaurantId: params.restaurantId, isActive: true },
    select: {
      quantity: true,
      costPerUnit: true,
      reorderLevel: true,
      minStock: true,
      maxStock: true,
      ...(params.branchId
        ? {
            locationStock: {
              where: { branchId: params.branchId },
              select: { available: true },
            },
          }
        : {}),
    },
  })

  const items = rows.map((item) => ({
    ...item,
    quantity: params.branchId
      ? ('locationStock' in item ? item.locationStock : []).reduce(
          (sum, row) => sum + row.available,
          0,
        )
      : item.quantity,
  }))

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
