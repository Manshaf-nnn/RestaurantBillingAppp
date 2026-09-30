import 'server-only'

import { Prisma } from '@prisma/client'

import { prisma } from '@/server/db/prisma'
import { utc } from '@/server/db/sql-time'
import type { DateRange } from '@/features/reports/range'

/**
 * Every item bought in a period, one row each.
 *
 * ── Why this reads the stock ledger and not the purchase orders ─────────────
 *
 * The rest of the purchasing report counts ORDERS: what was committed, on the
 * day it was placed, at the price on the order. That is the right answer to
 * "how much have we committed to suppliers". It is the wrong answer to "what
 * did we actually buy" — an owner asking that means what came through the
 * door and what was paid for it, and three things about orders get in the
 * way:
 *
 *   · an order line is in whatever unit it was raised in (a box, a case),
 *     while the item is counted in kilos or pieces, so summing lines mixes
 *     units under one label;
 *   · the order's price is a promise; the delivery's invoice is the fact, and
 *     the two differ often enough that the report has a variance tile;
 *   · stock bought without an order at all — a cash-and-carry run recorded
 *     as "Stock in" with a price — is a purchase to the owner and invisible
 *     to the orders.
 *
 * Every one of those is settled by the time a movement is posted: `PURCHASE`
 * rows are in the item's base unit, valued at exactly what was paid
 * (`valueMoved`, FIFO.md), stamped with the branch they landed at, and
 * written for deliveries against an order and for direct stock in alike. A
 * `RETURN_TO_SUPPLIER` row is the same fact in reverse, so it is shown
 * beside the purchase rather than netted silently out of it.
 *
 * Dated by when the stock was booked in, which is what the ledger knows.
 */

export interface PurchasedItemRow {
  key: string
  name: string
  sku: string | null
  category: string
  /** The item's base unit — the unit every figure on this row is in. */
  unit: string
  /** Bought in the period, base units. */
  quantity: number
  /** How many deliveries (or stock-ins) that was. */
  deliveries: number
  /** What was paid, minor units. */
  value: number
  /**
   * Value ÷ quantity — the average price PAID across the period's deliveries,
   * which is a purchasing fact, not a valuation of stock held (see the note
   * on `ItemPurchaseRow.averageUnitCost` in `report-drill.ts`).
   */
  averageUnitCost: number
  /** What the most recent delivery cost per base unit. */
  lastUnitCost: number
  lastBoughtAt: string | null
  /** Sent back to a supplier in the period, base units, as a positive number. */
  returnedQuantity: number
  /** What those returns were worth, minor units. */
  returnedValue: number
  /** Who it was bought from; "Direct stock in" for stock recorded without an order. */
  suppliers: string[]
  /** Where it landed. One entry when the report is narrowed to a location. */
  locations: string[]
}

export interface PurchasedItems {
  rows: PurchasedItemRow[]
  totals: {
    items: number
    deliveries: number
    value: number
    returnedValue: number
  }
}

const n = (v: bigint | number | null | undefined) => Number(v ?? 0)

