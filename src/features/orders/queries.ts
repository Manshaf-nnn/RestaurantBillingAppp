import 'server-only'

import type { OrderStatus, Prisma } from '@prisma/client'

import { prisma } from '@/server/db/prisma'
import { getGuestSessionId } from '@/server/auth/session'
import type { SelectedOption } from './pricing'

const ORDER_DETAIL_INCLUDE = {
  items: { orderBy: { createdAt: 'asc' as const } },
  table: { select: { id: true, number: true, label: true, area: true } },
  customer: { select: { id: true, name: true, phone: true, email: true, loyaltyPoints: true } },
  payments: { orderBy: { createdAt: 'desc' as const } },
  invoice: true,
  events: { orderBy: { createdAt: 'asc' as const } },
  coupon: { select: { code: true } },
  createdBy: { select: { id: true, name: true } },
  review: true,
} satisfies Prisma.OrderInclude

export type OrderDetail = Prisma.OrderGetPayload<{ include: typeof ORDER_DETAIL_INCLUDE }>

/** Full order for staff screens — always tenant-scoped. */
export async function getOrderForStaff(restaurantId: string, orderId: string) {
  return prisma.order.findFirst({
    where: { id: orderId, restaurantId },
    include: ORDER_DETAIL_INCLUDE,
  })
}

/**
 * Guest access to an order.
 *
 * A guest may read an order only if their anonymous session cookie matches the
 * one recorded when the order was placed. Knowing an order id is not enough.
 */
export async function getOrderForGuest(restaurantId: string, orderId: string) {
  const guestSessionId = await getGuestSessionId()
  if (!guestSessionId) return null

  return prisma.order.findFirst({
    where: { id: orderId, restaurantId, guestSessionId },
    include: ORDER_DETAIL_INCLUDE,
  })
}

/** Every open order this guest has on the current table. */
export async function getGuestOrders(restaurantId: string, tableId?: string) {
  const guestSessionId = await getGuestSessionId()
  if (!guestSessionId) return []

  return prisma.order.findMany({
    where: {
      restaurantId,
      guestSessionId,
      ...(tableId ? { tableId } : {}),
      placedAt: { gt: new Date(Date.now() - 12 * 60 * 60 * 1000) },
    },
    include: ORDER_DETAIL_INCLUDE,
    orderBy: { placedAt: 'desc' },
    take: 10,
  })
}

/** The kitchen rail: everything still cooking, oldest first. */
export async function getKitchenQueue(restaurantId: string) {
  return prisma.order.findMany({
    where: {
      restaurantId,
      status: { in: ['PENDING', 'ACCEPTED', 'PREPARING', 'READY'] },
    },
    include: {
      items: { orderBy: { createdAt: 'asc' } },
      table: { select: { id: true, number: true } },
    },
    orderBy: { placedAt: 'asc' },
    take: 100,
  })
}

export async function getKitchenStats(restaurantId: string) {
  const startOfDay = new Date()
  startOfDay.setHours(0, 0, 0, 0)

  const [pending, preparing, ready, completedToday, timings] = await Promise.all([
    prisma.order.count({ where: { restaurantId, status: 'PENDING' } }),
    prisma.order.count({ where: { restaurantId, status: { in: ['ACCEPTED', 'PREPARING'] } } }),
    prisma.order.count({ where: { restaurantId, status: 'READY' } }),
    prisma.order.count({
      where: { restaurantId, status: { in: ['SERVED', 'COMPLETED'] }, placedAt: { gte: startOfDay } },
    }),
    prisma.order.findMany({
      where: {
        restaurantId,
        readyAt: { not: null },
        acceptedAt: { not: null },
        placedAt: { gte: startOfDay },
      },
      select: { acceptedAt: true, readyAt: true },
      take: 200,
    }),
  ])

  const durations = timings
    .filter((row) => row.acceptedAt && row.readyAt)
    .map((row) => (row.readyAt!.getTime() - row.acceptedAt!.getTime()) / 60000)

  const averageCookMinutes =
    durations.length > 0
      ? Math.round(durations.reduce((total, value) => total + value, 0) / durations.length)
      : 0

  return { pending, preparing, ready, completedToday, averageCookMinutes }
}

