import 'server-only'

import { unstable_cache } from 'next/cache'
import { Prisma } from '@prisma/client'

import { previousRange, type DateRange } from '@/features/reports/range'

import { prisma } from '@/server/db/prisma'
import { localBucket, utc } from '@/server/db/sql-time'
import { percentChange } from '@/lib/utils'

/**
 * How long the trailing-window analytics may lag.
 *
 * The dashboard re-renders on a timer, and these are multi-day aggregations
 * over `order_items` — the most expensive queries in the app. Recomputing a
 * 30-day best-sellers list every fifteen seconds is pure waste: a minute of
 * staleness is invisible on a 30-day window, while the live figures (today's
 * revenue, open orders, the order feed) stay uncached and exact.
 */
const ANALYTICS_TTL_SECONDS = 60

export interface DashboardStats {
  /** Over the chosen period. */
  revenue: number
  revenueChange: number
  orders: number
  ordersChange: number
  averageOrderValue: number
  aovChange: number
  customers: number
  newCustomers: number
  /** Right now, regardless of the period. */
  tablesOccupied: number
  tablesTotal: number
  pendingOrders: number
  unpaidTotal: number
  lowStockCount: number
}

/**
 * Headline numbers for the dashboard hero row, each with a delta.
 *
 * Deliberately one round trip. This was nine parallel queries, which is fine
 * against a local database but not against serverless Postgres: each query pays
 * its own network latency, and the dashboard re-runs this on an interval. The
 * work is trivial for Postgres — it is the round trips that cost — so every
 * figure is gathered as a scalar subquery in a single statement.
 *
 * ── Two clocks in one row, on purpose ───────────────────────────────────────
 *
 * The first four figures answer "how did the chosen period go" and are compared
 * against the window of equal length before it — a month against the month
 * before, not against yesterday. This used to be today-versus-yesterday and
 * nothing else, which is the only comparison that made sense when today was the
 * only window on offer.
 *
 * The last five are *now*: tables occupied, orders still open, money owed,
 * items below reorder level. Giving those a period would be nonsense — "open
 * orders in March" is not a thing anyone wants to know — so they stay live and
 * ignore the range entirely.
 *
 * ── What is scoped to a branch, and the one thing that is not ───────────────
 *
 * `branchIds` used to be absent entirely, so the switcher at the top of the
 * page changed which location was named and not one number beneath it. Three
 * tiles then stayed restaurant-wide on the stated grounds that they "have no
 * branch dimension of their own". That was true of one and wrong about two:
 *
 *   tables      `restaurant_tables.branchId` is NOT NULL. Scoped.
 *   low stock   per-branch balances live in `inventory_stock`, which is what a
 *               location's shelf actually holds. Scoped — a Kandy manager was
 *               being alerted about Colombo running out of rice.
 *   customers   `Customer` genuinely has no branch. A guest belongs to the
 *               restaurant, not to a site, and inventing a branch for them
 *               would be worse than leaving the tile group-wide. Unscoped, on
 *               purpose, and the only one.
 */
