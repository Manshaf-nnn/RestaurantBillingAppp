import 'server-only'

import { Prisma } from '@prisma/client'

import { prisma } from '@/server/db/prisma'
import { METHOD_LABELS, destinationName, readPaymentConfig } from '@/features/payments/service'
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
          -- Ex-tax on every bill: an inclusive bill's subtotal already holds
          -- the tax that the tax column reports, so it is taken back out —
          -- net sales must never contain tax, whichever way the menu prices it.
          COALESCE(SUM(o.subtotal - CASE WHEN o."taxInclusive" THEN o."taxTotal" ELSE 0 END), 0)::bigint AS gross,
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
       * REFUNDED — partial refunds only exist there.
       *
       * Dated when the money went back, not by the order it belongs to
       * (owner decision, 2026-09-13). The two conventions lived side by side —
       * this report by order date, the payments report and the journal by
       * refund date — so a March refund of a January bill changed January's
       * signed net sales while showing in March's cash. One basis now; a
       * refund belongs to the day it was given, and a sealed month stays what
       * it was. A cancelled order's refunds are left out because cancellation
       * already removed its sale.
       */
      prisma.$queryRaw<Array<{ total: bigint | null }>>`
        SELECT COALESCE(SUM(r.amount), 0)::bigint AS total
        FROM refunds r
        JOIN orders o ON o.id = r."orderId"
        WHERE o."restaurantId" = ${params.restaurantId}
          AND o.status <> 'CANCELLED'
          AND r."createdAt" >= ${from} AND r."createdAt" <= ${to}
          ${branchFilter}
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
  /**
   * The same money by where it was allocated (bill.md §2). `destination` is
   * null for payments taken before destinations existed — labelled
   * "Unassigned" rather than folded into an account they never reached.
   */
  byDestination: Array<{
    destination: string | null
    label: string
    amount: number
    count: number
    share: number
  }>
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
      // Destination rides along on the SAME rows, so the two breakdowns below
      // are guaranteed to sum to the same total rather than being two queries
      // that can disagree.
      by: ['method', 'status', 'destination'],
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
        // The count is final at PENDING_REVIEW; review only signs it. The
        // journal's J16 counts both, and a drawer parked for review is by
        // definition one of the large variances — this line must not omit it.
        status: { in: ['CLOSED', 'PENDING_REVIEW'] },
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

  // One copy of the names, in the module that owns payments.
  const LABELS = METHOD_LABELS
  // Names come from settings, so a renamed account renames every label here
  // too — including on reports of months already gone.
  const config = readPaymentConfig(
    (await prisma.restaurant.findUnique({
      where: { id: params.restaurantId },
      select: { paymentConfig: true },
    }))?.paymentConfig,
  )

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
    /*
     * The same money, grouped by where it was allocated (bill.md §2).
     *
     * Payments taken before destinations existed carry none, and are reported
     * as "Unassigned" rather than quietly folded into a bank they never
     * reached — the honest answer, and it makes the rollout visible.
     */
    byDestination: [...paid
      .reduce((map, p) => {
        const code = p.destination ?? null
        const row = map.get(code) ?? { destination: code, amount: 0, count: 0 }
        row.amount += p._sum?.amount ?? 0
        row.count += p._count
        return map.set(code, row)
      }, new Map<string | null, { destination: string | null; amount: number; count: number }>())
      .values()]
      .map((row) => ({
        destination: row.destination,
        label: destinationName(config, row.destination),
        amount: row.amount,
        count: row.count,
        share: total > 0 ? Math.round((row.amount / total) * 10000) / 100 : 0,
      }))
      .sort((a, b) => b.amount - a.amount),
    cashDiscrepancy: drawers.reduce((s, d) => s + (d.variance ?? 0), 0),
    drawersClosed: drawers.length,
  }
}

/* ── One item, and what was actually paid for the bills it was on ─────────── */

/**
 * A payment settles a BILL, not a dish.
 *
 * There is no link from a payment to a line — `Payment.orderId` is the only
 * join there is, and no allocation table exists. So "the payments for this
 * item" can only honestly mean: the orders this item appeared on in this
 * period, and what was paid against each of those orders.
 *
 * Splitting a payment across the lines of its bill (line total ÷ subtotal ×
 * amount) would produce a number that looks precise and was never recorded
 * anywhere. This reports both figures side by side instead — the item's own
 * line total, and the bill's payments — which is the same convention the
 * refunds basis in this file already follows.
 */
export interface ItemPaymentRow {
  orderId: string
  orderNumber: string
  placedAt: Date
  branchName: string | null
  customerName: string | null
  /** How many of THIS item were on that order. */
  quantity: number
  /** What those lines came to, before the bill's own discounts and tax. */
  lineTotal: number
  /** The whole bill. */
  orderTotal: number
  orderPaid: number
  orderStatus: string
  paymentStatus: string
  /** Every payment recorded against the order, in the order they were taken. */
  payments: Array<{
    id: string
    method: string
    methodLabel: string
    amount: number
    status: string
    paidAt: Date | null
    receivedByName: string | null
    reference: string | null
  }>
  /** Money given back on this bill, whenever it was given. */
  refunded: number
}

export interface ItemPaymentDetail {
  itemName: string
  orders: number
  quantity: number
  /** Σ of this item's line totals across the period. */
  lineRevenue: number
  /** Σ of the whole bills those lines were on — deliberately a different figure. */
  billTotal: number
  /** Σ paid against those bills. */
  paid: number
  refunded: number
  rows: ItemPaymentRow[]
  /** More orders matched than are listed. */
  truncated: boolean
}

/** The most orders one item's drill-down will list. */
const ITEM_DETAIL_CAP = 300

export async function getItemPaymentDetail(params: {
  restaurantId: string
  range: DateRange
  branchIds: string[] | null
  /** The snapshotted line name, which is how `byItem` groups. */
  itemName: string
}): Promise<ItemPaymentDetail> {
  /*
   * The range's own Dates, not `utc()` — that helper builds a SQL fragment for
   * the raw queries above, and this one goes through the Prisma client.
   */
  const { from, to } = params.range

  /*
   * Fail closed: an empty allow-list means this viewer sees nothing, never
   * everything — the same rule `getSalesReport` applies above.
   */
  const orders = await prisma.order.findMany({
    where: {
      restaurantId: params.restaurantId,
      status: { not: 'CANCELLED' },
      placedAt: { gte: from, lte: to },
      ...(params.branchIds ? { branchId: { in: params.branchIds } } : {}),
      items: { some: { name: params.itemName, status: { not: 'CANCELLED' } } },
    },
    orderBy: { placedAt: 'desc' },
    take: ITEM_DETAIL_CAP + 1,
    select: {
      id: true,
      orderNumber: true,
      placedAt: true,
      status: true,
      paymentStatus: true,
      grandTotal: true,
      paidTotal: true,
      customerName: true,
      branch: { select: { name: true } },
      items: {
        where: { name: params.itemName, status: { not: 'CANCELLED' } },
        select: { quantity: true, lineTotal: true },
      },
      payments: {
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          method: true,
          amount: true,
          status: true,
          paidAt: true,
          reference: true,
          receivedBy: { select: { name: true } },
        },
      },
      refunds: { select: { amount: true } },
    },
  })

  const truncated = orders.length > ITEM_DETAIL_CAP
  const kept = truncated ? orders.slice(0, ITEM_DETAIL_CAP) : orders

  const rows: ItemPaymentRow[] = kept.map((order) => ({
    orderId: order.id,
    orderNumber: order.orderNumber,
    placedAt: order.placedAt,
    branchName: order.branch?.name ?? null,
    customerName: order.customerName || null,
    quantity: order.items.reduce((sum, line) => sum + line.quantity, 0),
    lineTotal: order.items.reduce((sum, line) => sum + line.lineTotal, 0),
    orderTotal: order.grandTotal,
    orderPaid: order.paidTotal,
    orderStatus: order.status as string,
    paymentStatus: order.paymentStatus as string,
    payments: order.payments.map((payment) => ({
      id: payment.id,
      method: payment.method as string,
      methodLabel: METHOD_LABELS[payment.method] ?? (payment.method as string),
      amount: payment.amount,
      status: payment.status as string,
      paidAt: payment.paidAt,
      receivedByName: payment.receivedBy?.name ?? null,
      reference: payment.reference,
    })),
    refunded: order.refunds.reduce((sum, refund) => sum + refund.amount, 0),
  }))

  return {
    itemName: params.itemName,
    orders: rows.length,
    quantity: rows.reduce((sum, row) => sum + row.quantity, 0),
    lineRevenue: rows.reduce((sum, row) => sum + row.lineTotal, 0),
    billTotal: rows.reduce((sum, row) => sum + row.orderTotal, 0),
    // Only payments that actually settled; a failed attempt is not takings.
    paid: rows.reduce(
      (sum, row) =>
        sum + row.payments.filter((p) => p.status === 'PAID').reduce((inner, p) => inner + p.amount, 0),
      0,
    ),
    refunded: rows.reduce((sum, row) => sum + row.refunded, 0),
    rows,
    truncated,
  }
}
