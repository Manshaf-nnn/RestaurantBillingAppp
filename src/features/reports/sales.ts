import 'server-only'

import { Prisma } from '@prisma/client'

import { prisma } from '@/server/db/prisma'
import { localBucket, utc } from '@/server/db/sql-time'
import type { DateRange } from './range'

/**
 * Sales reporting.
 *
 * ── What counts as a sale ───────────────────────────────────────────────────
 *
 * Cancelled orders are excluded entirely; refunded ones are included at their
 * original value with the refund shown separately. Netting a refund off the day
 * it was *given* rather than the day of the sale is what makes a report
 * disagree with the till, so both figures are reported rather than merged.
 *
 * ── Gross vs net ────────────────────────────────────────────────────────────
 *
 *   gross = the sum of what was sold before anything is taken off
 *   net   = gross − discounts − refunds, still before tax
 *
 * Tax and service charge are reported alongside, never folded into net, because
 * neither is the restaurant's money.
 */

export interface SalesTotals {
  grossSales: number
  discounts: number
  refunds: number
  netSales: number
  tax: number
  serviceCharge: number
  tips: number
  /** What actually landed: net + tax + service. */
  collected: number
  orders: number
  guests: number
  averageOrderValue: number
}

export interface Bucket {
  key: string
  label: string
  sales: number
  orders: number
}

export interface SalesReport {
  range: { from: string; to: string; label: string }
  totals: SalesTotals
  byHour: Bucket[]
  byDay: Bucket[]
  byCategory: Bucket[]
  byItem: Array<Bucket & { quantity: number }>
  byBranch: Bucket[]
  byEmployee: Bucket[]
  byType: Bucket[]
}