export async function getDashboardStats(params: {
  restaurantId: string
  range: DateRange
  branchIds?: string[] | null
}): Promise<DashboardStats> {
  const { restaurantId, range } = params
  const prior = previousRange(range)

  // Bound fragments, never concatenated into the SQL string.
  const ids = params.branchIds
  const atBranch = branchScope(ids)
  const atBranchT = branchScope(ids, 't')

  // The low-stock subquery needs one id or none; a multi-branch selection is
  // only ever "all locations" on this dashboard, which is the null case.
  const oneBranch = ids && ids.length === 1 ? ids[0] : null
  const noBranch = Boolean(ids && ids.length === 0)

  const [row] = await prisma.$queryRaw<
    Array<{
      revenue: bigint
      orders: bigint
      revenue_prior: bigint
      orders_prior: bigint
      tables_total: bigint
      tables_occupied: bigint
      customers: bigint
      new_customers: bigint
      pending_orders: bigint
      unpaid_total: bigint
      low_stock: bigint
    }>
  >`
    SELECT
      (SELECT COALESCE(SUM("grandTotal"), 0) FROM orders
        WHERE "restaurantId" = ${restaurantId} AND status <> 'CANCELLED' ${atBranch}
          AND "placedAt" >= ${utc(range.from)} AND "placedAt" <= ${utc(range.to)})::bigint       AS revenue,
      (SELECT COUNT(*) FROM orders
        WHERE "restaurantId" = ${restaurantId} AND status <> 'CANCELLED' ${atBranch}
          AND "placedAt" >= ${utc(range.from)} AND "placedAt" <= ${utc(range.to)})::bigint       AS orders,
      (SELECT COALESCE(SUM("grandTotal"), 0) FROM orders
        WHERE "restaurantId" = ${restaurantId} AND status <> 'CANCELLED' ${atBranch}
          AND "placedAt" >= ${utc(prior.from)} AND "placedAt" <= ${utc(prior.to)})::bigint       AS revenue_prior,
      (SELECT COUNT(*) FROM orders
        WHERE "restaurantId" = ${restaurantId} AND status <> 'CANCELLED' ${atBranch}
          AND "placedAt" >= ${utc(prior.from)} AND "placedAt" <= ${utc(prior.to)})::bigint       AS orders_prior,
      (SELECT COUNT(*) FROM restaurant_tables t
        WHERE t."restaurantId" = ${restaurantId} AND t."isActive" = true ${atBranchT})::bigint AS tables_total,
      (SELECT COUNT(*) FROM restaurant_tables t
        WHERE t."restaurantId" = ${restaurantId} AND t."isActive" = true ${atBranchT}
          AND t.status = 'OCCUPIED')::bigint                                           AS tables_occupied,
      (SELECT COUNT(DISTINCT "customerId") FROM orders
        WHERE "restaurantId" = ${restaurantId} AND "customerId" IS NOT NULL ${atBranch}
          AND "placedAt" >= ${utc(range.from)} AND "placedAt" <= ${utc(range.to)})::bigint       AS customers,
      (SELECT COUNT(*) FROM customers
        WHERE "restaurantId" = ${restaurantId}
          AND "createdAt" >= ${utc(range.from)} AND "createdAt" <= ${utc(range.to)})::bigint     AS new_customers,
      (SELECT COUNT(*) FROM orders
        WHERE "restaurantId" = ${restaurantId} ${atBranch}
          AND status IN ('PENDING', 'ACCEPTED', 'PREPARING'))::bigint                  AS pending_orders,
      (SELECT COALESCE(SUM("grandTotal" - "paidTotal"), 0) FROM orders
        WHERE "restaurantId" = ${restaurantId} AND status <> 'CANCELLED' ${atBranch}
          AND "paymentStatus" IN ('UNPAID', 'PARTIAL'))::bigint                        AS unpaid_total,
      (SELECT COUNT(*) FROM inventory_items i
        WHERE i."restaurantId" = ${restaurantId} AND i."isActive" = true
          AND ${noBranch} = false
          AND CASE WHEN ${oneBranch}::text IS NULL
                   THEN i.quantity
                   ELSE COALESCE((SELECT SUM(s.available) FROM inventory_stock s
                                   WHERE s."itemId" = i.id AND s."branchId" = ${oneBranch}), 0)
              END <= i."reorderLevel")::bigint                                         AS low_stock
  `

  const revenue = Number(row?.revenue ?? 0)
  const revenuePrior = Number(row?.revenue_prior ?? 0)
  const orders = Number(row?.orders ?? 0)
  const ordersPrior = Number(row?.orders_prior ?? 0)

  const aov = orders > 0 ? Math.round(revenue / orders) : 0
  const aovPrior = ordersPrior > 0 ? Math.round(revenuePrior / ordersPrior) : 0

  return {
    revenue,
    revenueChange: percentChange(revenue, revenuePrior),
    orders,
    ordersChange: percentChange(orders, ordersPrior),
    averageOrderValue: aov,
    aovChange: percentChange(aov, aovPrior),
    customers: Number(row?.customers ?? 0),
    newCustomers: Number(row?.new_customers ?? 0),
    tablesOccupied: Number(row?.tables_occupied ?? 0),
    tablesTotal: Number(row?.tables_total ?? 0),
    pendingOrders: Number(row?.pending_orders ?? 0),
    unpaidTotal: Number(row?.unpaid_total ?? 0),
    lowStockCount: Number(row?.low_stock ?? 0),
  }
}

