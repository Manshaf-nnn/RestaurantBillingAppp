import 'server-only'

import { prisma } from '@/server/db/prisma'

/**
 * Inventory variance.
 *
 * The question this answers is the one an owner actually loses sleep over:
 * between what the system said we had and what was physically on the shelf,
 * how much walked out of the door, and can any of it be explained?
 *
 * Variance is read from approved stock counts rather than recomputed, because
 * a count is a statement about a moment. Recomputing it later against today's
 * balance would quietly rewrite history every time something was sold.
 *
 * Explained vs unexplained is the useful split. A shortfall on an item that
 * also has wastage recorded that day is largely accounted for; a shortfall with
 * no wastage against it is the one worth investigating.
 */

export interface VarianceLine {
  itemId: string
  name: string
  unit: string
  /** What the system held when the count was taken. */
  expected: number
  /** What was physically counted. */
  actual: number
  variance: number
  /** variance × the item's cost, minor units. Negative is a loss. */
  varianceValue: number
  countReference: string
  countedAt: string
  approvedByName: string | null
  notes: string | null
  /** Wastage recorded for this item on the same day, in base units. */
  wastageSameDay: number
  /** True when wastage accounts for most of the shortfall. */
  likelyExplained: boolean
}

export interface VarianceReport {
  from: string
  to: string
  lines: VarianceLine[]
  totals: {
    countsIncluded: number
    itemsWithVariance: number
    /** Net value across all variances, minor units. */
    netValue: number
    /** Value of shortfalls only. */
    lossValue: number
    /** Value of shortfalls with no wastage to explain them. */
    unexplainedValue: number
  }
}

export async function getVarianceReport(params: {
  restaurantId: string
  days?: number
  now?: Date
  branchId?: string | null
}): Promise<VarianceReport> {
  const now = params.now ?? new Date()
  const from = new Date(now.getTime() - (params.days ?? 30) * 86_400_000)

  const counts = await prisma.stockCount.findMany({
    where: {
      restaurantId: params.restaurantId,
      status: 'APPROVED',
      approvedAt: { gte: from, lte: now },
      ...(params.branchId ? { branchId: params.branchId } : {}),
    },
    include: {
      approvedBy: { select: { name: true } },
      lines: { include: { item: { select: { id: true, name: true, unit: true, costPerUnit: true } } } },
    },
    orderBy: { approvedAt: 'desc' },
  })

  // One query for all the wastage in the window, matched to counts by day.
  const wastage = await prisma.wastageRecord.findMany({
    where: { restaurantId: params.restaurantId, createdAt: { gte: from, lte: now } },
    select: { itemId: true, quantity: true, createdAt: true },
  })
  const wastageByItemDay = new Map<string, number>()
  for (const w of wastage) {
    const key = `${w.itemId}:${w.createdAt.toISOString().slice(0, 10)}`
    wastageByItemDay.set(key, (wastageByItemDay.get(key) ?? 0) + w.quantity)
  }

  const lines: VarianceLine[] = []
  let netValue = 0
  let lossValue = 0
  let unexplainedValue = 0

  for (const count of counts) {
    const day = (count.approvedAt ?? count.countedAt).toISOString().slice(0, 10)

    for (const line of count.lines) {
      if (Math.abs(line.variance) < 1e-6) continue

      const value = Math.round(line.variance * line.item.costPerUnit)
      const wasted = wastageByItemDay.get(`${line.itemId}:${day}`) ?? 0
      // A shortfall is treated as explained when same-day wastage covers at
      // least 80% of it — exact matches are rare, and demanding one would mark
      // almost everything unexplained.
      const shortfall = line.variance < 0 ? Math.abs(line.variance) : 0
      const explained = shortfall > 0 && wasted >= shortfall * 0.8

      netValue += value
      if (value < 0) {
        lossValue += Math.abs(value)
        if (!explained) unexplainedValue += Math.abs(value)
      }

      lines.push({
        itemId: line.itemId,
        name: line.item.name,
        unit: line.item.unit,
        expected: line.systemQty,
        actual: line.countedQty,
        variance: line.variance,
        varianceValue: value,
        countReference: count.reference,
        countedAt: (count.approvedAt ?? count.countedAt).toISOString(),
        approvedByName: count.approvedBy?.name ?? null,
        notes: line.notes,
        wastageSameDay: wasted,
        likelyExplained: explained,
      })
    }
  }

  // Biggest loss first — that is the list a manager works down.
  lines.sort((a, b) => a.varianceValue - b.varianceValue)

  return {
    from: from.toISOString(),
    to: now.toISOString(),
    lines,
    totals: {
      countsIncluded: counts.length,
      itemsWithVariance: lines.length,
      netValue,
      lossValue,
      unexplainedValue,
    },
  }
}
