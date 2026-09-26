import 'server-only'

import { Prisma } from '@prisma/client'

import { prisma } from '@/server/db/prisma'
import { localBucket, utc } from '@/server/db/sql-time'
import type { DateRange } from '@/features/reports/range'

/**
 * What the restaurant bought, and from whom.
 *
 * ── A purchase order is not a purchase REQUEST ──────────────────────────────
 *
 * `service.ts` splits the two deliberately: DRAFT, PENDING_APPROVAL, RETURNED
 * and REJECTED are somebody ASKING to buy something, and only APPROVED onwards
 * is an order the restaurant has actually placed. Everything here counts orders
 * — so a request refused by an approver does not appear as money spent, and a
 * rejected request is not reported beside cancelled orders as though the buying
 * went wrong. Nothing was bought; nothing was cancelled.
 *
 * The one exception is the status panel, which says how many requests are still
 * waiting so the number is visible rather than merely excluded.
 */

/** Orders proper — approved and beyond. Requests are not spending. */
const ORDERS = Prisma.sql`p.status IN ('APPROVED','ORDERED','PARTIALLY_RECEIVED','RECEIVED','CLOSED','CANCELLED')`
/** Of those, the ones that represent money committed: a cancelled order is not. */
const COMMITTED = Prisma.sql`p.status IN ('APPROVED','ORDERED','PARTIALLY_RECEIVED','RECEIVED','CLOSED')`

export interface PurchasingTotals {
  /** Committed spend: the value of every order that was not cancelled. */
  purchaseValue: number
  orders: number
  suppliers: number
  /** Suppliers first used in this period — "2 new suppliers" on the tile. */
  newSuppliers: number
  averageOrderValue: number
  returns: number
  /**
   * Committed against actual, NOT against a budget.
   *
   * There is no budget anywhere in this system, so the tile the design asked
   * for cannot be answered honestly. What the data does support is the question
   * a buyer actually has: the PO committed one figure, the delivery was
   * invoiced at another, and the gap between them is real money. `purchases
   * .total` is never rewritten when the invoice differs (pinned by
   * po-workflow-test), so the two stay independent and the comparison means
   * something.
   *
   * Negative is good: less was charged than was committed.
   */
  variance: {
    committed: number
    actual: number
    amount: number
    /** Of committed. Null when nothing was received, so nothing is claimed. */
    percent: number | null
  }
}

export interface PurchasingDeltas {
  purchaseValue: number | null
  orders: number | null
  averageOrderValue: number | null
  returns: number | null
}

export interface PurchasingBucket {
  key: string
  label: string
  value: number
  share: number
}

export interface StatusSlice {
  key: string
  label: string
  count: number
  share: number
}

export interface PurchasingReport {
  totals: PurchasingTotals
  deltas: PurchasingDeltas
  /** Daily committed spend across the period. */
  trend: Array<{ label: string; value: number }>
  byCategory: PurchasingBucket[]
  bySupplier: PurchasingBucket[]
  byStatus: StatusSlice[]
  /** Requests not yet approved — excluded from the figures, named anyway. */
  awaitingApproval: number
  /** Twelve months, this year against last. */
  monthly: Array<{ label: string; thisYear: number; lastYear: number }>
}

function pctChange(now: number, before: number): number | null {
  if (before === 0) return null
  return Math.round(((now - before) / Math.abs(before)) * 1000) / 10
}

const n = (v: bigint | number | null | undefined) => Number(v ?? 0)
const shareOf = (part: number, whole: number) =>
  whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0

function branchSql(branchIds?: string[] | null) {
  return branchIds && branchIds.length > 0
    ? Prisma.sql`AND p."branchId" IN (${Prisma.join(branchIds)})`
    : Prisma.empty
}

/**
 * Which date a purchase belongs to.
 *
 * `orderedAt` where it exists, `createdAt` otherwise — an order belongs to the
 * period it was PLACED in, not the one it was keyed into the system in, and a
 * PO raised on the 31st and sent on the 1st is next month's spend. Coalesced
 * rather than assumed, because `orderedAt` is null until it is sent.
 */
const PLACED_AT_COLUMN = 'COALESCE(p."orderedAt", p."createdAt")'
const PLACED_AT = Prisma.raw(PLACED_AT_COLUMN)

