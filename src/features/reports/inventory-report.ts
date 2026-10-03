import 'server-only'

import { Prisma } from '@prisma/client'
import type { StockMovementType } from '@prisma/client'

import { alertQuantity, stockAtAlertBranch } from '@/features/inventory/alerts'
import { prisma } from '@/server/db/prisma'
import { roundQty } from '@/lib/quantity'

/**
 * Everything the Inventory Reports screen shows, in one module.
 *
 * ── Where the numbers come from ─────────────────────────────────────────────
 *
 * Stock VALUE is always `SUM(StockBatch.remainingValue)` — the sum of what is
 * left in each FIFO layer, in minor units (FIFO.md). Never quantity × a
 * blended rate: `costPerUnit` is restaurant-wide while the quantity is per
 * branch, so that multiplication disagrees with the layers, with the payable
 * that created them, and with itself between screens.
 *
 * Stock MOVEMENT is always `StockMovement.valueMoved`, which the ledger wrote
 * at the moment it drew the layers. Re-deriving it here from today's costs
 * would price last month's consumption at this month's prices.
 *
 * ── The four buckets ────────────────────────────────────────────────────────
 *
 * `StockMovementType` has sixteen values and a reader has four questions: what
 * came in, what went out, what moved between our own places, and what we
 * corrected. Everything is mapped onto those, and the mapping lives here so
 * the summary card, the movement table and the drill-down cannot disagree.
 */

export type MovementBucket = 'IN' | 'OUT' | 'TRANSFER' | 'ADJUSTMENT'

const BUCKETS: Record<MovementBucket, StockMovementType[]> = {
  IN: ['PURCHASE', 'PRODUCTION', 'CUSTOMER_RETURN'],
  OUT: ['SALE', 'CONSUMPTION', 'WASTE', 'WASTAGE', 'EXPIRY', 'PRODUCTION_CONSUMPTION', 'RETURN_TO_SUPPLIER', 'RETURN'],
  TRANSFER: ['TRANSFER_IN', 'TRANSFER_OUT'],
  ADJUSTMENT: ['ADJUSTMENT', 'ADJUSTMENT_IN', 'ADJUSTMENT_OUT'],
}

export const MOVEMENT_LABELS: Record<MovementBucket, string> = {
  IN: 'Stock In',
  OUT: 'Stock Out',
  TRANSFER: 'Stock Transfers',
  ADJUSTMENT: 'Stock Adjustments',
}

/** Which bucket a raw movement type reads as. */
export function bucketOf(type: StockMovementType): MovementBucket {
  for (const [bucket, types] of Object.entries(BUCKETS) as Array<[MovementBucket, StockMovementType[]]>) {
    if (types.includes(type)) return bucket
  }
  return 'ADJUSTMENT'
}

/** What consumption means for "top consumed items" — used up, not sent away. */
const CONSUMED: StockMovementType[] = [
  'SALE',
  'CONSUMPTION',
  'PRODUCTION_CONSUMPTION',
  'WASTE',
  'WASTAGE',
  'EXPIRY',
]

export interface InventoryReportParams {
  restaurantId: string
  /** Null means every location. */
  branchId?: string | null
  from: Date
  to: Date
}

export interface LowStockRow {
  itemId: string
  name: string
  category: string
  quantity: number
  unit: string
  reorderLevel: number
  /** The one location the threshold watches; null when it is the overall one. */
  alertBranchName: string | null
  outOfStock: boolean
}

export interface HeadlineFigure {
  value: number
  /** Signed change against the previous window of the same length, as a fraction. */
  change: number | null
}

export interface InventoryReportData {
  totalValue: number
  /** Against the same length of time before `from`. */
  totalValueChange: number | null
  totalItems: number
  categoryCount: number
  lowStock: HeadlineFigure
  outOfStock: HeadlineFigure
  usageValue: HeadlineFigure
  trend: Array<{ date: string; value: number }>
  byCategory: Array<{ category: string; items: number; quantity: number; value: number; share: number }>
  topConsumed: Array<{
    itemId: string
    name: string
    category: string
    quantity: number
    unit: string
    value: number
  }>
  /** The five the summary card shows. */
  lowStockItems: LowStockRow[]
  /**
   * Every item below its level, for the drill-down.
   *
   * The same computation as `lowStockItems`, not a second query: a page that
   * re-derives "low" with its own predicate is a page that eventually
   * disagrees with the tile that linked to it.
   */
  lowStockItemsAll: LowStockRow[]
  movements: Array<{ bucket: MovementBucket; label: string; units: number; value: number }>
}

