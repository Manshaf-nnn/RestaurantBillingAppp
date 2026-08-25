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
  /**
   * Whether this branch has a stock row for the item at all.
   *
   * Drives the sheet's default filter. False does not mean "do not count it" —
   * it means the book has never seen this item here, which is the interesting
   * case when it turns out to be sitting on the shelf.
   */
  heldHere: boolean
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

  /*
   * Every active item, not "items belonging to this branch".
   *
   * This used to filter `InventoryItem.branchId` and `InventoryItem.locationId`,
   * neither of which any screen has ever written — so both are null on every
   * row, the filter matched nothing, and the sheet was empty for every count
   * ever opened. That is why counting "did not work", and why Stock variance,
   * which reads only approved counts, had nothing to show either.
   *
   * The same mistake was found and fixed once in `purchasing/suggestions.ts` —
   * "branchId scopes the QUANTITY, not the item list" — and reappeared here and
   * in `alerts.ts`. `scripts/no-item-branch-filter.ts` now fails the build on it.
   *
   * Beyond being the bug, the wide population is also right. A stock count is
   * the completeness test: restricting it to what the book already knows is at
   * this branch makes it structurally incapable of finding stock that exists on
   * the shelf and not in the book — which is the error class that matters most,
   * and precisely the damage left behind by opening balances that landed on the
   * wrong branch. You cannot test completeness against a population defined by
   * the thing you are testing.
   *
   * `heldHere` keeps that from meaning a 400-line sheet: the sheet defaults to
   * what this branch stocks and the rest is one tap away.
   */
  const [items, onHand] = await Promise.all([
    prisma.inventoryItem.findMany({
      where: { restaurantId: params.restaurantId, isActive: true },
      orderBy: [{ category: 'asc' }, { name: 'asc' }],
      select: {
        id: true, name: true, sku: true, unit: true, category: true,
        quantity: true, costPerUnit: true,
        location: { select: { name: true } },
      },
    }),
    count.branchId
      ? prisma.inventoryStock.findMany({
          where: {
            restaurantId: params.restaurantId,
            branchId: count.branchId,
            ...(count.locationId ? { storageLocationId: count.locationId } : {}),
          },
          select: { itemId: true },
        })
      : Promise.resolve([]),
  ])

  /*
   * Stocked here means a row EXISTS, not that it is above zero. A row at zero
   * says this branch carries the item and has run out — which is exactly the
   * line you most want somebody to walk over and confirm.
   */
  const heldHere = new Set(onHand.map((row) => row.itemId))
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
      heldHere: heldHere.has(item.id),
    }
  })

  /*
   * Built from the LINES, not from the item list above.
   *
   * It used to iterate the items and skip those without a line, so any line
   * whose item fell outside the sheet's population was invisible to the approver
   * — and still posted to the ledger on approval. The same loop fed
   * `withVariance`, so the button could read "approve and adjust 0 items" while
   * adjusting several. An approver has to see everything they are signing.
   */
  const itemById = new Map(items.map((i) => [i.id, i]))
  const review: CountReviewLine[] = []
  let netVarianceValue = 0
  let withVariance = 0

  for (const line of count.lines) {
    const item = itemById.get(line.itemId) ?? (await countedItem(line.itemId))
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
      heldHere: heldHere.has(item.id),
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
      /*
       * Counted against what this branch stocks, not against the whole
       * catalogue. Now that the sheet offers every item, `items.length - lines`
       * would report a restaurant's entire item list as outstanding work and no
       * count would ever look finished.
       */
      uncounted: sheet.filter((row) => row.heldHere && row.countedQty === null).length,
      withVariance,
      netVarianceValue,
    },
  }
}

/**
 * Metadata for a counted item that has since been retired.
 *
 * Rare, and it must not blank the review: the line was counted, the variance is
 * real, and approval will post it. The item is fetched without the `isActive`
 * filter for exactly that reason.
 */
async function countedItem(itemId: string) {
  const item = await prisma.inventoryItem.findUnique({
    where: { id: itemId },
    select: {
      id: true, name: true, sku: true, unit: true, category: true,
      quantity: true, costPerUnit: true,
      location: { select: { name: true } },
    },
  })
  if (!item) throw new NotFoundError('Inventory item')
  return item
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