export async function getPurchasingReport(params: {
  restaurantId: string
  range: DateRange
  branchIds?: string[] | null
  timeZone: string
}): Promise<PurchasingReport> {
  const from = utc(params.range.from)
  const to = utc(params.range.to)
  const branch = branchSql(params.branchIds)

  const scope = Prisma.sql`
    p."restaurantId" = ${params.restaurantId}
    AND ${PLACED_AT} >= ${from} AND ${PLACED_AT} <= ${to}
    ${branch}
  `

  /* The window before this one, of equal length, for the tiles' arrows. */
  const span = params.range.to.getTime() - params.range.from.getTime()
  const prevTo = new Date(params.range.from.getTime() - 1)
  const prevFrom = new Date(prevTo.getTime() - span)
  const prevScope = Prisma.sql`
    p."restaurantId" = ${params.restaurantId}
    AND ${PLACED_AT} >= ${utc(prevFrom)} AND ${PLACED_AT} <= ${utc(prevTo)}
    ${branch}
  `

  const year = params.range.to.getFullYear()

  const [
    totalsRow, prevRow, supplierCounts, returnsRow, prevReturnsRow,
    varianceRow, trendRows, categoryRows, supplierRows, statusRows, requestRow, monthlyRows,
  ] = await Promise.all([
    prisma.$queryRaw<Array<{ value: bigint | null; orders: bigint | null }>>`
      SELECT COALESCE(SUM(CASE WHEN ${COMMITTED} THEN p.total ELSE 0 END), 0)::bigint AS value,
             COUNT(*) FILTER (WHERE ${ORDERS})::bigint AS orders
      FROM purchases p WHERE ${scope}
    `,
    prisma.$queryRaw<Array<{ value: bigint | null; orders: bigint | null }>>`
      SELECT COALESCE(SUM(CASE WHEN ${COMMITTED} THEN p.total ELSE 0 END), 0)::bigint AS value,
             COUNT(*) FILTER (WHERE ${ORDERS})::bigint AS orders
      FROM purchases p WHERE ${prevScope}
    `,
    /*
     * Suppliers bought from in the period, and how many of those had never been
     * bought from before it — "new" meaning new to the restaurant, not newly
     * created, since a supplier row can sit unused for a year.
     */
    prisma.$queryRaw<Array<{ used: bigint | null; fresh: bigint | null }>>`
      WITH used AS (
        SELECT DISTINCT p."supplierId" AS id
        FROM purchases p WHERE ${scope} AND ${COMMITTED} AND p."supplierId" IS NOT NULL
      )
      SELECT COUNT(*)::bigint AS used,
             COUNT(*) FILTER (
               WHERE NOT EXISTS (
                 SELECT 1 FROM purchases q
                 WHERE q."supplierId" = used.id
                   AND q."restaurantId" = ${params.restaurantId}
                   AND q.status IN ('APPROVED','ORDERED','PARTIALLY_RECEIVED','RECEIVED','CLOSED')
                   AND COALESCE(q."orderedAt", q."createdAt") < ${from}
               )
             )::bigint AS fresh
      FROM used
    `,
    prisma.$queryRaw<Array<{ total: bigint | null }>>`
      SELECT COALESCE(SUM(l.quantity * l."unitCost"), 0)::bigint AS total
      FROM purchase_return_lines l
      JOIN purchase_returns r ON r.id = l."returnId"
      WHERE r."restaurantId" = ${params.restaurantId}
        AND r."createdAt" >= ${from} AND r."createdAt" <= ${to}
        ${params.branchIds && params.branchIds.length > 0
          ? Prisma.sql`AND r."branchId" IN (${Prisma.join(params.branchIds)})`
          : Prisma.empty}
    `,
    prisma.$queryRaw<Array<{ total: bigint | null }>>`
      SELECT COALESCE(SUM(l.quantity * l."unitCost"), 0)::bigint AS total
      FROM purchase_return_lines l
      JOIN purchase_returns r ON r.id = l."returnId"
      WHERE r."restaurantId" = ${params.restaurantId}
        AND r."createdAt" >= ${utc(prevFrom)} AND r."createdAt" <= ${utc(prevTo)}
        ${params.branchIds && params.branchIds.length > 0
          ? Prisma.sql`AND r."branchId" IN (${Prisma.join(params.branchIds)})`
          : Prisma.empty}
    `,
    /*
     * Committed against actual, over the orders that have actually received
     * something — comparing a PO nothing has arrived against would report the
     * whole of it as a saving.
     */
    prisma.$queryRaw<Array<{ committed: bigint | null; actual: bigint | null }>>`
      WITH received AS (
        SELECT DISTINCT p.id, p.total
        FROM purchases p
        JOIN goods_receipts g ON g."purchaseId" = p.id
        WHERE ${scope} AND ${COMMITTED}
      )
      SELECT COALESCE(SUM(r.total), 0)::bigint AS committed,
             COALESCE((
               SELECT SUM(gl."acceptedQty" * gl."unitCost")
               FROM goods_receipt_lines gl
               JOIN goods_receipts g2 ON g2.id = gl."receiptId"
               WHERE g2."purchaseId" IN (SELECT id FROM received)
             ), 0)::bigint AS actual
      FROM received r
    `,
    prisma.$queryRaw<Array<{ key: string; value: bigint | null }>>`
      SELECT to_char(${localBucket('day', PLACED_AT_COLUMN, params.timeZone)}, 'YYYY-MM-DD') AS key,
             COALESCE(SUM(p.total), 0)::bigint AS value
      FROM purchases p WHERE ${scope} AND ${COMMITTED}
      GROUP BY 1 ORDER BY 1
    `,
    /*
     * By what was bought, through the item's managed category. `category` is
     * also a free-text column on the item; the managed one is used where it is
     * set and the text is the fallback, so a restaurant that never adopted
     * categories still gets a breakdown rather than one grey slice.
     */
    prisma.$queryRaw<Array<{ key: string | null; value: bigint | null }>>`
      SELECT COALESCE(c.name, NULLIF(i.category, ''), 'Uncategorised') AS key,
             COALESCE(SUM(pi."lineTotal"), 0)::bigint AS value
      FROM purchase_items pi
      JOIN purchases p ON p.id = pi."purchaseId"
      JOIN inventory_items i ON i.id = pi."itemId"
      LEFT JOIN inventory_categories c ON c.id = i."categoryId"
      WHERE ${scope} AND ${COMMITTED}
      GROUP BY 1 ORDER BY value DESC
    `,
    prisma.$queryRaw<Array<{ key: string | null; label: string | null; value: bigint | null }>>`
      SELECT p."supplierId" AS key, COALESCE(s.name, 'No supplier') AS label,
             COALESCE(SUM(p.total), 0)::bigint AS value
      FROM purchases p
      LEFT JOIN suppliers s ON s.id = p."supplierId"
      WHERE ${scope} AND ${COMMITTED}
      GROUP BY 1, 2 ORDER BY value DESC
    `,
    /*
     * CLOSED means two different things and the status alone cannot tell them
     * apart: fully received and then signed off, or closed short because the
     * rest was never coming. `receivedAt` is set by receiving.ts only when every
     * line is complete, so it is what separates them — closed-short is reported
     * as partial, which is what it is.
     */
    prisma.$queryRaw<Array<{ key: string; count: bigint | null }>>`
      SELECT CASE
               WHEN p.status = 'RECEIVED' THEN 'RECEIVED'
               WHEN p.status = 'CLOSED' AND p."receivedAt" IS NOT NULL THEN 'RECEIVED'
               WHEN p.status = 'CLOSED' THEN 'PARTIAL'
               WHEN p.status = 'PARTIALLY_RECEIVED' THEN 'PARTIAL'
               WHEN p.status = 'CANCELLED' THEN 'CANCELLED'
               ELSE 'PENDING'
             END AS key,
             COUNT(*)::bigint AS count
      FROM purchases p WHERE ${scope} AND ${ORDERS}
      GROUP BY 1
    `,
    prisma.$queryRaw<Array<{ count: bigint | null }>>`
      SELECT COUNT(*)::bigint AS count FROM purchases p
      WHERE ${scope} AND p.status IN ('DRAFT','PENDING_APPROVAL','RETURNED','REJECTED')
    `,
    /*
     * Twelve months of this year beside twelve of last. Not bounded by the
     * chosen period — the panel is a year-on-year comparison and would be empty
     * for every range shorter than a month if it were.
     */
    prisma.$queryRaw<Array<{ y: number; m: number; value: bigint | null }>>`
      SELECT EXTRACT(YEAR FROM ${localBucket('month', PLACED_AT_COLUMN, params.timeZone)})::int AS y,
             EXTRACT(MONTH FROM ${localBucket('month', PLACED_AT_COLUMN, params.timeZone)})::int AS m,
             COALESCE(SUM(p.total), 0)::bigint AS value
      FROM purchases p
      WHERE p."restaurantId" = ${params.restaurantId} ${branch} AND ${COMMITTED}
        AND ${PLACED_AT} >= ${utc(new Date(Date.UTC(year - 1, 0, 1)))}
        AND ${PLACED_AT} < ${utc(new Date(Date.UTC(year + 1, 0, 1)))}
      GROUP BY 1, 2
    `,
  ])

  const purchaseValue = n(totalsRow[0]?.value)
  const orders = n(totalsRow[0]?.orders)
  const prevValue = n(prevRow[0]?.value)
  const prevOrders = n(prevRow[0]?.orders)
  const returns = n(returnsRow[0]?.total)
  const committed = n(varianceRow[0]?.committed)
  const actual = n(varianceRow[0]?.actual)

  const aov = orders > 0 ? Math.round(purchaseValue / orders) : 0
  const prevAov = prevOrders > 0 ? Math.round(prevValue / prevOrders) : 0

  const categories = categoryRows.map((r) => ({ key: r.key ?? 'Uncategorised', value: n(r.value) }))
  const categoryTotal = categories.reduce((s, r) => s + r.value, 0)
  const suppliers = supplierRows.map((r) => ({
    key: r.key ?? 'none',
    label: r.label ?? 'No supplier',
    value: n(r.value),
  }))
  const supplierTotal = suppliers.reduce((s, r) => s + r.value, 0)

  const statusLabels: Record<string, string> = {
    RECEIVED: 'Received',
    PENDING: 'Pending',
    PARTIAL: 'Partial',
    CANCELLED: 'Cancelled',
  }
  const statusCounts = new Map(statusRows.map((r) => [r.key, n(r.count)]))
  const statusTotal = [...statusCounts.values()].reduce((s, c) => s + c, 0)

  const monthly = Array.from({ length: 12 }, (_, i) => {
    const month = i + 1
    const find = (y: number) =>
      n(monthlyRows.find((r) => Number(r.y) === y && Number(r.m) === month)?.value)
    return {
      label: new Date(Date.UTC(2000, i, 1)).toLocaleString('en', { month: 'short' }),
      thisYear: find(year),
      lastYear: find(year - 1),
    }
  })

  return {
    totals: {
      purchaseValue,
      orders,
      suppliers: n(supplierCounts[0]?.used),
      newSuppliers: n(supplierCounts[0]?.fresh),
      averageOrderValue: aov,
      returns,
      variance: {
        committed,
        actual,
        amount: actual - committed,
        percent: committed > 0 ? Math.round(((actual - committed) / committed) * 1000) / 10 : null,
      },
    },
    deltas: {
      purchaseValue: pctChange(purchaseValue, prevValue),
      orders: pctChange(orders, prevOrders),
      averageOrderValue: pctChange(aov, prevAov),
      returns: pctChange(returns, n(prevReturnsRow[0]?.total)),
    },
    trend: trendRows.map((r) => ({ label: r.key, value: n(r.value) })),
    byCategory: categories.map((r) => ({
      key: r.key,
      label: r.key,
      value: r.value,
      share: shareOf(r.value, categoryTotal),
    })),
    bySupplier: suppliers.map((r) => ({
      key: r.key,
      label: r.label,
      value: r.value,
      share: shareOf(r.value, supplierTotal),
    })),
    byStatus: ['RECEIVED', 'PENDING', 'PARTIAL', 'CANCELLED'].map((key) => ({
      key,
      label: statusLabels[key],
      count: statusCounts.get(key) ?? 0,
      share: shareOf(statusCounts.get(key) ?? 0, statusTotal),
    })),
    awaitingApproval: n(requestRow[0]?.count),
    monthly,
  }
}
