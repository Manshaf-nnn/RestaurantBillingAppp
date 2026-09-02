import 'server-only'
import { Prisma } from '@prisma/client'

import { prisma } from '@/server/db/prisma'
import type { DateRange } from './range'

/**
 * The stock reconciliation statement.
 *
 * Opening + everything in − everything out = closing, per item, for a period and
 * optionally one location. It is the report that answers "where did it all go",
 * and until now it existed only as an assertion inside the test scripts:
 * `recomputeBalance` compared a cached balance to its ledger and had no callers
 * anywhere in `src/`.
 *
 * Two numbers matter most and neither was visible to an owner:
 *
 *   • the movement breakdown — what was bought, made, sold, wasted, transferred
 *   • the DRIFT — cached balance minus ledger sum, which must be zero
 *
 * Drift is not a rounding curiosity. It means something changed a balance
 * without writing a movement, and every figure derived from that item is wrong
 * from that moment on. Three such paths existed in this codebase and are fixed;
 * this is how you would find the fourth.
 */

/** How each movement type is presented in the ladder. */
const BUCKETS = {
  OPENING_BALANCE: { label: 'Opening balance', group: 'opening' },
  PURCHASE: { label: 'Purchases received', group: 'in' },
  PRODUCTION_OUTPUT: { label: 'Produced', group: 'in' },
  PRODUCTION: { label: 'Produced', group: 'in' },
  TRANSFER_IN: { label: 'Transferred in', group: 'in' },
  CUSTOMER_RETURN: { label: 'Customer returns', group: 'in' },
  SALE_REVERSAL: { label: 'Sales reversed', group: 'in' },
  ADJUSTMENT_IN: { label: 'Adjustments up', group: 'in' },
  RETURN: { label: 'Returned', group: 'in' },
  SALE: { label: 'Sold', group: 'out' },
  CONSUMPTION: { label: 'Consumed', group: 'out' },
  PRODUCTION_CONSUMPTION: { label: 'Used in production', group: 'out' },
  TRANSFER_OUT: { label: 'Transferred out', group: 'out' },
  WASTAGE: { label: 'Wasted', group: 'out' },
  WASTE: { label: 'Wasted', group: 'out' },
  EXPIRY: { label: 'Expired', group: 'out' },
  RETURN_TO_SUPPLIER: { label: 'Returned to supplier', group: 'out' },
  ADJUSTMENT_OUT: { label: 'Adjustments down', group: 'out' },
  ADJUSTMENT: { label: 'Adjustments', group: 'out' },
} as const

export interface ReconciliationLine {
  itemId: string
  name: string
  unit: string
  opening: number
  movements: Array<{ label: string; group: string; quantity: number; value: number }>
  totalIn: number
  totalOut: number
  /** Money in and out over the window, valued at each movement's own cost —
   *  the §75 value ladder beside the quantity one. */
  valueIn: number
  valueOut: number
  /** opening + in − out, what the ledger says the balance should be. */
  expected: number
  /** What `InventoryItem.quantity` actually holds. */
  cached: number
  /** cached − expected. Anything but zero means a balance moved off-ledger. */
  drift: number
  valueAtCost: number
}

export interface ReconciliationReport {
  range: { from: string; to: string; label: string }
  branchId: string | null
  lines: ReconciliationLine[]
  totals: {
    items: number
    drifting: number
    valueAtCost: number
    valueIn: number
    valueOut: number
    /** The exact worth on hand right now, from the value-carrying WAC. */
    stockValueNow: number
  }
  /** The whole point: true when every item's books balance. */
  balanced: boolean
}

