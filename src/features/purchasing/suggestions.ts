import 'server-only'

import { prisma } from '@/server/db/prisma'

/**
 * Reorder suggestions and price trends.
 *
 * The suggestion answers "what should I buy, and how much?" rather than just
 * flagging that something is low. Quantity is proposed up to the par level
 * where one is set, and to twice the reorder level otherwise — enough to clear
 * the alert with headroom, rather than ordering exactly the shortfall and being
 * low again by the weekend.
 */

export interface ReorderSuggestion {
  itemId: string
  name: string
  unit: string
  currentQty: number
  reorderLevel: number
  maxStock: number | null
  /** In base units. */
  suggestedQty: number
  /** Estimated cost of the suggestion, minor units. */
  estimatedCost: number
  supplierId: string | null
  supplierName: string | null
  leadTimeDays: number | null
  minOrderQty: number | null
}

export async function getReorderSuggestions(params: {
  restaurantId: string
  branchId?: string | null
}): Promise<ReorderSuggestion[]> {
  const items = await prisma.inventoryItem.findMany({
    where: {
      restaurantId: params.restaurantId,
      isActive: true,
      ...(params.branchId ? { branchId: params.branchId } : {}),
    },
    select: {
      id: true, name: true, unit: true, quantity: true, reorderLevel: true,
      minStock: true, maxStock: true, costPerUnit: true,
      supplierItems: {
        where: { isActive: true },
        orderBy: [{ isPreferred: 'desc' }, { price: 'asc' }],
        take: 1,
        select: {
          price: true, leadTimeDays: true, minOrderQty: true,
          supplier: { select: { id: true, name: true } },
        },
      },
    },
  })

  const suggestions: ReorderSuggestion[] = []

  for (const item of items) {
    const floor = Math.max(item.reorderLevel, item.minStock)
    if (floor <= 0 || item.quantity > floor) continue

    const target = item.maxStock && item.maxStock > floor ? item.maxStock : floor * 2
    let suggested = round(target - item.quantity)
    if (suggested <= 0) continue

    const source = item.supplierItems[0]
    // Never suggest less than the supplier is willing to sell.
    if (source?.minOrderQty && suggested < source.minOrderQty) suggested = source.minOrderQty

    suggestions.push({
      itemId: item.id,
      name: item.name,
      unit: item.unit,
      currentQty: item.quantity,
      reorderLevel: item.reorderLevel,
      maxStock: item.maxStock,
      suggestedQty: suggested,
      estimatedCost: Math.round(suggested * (source?.price || item.costPerUnit)),
      supplierId: source?.supplier.id ?? null,
      supplierName: source?.supplier.name ?? null,
      leadTimeDays: source?.leadTimeDays ?? null,
      minOrderQty: source?.minOrderQty ?? null,
    })
  }

  // Most urgent first: furthest below its own floor, proportionally.
  return suggestions.sort(
    (a, b) => a.currentQty / (a.reorderLevel || 1) - b.currentQty / (b.reorderLevel || 1),
  )
}

export interface PricePoint {
  recordedAt: string
  unitCost: number
  supplierName: string | null
  quantity: number
}

export interface PriceTrend {
  itemId: string
  name: string
  unit: string
  points: PricePoint[]
  first: number | null
  latest: number | null
  /** Percentage change from the first recorded price to the latest. */
  changePercent: number | null
}

/** What an item has cost over time, oldest first. */
export async function getPriceTrend(params: {
  restaurantId: string
  itemId: string
  limit?: number
}): Promise<PriceTrend> {
  const item = await prisma.inventoryItem.findFirstOrThrow({
    where: { id: params.itemId, restaurantId: params.restaurantId },
    select: { id: true, name: true, unit: true },
  })

  const history = await prisma.purchasePriceHistory.findMany({
    where: { itemId: params.itemId, restaurantId: params.restaurantId },
    orderBy: { recordedAt: 'asc' },
    take: params.limit ?? 60,
    include: { supplier: { select: { name: true } } },
  })

  const points: PricePoint[] = history.map((h) => ({
    recordedAt: h.recordedAt.toISOString(),
    unitCost: h.unitCost,
    supplierName: h.supplier?.name ?? null,
    quantity: h.quantity,
  }))

  const first = points[0]?.unitCost ?? null
  const latest = points[points.length - 1]?.unitCost ?? null

  return {
    itemId: item.id,
    name: item.name,
    unit: item.unit,
    points,
    first,
    latest,
    changePercent:
      first && latest && first > 0 ? Math.round(((latest - first) / first) * 10000) / 100 : null,
  }
}

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6
}
