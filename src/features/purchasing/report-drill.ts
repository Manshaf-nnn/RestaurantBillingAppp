import 'server-only'

import { Prisma } from '@prisma/client'

import { prisma } from '@/server/db/prisma'
import { utc } from '@/server/db/sql-time'
import type { DateRange } from '@/features/reports/range'

/**
 * The tables behind the purchasing report's three "View details".
 *
 * Same rule as the dashboard they hang off: an order is APPROVED onwards, and
 * a request somebody raised but nobody approved is not a purchase. See the
 * header of `report.ts`.
 */

const COMMITTED = Prisma.sql`p.status IN ('APPROVED','ORDERED','PARTIALLY_RECEIVED','RECEIVED','CLOSED')`
const ORDERS = Prisma.sql`p.status IN ('APPROVED','ORDERED','PARTIALLY_RECEIVED','RECEIVED','CLOSED','CANCELLED')`
const PLACED_AT = Prisma.raw('COALESCE(p."orderedAt", p."createdAt")')

export interface PurchaseOrderRow {
  key: string
  number: string
  placedAt: string
  supplier: string
  items: number
  value: number
  /** RECEIVED | PARTIAL | PENDING | CANCELLED — the screen colours it. */
  status: string
  statusLabel: string
}

export interface ItemPurchaseRow {
  key: string
  label: string
  category: string
  /** In the item's own stock unit, which is why the unit travels with it. */
  quantity: number
  unit: string
  value: number
  /**
   * Value ÷ quantity, and NOT a valuation.
   *
   * `no-average-cost-valuation` forbids pricing stock HELD at a blended rate,
   * because what a branch holds is worth the sum of its FIFO layers. This is a
   * different figure: the average of what was PAID across the period's
   * deliveries, which is a purchasing fact and the only sensible answer to
   * "what are we paying for tomatoes these days".
   */
  averageUnitCost: number
}

export interface SupplierPurchaseRow {
  key: string
  label: string
  orders: number
  items: number
  quantity: number
  value: number
  share: number
}

export interface PurchasingDrill {
  orders: PurchaseOrderRow[]
  byItem: ItemPurchaseRow[]
  bySupplier: SupplierPurchaseRow[]
}

const n = (v: bigint | number | null | undefined) => Number(v ?? 0)