/**
 * `AND <alias>."branchId" IN (…)` as a bound fragment.
 *
 * The empty list is the case worth spelling out: it means a confined user with
 * no location — "sees nothing" — and `IN ()` is a syntax error in Postgres, so
 * it becomes a predicate that is simply false. Reading it as "no filter" is the
 * bug this codebase has already fixed twice, on the transfers page and in
 * `selectedBranch`; it does not get to happen a third time here.
 */
function branchScope(branchIds: string[] | null | undefined, alias?: string): Prisma.Sql {
  if (!branchIds) return Prisma.empty
  const column = alias ? Prisma.raw(`${alias}."branchId"`) : Prisma.raw(`"branchId"`)
  if (branchIds.length === 0) return Prisma.sql`AND false`
  return Prisma.sql`AND ${column} IN (${Prisma.join(branchIds)})`
}

export interface SalesPoint {
  date: string
  label: string
  revenue: number
  orders: number
}

/**
 * Revenue over a range, bucketed by hour, day or month.
 *
 * ── What changed, and why the timezone matters here most ────────────────────
 *
 * This was `getSalesSeries(restaurantId, days)` — a fixed count of trailing
 * days, truncated with a bare `date_trunc('day', …)` which uses the database
 * session's timezone (UTC on Neon). The old comment admitted it: "A day here is
 * therefore a UTC day, not a Sri Lankan one… Fixing that properly means
 * truncating in the restaurant's own timezone and is a separate change."
 *
 * This is that change, because a period selector makes the seam visible. Ask
 * for "today" in `Asia/Kolkata` and a UTC bucket starts the day at 05:30 local
 * — the chart would open with five empty hours and drop last night's late
 * service onto it. `AT TIME ZONE` moves the truncation into the restaurant's
 * own clock.
 *
 * The gap-fill walks the same clock rather than adding fixed milliseconds, so a
 * month is its real number of days and a DST day is its real number of hours.
 */