export async function getSalesReport(params: {
  restaurantId: string
  range: DateRange
  branchIds?: string[] | null
}): Promise<SalesReport> {
  /*
   * ── Aggregated in SQL, and bucketed in the restaurant's own timezone ───────
   *
   * This used to load every order in the range — with its items, food,
   * category, branch and two user relations — and fold them into JS Maps. Two
   * separate problems with that, and the second is the one that was actually
   * showing people wrong numbers:
   *
   * 1. It was unbounded. A year's range on a busy restaurant pulled every row
   *    and every line into memory before summing anything (production.md §4:
   *    no unbounded queries, use SQL aggregation).
   *
   * 2. The hour and day buckets were in the WRONG TIMEZONE. `placedAt` is a
   *    naive-UTC column; the old code called `.getHours()` on it, which reads
   *    the SERVER's clock, and `.toISOString().slice(0,10)`, which is UTC. The
   *    range was resolved correctly in the restaurant's timezone and then
   *    bucketed in a different one. On Netlify — a UTC host — an Asia/Colombo
   *    restaurant's "sales by hour" chart was shifted five and a half hours,
   *    and "by day" cut the day at 05:30 local, so an evening's trade was
   *    reported against the following morning. The existing test only checked
   *    that the hours came back sorted, which they faithfully did.
   *
   * `localBucket()` from sql-time.ts builds the double `AT TIME ZONE` that a
   * naive-UTC column needs, and `utc()` pins the range bounds so the session
   * timezone cannot move them. Read its header before touching any of this:
   * both mistakes are the kind that look right and are off by an offset.
   */
  const restaurant = await prisma.restaurant.findUniqueOrThrow({
    where: { id: params.restaurantId },
    select: { timezone: true },
  })
  const tz = restaurant.timezone || 'UTC'

  const from = utc(params.range.from)
  const to = utc(params.range.to)
  // An empty allow-list means "sees nothing", never "sees everything" — the
  // same fail-closed rule the branch guards use everywhere else.
  const branchFilter = params.branchIds
    ? Prisma.sql`AND o."branchId" IN (${Prisma.join(
        params.branchIds.length > 0 ? params.branchIds : ['\u0000none'],
      )})`
    : Prisma.empty

  const ORDER_SCOPE = Prisma.sql`
    o."restaurantId" = ${params.restaurantId}
    AND o.status <> 'CANCELLED'
    AND o."placedAt" >= ${from} AND o."placedAt" <= ${to}
    ${branchFilter}
  `

  type Row = { key: string | null; label: string | null; sales: bigint | null; orders: bigint | null }
  const num = (value: bigint | number | null | undefined) => Number(value ?? 0)

  const [totalsRow, refunded, hourRows, dayRows, typeRows, branchRows, employeeRows, categoryRows, itemRows] =
    await Promise.all([
      prisma.$queryRaw<Array<{
        gross: bigint | null; discounts: bigint | null; tax: bigint | null
        service: bigint | null; tips: bigint | null; guests: bigint | null; orders: bigint | null
      }>>`
        SELECT
          COALESCE(SUM(o.subtotal), 0)::bigint                                  AS gross,
          COALESCE(SUM(o."discountTotal" + o."loyaltyDiscount"), 0)::bigint     AS discounts,
          COALESCE(SUM(o."taxTotal"), 0)::bigint                                AS tax,
          COALESCE(SUM(o."serviceCharge"), 0)::bigint                           AS service,
          COALESCE(SUM(o."tipAmount"), 0)::bigint                               AS tips,
          COALESCE(SUM(o."guestCount"), 0)::bigint                              AS guests,
          COUNT(*)::bigint                                                      AS orders
        FROM orders o WHERE ${ORDER_SCOPE}
      `,

      /*
       * Refunds come from the refunds ledger, not from payment rows flipped to
       * REFUNDED — partial refunds only exist there. Attributed to the order
       * they belong to rather than the day they were given, so a report always
       * reconciles against the bill it describes.
       */
      prisma.$queryRaw<Array<{ total: bigint | null }>>`
        SELECT COALESCE(SUM(r.amount), 0)::bigint AS total
        FROM refunds r
        JOIN orders o ON o.id = r."orderId"
        WHERE ${ORDER_SCOPE}
      `,

      prisma.$queryRaw<Row[]>`
        SELECT to_char(${localBucket('hour', 'o."placedAt"', tz)}, 'HH24') AS key,
               NULL AS label,
               COALESCE(SUM(o.subtotal), 0)::bigint AS sales,
               COUNT(*)::bigint AS orders
        FROM orders o WHERE ${ORDER_SCOPE}
        GROUP BY 1 ORDER BY 1
      `,

      prisma.$queryRaw<Row[]>`
        SELECT to_char(${localBucket('day', 'o."placedAt"', tz)}, 'YYYY-MM-DD') AS key,
               NULL AS label,
               COALESCE(SUM(o.subtotal), 0)::bigint AS sales,
               COUNT(*)::bigint AS orders
        FROM orders o WHERE ${ORDER_SCOPE}
        GROUP BY 1 ORDER BY 1
      `,

      prisma.$queryRaw<Row[]>`
        SELECT o.type::text AS key, NULL AS label,
               COALESCE(SUM(o.subtotal), 0)::bigint AS sales, COUNT(*)::bigint AS orders
        FROM orders o WHERE ${ORDER_SCOPE}
        GROUP BY 1
      `,

      prisma.$queryRaw<Row[]>`
        SELECT COALESCE(o."branchId", 'none') AS key,
               COALESCE(b.name, 'Unassigned') AS label,
               COALESCE(SUM(o.subtotal), 0)::bigint AS sales, COUNT(*)::bigint AS orders
        FROM orders o
        LEFT JOIN branches b ON b.id = o."branchId"
        WHERE ${ORDER_SCOPE}
        GROUP BY 1, 2
      `,

      /*
       * Credit the person who SERVED the table, falling back to whoever keyed
       * the order in. A cashier ringing up a waiter's order must not appear as
       * the top seller. Orders with neither are simply not attributed, which is
       * why this filters rather than grouping them under 'none'.
       */
      prisma.$queryRaw<Row[]>`
        SELECT COALESCE(o."servedById", o."createdById") AS key,
               u.name AS label,
               COALESCE(SUM(o.subtotal), 0)::bigint AS sales, COUNT(*)::bigint AS orders
        FROM orders o
        JOIN users u ON u.id = COALESCE(o."servedById", o."createdById")
        WHERE ${ORDER_SCOPE}
        GROUP BY 1, 2
      `,

      prisma.$queryRaw<Row[]>`
        SELECT COALESCE(c.id, 'none') AS key,
               COALESCE(c.name, 'Uncategorised') AS label,
               COALESCE(SUM(oi."lineTotal"), 0)::bigint AS sales,
               COUNT(*)::bigint AS orders
        FROM order_items oi
        JOIN orders o ON o.id = oi."orderId"
        LEFT JOIN foods f ON f.id = oi."foodId"
        LEFT JOIN categories c ON c.id = f."categoryId"
        WHERE ${ORDER_SCOPE} AND oi.status <> 'CANCELLED'
        GROUP BY 1, 2
      `,

      /*
       * Keyed by the line's snapshotted NAME, not the food id, and deliberately.
       * The name on the line is what was sold under that name at that moment; a
       * dish later renamed or deleted still reports as itself, which is the
       * whole reason the name is snapshotted onto the line.
       */
      prisma.$queryRaw<Array<Row & { quantity: bigint | null }>>`
        SELECT oi.name AS key, oi.name AS label,
               COALESCE(SUM(oi."lineTotal"), 0)::bigint AS sales,
               COUNT(*)::bigint AS orders,
               COALESCE(SUM(oi.quantity), 0)::bigint AS quantity
        FROM order_items oi
        JOIN orders o ON o.id = oi."orderId"
        WHERE ${ORDER_SCOPE} AND oi.status <> 'CANCELLED'
        GROUP BY 1, 2
        ORDER BY sales DESC
        LIMIT 50
      `,
    ])

  const totals = totalsRow[0]
  const grossSales = num(totals?.gross)
  const discounts = num(totals?.discounts)
  const refunds = num(refunded[0]?.total)
  const tax = num(totals?.tax)
  const serviceCharge = num(totals?.service)
  const tips = num(totals?.tips)
  const guests = num(totals?.guests)
  const orderCount = num(totals?.orders)
  const netSales = grossSales - discounts - refunds

  const toBuckets = (rows: Row[]): Bucket[] =>
    rows
      .map((row) => ({
        key: row.key ?? 'none',
        label: row.label ?? row.key ?? 'none',
        sales: num(row.sales),
        orders: num(row.orders),
      }))
      .sort((a, b) => b.sales - a.sales)

  return {
    range: {
      from: params.range.from.toISOString(),
      to: params.range.to.toISOString(),
      label: params.range.label,
    },
    totals: {
      grossSales,
      discounts,
      refunds,
      netSales,
      tax,
      serviceCharge,
      tips,
      collected: netSales + tax + serviceCharge,
      orders: orderCount,
      guests,
      averageOrderValue: orderCount > 0 ? Math.round(netSales / orderCount) : 0,
    },
    // Hours and days read chronologically; everything else biggest first.
    byHour: toBuckets(hourRows)
      .sort((a, b) => a.key.localeCompare(b.key))
      .map((bucket) => ({ ...bucket, label: `${bucket.key}:00` })),
    byDay: toBuckets(dayRows).sort((a, b) => a.key.localeCompare(b.key)),
    byCategory: toBuckets(categoryRows),
    byItem: itemRows.map((row) => ({
      key: row.key ?? 'none',
      label: row.label ?? row.key ?? 'none',
      sales: num(row.sales),
      orders: num(row.orders),
      quantity: num(row.quantity),
    })),
    byBranch: toBuckets(branchRows),
    byEmployee: toBuckets(employeeRows),
    byType: toBuckets(typeRows).map((bucket) => ({
      ...bucket,
      label: bucket.key.replace(/_/g, ' ').toLowerCase(),
    })),
  }
}