export async function listPurchasedItems(params: {
  restaurantId: string
  range: DateRange
  branchIds?: string[] | null
  /** Rows to return, biggest spend first. Totals always cover every row. */
  limit?: number
}): Promise<PurchasedItems> {
  const from = utc(params.range.from)
  const to = utc(params.range.to)
  const branch =
    params.branchIds && params.branchIds.length > 0
      ? Prisma.sql`AND m."branchId" IN (${Prisma.join(params.branchIds)})`
      : params.branchIds
        ? // Confined to nowhere: fail closed, never open.
          Prisma.sql`AND FALSE`
        : Prisma.empty

  const scope = Prisma.sql`
    m."restaurantId" = ${params.restaurantId}
    AND m.type IN ('PURCHASE', 'RETURN_TO_SUPPLIER')
    AND m."createdAt" >= ${from} AND m."createdAt" <= ${to}
    ${branch}
  `

  const [rows, latest] = await Promise.all([
    prisma.$queryRaw<Array<{
      key: string; name: string; sku: string | null; category: string | null; unit: string
      qty: number | null; value: bigint | null; deliveries: bigint | null
      returned_qty: number | null; returned_value: bigint | null
      last_at: Date | null; suppliers: string[] | null; locations: string[] | null
    }>>`
      WITH scoped AS (
        SELECT m."itemId", m.type, m.quantity, m."valueMoved", m."createdAt",
               CASE WHEN m.type = 'PURCHASE' THEN COALESCE(s.name, 'Direct stock in') END AS supplier,
               b.name AS branch
        FROM stock_movements m
        JOIN branches b ON b.id = m."branchId"
        LEFT JOIN purchases p ON p.id = m."purchaseId"
        LEFT JOIN suppliers s ON s.id = p."supplierId"
        WHERE ${scope}
      )
      SELECT i.id AS key, i.name, i.sku,
             COALESCE(c.name, NULLIF(i.category, ''), 'Uncategorised') AS category,
             i.unit::text AS unit,
             COALESCE(SUM(sc.quantity) FILTER (WHERE sc.type = 'PURCHASE'), 0)::float8 AS qty,
             COALESCE(SUM(sc."valueMoved") FILTER (WHERE sc.type = 'PURCHASE'), 0)::bigint AS value,
             COUNT(*) FILTER (WHERE sc.type = 'PURCHASE')::bigint AS deliveries,
             COALESCE(-SUM(sc.quantity) FILTER (WHERE sc.type = 'RETURN_TO_SUPPLIER'), 0)::float8 AS returned_qty,
             COALESCE(SUM(sc."valueMoved") FILTER (WHERE sc.type = 'RETURN_TO_SUPPLIER'), 0)::bigint AS returned_value,
             MAX(sc."createdAt") FILTER (WHERE sc.type = 'PURCHASE') AS last_at,
             ARRAY_REMOVE(ARRAY_AGG(DISTINCT sc.supplier), NULL) AS suppliers,
             ARRAY_AGG(DISTINCT sc.branch) AS locations
      FROM scoped sc
      JOIN inventory_items i ON i.id = sc."itemId"
      LEFT JOIN inventory_categories c ON c.id = i."categoryId"
      GROUP BY i.id, i.name, i.sku, 4, i.unit
      ORDER BY value DESC, i.name ASC
    `,

    // The most recent delivery of each item, for "last paid".
    prisma.$queryRaw<Array<{ key: string; quantity: number; value: bigint | null }>>`
      SELECT DISTINCT ON (m."itemId") m."itemId" AS key, m.quantity, m."valueMoved"::bigint AS value
      FROM stock_movements m
      WHERE ${scope} AND m.type = 'PURCHASE'
      ORDER BY m."itemId", m."createdAt" DESC
    `,
  ])

  const lastPaid = new Map(
    latest.map((r) => [r.key, r.quantity > 0 ? Math.round(n(r.value) / r.quantity) : 0]),
  )

  const all = rows.map((r): PurchasedItemRow => {
    const quantity = Number(r.qty ?? 0)
    const value = n(r.value)
    return {
      key: r.key,
      name: r.name,
      sku: r.sku,
      category: r.category ?? 'Uncategorised',
      unit: r.unit,
      quantity,
      deliveries: n(r.deliveries),
      value,
      averageUnitCost: quantity > 0 ? Math.round(value / quantity) : 0,
      lastUnitCost: lastPaid.get(r.key) ?? 0,
      lastBoughtAt: r.last_at ? r.last_at.toISOString() : null,
      returnedQuantity: Number(r.returned_qty ?? 0),
      returnedValue: n(r.returned_value),
      suppliers: r.suppliers ?? [],
      locations: r.locations ?? [],
    }
  })

  return {
    rows: params.limit ? all.slice(0, params.limit) : all,
    totals: {
      items: all.length,
      deliveries: all.reduce((sum, row) => sum + row.deliveries, 0),
      value: all.reduce((sum, row) => sum + row.value, 0),
      returnedValue: all.reduce((sum, row) => sum + row.returnedValue, 0),
    },
  }
}