export async function getRevenueSeries(params: {
  restaurantId: string
  range: DateRange
  branchIds?: string[] | null
}): Promise<SalesPoint[]> {
  const { restaurantId, range } = params
  const unit = range.granularity
  const tz = range.timeZone

  const atBranch = branchScope(params.branchIds)

  const rows = await prisma.$queryRaw<Array<{ bucket: Date; revenue: bigint | null; orders: bigint }>>`
    SELECT ${localBucket(unit, '"placedAt"', tz)} AS bucket,
           SUM("grandTotal")::bigint      AS revenue,
           COUNT(*)::bigint               AS orders
    FROM orders
    WHERE "restaurantId" = ${restaurantId}
      AND "placedAt" >= ${utc(range.from)}
      AND "placedAt" <= ${utc(range.to)}
      AND status <> 'CANCELLED'
      ${atBranch}
    GROUP BY 1
    ORDER BY 1
  `

  /*
   * `AT TIME ZONE` returns a `timestamp without time zone` — wall-clock numbers
   * in the restaurant's day. The driver hands those back as Dates pretending to
   * be UTC, so the key is read with the UTC getters. Reading them any other way
   * would re-apply the server's offset and shift every bucket back.
   */
  const keyOf = (d: Date) => {
    const y = d.getUTCFullYear()
    const m = String(d.getUTCMonth() + 1).padStart(2, '0')
    const day = String(d.getUTCDate()).padStart(2, '0')
    if (unit === 'month') return `${y}-${m}`
    if (unit === 'day') return `${y}-${m}-${day}`
    return `${y}-${m}-${day}T${String(d.getUTCHours()).padStart(2, '0')}`
  }

  const found = new Map(
    rows.map((row) => [
      keyOf(row.bucket),
      { revenue: Number(row.revenue ?? 0), orders: Number(row.orders) },
    ]),
  )

  // Walk the range in the restaurant's own clock so every bucket that exists
  // gets a bar, including the empty ones — a gap in a chart reads as missing
  // data, a zero reads as a quiet hour.
  const points: SalesPoint[] = []
  const wall = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hour12: false,
  })
  const readWall = (d: Date) => {
    const parts = wall.formatToParts(d)
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? '0')
    return { y: get('year'), m: get('month'), d: get('day'), h: get('hour') % 24 }
  }

  const step = unit === 'hour' ? 3_600_000 : 86_400_000
  const labelFormat: Intl.DateTimeFormatOptions =
    unit === 'hour'
      ? { hour: 'numeric', hour12: true, timeZone: tz }
      : unit === 'month'
        ? { month: 'short', year: '2-digit', timeZone: tz }
        : { day: 'numeric', month: 'short', timeZone: tz }

  const seen = new Set<string>()
  for (let t = range.from.getTime(); t <= range.to.getTime(); t += step) {
    const at = new Date(t)
    const w = readWall(at)
    const key =
      unit === 'month'
        ? `${w.y}-${String(w.m).padStart(2, '0')}`
        : unit === 'day'
          ? `${w.y}-${String(w.m).padStart(2, '0')}-${String(w.d).padStart(2, '0')}`
          : `${w.y}-${String(w.m).padStart(2, '0')}-${String(w.d).padStart(2, '0')}T${String(w.h).padStart(2, '0')}`

    if (seen.has(key)) continue
    seen.add(key)

    const entry = found.get(key)
    points.push({
      date: key,
      label: at.toLocaleDateString('en-GB', labelFormat).replace(',', ''),
      revenue: entry?.revenue ?? 0,
      orders: entry?.orders ?? 0,
    })
  }

  return points
}

export interface HourPoint {
  hour: number
  label: string
  orders: number
  revenue: number
}

/** Order volume by hour of day over the trailing window — the "peak hours" view. */
export async function getPeakHours(
  restaurantId: string,
  days = 30,
  branchId?: string | null,
  /**
   * The restaurant's timezone. Defaults to UTC, which is what this query did
   * before and is right for nobody.
   *
   * `EXTRACT(HOUR FROM "placedAt")` reads the hour off a column that holds UTC,
   * so for a restaurant at UTC+5:30 the eight o'clock dinner rush appeared as a
   * spike at half past two in the afternoon. The chart was correct about the
   * shape of the day and wrong about every label on it.
   */
  timeZone = 'UTC',
): Promise<HourPoint[]> {
  const start = new Date()
  start.setDate(start.getDate() - days)
  const atBranch = branchId ? Prisma.sql`AND "branchId" = ${branchId}` : Prisma.empty

  const rows = await prisma.$queryRaw<Array<{ hour: number; orders: bigint; revenue: bigint | null }>>`
    SELECT EXTRACT(HOUR FROM ("placedAt" AT TIME ZONE 'UTC') AT TIME ZONE ${timeZone})::int AS hour,
           COUNT(*)::bigint                   AS orders,
           SUM("grandTotal")::bigint          AS revenue
    FROM orders
    WHERE "restaurantId" = ${restaurantId}
      AND "placedAt" >= ${utc(start)}
      AND status <> 'CANCELLED'
      ${atBranch}
    GROUP BY 1
    ORDER BY 1
  `

  const byHour = new Map(
    rows.map((row) => [row.hour, { orders: Number(row.orders), revenue: Number(row.revenue ?? 0) }]),
  )

  return Array.from({ length: 24 }, (_, hour) => ({
    hour,
    label: `${String(hour).padStart(2, '0')}:00`,
    orders: byHour.get(hour)?.orders ?? 0,
    revenue: byHour.get(hour)?.revenue ?? 0,
  }))
}

