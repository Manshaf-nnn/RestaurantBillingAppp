import 'server-only'

import { Prisma } from '@prisma/client'

import { prisma } from '@/server/db/prisma'
import { localBucket, utc } from '@/server/db/sql-time'
import type { DateRange } from './range'

/**
 * The sales screen's two extras: how the period compares with the one before
 * it, and the three breakdowns its drill-downs read.
 *
 * Kept beside `sales.ts` rather than inside it because they answer different
 * questions. `getSalesReport` answers "how did we do and how does it split",
 * and every screen that shows a figure uses it. These two are the report
 * PAGE's own furniture — the arrows on the tiles, and the tables behind
 * "View details" — so a change to how a tile is decorated never reaches the
 * query that every other screen's numbers come out of.
 */

/* ── Period over period ─────────────────────────────────────────────────── */

export interface SalesDeltas {
  /**
   * Percent change against the preceding period of the SAME LENGTH, or null.
   *
   * Null rather than zero when the previous period sold nothing: "up 0%" and
   * "there is nothing to compare with" are different statements, and a tile
   * that cannot tell them apart invents a trend out of a restaurant's first
   * week of trading.
   */
  grossSales: number | null
  orders: number | null
  averageOrderValue: number | null
  itemsSold: number | null
  discounts: number | null
  netSales: number | null
  /** What it is being compared against, so the screen can say so. */
  previous: { from: string; to: string }
}

function pctChange(now: number, before: number): number | null {
  if (before === 0) return null
  return Math.round(((now - before) / Math.abs(before)) * 1000) / 10
}

export async function getSalesDeltas(params: {
  restaurantId: string
  range: DateRange
  branchIds?: string[] | null
  /** This period's figures, already computed — not fetched twice. */
  current: {
    grossSales: number
    orders: number
    averageOrderValue: number
    itemsSold: number
    discounts: number
    netSales: number
  }
}): Promise<SalesDeltas> {
  /*
   * The window immediately before this one, of equal length. A month is
   * compared with the month before it, a Tuesday with the Monday — whatever
   * the owner picked, the comparison is the same shape, so the arrow always
   * means "against the last one of these".
   */
  const span = params.range.to.getTime() - params.range.from.getTime()
  const prevTo = new Date(params.range.from.getTime() - 1)
  const prevFrom = new Date(prevTo.getTime() - span)

  const branchFilter =
    params.branchIds && params.branchIds.length > 0
      ? Prisma.sql`AND o."branchId" IN (${Prisma.join(params.branchIds)})`
      : Prisma.empty

  const scope = Prisma.sql`
    o."restaurantId" = ${params.restaurantId}
    AND o.status <> 'CANCELLED'
    AND o."placedAt" >= ${utc(prevFrom)} AND o."placedAt" <= ${utc(prevTo)}
    ${branchFilter}
  `

  const [totals, sold, refunds] = await Promise.all([
    prisma.$queryRaw<Array<{ gross: bigint | null; discounts: bigint | null; orders: bigint | null }>>`
      SELECT
        COALESCE(SUM(o.subtotal - CASE WHEN o."taxInclusive" THEN o."taxTotal" ELSE 0 END), 0)::bigint AS gross,
        COALESCE(SUM(o."discountTotal" + o."loyaltyDiscount"), 0)::bigint AS discounts,
        COUNT(*)::bigint AS orders
      FROM orders o WHERE ${scope}
    `,
    prisma.$queryRaw<Array<{ sold: bigint | null }>>`
      SELECT COALESCE(SUM(oi.quantity), 0)::bigint AS sold
      FROM order_items oi JOIN orders o ON o.id = oi."orderId"
      WHERE ${scope} AND oi.status <> 'CANCELLED'
    `,
    /* Same basis as the report itself: a refund belongs to the day it was given. */
    prisma.$queryRaw<Array<{ total: bigint | null }>>`
      SELECT COALESCE(SUM(r.amount), 0)::bigint AS total
      FROM refunds r JOIN orders o ON o.id = r."orderId"
      WHERE o."restaurantId" = ${params.restaurantId}
        AND o.status <> 'CANCELLED'
        AND r."createdAt" >= ${utc(prevFrom)} AND r."createdAt" <= ${utc(prevTo)}
        ${branchFilter}
    `,
  ])

  const n = (v: bigint | null | undefined) => Number(v ?? 0)
  const gross = n(totals[0]?.gross)
  const discounts = n(totals[0]?.discounts)
  const orders = n(totals[0]?.orders)
  const net = gross - discounts - n(refunds[0]?.total)
  const aov = orders > 0 ? Math.round(net / orders) : 0
  const itemsSold = n(sold[0]?.sold)

  return {
    grossSales: pctChange(params.current.grossSales, gross),
    orders: pctChange(params.current.orders, orders),
    averageOrderValue: pctChange(params.current.averageOrderValue, aov),
    itemsSold: pctChange(params.current.itemsSold, itemsSold),
    discounts: pctChange(params.current.discounts, discounts),
    netSales: pctChange(params.current.netSales, net),
    previous: { from: prevFrom.toISOString(), to: prevTo.toISOString() },
  }
}