/** `where` for movements in the window, at the chosen location. */
function movementWhere(params: InventoryReportParams): Prisma.StockMovementWhereInput {
  return {
    restaurantId: params.restaurantId,
    ...(params.branchId ? { branchId: params.branchId } : {}),
    createdAt: { gte: params.from, lte: params.to },
  }
}

/** The layers at the chosen location — what stock is worth right now. */
function layerWhere(params: Pick<InventoryReportParams, 'restaurantId' | 'branchId'>): Prisma.StockBatchWhereInput {
  return {
    restaurantId: params.restaurantId,
    ...(params.branchId ? { branchId: params.branchId } : {}),
    remainingQty: { gt: 0 },
  }
}

const UNCATEGORISED = 'Uncategorised'

export async function getInventoryReport(params: InventoryReportParams): Promise<InventoryReportData> {
  const span = Math.max(1, params.to.getTime() - params.from.getTime())
  const prevFrom = new Date(params.from.getTime() - span)
  const prevTo = params.from

  const [layers, items, usage, prevUsage, movementRows, consumedRows, trendRows] = await Promise.all([
    // Value and quantity per item, from the layers.
    prisma.stockBatch.groupBy({
      by: ['itemId'],
      where: layerWhere(params),
      _sum: { remainingValue: true, remainingQty: true },
    }),
    prisma.inventoryItem.findMany({
      where: { restaurantId: params.restaurantId, isActive: true },
      select: {
        id: true, name: true, unit: true, category: true, quantity: true,
        reorderLevel: true, minStock: true,
        alertBranchId: true,
        alertBranch: { select: { name: true } },
        ...(params.branchId
          ? { locationStock: { where: { branchId: params.branchId }, select: { available: true } } }
          : {}),
      },
      orderBy: { name: 'asc' },
    }),
    prisma.stockMovement.aggregate({
      where: { ...movementWhere(params), type: { in: CONSUMED } },
      _sum: { valueMoved: true },
    }),
    prisma.stockMovement.aggregate({
      where: {
        restaurantId: params.restaurantId,
        ...(params.branchId ? { branchId: params.branchId } : {}),
        createdAt: { gte: prevFrom, lt: prevTo },
        type: { in: CONSUMED },
      },
      _sum: { valueMoved: true },
    }),
    prisma.stockMovement.groupBy({
      by: ['type'],
      where: movementWhere(params),
      _sum: { valueMoved: true, quantity: true },
      _count: true,
    }),
    prisma.stockMovement.groupBy({
      by: ['itemId'],
      where: { ...movementWhere(params), type: { in: CONSUMED } },
      _sum: { valueMoved: true, quantity: true },
      orderBy: { _sum: { valueMoved: 'desc' } },
      take: 5,
    }),
    /*
     * The trend, walked BACKWARDS from today's value.
     *
     * There is no history of what stock was worth on a past day — the layers
     * only know what is left now — so a day's closing value is today's value
     * minus every movement since. One grouped query gives the daily net, and
     * the series is a running subtraction over it. That is exact against the
     * ledger by construction: the same rows that moved the value are the ones
     * unwinding it.
     */
    prisma.$queryRaw<Array<{ day: Date; net: bigint }>>`
      SELECT date_trunc('day', "createdAt") AS day,
             SUM("valueMoved")::bigint      AS net
      FROM stock_movements
      WHERE "restaurantId" = ${params.restaurantId}
        AND "createdAt" >= ${params.from}
        AND "createdAt" <= ${params.to}
        ${params.branchId ? Prisma.sql`AND "branchId" = ${params.branchId}` : Prisma.empty}
      GROUP BY 1
      ORDER BY 1
    `,
  ])

  const valueByItem = new Map(layers.map((row) => [row.itemId, row._sum.remainingValue ?? 0]))
  const qtyByItem = new Map(layers.map((row) => [row.itemId, row._sum.remainingQty ?? 0]))
  const totalValue = [...valueByItem.values()].reduce((sum, value) => sum + value, 0)

  /** What this location holds, in base units. */
  const heldBy = (item: (typeof items)[number]) =>
    params.branchId
      ? ('locationStock' in item ? item.locationStock : []).reduce((sum, row) => sum + row.available, 0)
      : item.quantity

  const watchedAt = params.branchId ? null : await stockAtAlertBranch(params.restaurantId)

  let lowStock = 0
  let outOfStock = 0
  const byCategoryMap = new Map<string, { items: number; quantity: number; value: number }>()
  const lowStockItems: LowStockRow[] = []

  for (const item of items) {
    const held = heldBy(item)
    const floor = item.reorderLevel > 0 ? item.reorderLevel : item.minStock
    // The shelf the threshold watches: the one in view, unless the item's
    // alert is pinned to a single location (`alertQuantity`).
    const watched = alertQuantity({
      alertBranchId: item.alertBranchId,
      viewBranchId: params.branchId ?? null,
      quantity: held,
      atAlertBranch: watchedAt?.get(item.id) ?? 0,
    })
    const isOut = held <= 0
    const isLow = !isOut && floor > 0 && watched !== null && watched <= floor
    if (isOut) outOfStock += 1
    if (isLow) lowStock += 1
    if (isOut || isLow) {
      lowStockItems.push({
        itemId: item.id,
        name: item.name,
        category: item.category ?? UNCATEGORISED,
        // A low row quotes the shelf that made it low.
        quantity: roundQty(isLow && watched !== null ? watched : held),
        unit: item.unit as string,
        reorderLevel: floor,
        alertBranchName: item.alertBranchId ? item.alertBranch?.name ?? null : null,
        outOfStock: isOut,
      })
    }

    const key = item.category ?? UNCATEGORISED
    const row = byCategoryMap.get(key) ?? { items: 0, quantity: 0, value: 0 }
    row.items += 1
    row.quantity += qtyByItem.get(item.id) ?? 0
    row.value += valueByItem.get(item.id) ?? 0
    byCategoryMap.set(key, row)
  }

  // Out of stock first — those are the ones that stop service.
  lowStockItems.sort((a, b) => Number(b.outOfStock) - Number(a.outOfStock) || a.quantity - b.quantity)

  const byCategory = [...byCategoryMap.entries()]
    .map(([category, row]) => ({
      category,
      items: row.items,
      quantity: roundQty(row.quantity),
      value: row.value,
      share: totalValue > 0 ? row.value / totalValue : 0,
    }))
    .sort((a, b) => b.value - a.value)

  const itemById = new Map(items.map((item) => [item.id, item]))
  const topConsumed = consumedRows.map((row) => {
    const item = itemById.get(row.itemId)
    return {
      itemId: row.itemId,
      name: item?.name ?? 'Unknown item',
      category: item?.category ?? UNCATEGORISED,
      quantity: roundQty(Math.abs(row._sum.quantity ?? 0)),
      unit: (item?.unit as string) ?? '',
      value: Math.abs(row._sum.valueMoved ?? 0),
    }
  })

  const bucketTotals = new Map<MovementBucket, { units: number; value: number }>()
  for (const row of movementRows) {
    const bucket = bucketOf(row.type)
    const current = bucketTotals.get(bucket) ?? { units: 0, value: 0 }
    current.units += Math.abs(row._sum.quantity ?? 0)
    current.value += Math.abs(row._sum.valueMoved ?? 0)
    bucketTotals.set(bucket, current)
  }
  const movements = (Object.keys(BUCKETS) as MovementBucket[]).map((bucket) => ({
    bucket,
    label: MOVEMENT_LABELS[bucket],
    units: roundQty(bucketTotals.get(bucket)?.units ?? 0),
    value: bucketTotals.get(bucket)?.value ?? 0,
  }))

  /*
   * Unwind the daily nets from today's value to get each day's close, then
   * read it forwards. `netByDay` is signed: inbound value is positive and
   * outbound negative, exactly as the ledger wrote it.
   */
  const netByDay = new Map<string, number>()
  for (const row of trendRows) {
    netByDay.set(row.day.toISOString().slice(0, 10), Number(row.net))
  }
  const days: string[] = []
  for (let d = new Date(params.from); d <= params.to; d = new Date(d.getTime() + 86_400_000)) {
    days.push(d.toISOString().slice(0, 10))
  }
  const closing = new Map<string, number>()
  let running = totalValue
  for (const day of [...days].reverse()) {
    closing.set(day, running)
    running -= netByDay.get(day) ?? 0
  }
  const trend = days.map((date) => ({ date, value: Math.max(0, closing.get(date) ?? 0) }))

  /** The value at the start of the window, for the headline's change figure. */
  const openingValue = trend.length > 0 ? trend[0].value : totalValue
  const usageValue = Math.abs(usage._sum.valueMoved ?? 0)
  const prevUsageValue = Math.abs(prevUsage._sum.valueMoved ?? 0)

  const change = (now: number, before: number): number | null =>
    before > 0 ? (now - before) / before : null

  return {
    totalValue,
    totalValueChange: change(totalValue, openingValue),
    totalItems: items.length,
    categoryCount: byCategoryMap.size,
    // Counts have no meaningful "previous" without a snapshot table, and an
    // invented one would be a number nobody could check. Null renders as the
    // plain count with its caption, which is honest.
    lowStock: { value: lowStock, change: null },
    outOfStock: { value: outOfStock, change: null },
    usageValue: { value: usageValue, change: change(usageValue, prevUsageValue) },
    trend,
    byCategory,
    topConsumed,
    lowStockItems: lowStockItems.slice(0, 5),
    lowStockItemsAll: lowStockItems,
    movements,
  }
}