export interface PopularItem {
  foodId: string | null
  name: string
  quantity: number
  revenue: number
}

export async function getPopularItems(params: {
  restaurantId: string
  range: DateRange
  limit?: number
  branchIds?: string[] | null
}): Promise<PopularItem[]> {
  const { restaurantId, range, limit = 8 } = params
  const atBranch = branchScope(params.branchIds, 'o')

  const rows = await prisma.$queryRaw<
    Array<{ foodId: string | null; name: string; quantity: bigint; revenue: bigint | null }>
  >`
    SELECT oi."foodId"            AS "foodId",
           oi.name                AS name,
           SUM(oi.quantity)::bigint    AS quantity,
           SUM(oi."lineTotal")::bigint AS revenue
    FROM order_items oi
    JOIN orders o ON o.id = oi."orderId"
    WHERE o."restaurantId" = ${restaurantId}
      AND o."placedAt" >= ${utc(range.from)}
      AND o."placedAt" <= ${utc(range.to)}
      AND o.status <> 'CANCELLED'
      AND oi.status <> 'CANCELLED'
      ${atBranch}
    GROUP BY oi."foodId", oi.name
    ORDER BY quantity DESC
    LIMIT ${limit}
  `

  return rows.map((row) => ({
    foodId: row.foodId,
    name: row.name,
    quantity: Number(row.quantity),
    revenue: Number(row.revenue ?? 0),
  }))
}

export interface CategoryShare {
  name: string
  revenue: number
  orders: number
}

export async function getCategoryBreakdown(params: {
  restaurantId: string
  range: DateRange
  branchIds?: string[] | null
}): Promise<CategoryShare[]> {
  const { restaurantId, range } = params
  const atBranch = branchScope(params.branchIds, 'o')

  const rows = await prisma.$queryRaw<Array<{ name: string; revenue: bigint | null; orders: bigint }>>`
    SELECT c.name                       AS name,
           SUM(oi."lineTotal")::bigint  AS revenue,
           COUNT(DISTINCT o.id)::bigint AS orders
    FROM order_items oi
    JOIN orders o     ON o.id = oi."orderId"
    JOIN foods f      ON f.id = oi."foodId"
    JOIN categories c ON c.id = f."categoryId"
    WHERE o."restaurantId" = ${restaurantId}
      AND o."placedAt" >= ${utc(range.from)}
      AND o."placedAt" <= ${utc(range.to)}
      AND o.status <> 'CANCELLED'
      ${atBranch}
    GROUP BY c.name
    ORDER BY revenue DESC
    LIMIT 8
  `

  return rows.map((row) => ({
    name: row.name,
    revenue: Number(row.revenue ?? 0),
    orders: Number(row.orders),
  }))
}

export interface PaymentMix {
  method: string
  amount: number
  count: number
}

export async function getPaymentMix(params: {
  restaurantId: string
  range: DateRange
  branchIds?: string[] | null
}): Promise<PaymentMix[]> {
  const ids = params.branchIds

  const rows = await prisma.payment.groupBy({
    by: ['method'],
    where: {
      restaurantId: params.restaurantId,
      status: 'PAID',
      paidAt: { gte: params.range.from, lte: params.range.to },
      // Payments have no branch of their own; they belong to the order's branch.
      // An empty allow-list matches nothing rather than everything.
      ...(ids ? { order: { branchId: ids.length ? { in: ids } : '__none__' } } : {}),
    },
    _sum: { amount: true },
    _count: true,
  })

  return rows
    .map((row) => ({ method: row.method, amount: row._sum.amount ?? 0, count: row._count }))
    .sort((a, b) => b.amount - a.amount)
}

