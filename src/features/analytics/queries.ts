import 'server-only'

import type { Prisma } from '@prisma/client'

import { prisma } from '@/server/db/prisma'
import { percentChange } from '@/lib/utils'

export function dayRange(offsetDays = 0): { start: Date; end: Date } {
  const start = new Date()
  start.setDate(start.getDate() - offsetDays)
  start.setHours(0, 0, 0, 0)
  const end = new Date(start)
  end.setDate(end.getDate() + 1)
  return { start, end }
}

export interface DashboardStats {
  revenueToday: number
  revenueChange: number
  ordersToday: number
  ordersChange: number
  averageOrderValue: number
  aovChange: number
  tablesOccupied: number
  tablesTotal: number
  customersToday: number
  newCustomersToday: number
  pendingOrders: number
  unpaidTotal: number
  lowStockCount: number
}

/** Headline numbers for the dashboard hero row, each with a day-over-day delta. */
export async function getDashboardStats(restaurantId: string): Promise<DashboardStats> {
  const today = dayRange(0)
  const yesterday = dayRange(1)

  const [
    todayAgg,
    yesterdayAgg,
    tablesTotal,
    tablesOccupied,
    customersToday,
    newCustomers,
    pendingOrders,
    unpaid,
    lowStock,
  ] = await Promise.all([
    prisma.order.aggregate({
      where: {
        restaurantId,
        status: { notIn: ['CANCELLED'] },
        placedAt: { gte: today.start, lt: today.end },
      },
      _sum: { grandTotal: true },
      _count: true,
    }),
    prisma.order.aggregate({
      where: {
        restaurantId,
        status: { notIn: ['CANCELLED'] },
        placedAt: { gte: yesterday.start, lt: yesterday.end },
      },
      _sum: { grandTotal: true },
      _count: true,
    }),
    prisma.restaurantTable.count({ where: { restaurantId, isActive: true } }),
    prisma.restaurantTable.count({ where: { restaurantId, isActive: true, status: 'OCCUPIED' } }),
    prisma.order
      .findMany({
        where: { restaurantId, placedAt: { gte: today.start, lt: today.end }, customerId: { not: null } },
        select: { customerId: true },
        distinct: ['customerId'],
      })
      .then((rows) => rows.length),
    prisma.customer.count({ where: { restaurantId, createdAt: { gte: today.start, lt: today.end } } }),
    prisma.order.count({
      where: { restaurantId, status: { in: ['PENDING', 'ACCEPTED', 'PREPARING'] } },
    }),
    prisma.order.aggregate({
      where: { restaurantId, paymentStatus: { in: ['UNPAID', 'PARTIAL'] }, status: { not: 'CANCELLED' } },
      _sum: { grandTotal: true, paidTotal: true },
    }),
    prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*)::bigint AS count
      FROM inventory_items
      WHERE "restaurantId" = ${restaurantId}
        AND "isActive" = true
        AND quantity <= "reorderLevel"
    `,
  ])

  const revenueToday = todayAgg._sum.grandTotal ?? 0
  const revenueYesterday = yesterdayAgg._sum.grandTotal ?? 0
  const ordersToday = todayAgg._count
  const ordersYesterday = yesterdayAgg._count

  const aovToday = ordersToday > 0 ? Math.round(revenueToday / ordersToday) : 0
  const aovYesterday = ordersYesterday > 0 ? Math.round(revenueYesterday / ordersYesterday) : 0

  return {
    revenueToday,
    revenueChange: percentChange(revenueToday, revenueYesterday),
    ordersToday,
    ordersChange: percentChange(ordersToday, ordersYesterday),
    averageOrderValue: aovToday,
    aovChange: percentChange(aovToday, aovYesterday),
    tablesOccupied,
    tablesTotal,
    customersToday,
    newCustomersToday: newCustomers,
    pendingOrders,
    unpaidTotal: (unpaid._sum.grandTotal ?? 0) - (unpaid._sum.paidTotal ?? 0),
    lowStockCount: Number(lowStock[0]?.count ?? 0),
  }
}

export interface SalesPoint {
  date: string
  label: string
  revenue: number
  orders: number
}

/** Daily revenue/order counts for the trend chart. */
export async function getSalesSeries(restaurantId: string, days = 14): Promise<SalesPoint[]> {
  const start = new Date()
  start.setDate(start.getDate() - (days - 1))
  start.setHours(0, 0, 0, 0)

  const rows = await prisma.$queryRaw<Array<{ day: Date; revenue: bigint | null; orders: bigint }>>`
    SELECT date_trunc('day', "placedAt") AS day,
           SUM("grandTotal")::bigint      AS revenue,
           COUNT(*)::bigint               AS orders
    FROM orders
    WHERE "restaurantId" = ${restaurantId}
      AND "placedAt" >= ${start}
      AND status <> 'CANCELLED'
    GROUP BY 1
    ORDER BY 1
  `

  const byDay = new Map(
    rows.map((row) => [
      row.day.toISOString().slice(0, 10),
      { revenue: Number(row.revenue ?? 0), orders: Number(row.orders) },
    ]),
  )

  return Array.from({ length: days }, (_, index) => {
    const date = new Date(start)
    date.setDate(start.getDate() + index)
    const key = date.toISOString().slice(0, 10)
    const entry = byDay.get(key)
    return {
      date: key,
      label: date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }),
      revenue: entry?.revenue ?? 0,
      orders: entry?.orders ?? 0,
    }
  })
}

export interface HourPoint {
  hour: number
  label: string
  orders: number
  revenue: number
}

/** Order volume by hour of day over the trailing window — the "peak hours" view. */
export async function getPeakHours(restaurantId: string, days = 30): Promise<HourPoint[]> {
  const start = new Date()
  start.setDate(start.getDate() - days)

  const rows = await prisma.$queryRaw<Array<{ hour: number; orders: bigint; revenue: bigint | null }>>`
    SELECT EXTRACT(HOUR FROM "placedAt")::int AS hour,
           COUNT(*)::bigint                   AS orders,
           SUM("grandTotal")::bigint          AS revenue
    FROM orders
    WHERE "restaurantId" = ${restaurantId}
      AND "placedAt" >= ${start}
      AND status <> 'CANCELLED'
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

export async function getPopularItems(
  restaurantId: string,
  days = 30,
  limit = 8,
): Promise<PopularItem[]> {
  const start = new Date()
  start.setDate(start.getDate() - days)

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
      AND o."placedAt" >= ${start}
      AND o.status <> 'CANCELLED'
      AND oi.status <> 'CANCELLED'
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

export async function getCategoryBreakdown(restaurantId: string, days = 30): Promise<CategoryShare[]> {
  const start = new Date()
  start.setDate(start.getDate() - days)

  const rows = await prisma.$queryRaw<Array<{ name: string; revenue: bigint | null; orders: bigint }>>`
    SELECT c.name                       AS name,
           SUM(oi."lineTotal")::bigint  AS revenue,
           COUNT(DISTINCT o.id)::bigint AS orders
    FROM order_items oi
    JOIN orders o     ON o.id = oi."orderId"
    JOIN foods f      ON f.id = oi."foodId"
    JOIN categories c ON c.id = f."categoryId"
    WHERE o."restaurantId" = ${restaurantId}
      AND o."placedAt" >= ${start}
      AND o.status <> 'CANCELLED'
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

export async function getPaymentMix(restaurantId: string, days = 30): Promise<PaymentMix[]> {
  const start = new Date()
  start.setDate(start.getDate() - days)

  const rows = await prisma.payment.groupBy({
    by: ['method'],
    where: { restaurantId, status: 'PAID', paidAt: { gte: start } },
    _sum: { amount: true },
    _count: true,
  })

  return rows
    .map((row) => ({ method: row.method, amount: row._sum.amount ?? 0, count: row._count }))
    .sort((a, b) => b.amount - a.amount)
}

/** Orders per staff member with the revenue they touched. */
export async function getStaffPerformance(restaurantId: string, days = 30) {
  const start = new Date()
  start.setDate(start.getDate() - days)

  const [ordersByStaff, paymentsByStaff, users] = await Promise.all([
    prisma.order.groupBy({
      by: ['createdById'],
      where: { restaurantId, placedAt: { gte: start }, createdById: { not: null } },
      _sum: { grandTotal: true },
      _count: true,
    }),
    prisma.payment.groupBy({
      by: ['receivedById'],
      where: { restaurantId, paidAt: { gte: start }, status: 'PAID', receivedById: { not: null } },
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

/** Aggregate figures for the reports screen and its exports. */
export async function getReportSummary(restaurantId: string, range: ReportRange) {
  const where: Prisma.OrderWhereInput = {
    restaurantId,
    placedAt: { gte: range.from, lte: range.to },
    status: { notIn: ['CANCELLED'] },
  }

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
      where: { restaurantId, placedAt: { gte: range.from, lte: range.to }, status: 'CANCELLED' },
    }),
    prisma.$queryRaw<Array<{ cost: bigint | null }>>`
      SELECT SUM(oi."costPrice" * oi.quantity)::bigint AS cost
      FROM order_items oi
      JOIN orders o ON o.id = oi."orderId"
      WHERE o."restaurantId" = ${restaurantId}
        AND o."placedAt" BETWEEN ${range.from} AND ${range.to}
        AND o.status <> 'CANCELLED'
    `,
    prisma.payment.groupBy({
      by: ['method'],
      where: { restaurantId, status: 'PAID', paidAt: { gte: range.from, lte: range.to } },
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
        AND o."placedAt" BETWEEN ${range.from} AND ${range.to}
        AND o.status <> 'CANCELLED'
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