/* ── The drill-down tables ──────────────────────────────────────────────── */

export interface BreakdownRow {
  key: string
  label: string
  /** A second line under the label — an item's category, a method's account. */
  sub: string | null
  /**
   * The dish's picture, where the dish still exists and has one.
   *
   * Null is ordinary, not an error: a row is keyed on the name snapshotted onto
   * the line, so a dish since deleted still reports its sales and simply has no
   * picture to show for them.
   */
  imageUrl: string | null
  orders: number
  itemsSold: number
  gross: number
  discount: number
  net: number
  /** Share of the period's net sales, percent to one decimal. */
  share: number
}

/**
 * ── Why the discount column is apportioned, and how ─────────────────────────
 *
 * A discount belongs to a BILL, not to a dish: "10% off" is taken off the
 * bill, and no column anywhere records which of its lines gave up the money.
 * A by-item table with a discount column therefore has to divide it, and the
 * only honest division is in proportion to what each line contributed.
 *
 * Dividing in proportion does not land on whole cents, so this uses largest
 * remainder — floor every share, then hand the leftover units to the lines
 * with the biggest fractions. That is the same rule `apportion()` in
 * profit.ts applies for the same reason, and it is what makes the column add
 * up: the shares of a bill's discount sum to that bill's discount exactly,
 * so the table's own total equals the tile above it rather than missing it by
 * a few cents per order.
 *
 * It is done in SQL because the rest of this report is, and because the
 * alternative is reading every line of every bill in the range into memory to
 * add up fifty rows.
 */
const APPORTIONED_LINES = Prisma.sql`
  , floored AS (
    SELECT s.*,
           FLOOR(s.raw) AS base,
           s.disc - SUM(FLOOR(s.raw)) OVER (PARTITION BY s.oid) AS residue,
           ROW_NUMBER() OVER (
             PARTITION BY s.oid ORDER BY s.raw - FLOOR(s.raw) DESC, s.line_id
           ) AS rn
    FROM share s
  )
  , apportioned AS (
    SELECT f.*, (f.base + CASE WHEN f.rn <= f.residue THEN 1 ELSE 0 END)::bigint AS line_discount
    FROM floored f
  )
`

export interface SalesBreakdowns {
  byItem: BreakdownRow[]
  byTime: BreakdownRow[]
  byPayment: BreakdownRow[]
}

