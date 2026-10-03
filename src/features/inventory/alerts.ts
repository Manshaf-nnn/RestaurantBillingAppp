import 'server-only'

import type { StockAlertLevel } from '@prisma/client'

import { roundQty } from '@/lib/quantity'
import { prisma } from '@/server/db/prisma'
import { notify } from '@/server/notifications'

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
import { alertQuantity, levelFor } from './stock-level'
export { alertQuantity, alertThreshold, levelFor } from './stock-level'

/**
 * What each location-watched item holds at the location it watches.
 *
 * Only items whose "Alert me below" is pinned to one location appear, keyed by
 * item id; a pinned item with nothing there yet is simply absent, which every
 * reader takes as zero. One joined query rather than every item's stock rows:
 * the common case is that nothing is pinned and this returns nothing.
 *
 * Needed only with no location in view — with one chosen, the shelf on screen
 * either is the watched one or the threshold does not apply (`alertQuantity`).
 */
export async function stockAtAlertBranch(restaurantId: string): Promise<Map<string, number>> {
  const rows = await prisma.$queryRaw<Array<{ itemId: string; available: number }>>`
    SELECT i.id AS "itemId", COALESCE(SUM(s.available), 0)::float8 AS available
      FROM inventory_items i
      JOIN inventory_stock s ON s."itemId" = i.id AND s."branchId" = i."alertBranchId"
     WHERE i."restaurantId" = ${restaurantId}
       AND i."alertBranchId" IS NOT NULL
     GROUP BY i.id
  `
  return new Map(rows.map((row) => [row.itemId, Number(row.available)]))
}

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
      alertBranchId: true,
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

  const watched = params.branchId ? null : await stockAtAlertBranch(params.restaurantId)

  const alerts: StockAlert[] = []
  for (const item of items) {
    const level = levelFor({
      ...item,
      alertQuantity: alertQuantity({
        alertBranchId: item.alertBranchId,
        viewBranchId: params.branchId ?? null,
        quantity: item.quantity,
        atAlertBranch: watched?.get(item.id) ?? 0,
      }),
    })
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
      id: true,
      reorderLevel: true,
      minStock: true,
      maxStock: true,
      alertBranchId: true,
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
  /*
   * Stock value from the layers (FIFO.md), not `quantity × costPerUnit`.
   *
   * The multiplication took a restaurant-wide rate — and, when a branch was
   * chosen, multiplied it by that branch's quantity, so a location holding an
   * item bought cheaply was valued at the blend of every branch's purchases.
   * `remainingValue` already is what each layer holds, so this is an integer
   * sum scoped to whichever branch was asked about.
   */
  const layerValue = await prisma.stockBatch.aggregate({
    where: {
      restaurantId: params.restaurantId,
      remainingQty: { gt: 0 },
      ...(params.branchId ? { branchId: params.branchId } : {}),
    },
    _sum: { remainingValue: true },
  })
  const inventoryValue = layerValue._sum.remainingValue ?? 0

  const watched = params.branchId ? null : await stockAtAlertBranch(params.restaurantId)

  for (const item of items) {
    const level = levelFor({
      ...item,
      alertQuantity: alertQuantity({
        alertBranchId: item.alertBranchId,
        viewBranchId: params.branchId ?? null,
        quantity: item.quantity,
        atAlertBranch: watched?.get(item.id) ?? 0,
      }),
    })
    if (level === 'OUT_OF_STOCK') outOfStock += 1
    else if (level === 'LOW_STOCK') lowStock += 1
    else if (level === 'OVERSTOCK') overstock += 1
  }

  return {
    totalItems: items.length,
    outOfStock,
    lowStock,
    overstock,
    inventoryValue: Math.round(inventoryValue),
  }
}