/** Ready-to-serve orders plus open guest requests, for the waiter station. */
export async function getWaiterBoard(restaurantId: string) {
  const [ready, serving, requests, tables] = await Promise.all([
    prisma.order.findMany({
      where: { restaurantId, status: 'READY' },
      include: { items: true, table: { select: { id: true, number: true } } },
      orderBy: { readyAt: 'asc' },
    }),
    prisma.order.findMany({
      where: { restaurantId, status: { in: ['PENDING', 'ACCEPTED', 'PREPARING'] } },
      include: { items: true, table: { select: { id: true, number: true } } },
      orderBy: { placedAt: 'asc' },
      take: 40,
    }),
    prisma.serviceRequest.findMany({
      where: { restaurantId, status: 'OPEN' },
      include: { table: { select: { id: true, number: true } } },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.restaurantTable.findMany({
      where: { restaurantId, isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { number: 'asc' }],
      include: {
        orders: {
          where: { status: { notIn: ['COMPLETED', 'CANCELLED'] } },
          select: { id: true, orderNumber: true, status: true, grandTotal: true, paymentStatus: true },
        },
      },
    }),
  ])

  return { ready, serving, requests, tables }
}

export interface OrderListFilter {
  search?: string
  status?: string
  paymentStatus?: string
  type?: string
  from?: string
  to?: string
  page?: number
  perPage?: number
}

/** Paginated order search for the management console. */
export async function listOrders(restaurantId: string, filter: OrderListFilter) {
  const page = Math.max(1, filter.page ?? 1)
  const perPage = Math.min(100, Math.max(10, filter.perPage ?? 25))

  const where: Prisma.OrderWhereInput = {
    restaurantId,
    ...(filter.status && filter.status !== 'ALL'
      ? { status: filter.status as OrderStatus }
      : {}),
    ...(filter.paymentStatus && filter.paymentStatus !== 'ALL'
      ? { paymentStatus: filter.paymentStatus as never }
      : {}),
    ...(filter.type && filter.type !== 'ALL' ? { type: filter.type as never } : {}),
    ...(filter.from || filter.to
      ? {
          placedAt: {
            ...(filter.from ? { gte: new Date(filter.from) } : {}),
            ...(filter.to ? { lte: new Date(`${filter.to}T23:59:59.999`) } : {}),
          },
        }
      : {}),
    ...(filter.search
      ? {
          OR: [
            { orderNumber: { contains: filter.search, mode: 'insensitive' } },
            { customerName: { contains: filter.search, mode: 'insensitive' } },
            { customerPhone: { contains: filter.search } },
            { table: { number: { contains: filter.search, mode: 'insensitive' } } },
          ],
        }
      : {}),
  }

  const [orders, total] = await Promise.all([
    prisma.order.findMany({
      where,
      include: {
        table: { select: { number: true } },
        items: { select: { id: true, quantity: true } },
        payments: { select: { method: true, status: true } },
      },
      orderBy: { placedAt: 'desc' },
      skip: (page - 1) * perPage,
      take: perPage,
    }),
    prisma.order.count({ where }),
  ])

  return { orders, total, page, perPage, pageCount: Math.max(1, Math.ceil(total / perPage)) }
}

/** Unpaid bills waiting at the till. */
export async function getCashierQueue(restaurantId: string) {
  return prisma.order.findMany({
    where: {
      restaurantId,
      status: { notIn: ['CANCELLED'] },
      paymentStatus: { in: ['UNPAID', 'PARTIAL'] },
    },
    include: {
      items: true,
      table: { select: { id: true, number: true } },
      payments: true,
    },
    orderBy: { placedAt: 'asc' },
  })
}

export function readOptions(value: unknown): SelectedOption[] {
  return Array.isArray(value) ? (value as SelectedOption[]) : []
}

export const ORDER_TIMELINE: Array<{ status: OrderStatus; label: string; description: string }> = [
  { status: 'PENDING', label: 'Order received', description: 'We have your order' },
  { status: 'ACCEPTED', label: 'Accepted', description: 'The kitchen has taken it on' },
  { status: 'PREPARING', label: 'Preparing', description: 'Your food is being cooked' },
  { status: 'READY', label: 'Ready', description: 'Freshly plated and on its way' },
  { status: 'SERVED', label: 'Served', description: 'Enjoy your meal' },
]