// ── the drill-downs ──────────────────────────────────────────────────────────

export interface ItemInventoryRow {
  itemId: string
  name: string
  category: string
  unit: string
  opening: number
  stockIn: number
  stockOut: number
  closing: number
  value: number
}

/**
 * Opening → in → out → closing, per item.
 *
 * Closing is what the layers hold now; opening is closing less everything
 * that moved in the window. Derived rather than stored for the same reason
 * the trend is: there is no snapshot table, and the movements are the truth.
 */
export async function listItemInventory(params: InventoryReportParams): Promise<ItemInventoryRow[]> {
  const [items, layers, moved] = await Promise.all([
    prisma.inventoryItem.findMany({
      where: { restaurantId: params.restaurantId, isActive: true },
      select: {
        id: true, name: true, unit: true, category: true, quantity: true,
        ...(params.branchId
          ? { locationStock: { where: { branchId: params.branchId }, select: { available: true } } }
          : {}),
      },
      orderBy: { name: 'asc' },
    }),
    prisma.stockBatch.groupBy({
      by: ['itemId'],
      where: layerWhere(params),
      _sum: { remainingValue: true },
    }),
    prisma.stockMovement.groupBy({
      by: ['itemId', 'type'],
      where: movementWhere(params),
      _sum: { quantity: true },
    }),
  ])

  const valueByItem = new Map(layers.map((row) => [row.itemId, row._sum.remainingValue ?? 0]))
  const inByItem = new Map<string, number>()
  const outByItem = new Map<string, number>()
  for (const row of moved) {
    const qty = Math.abs(row._sum.quantity ?? 0)
    const bucket = bucketOf(row.type)
    // Direction, not bucket: a transfer in adds and a transfer out removes.
    const inbound =
      bucket === 'IN' ||
      row.type === 'TRANSFER_IN' ||
      row.type === 'ADJUSTMENT_IN' ||
      (row.type === 'ADJUSTMENT' && (row._sum.quantity ?? 0) > 0)
    const map = inbound ? inByItem : outByItem
    map.set(row.itemId, (map.get(row.itemId) ?? 0) + qty)
  }

  return items.map((item) => {
    const closing = params.branchId
      ? ('locationStock' in item ? item.locationStock : []).reduce((sum, row) => sum + row.available, 0)
      : item.quantity
    const stockIn = inByItem.get(item.id) ?? 0
    const stockOut = outByItem.get(item.id) ?? 0
    return {
      itemId: item.id,
      name: item.name,
      category: item.category ?? UNCATEGORISED,
      unit: item.unit as string,
      opening: roundQty(closing - stockIn + stockOut),
      stockIn: roundQty(stockIn),
      stockOut: roundQty(stockOut),
      closing: roundQty(closing),
      value: valueByItem.get(item.id) ?? 0,
    }
  })
}