export async function getPurchasingDrill(params: {
  restaurantId: string
  range: DateRange
  branchIds?: string[] | null
}): Promise<PurchasingDrill> {
  const from = utc(params.range.from)
  const to = utc(params.range.to)
  const branch =
    params.branchIds && params.branchIds.length > 0
      ? Prisma.sql`AND p."branchId" IN (${Prisma.join(params.branchIds)})`
      : Prisma.empty

  const scope = Prisma.sql`
    p."restaurantId" = ${params.restaurantId}
    AND ${PLACED_AT} >= ${from} AND ${PLACED_AT} <= ${to}
    ${branch}
  `

  const [orderRows, itemRows, supplierRows] = await Promise.all([
    prisma.$queryRaw<Array<{
      id: string; number: string; placed: Date; supplier: string | null
      items: bigint | null; value: bigint | null; status: string; received: Date | null
    }>>`
      SELECT p.id, p.number, ${PLACED_AT} AS placed,
             s.name AS supplier,
             (SELECT COUNT(*) FROM purchase_items pi WHERE pi."purchaseId" = p.id)::bigint AS items,
             p.total::bigint AS value,
             p.status::text AS status,
             p."receivedAt" AS received
      FROM purchases p
      LEFT JOIN suppliers s ON s.id = p."supplierId"
      WHERE ${scope} AND ${ORDERS}
      ORDER BY placed DESC
      LIMIT 500
    `,

    prisma.$queryRaw<Array<{
      key: string; label: string; category: string | null; unit: string | null
      qty: number | null; value: bigint | null
    }>>`
      SELECT i.id AS key, i.name AS label,
             COALESCE(c.name, NULLIF(i.category, ''), 'Uncategorised') AS category,
             i.unit::text AS unit,
             COALESCE(SUM(pi.quantity), 0)::float8 AS qty,
             COALESCE(SUM(pi."lineTotal"), 0)::bigint AS value
      FROM purchase_items pi
      JOIN purchases p ON p.id = pi."purchaseId"
      JOIN inventory_items i ON i.id = pi."itemId"
      LEFT JOIN inventory_categories c ON c.id = i."categoryId"
      WHERE ${scope} AND ${COMMITTED}
      GROUP BY 1, 2, 3, 4
      ORDER BY value DESC
      LIMIT 200
    `,

    prisma.$queryRaw<Array<{
      key: string | null; label: string | null; orders: bigint | null
      items: bigint | null; qty: number | null; value: bigint | null
    }>>`
      SELECT p."supplierId" AS key, COALESCE(s.name, 'No supplier') AS label,
             COUNT(DISTINCT p.id)::bigint AS orders,
             COUNT(pi.id)::bigint AS items,
             COALESCE(SUM(pi.quantity), 0)::float8 AS qty,
             COALESCE(SUM(p.total), 0)::bigint AS value
      FROM purchases p
      LEFT JOIN suppliers s ON s.id = p."supplierId"
      LEFT JOIN purchase_items pi ON pi."purchaseId" = p.id
      WHERE ${scope} AND ${COMMITTED}
      GROUP BY 1, 2
      ORDER BY value DESC
      LIMIT 200
    `,
  ])

  /*
   * `SUM(p.total)` over a join to the lines would multiply the order's total by
   * the number of lines on it, so the supplier value is summed from the orders
   * themselves in a second pass rather than from the joined rows.
   */
  const supplierValues = await prisma.$queryRaw<Array<{ key: string | null; value: bigint | null }>>`
    SELECT p."supplierId" AS key, COALESCE(SUM(p.total), 0)::bigint AS value
    FROM purchases p WHERE ${scope} AND ${COMMITTED}
    GROUP BY 1
  `
  const trueValue = new Map(supplierValues.map((r) => [r.key ?? 'none', n(r.value)]))
  const grand = [...trueValue.values()].reduce((s, v) => s + v, 0)

  const statusOf = (status: string, received: Date | null) => {
    if (status === 'RECEIVED') return 'RECEIVED'
    if (status === 'CLOSED') return received ? 'RECEIVED' : 'PARTIAL'
    if (status === 'PARTIALLY_RECEIVED') return 'PARTIAL'
    if (status === 'CANCELLED') return 'CANCELLED'
    return 'PENDING'
  }
  const statusLabels: Record<string, string> = {
    RECEIVED: 'Received', PARTIAL: 'Partial', PENDING: 'Pending', CANCELLED: 'Cancelled',
  }

  return {
    orders: orderRows.map((r) => {
      const status = statusOf(r.status, r.received)
      return {
        key: r.id,
        number: r.number,
        placedAt: r.placed.toISOString(),
        supplier: r.supplier ?? 'No supplier',
        items: n(r.items),
        value: n(r.value),
        status,
        statusLabel: statusLabels[status],
      }
    }),
    byItem: itemRows.map((r) => {
      const quantity = Number(r.qty ?? 0)
      const value = n(r.value)
      return {
        key: r.key,
        label: r.label,
        category: r.category ?? 'Uncategorised',
        quantity,
        unit: r.unit ?? '',
        value,
        averageUnitCost: quantity > 0 ? Math.round(value / quantity) : 0,
      }
    }),
    bySupplier: supplierRows.map((r) => {
      const key = r.key ?? 'none'
      const value = trueValue.get(key) ?? 0
      return {
        key,
        label: r.label ?? 'No supplier',
        orders: n(r.orders),
        items: n(r.items),
        quantity: Number(r.qty ?? 0),
        value,
        share: grand > 0 ? Math.round((value / grand) * 1000) / 10 : 0,
      }
    }),
  }
}