/**
 * Tell the managers an item has hit its reorder level.
 *
 * The reorder level has existed on every item since the beginning, and until
 * now crossing it did nothing anybody could see: both call sites emitted a
 * websocket event that no client subscribes to and that does not exist at all
 * on Netlify, where realtime is off. An owner set 200 thresholds and found out
 * they were out of chicken when the kitchen could not accept the order.
 *
 * ── Once a day per item, not once per sale ──────────────────────────────────
 *
 * An item BELOW its level stays below it through every subsequent sale, so
 * without the window a busy evening would put forty entries about the same
 * chicken in the bell. A rolling 24 hours rather than "today" keeps this
 * timezone-free — the exact boundary does not matter, only that it does not
 * nag.
 *
 * Never throws: a failed notification must not cost anybody their sale or
 * their stock adjustment, so callers do not even await error handling.
 */
export async function notifyLowStock(params: {
  restaurantId: string
  branchId?: string | null
  item: {
    id: string; name: string; quantity: number; reorderLevel: number; unit: string
    /** The one location the threshold watches, when it is not the overall one. */
    alertBranchName?: string | null
  }
}): Promise<void> {
  try {
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000)
    const already = await prisma.notification.findFirst({
      where: {
        restaurantId: params.restaurantId,
        type: 'LOW_STOCK',
        createdAt: { gte: dayAgo },
        data: { path: ['itemId'], equals: params.item.id },
      },
      select: { id: true },
    })
    if (already) return

    await notify({
      restaurantId: params.restaurantId,
      branchId: params.branchId ?? null,
      type: 'LOW_STOCK',
      audience: 'MANAGEMENT',
      title: `${params.item.name} is running low`,
      body: params.item.alertBranchName
        ? `${params.item.quantity} ${params.item.unit.toLowerCase()} left at ${params.item.alertBranchName} — you asked to be told at ${params.item.reorderLevel} there.`
        : `${params.item.quantity} ${params.item.unit.toLowerCase()} left — you asked to be told at ${params.item.reorderLevel}.`,
      data: { itemId: params.item.id, href: '/dashboard/inventory' },
    })
  } catch {
    // Deliberately swallowed — see the docstring.
  }
}

export interface ItemAtReorderLevel {
  id: string
  name: string
  unit: string
  /** The balance the threshold watches — the total, or the one location's shelf. */
  quantity: number
  reorderLevel: number
  alertBranchId: string | null
  alertBranchName: string | null
}

/**
 * Which of these items a movement has left at or under their reorder level.
 *
 * Both callers used to compare the item's TOTAL to its level inline. That is
 * still the answer for an overall alert; an item that watches one location is
 * judged on that location's shelf instead, so a sale in the kitchen can warn
 * about the kitchen while the warehouse holds plenty — and a full kitchen is
 * not reported low because the total happens to be small.
 *
 * Read after the movement has committed, and never throws: the stock has
 * already moved, and a failed alert must not turn that into an error.
 */
export async function itemsAtReorderLevel(
  restaurantId: string,
  itemIds: string[],
): Promise<ItemAtReorderLevel[]> {
  if (itemIds.length === 0) return []
  try {
    const items = await prisma.inventoryItem.findMany({
      where: { id: { in: itemIds }, restaurantId },
      select: {
        id: true, name: true, quantity: true, reorderLevel: true, unit: true,
        alertBranchId: true,
        alertBranch: { select: { name: true } },
        locationStock: { select: { branchId: true, available: true } },
      },
    })
    return items
      .map((item) => ({
        id: item.id,
        name: item.name,
        unit: item.unit as string,
        quantity: item.alertBranchId
          ? roundQty(
              item.locationStock
                .filter((row) => row.branchId === item.alertBranchId)
                .reduce((sum, row) => sum + row.available, 0),
            )
          : item.quantity,
        reorderLevel: item.reorderLevel,
        alertBranchId: item.alertBranchId,
        alertBranchName: item.alertBranchId ? item.alertBranch?.name ?? null : null,
      }))
      .filter((item) => item.quantity <= item.reorderLevel)
  } catch {
    return []
  }
}