/** Orders per staff member with the revenue they touched. */
export async function getStaffPerformance(
  restaurantId: string,
  days = 30,
  branchId?: string | null,
) {
  const start = new Date()
  start.setDate(start.getDate() - days)

  const [ordersByStaff, paymentsByStaff, users] = await Promise.all([
    prisma.order.groupBy({
      by: ['createdById'],
      where: {
        restaurantId,
        placedAt: { gte: start },
        createdById: { not: null },
        ...(branchId ? { branchId } : {}),
      },
      _sum: { grandTotal: true },
      _count: true,
    }),
    prisma.payment.groupBy({
      by: ['receivedById'],
      where: {
        restaurantId,
        paidAt: { gte: start },
        status: 'PAID',
        receivedById: { not: null },
        ...(branchId ? { order: { branchId } } : {}),
      },
      _sum: { amount: true },
      _count: true,
    }),
    prisma.user.findMany({
      where: { restaurantId, deletedAt: null },
      select: { id: true, name: true, role: true },
    }),
  ])

  return users
    .map((user) => {
      const created = ordersByStaff.find((row) => row.createdById === user.id)
      const collected = paymentsByStaff.find((row) => row.receivedById === user.id)
      return {
        id: user.id,
        name: user.name,
        role: user.role,
        ordersCreated: created?._count ?? 0,
        orderRevenue: created?._sum.grandTotal ?? 0,
        paymentsCollected: collected?._count ?? 0,
        paymentTotal: collected?._sum.amount ?? 0,
      }
    })
    .filter((row) => row.ordersCreated > 0 || row.paymentsCollected > 0)
    .sort((a, b) => b.paymentTotal + b.orderRevenue - (a.paymentTotal + a.orderRevenue))
}

export interface ReportRange {
  from: Date
  to: Date
}

export function resolveRange(preset: string, from?: string, to?: string): ReportRange {
  const end = new Date()
  end.setHours(23, 59, 59, 999)
  const start = new Date()
  start.setHours(0, 0, 0, 0)

  switch (preset) {
    case 'today':
      return { from: start, to: end }
    case 'yesterday': {
      start.setDate(start.getDate() - 1)
      const yEnd = new Date(start)
      yEnd.setHours(23, 59, 59, 999)
      return { from: start, to: yEnd }
    }
    case 'week':
      start.setDate(start.getDate() - 6)
      return { from: start, to: end }
    case 'month':
      start.setDate(start.getDate() - 29)
      return { from: start, to: end }
    case 'quarter':
      start.setDate(start.getDate() - 89)
      return { from: start, to: end }
    case 'year':
      start.setFullYear(start.getFullYear() - 1)
      return { from: start, to: end }
    case 'custom':
      return {
        from: from ? new Date(from) : start,
        to: to ? new Date(`${to}T23:59:59.999`) : end,
      }
    default:
      start.setDate(start.getDate() - 6)
      return { from: start, to: end }
  }
}

/**
 * Aggregate figures for the reports screen and its exports.
 *
 * `branchIds` was not a parameter at all, so `/dashboard/reports` — and the
 * CSV/XLSX export behind it — showed a branch manager the whole group's
 * revenue, cost of goods, gross profit, payment mix and top-selling items.
 * Every other report on the site was already scoped; this was the one that had
 * never been given the argument.
 *
 * The raw-SQL halves take a Prisma fragment rather than string interpolation,
 * the same way `getDashboardStats` does above.
 */