export async function getSalesBreakdowns(params: {
  restaurantId: string
  range: DateRange
  branchIds?: string[] | null
  timeZone: string
  /** The period's net sales, for the share column. */
  netSales: number
}): Promise<SalesBreakdowns> {
  const from = utc(params.range.from)
  const to = utc(params.range.to)
  const branchFilter =
    params.branchIds && params.branchIds.length > 0
      ? Prisma.sql`AND o."branchId" IN (${Prisma.join(params.branchIds)})`
      : Prisma.empty

  const scope = Prisma.sql`
    o."restaurantId" = ${params.restaurantId}
    AND o.status <> 'CANCELLED'
    AND o."placedAt" >= ${from} AND o."placedAt" <= ${to}
    ${branchFilter}
  `

  /** Every non-cancelled line in the period, with its bill's discount to share. */
  const LINES = Prisma.sql`
    WITH line AS (
      SELECT oi.id AS line_id, oi.name, oi.quantity, oi."lineTotal",
             oi."foodId", o.id AS oid, o."placedAt",
             (o."discountTotal" + o."loyaltyDiscount")::bigint AS disc,
             o.subtotal
      FROM order_items oi
      JOIN orders o ON o.id = oi."orderId"
      WHERE ${scope} AND oi.status <> 'CANCELLED'
    )
    , share AS (
      SELECT l.*,
             CASE WHEN l.subtotal > 0
                  THEN l.disc::numeric * l."lineTotal" / l.subtotal
                  ELSE 0 END AS raw
      FROM line l
    )
    ${APPORTIONED_LINES}
  `

  type Raw = {
    key: string | null; label: string | null; sub: string | null
    orders: bigint | null; sold: bigint | null
    gross: bigint | null; discount: bigint | null
    image: string | null
  }

  const [itemRows, timeRows, paymentRows] = await Promise.all([
    /*
     * Keyed on the line's snapshotted NAME, matching `byItem` in sales.ts: the
     * name on the line is what was sold under that name at that moment, so a
     * dish since renamed or deleted still reports as itself. The category comes
     * from the food where it still exists, which is why it is a MAX over a left
     * join and not part of the key.
     */
    prisma.$queryRaw<Raw[]>`
      ${LINES}
      SELECT a.name AS key, a.name AS label,
             MAX(c.name) AS sub,
             MAX(f."imageUrl") AS image,
             COUNT(DISTINCT a.oid)::bigint AS orders,
             COALESCE(SUM(a.quantity), 0)::bigint AS sold,
             COALESCE(SUM(a."lineTotal"), 0)::bigint AS gross,
             COALESCE(SUM(a.line_discount), 0)::bigint AS discount
      FROM apportioned a
      LEFT JOIN foods f ON f.id = a."foodId"
      LEFT JOIN categories c ON c.id = f."categoryId"
      GROUP BY 1, 2
      ORDER BY gross DESC
      LIMIT 100
    `,

    /*
     * By hour of the local day, bucketed with the same `localBucket` the rest
     * of the report uses — `placedAt` is naive UTC, and reading its hour in the
     * server's zone is how this chart once came out shifted by an offset.
     */
    prisma.$queryRaw<Raw[]>`
      ${LINES}
      SELECT to_char(${localBucket('hour', 'a."placedAt"', params.timeZone)}, 'HH24') AS key,
             NULL AS label, NULL AS sub, NULL AS image,
             COUNT(DISTINCT a.oid)::bigint AS orders,
             COALESCE(SUM(a.quantity), 0)::bigint AS sold,
             COALESCE(SUM(a."lineTotal"), 0)::bigint AS gross,
             COALESCE(SUM(a.line_discount), 0)::bigint AS discount
      FROM apportioned a
      GROUP BY 1
      ORDER BY 1
    `,

    /*
     * Payments, not bills: this one groups the money that actually came in,
     * so its rows are payment rows and its discount is the bill's discount
     * attributed to the payments that settled it — apportioned the same way,
     * because a bill can be settled by more than one payment.
     */
    prisma.$queryRaw<Raw[]>`
      WITH pay AS (
        SELECT p.id AS line_id, p.method::text AS name, p.amount AS "lineTotal",
               1::int AS quantity, p."destination", o.id AS oid,
               (o."discountTotal" + o."loyaltyDiscount")::bigint AS disc,
               NULLIF(o."paidTotal", 0) AS subtotal
        FROM payments p
        JOIN orders o ON o.id = p."orderId"
        WHERE ${scope} AND p.status IN ('PAID', 'REFUNDED')
      )
      , share AS (
        SELECT pa.*,
               CASE WHEN pa.subtotal > 0
                    THEN pa.disc::numeric * pa."lineTotal" / pa.subtotal
                    ELSE 0 END AS raw
        FROM pay pa
      )
      ${APPORTIONED_LINES}
      SELECT a.name AS key, a.name AS label,
             MAX(a."destination") AS sub, NULL AS image,
             COUNT(*)::bigint AS orders,
             0::bigint AS sold,
             COALESCE(SUM(a."lineTotal"), 0)::bigint AS gross,
             COALESCE(SUM(a.line_discount), 0)::bigint AS discount
      FROM apportioned a
      GROUP BY 1, 2
      ORDER BY gross DESC
    `,
  ])

  const n = (v: bigint | number | null | undefined) => Number(v ?? 0)
  const toRows = (rows: Raw[], label?: (key: string) => string): BreakdownRow[] =>
    rows.map((row) => {
      const key = row.key ?? 'none'
      const gross = n(row.gross)
      const discount = n(row.discount)
      const net = gross - discount
      return {
        key,
        label: label ? label(key) : (row.label ?? key),
        sub: row.sub,
        imageUrl: row.image,
        orders: n(row.orders),
        itemsSold: n(row.sold),
        gross,
        discount,
        net,
        share: params.netSales > 0 ? Math.round((net / params.netSales) * 1000) / 10 : 0,
      }
    })

  return {
    byItem: toRows(itemRows),
    // "08:00 AM – 09:00 AM", the way the drill-down reads it.
    byTime: toRows(timeRows, (key) => {
      const h = Number(key)
      const face = (n24: number) => {
        const h12 = n24 % 12 === 0 ? 12 : n24 % 12
        return `${String(h12).padStart(2, '0')}:00 ${n24 < 12 ? 'AM' : 'PM'}`
      }
      return `${face(h)} – ${face((h + 1) % 24)}`
    }),
    /*
     * BANK_TRANSFER → "Bank Transfer". Lowercased FIRST: the enum arrives in
     * capitals, and title-casing a word that is already capitals leaves it
     * shouting.
     */
    byPayment: toRows(paymentRows, (key) =>
      key.toLowerCase().replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
    ),
  }
}