export interface MovementRow {
  id: string
  at: string
  type: StockMovementType
  bucket: MovementBucket
  itemId: string
  itemName: string
  quantity: number
  unit: string
  unitCost: number
  value: number
  reference: string | null
  branchName: string | null
}

export async function listMovementDetails(
  params: InventoryReportParams & { bucket?: MovementBucket | null; limit?: number },
): Promise<MovementRow[]> {
  const rows = await prisma.stockMovement.findMany({
    where: {
      ...movementWhere(params),
      ...(params.bucket ? { type: { in: BUCKETS[params.bucket] } } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: params.limit ?? 200,
    select: {
      id: true, createdAt: true, type: true, quantity: true, enteredUnit: true,
      unitCost: true, valueMoved: true, referenceType: true, referenceId: true, reason: true,
      item: { select: { id: true, name: true, unit: true } },
      branch: { select: { name: true } },
    },
  })

  return rows.map((row) => ({
    id: row.id,
    at: row.createdAt.toISOString(),
    type: row.type,
    bucket: bucketOf(row.type),
    itemId: row.item.id,
    itemName: row.item.name,
    quantity: roundQty(Math.abs(row.quantity)),
    unit: (row.enteredUnit ?? row.item.unit) as string,
    unitCost: row.unitCost,
    value: Math.abs(row.valueMoved),
    // The document it came from, where the movement names one.
    reference: row.referenceType && row.referenceId ? `${row.referenceType} ${row.referenceId.slice(0, 8)}` : row.reason,
    branchName: row.branch?.name ?? null,
  }))
}