export async function getReconciliationReport(params: {
  restaurantId: string
  range: DateRange
  branchId?: string | null
}): Promise<ReconciliationReport> {
  const scope = {
    restaurantId: params.restaurantId,
    ...(params.branchId ? { branchId: params.branchId } : {}),
  }

  /*
   * Opening is everything before the window, not a stored figure. Storing it
   * would be a second source of truth that could disagree with the ledger, which
   * is the failure this report exists to detect.
   */
  const [before, within, items, values, shelfBalances] = await Promise.all([
    prisma.stockMovement.groupBy({
      by: ['itemId'],
      where: { ...scope, createdAt: { lt: params.range.from } },
      _sum: { quantity: true },
    }),
    prisma.stockMovement.groupBy({
      by: ['itemId', 'type'],
      where: { ...scope, createdAt: { gte: params.range.from, lte: params.range.to } },
      _sum: { quantity: true },
    }),
    prisma.inventoryItem.findMany({
      where: { restaurantId: params.restaurantId, isActive: true },
      select: { id: true, name: true, unit: true, quantity: true, costPerUnit: true, stockValue: true },
      orderBy: { name: 'asc' },
    }),
    /*
     * The value beside every quantity (§75). Each movement row is stamped
     * with the cost in force when it happened, so quantity × unitCost per row
     * IS the money that moved — grouped here the same way the quantities are.
     */
    prisma.$queryRaw<Array<{ itemId: string; type: string; value: bigint | null }>>`
      SELECT "itemId", type::text AS type, SUM(quantity * "unitCost")::bigint AS value
      FROM stock_movements
      WHERE "restaurantId" = ${params.restaurantId}
        ${params.branchId ? Prisma.sql`AND "branchId" = ${params.branchId}` : Prisma.empty}
        AND "createdAt" >= ${params.range.from} AND "createdAt" <= ${params.range.to}
      GROUP BY 1, 2
    `,
    /*
     * The stored balance for ONE branch, summed across its shelves.
     *
     * This is what makes a branch-scoped run mean anything. It used to set
     * `cached = expected` when a branch was selected — comparing the ledger
     * replay against itself — so the screen whose entire job is proving the
     * books reported "balanced" without having checked a single figure.
     *
     * The reasoning behind that was half right: `InventoryItem.quantity` is
     * restaurant-wide, so comparing it to one branch's ladder would flag every
     * multi-branch item. But the branch has a stored total of its own —
     * `InventoryStock.available`, the number every branch figure on every
     * screen is summed from — and nothing anywhere reconciled it.
     */
    params.branchId
      ? prisma.inventoryStock.groupBy({
          by: ['itemId'],
          where: { restaurantId: params.restaurantId, branchId: params.branchId },
          _sum: { available: true },
        })
      : Promise.resolve([]),
  ])

  const openingByItem = new Map(before.map((r) => [r.itemId, r._sum.quantity ?? 0]))
  const valueByItemType = new Map(values.map((r) => [`${r.itemId}:${r.type}`, Number(r.value ?? 0)]))
  const shelfByItem = new Map(shelfBalances.map((r) => [r.itemId, r._sum.available ?? 0]))
  const byItem = new Map<string, Array<{ type: string; quantity: number }>>()
  for (const row of within) {
    const list = byItem.get(row.itemId) ?? []
    list.push({ type: row.type, quantity: row._sum.quantity ?? 0 })
    byItem.set(row.itemId, list)
  }

  const lines: ReconciliationLine[] = []

  for (const item of items) {
    const rows = byItem.get(item.id) ?? []
    const opening = round(openingByItem.get(item.id) ?? 0)

    /*
     * Nothing to say about an item with no history and no stock — but "no
     * stock" has to mean the total being compared. A branch run that skipped on
     * the restaurant-wide figure would drop exactly the item whose shelf holds
     * something the ledger has never heard of, which is the drift most worth
     * finding.
     */
    const storedHere = params.branchId ? (shelfByItem.get(item.id) ?? 0) : item.quantity
    if (rows.length === 0 && opening === 0 && storedHere === 0) continue

    const merged = new Map<string, { label: string; group: string; quantity: number; value: number }>()
    let totalIn = 0
    let totalOut = 0
    let valueIn = 0
    let valueOut = 0

    for (const row of rows) {
      const bucket = BUCKETS[row.type as keyof typeof BUCKETS] ?? {
        label: row.type.replace(/_/g, ' ').toLowerCase(),
        group: row.quantity >= 0 ? 'in' : 'out',
      }
      const rowValue = valueByItemType.get(`${item.id}:${row.type}`) ?? 0
      const existing = merged.get(bucket.label) ?? { ...bucket, quantity: 0, value: 0 }
      existing.quantity = round(existing.quantity + row.quantity)
      existing.value += rowValue
      merged.set(bucket.label, existing)

      if (row.quantity >= 0) {
        totalIn = round(totalIn + row.quantity)
        valueIn += rowValue
      } else {
        totalOut = round(totalOut + Math.abs(row.quantity))
        valueOut += Math.abs(rowValue)
      }
    }

    const expected = round(opening + totalIn - totalOut)

    /*
     * Whichever stored total belongs to what was just replayed: this branch's
     * shelf sum when one is selected, the restaurant-wide cache otherwise.
     * Both are real numbers held somewhere else in the database, which is what
     * a drift check needs — comparing the replay against itself proves nothing.
     */
    const cached = params.branchId ? round(shelfByItem.get(item.id) ?? 0) : item.quantity

    lines.push({
      itemId: item.id,
      name: item.name,
      unit: item.unit,
      opening,
      movements: [...merged.values()].sort((a, b) => a.group.localeCompare(b.group)),
      totalIn,
      totalOut,
      expected,
      cached,
      drift: round(cached - expected),
      valueAtCost: Math.round(Math.max(0, expected) * item.costPerUnit),
      valueIn,
      valueOut,
    })
  }

  const drifting = lines.filter((l) => Math.abs(l.drift) > 1e-6).length

  return {
    range: {
      from: params.range.from.toISOString(),
      to: params.range.to.toISOString(),
      label: params.range.label,
    },
    branchId: params.branchId ?? null,
    lines,
    totals: {
      items: lines.length,
      drifting,
      valueAtCost: lines.reduce((sum, l) => sum + l.valueAtCost, 0),
      valueIn: lines.reduce((sum, l) => sum + l.valueIn, 0),
      valueOut: lines.reduce((sum, l) => sum + l.valueOut, 0),
      stockValueNow: Math.round(
        items.reduce((sum, item) => sum + Number(item.stockValue), 0),
      ),
    },
    balanced: drifting === 0,
  }
}

const round = (n: number) => Math.round(n * 1e6) / 1e6
