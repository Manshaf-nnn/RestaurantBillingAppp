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

/**
 * A `YYYY-MM-DD` bucket in a given zone.
 *
 * `en-CA` is the locale whose short date format IS ISO, which makes this a
 * one-liner rather than a manual assembly of parts. Deliberately not
 * `localBucket()` from `sql-time.ts` — that is for raw SQL, and these are
 * Prisma reads.
 */
function dayKeyIn(timeZone?: string): (date: Date) => string {
  const format = new Intl.DateTimeFormat('en-CA', {
    timeZone: timeZone || 'UTC',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  return (date: Date) => format.format(date)
}

export async function getVarianceReport(params: {
  restaurantId: string
  days?: number
  now?: Date
  branchId?: string | null
  /** The restaurant's own zone, so "same day" means the same day to its staff. */
  timeZone?: string
}): Promise<VarianceReport> {
  const now = params.now ?? new Date()
  const from = new Date(now.getTime() - (params.days ?? 30) * 86_400_000)

  /*
   * Windowed on `countedAt`, not `approvedAt`.
   *
   * A count is a statement about the day the shelf was walked. Filtering on the
   * approval date meant a count taken on the 30th and signed off on the 2nd
   * appeared in the wrong month — and, worse, it was matched against the wrong
   * day's wastage below, so a genuinely explained shortfall was reported as
   * unexplained loss.
   */
  const counts = await prisma.stockCount.findMany({
    where: {
      restaurantId: params.restaurantId,
      status: 'APPROVED',
      countedAt: { gte: from, lte: now },
      ...(params.branchId ? { branchId: params.branchId } : {}),
    },
    include: {
      approvedBy: { select: { name: true } },
      lines: { include: { item: { select: { id: true, name: true, unit: true, costPerUnit: true } } } },
    },
    orderBy: { countedAt: 'desc' },
  })

  /*
   * One query for all the wastage in the window, matched to counts by day.
   *
   * Days are bucketed in the RESTAURANT's timezone. `toISOString()` buckets in
   * UTC, so for Asia/Colombo everything binned after 18:30 local landed on the
   * following day and stopped matching the count it belonged to — the evening
   * spoilage, which is most of it.
   */
  const dayOf = dayKeyIn(params.timeZone)
  const wastage = await prisma.wastageRecord.findMany({
    where: { restaurantId: params.restaurantId, createdAt: { gte: from, lte: now } },
    select: { itemId: true, quantity: true, createdAt: true },
  })
  const wastageByItemDay = new Map<string, number>()
  for (const w of wastage) {
    const key = `${w.itemId}:${dayOf(w.createdAt)}`
    wastageByItemDay.set(key, (wastageByItemDay.get(key) ?? 0) + w.quantity)
  }

  const lines: VarianceLine[] = []
  let netValue = 0
  let lossValue = 0
  let unexplainedValue = 0

  for (const count of counts) {
    // The day the shelf was walked — the day the stock actually went missing —
    // not the day a manager got round to signing the sheet.
    const day = dayOf(count.countedAt)

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