export interface PaymentsReport {
  byMethod: Array<{ method: string; label: string; amount: number; count: number; share: number }>
  total: number
  refunded: number
  /** Cash counted in drawers minus cash the system recorded. */
  cashDiscrepancy: number
  drawersClosed: number
}

/**
 * Payment mix, and whether the cash actually balanced.
 *
 * The discrepancy figure is the sum of drawer variances over the period. It is
 * reported separately from takings rather than adjusted into them: a till that
 * was short by 500 still took what it took, and hiding the difference inside
 * revenue is how a shortfall stops being noticed.
 */
export async function getPaymentsReport(params: {
  restaurantId: string
  range: DateRange
  branchIds?: string[] | null
}): Promise<PaymentsReport> {
  const [payments, refunds, drawers] = await Promise.all([
    prisma.payment.groupBy({
      by: ['method', 'status'],
      where: {
        restaurantId: params.restaurantId,
        paidAt: { gte: params.range.from, lte: params.range.to },
        status: { in: ['PAID', 'REFUNDED'] },
        // The cash-variance figure ten lines below was already branch-scoped
        // and this was not, so the two halves of the same panel could never be
        // reconciled against each other.
        ...(params.branchIds ? { order: { branchId: { in: params.branchIds } } } : {}),
      },
      _sum: { amount: true },
      _count: true,
    }),
    /*
     * From the refunds ledger, dated when the money went back. Reading the
     * REFUNDED status flip missed every partial refund — a payment half
     * returned still reads PAID — so "collected" overstated by exactly the
     * partials. report-agreement-test caught this the day it was written.
     */
    prisma.refund.aggregate({
      where: {
        restaurantId: params.restaurantId,
        createdAt: { gte: params.range.from, lte: params.range.to },
        ...(params.branchIds ? { order: { branchId: { in: params.branchIds } } } : {}),
      },
      _sum: { amount: true },
    }),
    prisma.cashDrawerSession.findMany({
      where: {
        restaurantId: params.restaurantId,
        status: 'CLOSED',
        closedAt: { gte: params.range.from, lte: params.range.to },
        ...(params.branchIds ? { branchId: { in: params.branchIds } } : {}),
      },
      select: { variance: true },
    }),
  ])

  // PAID and REFUNDED alike arrived as money once; what went back is the
  // refunds ledger's business, subtracted as `refunded` below.
  const total = payments.reduce((s, p) => s + (p._sum?.amount ?? 0), 0)
  const refunded = refunds._sum.amount ?? 0
  const paid = payments

  const LABELS: Record<string, string> = {
    CASH: 'Cash', CARD: 'Card', QR: 'QR', ONLINE: 'Online',
    WALLET: 'Wallet', BANK_TRANSFER: 'Bank transfer', OTHER: 'Other',
  }

  return {
    total,
    refunded,
    byMethod: [...paid
      .reduce((map, p) => {
        // PAID and REFUNDED rows of one method are the same money arriving —
        // merged, or the mix would list Cash twice.
        const row = map.get(p.method) ?? { method: p.method, amount: 0, count: 0 }
        row.amount += p._sum?.amount ?? 0
        row.count += p._count
        return map.set(p.method, row)
      }, new Map<string, { method: string; amount: number; count: number }>())
      .values()]
      .map((p) => ({
        method: p.method,
        label: LABELS[p.method] ?? p.method,
        amount: p.amount,
        count: p.count,
        share: total > 0 ? Math.round((p.amount / total) * 10000) / 100 : 0,
      }))
      .sort((a, b) => b.amount - a.amount),
    cashDiscrepancy: drawers.reduce((s, d) => s + (d.variance ?? 0), 0),
    drawersClosed: drawers.length,
  }
}