export async function getReportSummary(
  restaurantId: string,
  range: ReportRange,
  branchIds?: string[] | null,
) {
  const where: Prisma.OrderWhereInput = {
    restaurantId,
    placedAt: { gte: range.from, lte: range.to },
    status: { notIn: ['CANCELLED'] },
    ...(branchIds ? { branchId: { in: branchIds } } : {}),
  }

  // `IN ()` is a syntax error in Postgres, so an empty allow-list — a confined
  // user with no location — becomes a predicate that is simply false.
  const atBranch = branchIds
    ? branchIds.length
      ? Prisma.sql`AND o."branchId" IN (${Prisma.join(branchIds)})`
      : Prisma.sql`AND false`
    : Prisma.empty

  const [orders, cancelled, cost, payments, customers, topItems] = await Promise.all([
    prisma.order.aggregate({
      where,
      _sum: {
        grandTotal: true,
        subtotal: true,
        taxTotal: true,
        serviceCharge: true,
        discountTotal: true,
        tipAmount: true,
      },
      _count: true,
      _avg: { grandTotal: true },
    }),
    prisma.order.count({
      where: {
        restaurantId,
        placedAt: { gte: range.from, lte: range.to },
        status: 'CANCELLED',
        ...(branchIds ? { branchId: { in: branchIds } } : {}),
      },
    }),
    prisma.$queryRaw<Array<{ cost: bigint | null }>>`
      SELECT SUM(oi."costPrice" * oi.quantity)::bigint AS cost
      FROM order_items oi
      JOIN orders o ON o.id = oi."orderId"
      WHERE o."restaurantId" = ${restaurantId}
        AND o."placedAt" BETWEEN ${utc(range.from)} AND ${utc(range.to)}
        AND o.status <> 'CANCELLED'
        ${atBranch}
    `,
    prisma.payment.groupBy({
      by: ['method'],
      where: {
        restaurantId,
        status: 'PAID',
        paidAt: { gte: range.from, lte: range.to },
        // Payments reach a location through their order.
        ...(branchIds ? { order: { branchId: { in: branchIds } } } : {}),
      },
      _sum: { amount: true },
      _count: true,
    }),
    prisma.order
      .findMany({
        where: { ...where, customerId: { not: null } },
        select: { customerId: true },
        distinct: ['customerId'],
      })
      .then((rows) => rows.length),
    prisma.$queryRaw<Array<{ name: string; quantity: bigint; revenue: bigint | null }>>`
      SELECT oi.name AS name,
             SUM(oi.quantity)::bigint    AS quantity,
             SUM(oi."lineTotal")::bigint AS revenue
      FROM order_items oi
      JOIN orders o ON o.id = oi."orderId"
      WHERE o."restaurantId" = ${restaurantId}
        AND o."placedAt" BETWEEN ${utc(range.from)} AND ${utc(range.to)}
        AND o.status <> 'CANCELLED'
        ${atBranch}
      GROUP BY oi.name
      ORDER BY revenue DESC NULLS LAST
      LIMIT 20
    `,
  ])

  const revenue = orders._sum.grandTotal ?? 0
  const foodCost = Number(cost[0]?.cost ?? 0)

  return {
    range,
    orderCount: orders._count,
    cancelledCount: cancelled,
    revenue,
    netSales: orders._sum.subtotal ?? 0,
    tax: orders._sum.taxTotal ?? 0,
    serviceCharge: orders._sum.serviceCharge ?? 0,
    discounts: orders._sum.discountTotal ?? 0,
    tips: orders._sum.tipAmount ?? 0,
    averageOrderValue: Math.round(orders._avg.grandTotal ?? 0),
    foodCost,
    grossProfit: (orders._sum.subtotal ?? 0) - foodCost,
    uniqueCustomers: customers,
    payments: payments.map((row) => ({
      method: row.method,
      amount: row._sum.amount ?? 0,
      count: row._count,
    })),
    topItems: topItems.map((row) => ({
      name: row.name,
      quantity: Number(row.quantity),
      revenue: Number(row.revenue ?? 0),
    })),
  }
}

export type ReportSummary = Awaited<ReturnType<typeof getReportSummary>>

// ── cached read paths for the dashboard ──────────────────────────────────────
//
// The uncached functions above stay exported for reports and exports, where an
// operator has explicitly asked for a fresh figure and expects to wait for it.

