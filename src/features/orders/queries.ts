import 'server-only'

import type { OrderStatus, Prisma } from '@prisma/client'

import { AppError } from '@/lib/errors'
import { prisma } from '@/server/db/prisma'
import { normalizeTableStatus } from '@/features/floor/table-state'
import { tableStatesFor } from '@/features/floor/table-state-server'
import { getGuestSessionId } from '@/server/auth/session'
import { GUEST_CHANNELS } from './channels'
import type { SelectedOption } from './pricing'

const ORDER_DETAIL_INCLUDE = {
  items: { orderBy: { createdAt: 'asc' as const } },
  table: { select: { id: true, number: true, label: true, area: true } },
  // The branch's code, so a guest screen can prove which place it belongs to
  // when it calls back — a call bell must ring in the room the guest is in.
  branch: { select: { code: true, name: true } },
  customer: { select: { id: true, name: true, phone: true, email: true, loyaltyPoints: true } },
  payments: {
    orderBy: { createdAt: 'desc' as const },
    include: { refunds: { orderBy: { createdAt: 'asc' as const } } },
  },
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

/**
 * The live floor screens, all branch-scoped.
 *
 * These three took a restaurant id and nothing else, so a chef in Kandy watched
 * Colombo's tickets arrive on the rail and a waiter's board listed tables in a
 * building they had never been to. It is the most visible form of the leak, and
 * the fix is one predicate in each query.
 *
 * `branchIds` follows the house convention: `null` means every location (an
 * owner deliberately looking at the whole business), an array narrows, and an
 * EMPTY array must return nothing — never everything.
 */
function atBranch(branchIds?: string[] | null) {
  return branchIds ? { branchId: { in: branchIds } } : {}
}

/**
 * A QR / online order that the till has not yet accepted (abc.md §5).
 *
 * Spread into a `where` to keep such orders OFF a kitchen or waiter query:
 * they are the cashier's until accepted, and the same row appears on the
 * rail the moment it is.
 */
const NOT_AWAITING_CASHIER = {
  NOT: { status: 'PENDING' as const, channel: { in: [...GUEST_CHANNELS] } },
}

/**
 * The kitchen rail: everything accepted and still cooking, oldest first.
 *
 * Nothing PENDING is on it (aO.md §1). A staff order is accepted by being
 * typed in; a QR / online order waits at the till and arrives here through
 * the cashier's Accept. The rail therefore never has to ask whether a ticket
 * can be routed — that was settled before the ticket existed here.
 */
export async function getKitchenQueue(restaurantId: string, branchIds?: string[] | null) {
  return prisma.order.findMany({
    where: {
      restaurantId,
      ...atBranch(branchIds),
      status: { in: ['ACCEPTED', 'PREPARING', 'READY'] },
    },
    include: {
      items: { orderBy: { createdAt: 'asc' } },
      table: { select: { id: true, number: true } },
    },
    orderBy: [{ priority: 'desc' }, { placedAt: 'asc' }],
    take: 100,
  })
}

export async function getKitchenStats(restaurantId: string, branchIds?: string[] | null) {
  const startOfDay = new Date()
  startOfDay.setHours(0, 0, 0, 0)
  const here = atBranch(branchIds)

  const [preparing, ready, completedToday, timings] = await Promise.all([
    prisma.order.count({ where: { restaurantId, ...here, status: { in: ['ACCEPTED', 'PREPARING'] } } }),
    prisma.order.count({ where: { restaurantId, ...here, status: 'READY' } }),
    prisma.order.count({
      where: { restaurantId, ...here, status: { in: ['SERVED', 'COMPLETED'] }, placedAt: { gte: startOfDay } },
    }),
    prisma.order.findMany({
      where: {
        restaurantId,
        ...here,
        readyAt: { not: null },
        acceptedAt: { not: null },
        placedAt: { gte: startOfDay },
      },
      select: { acceptedAt: true, readyAt: true },
      /*
       * Newest first, because `take` without an order is not a sample — it is
       * whatever the query plan happened to yield. Past 200 qualifying orders
       * the average was computed over an arbitrary subset that could differ
       * between two identical page loads, which is not a number to make a
       * staffing decision on.
       */
      orderBy: { readyAt: 'desc' },
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

  return { preparing, ready, completedToday, averageCookMinutes }
}

/** Ready-to-serve orders plus open guest requests, for the waiter station. */
export async function getWaiterBoard(restaurantId: string, branchIds?: string[] | null) {
  const here = atBranch(branchIds)
  const [ready, serving, requests, tables] = await Promise.all([
    /*
     * Anything with food waiting to be carried out — by ITEM, not by order.
     *
     * This asked for orders whose own status was READY, which was right when
     * one rail cooked a whole ticket at once. With kitchen sections it is
     * wrong in the way that matters most: the pizza is up and the rice is
     * still in the pan, so the order reads PREPARING, and nothing tells the
     * waiter there is a pizza going cold under the lamp.
     *
     * Any open order holding at least one READY item now surfaces here.
     * Whole-order READY is a special case of that, so nothing regresses for a
     * restaurant with no sections.
     */
    prisma.order.findMany({
      where: {
        restaurantId,
        ...here,
        status: { in: ['ACCEPTED', 'PREPARING', 'READY', 'SERVED'] },
        items: { some: { status: 'READY' } },
      },
      include: { items: true, table: { select: { id: true, number: true } } },
      orderBy: [{ readyAt: 'asc' }, { placedAt: 'asc' }],
    }),
    prisma.order.findMany({
      where: {
        restaurantId,
        ...here,
        status: { in: ['PENDING', 'ACCEPTED', 'PREPARING'] },
        // A QR / online order the till has not accepted is not being cooked.
        ...NOT_AWAITING_CASHIER,
        // Kept off the "waiting to be cooked" list once something on it is
        // ready, or a half-finished table would appear in both columns.
        items: { none: { status: 'READY' } },
      },
      include: { items: true, table: { select: { id: true, number: true } } },
      orderBy: { placedAt: 'asc' },
      take: 40,
    }),
    prisma.serviceRequest.findMany({
      // A service request has no branch of its own; it reaches one through the
      // table the guest is sitting at, which is required and always set.
      where: {
        restaurantId,
        // Acknowledged calls stay on the board until somebody marks them done
        // (abc.md §7) — the acknowledgement says who is going, not that it is over.
        status: { in: ['OPEN', 'ACKNOWLEDGED'] },
        ...(branchIds ? { table: { branchId: { in: branchIds } } } : {}),
      },
      include: { table: { select: { id: true, number: true } } },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.restaurantTable.findMany({
      where: { restaurantId, ...here, isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { number: 'asc' }],
      include: {
        orders: {
          where: { status: { notIn: ['COMPLETED', 'CANCELLED'] } },
          select: { id: true, orderNumber: true, status: true, grandTotal: true, paymentStatus: true },
        },
      },
    }),
  ])

  // The derived three-state value per table (abc.md §3), so the floor plan
  // shows Reserved during a booking's window and never a stale hand-set label.
  const states = await tableStatesFor(prisma, {
    restaurantId,
    tableIds: tables.map((t) => t.id),
    occupiedIds: tables.filter((t) => t.orders.length > 0).map((t) => t.id),
  })
  return {
    ready,
    serving,
    requests,
    tables: tables.map((t) => ({
      ...t,
      state: states.get(t.id)?.state ?? normalizeTableStatus(t.status),
      reservedFor: states.get(t.id)?.reservation?.customerName ?? null,
    })),
  }
}

export interface OrderListFilter {
  search?: string
  status?: string
  paymentStatus?: string
  type?: string
  /** Where the order came from: QR, STAFF, COUNTER, PHONE, ONLINE (abc.md §1). */
  channel?: string
  from?: string
  to?: string
  page?: number
  /**
   * Rows per page. A number is clamped to [10, 5000]; 'ALL' shows the whole
   * filtered set and needs a period (`from` AND `to`), or it is refused.
   */
  perPage?: number | 'ALL'
  /** Restrict to one location. Null or absent means every location. */
  branchId?: string | null
}

/** The whole filtered set's money, from the rows' own predicate (abc.md §1). */
export interface OrderListTotals {
  count: number
  grandTotal: number
  tipAmount: number
  paidTotal: number
  /** total + tips − collected. Never negative: the service refuses overpayment. */
  outstanding: number
}

/** The hard ceiling on one page, including "All": a safety limit, not a horizon. */
export const ORDER_LIST_MAX_ROWS = 5000

/**
 * Paginated order search for the management console.
 *
 * ── Totals are the set's, not the page's ────────────────────────────────────
 *
 * `totals` is an aggregate over the SAME `where` as the rows, so it is the
 * whole filtered set's count, total, collected and outstanding whichever
 * page is showing — and with 'ALL' it equals the sum of the rows returned.
 * The screen's footer therefore never contradicts the export.
 *
 * ── Rows per page ───────────────────────────────────────────────────────────
 *
 * The clamp used to be 100, which silently cut the export's 500 a page and
 * made it page five times as often for the same rows. It is 5000 now; the
 * screen offers 50 / 100 / All, and All is refused without a period so a
 * years-old restaurant cannot ask for everything it has ever sold in one
 * request.
 */
export async function listOrders(restaurantId: string, filter: OrderListFilter) {
  const page = Math.max(1, filter.page ?? 1)
  const all = filter.perPage === 'ALL'
  if (all && !(filter.from && filter.to)) {
    throw new AppError('Choose a period before showing every order', 400, 'RANGE_REQUIRED')
  }
  const perPage = all
    ? ORDER_LIST_MAX_ROWS
    : Math.min(ORDER_LIST_MAX_ROWS, Math.max(10, typeof filter.perPage === 'number' ? filter.perPage : 25))

  const where: Prisma.OrderWhereInput = {
    restaurantId,
    ...(filter.branchId ? { branchId: filter.branchId } : {}),
    ...(filter.status && filter.status !== 'ALL'
      ? { status: filter.status as OrderStatus }
      : {}),
    ...(filter.paymentStatus && filter.paymentStatus !== 'ALL'
      ? { paymentStatus: filter.paymentStatus as never }
      : {}),
    ...(filter.type && filter.type !== 'ALL' ? { type: filter.type as never } : {}),
    ...(filter.channel && filter.channel !== 'ALL' ? { channel: filter.channel as never } : {}),
    /*
     * `to` arrives in one of two shapes, and both have to work.
     *
     * The orders screen sends a date off an `<input type="date">` —
     * "2026-09-15", meaning the whole of that day — so the end of the day has
     * to be appended or the filter excludes everything after midnight.
     *
     * The export route sends a full instant, already resolved to the
     * restaurant's end-of-day by `resolveRange`. Appending to THAT produced
     * "2026-09-15T18:29:59.999ZT23:59:59.999", which is an Invalid Date, which
     * Prisma refuses — so every Orders export returned a 500. It had been
     * doing so silently: nothing rendered the error, and no test asked the
     * route for a file until `export-coverage-test`.
     *
     * A date-only string is ten characters and carries no `T`. That is the
     * distinction, and it is checked rather than assumed.
     */
    ...(filter.from || filter.to
      ? {
          placedAt: {
            ...(filter.from ? { gte: new Date(filter.from) } : {}),
            ...(filter.to
              ? { lte: new Date(filter.to.includes('T') ? filter.to : `${filter.to}T23:59:59.999`) }
              : {}),
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

  const [orders, aggregate] = await Promise.all([
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
    prisma.order.aggregate({
      where,
      _count: { _all: true },
      _sum: { grandTotal: true, tipAmount: true, paidTotal: true },
    }),
  ])

  const total = aggregate._count._all
  const grandTotal = aggregate._sum.grandTotal ?? 0
  const tipAmount = aggregate._sum.tipAmount ?? 0
  const paidTotal = aggregate._sum.paidTotal ?? 0
  const totals: OrderListTotals = {
    count: total,
    grandTotal,
    tipAmount,
    paidTotal,
    outstanding: Math.max(0, grandTotal + tipAmount - paidTotal),
  }

  return {
    orders,
    total,
    page,
    perPage: all ? ('ALL' as const) : perPage,
    pageCount: all ? 1 : Math.max(1, Math.ceil(total / perPage)),
    totals,
  }
}

/** Unpaid bills waiting at the till. */
export async function getCashierQueue(restaurantId: string, branchIds?: string[] | null) {
  return prisma.order.findMany({
    where: {
      restaurantId,
      // The till at Colombo settles Colombo's bills. The menu on this same
      // screen was already branch-scoped; the queue beside it was not.
      ...atBranch(branchIds),
      status: { notIn: ['CANCELLED'] },
      // Show unpaid/partially-paid bills plus takeaway orders (so cashier
      // can keep a copy of takeaway orders even after payment until the
      // food is served/delivered).
      OR: [
        { paymentStatus: { in: ['UNPAID', 'PARTIAL'] } },
        { AND: [{ type: 'TAKEAWAY' }, { status: { notIn: ['SERVED', 'COMPLETED'] } }] },
      ],
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
  { status: 'PENDING', label: 'Order received', description: 'Waiting to be confirmed' },
  { status: 'ACCEPTED', label: 'Accepted', description: 'Confirmed and sent to the kitchen' },
  { status: 'PREPARING', label: 'Preparing', description: 'Your food is being cooked' },
  { status: 'READY', label: 'Ready', description: 'Freshly plated and on its way' },
  { status: 'SERVED', label: 'Served', description: 'Enjoy your meal' },
]
