import 'server-only'

import type { StockCountStatus, StockUnit } from '@prisma/client'

import { NotFoundError } from '@/lib/errors'
import { prisma } from '@/server/db/prisma'

/**
 * Reads for the stock-count screens.
 *
 * The counting sheet deliberately does not carry the system quantity. Handing a
 * counter the number they are "supposed" to find is how counts come back
 * matching the system while the shelf says otherwise — people stop counting and
 * start confirming. The variance is revealed on the review screen instead,
 * where the person approving it can actually act on it.
 */

export interface CountSheetItem {
  itemId: string
  name: string
  sku: string | null
  unit: StockUnit
  category: string | null
  locationName: string | null
  /** What has been keyed in so far, in the item's base unit. Null = uncounted. */
  countedQty: number | null
  notes: string | null
}

export interface CountReviewLine extends Omit<CountSheetItem, 'countedQty'> {
  countedQty: number
  systemQty: number
  variance: number
  /** Variance × average cost, in minor units. Negative is a loss. */
  varianceValue: number
}

export interface StockCountDetail {
  id: string
  reference: string
  status: StockCountStatus
  notes: string | null
  countedByName: string | null
  countedAt: string
  approvedByName: string | null
  approvedAt: string | null
  /** Needed so the page can refuse a count belonging to another branch. */
  branchId: string | null
  branchName: string | null
  locationName: string | null
  currency: string
  /** Everything countable, whether counted yet or not. */
  sheet: CountSheetItem[]
  /** Only lines that have been counted, with variance revealed. */
  review: CountReviewLine[]
  totals: {
    counted: number
    uncounted: number
    withVariance: number
    /** Net value of all variances, minor units. */
    netVarianceValue: number
  }
}

export async function getStockCountDetail(params: {
  restaurantId: string
  stockCountId: string
  currency: string
}): Promise<StockCountDetail> {
  const count = await prisma.stockCount.findFirst({
    where: { id: params.stockCountId, restaurantId: params.restaurantId },
    include: {
      countedBy: { select: { name: true } },
      approvedBy: { select: { name: true } },
      branch: { select: { name: true } },
      location: { select: { name: true } },
      lines: true,
    },
  })
  if (!count) throw new NotFoundError('Stock count')

  // Everything active in scope is countable. A count scoped to a location only
  // offers that location's stock, so a counter is never asked about a shelf
  // they are not standing in front of.
  const items = await prisma.inventoryItem.findMany({
    where: {
      restaurantId: params.restaurantId,
      isActive: true,
      ...(count.branchId ? { branchId: count.branchId } : {}),
      ...(count.locationId ? { locationId: count.locationId } : {}),
    },
    orderBy: [{ category: 'asc' }, { name: 'asc' }],
    select: {
      id: true, name: true, sku: true, unit: true, category: true,
      quantity: true, costPerUnit: true,
      location: { select: { name: true } },
    },
  })

  const lineByItem = new Map(count.lines.map((l) => [l.itemId, l]))

  const sheet: CountSheetItem[] = items.map((item) => {
    const line = lineByItem.get(item.id)
    return {
      itemId: item.id,
      name: item.name,
      sku: item.sku,
      unit: item.unit,
      category: item.category,
      locationName: item.location?.name ?? null,
      countedQty: line ? line.countedQty : null,
      notes: line?.notes ?? null,
    }
  })

  const review: CountReviewLine[] = []
  let netVarianceValue = 0
  let withVariance = 0

  for (const item of items) {
    const line = lineByItem.get(item.id)
    if (!line) continue
    const varianceValue = Math.round(line.variance * item.costPerUnit)
    netVarianceValue += varianceValue
    if (Math.abs(line.variance) > 1e-6) withVariance += 1

    review.push({
      itemId: item.id,
      name: item.name,
      sku: item.sku,
      unit: item.unit,
      category: item.category,
      locationName: item.location?.name ?? null,
      countedQty: line.countedQty,
      notes: line.notes,
      systemQty: line.systemQty,
      variance: line.variance,
      varianceValue,
    })
  }

  review.sort((a, b) => Math.abs(b.variance) - Math.abs(a.variance))

  return {
    id: count.id,
    reference: count.reference,
    status: count.status,
    notes: count.notes,
    countedByName: count.countedBy?.name ?? null,
    countedAt: count.countedAt.toISOString(),
    approvedByName: count.approvedBy?.name ?? null,
    approvedAt: count.approvedAt?.toISOString() ?? null,
    branchId: count.branchId,
    branchName: count.branch?.name ?? null,
    locationName: count.location?.name ?? null,
    currency: params.currency,
    sheet,
    review,
    totals: {
      counted: count.lines.length,
      uncounted: items.length - count.lines.length,
      withVariance,
      netVarianceValue,
    },
  }
}

export interface StockCountSummary {
  id: string
  reference: string
  status: StockCountStatus
  countedByName: string | null
  countedAt: string
  approvedByName: string | null
  lineCount: number
  branchName: string | null
}

export async function listStockCounts(params: {
  restaurantId: string
  /** Locations the viewer may see. Null is unrestricted; [] sees nothing. */
  branchIds?: string[] | null
  limit?: number
}): Promise<StockCountSummary[]> {
  const counts = await prisma.stockCount.findMany({
    where: {
      restaurantId: params.restaurantId,
      ...(params.branchIds ? { branchId: { in: params.branchIds } } : {}),
    },
    orderBy: { countedAt: 'desc' },
    take: params.limit ?? 40,
    include: {
      countedBy: { select: { name: true } },
      approvedBy: { select: { name: true } },
      branch: { select: { name: true } },
      _count: { select: { lines: true } },
    },
  })

  return counts.map((c) => ({
    id: c.id,
    reference: c.reference,
    status: c.status,
    countedByName: c.countedBy?.name ?? null,
    countedAt: c.countedAt.toISOString(),
    approvedByName: c.approvedBy?.name ?? null,
    lineCount: c._count.lines,
    branchName: c.branch?.name ?? null,
  }))
}