/*
 * The branch belongs in the cache KEY, not just in the arguments.
 *
 * `unstable_cache` keys on the array it is given and nothing else — it cannot
 * see the closure. Filter by branch while keying on restaurant alone and the
 * first location to load the page fills the cache for every other one, so Kandy
 * is shown Colombo's revenue for the next five minutes. That is a wrong number
 * presented confidently, which is worse than a slow one.
 */

/**
 * A stable cache-key fragment for a branch scope.
 *
 * Sorted, because `['a','b']` and `['b','a']` are the same query and must not
 * be two entries. `null` is "every location" and is spelled out rather than
 * left empty, so it can never collide with the empty list — which means the
 * opposite, and would otherwise share a key with it.
 */
function branchKey(branchIds?: string[] | null): string {
  if (!branchIds) return 'all'
  if (branchIds.length === 0) return 'none'
  return [...branchIds].sort().join(',')
}


/**
 * Cached wrapper — see {@link ANALYTICS_TTL_SECONDS}.
 *
 * A CUSTOM range goes straight to the database. The presets are a closed set,
 * so their keys are too; two arbitrary dates are not, and caching them would
 * fill the store with entries nobody asks for twice. The same reasoning the
 * uncached export path is built on.
 */
export function getCachedRevenueSeries(params: {
  restaurantId: string
  range: DateRange
  branchIds?: string[] | null
}): Promise<SalesPoint[]> {
  if (params.range.preset === 'CUSTOM') return getRevenueSeries(params)
  return unstable_cache(
    () => getRevenueSeries(params),
    [
      'analytics:revenue-series',
      params.restaurantId,
      params.range.granularity,
      ...periodKey(params.range, params.branchIds),
    ],
    { revalidate: ANALYTICS_TTL_SECONDS },
  )()
}

/**
 * Cached wrappers for the period-driven cards.
 *
 * All three follow the same rule as the trend: a preset is a closed set and
 * caches, a CUSTOM range does not. `periodKey` is the shared fragment so the
 * four wrappers cannot drift into keying on different things — the mistake
 * that put Colombo's revenue on Kandy's dashboard, one file above.
 */
function periodKey(range: DateRange, branchIds?: string[] | null): string[] {
  return [range.preset, String(range.from.getTime()), String(range.to.getTime()), branchKey(branchIds)]
}

/** Cached wrapper — see {@link ANALYTICS_TTL_SECONDS}. */
export function getCachedPopularItems(params: {
  restaurantId: string
  range: DateRange
  limit?: number
  branchIds?: string[] | null
}): Promise<PopularItem[]> {
  if (params.range.preset === 'CUSTOM') return getPopularItems(params)
  return unstable_cache(
    () => getPopularItems(params),
    [
      'analytics:popular',
      params.restaurantId,
      String(params.limit ?? 8),
      ...periodKey(params.range, params.branchIds),
    ],
    { revalidate: ANALYTICS_TTL_SECONDS },
  )()
}

/** Cached wrapper — see {@link ANALYTICS_TTL_SECONDS}. */
export function getCachedCategoryBreakdown(params: {
  restaurantId: string
  range: DateRange
  branchIds?: string[] | null
}): Promise<CategoryShare[]> {
  if (params.range.preset === 'CUSTOM') return getCategoryBreakdown(params)
  return unstable_cache(
    () => getCategoryBreakdown(params),
    ['analytics:categories', params.restaurantId, ...periodKey(params.range, params.branchIds)],
    { revalidate: ANALYTICS_TTL_SECONDS },
  )()
}

/** Cached wrapper — see {@link ANALYTICS_TTL_SECONDS}. */
export function getCachedPaymentMix(params: {
  restaurantId: string
  range: DateRange
  branchIds?: string[] | null
}): Promise<PaymentMix[]> {
  if (params.range.preset === 'CUSTOM') return getPaymentMix(params)
  return unstable_cache(
    () => getPaymentMix(params),
    ['analytics:payment-mix', params.restaurantId, ...periodKey(params.range, params.branchIds)],
    { revalidate: ANALYTICS_TTL_SECONDS },
  )()
}
