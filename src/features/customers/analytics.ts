import 'server-only'

import { customersAtBranch } from '@/lib/rbac'
import { prisma } from '@/server/db/prisma'

/**
 * Customer analytics.
 *
 * Aimed at the questions a restaurant owner actually asks: who comes back, who
 * spends, what do they order, and who has stopped coming. Nothing here profiles
 * beyond what the restaurant already recorded to serve the order.
 */

export interface CustomerProfile {
  id: string
  name: string | null
  phone: string | null
  email: string | null
  group: string
  marketingConsent: boolean
  notes: string | null
  totalSpent: number
  totalOrders: number
  loyaltyPoints: number
  /** True when spend/visits/last visit are this branch's rather than the group's. */
  figuresScopedToBranch: boolean
  lastOrderAt: string | null
  /** Average spend per visit. */
  averageOrder: number
  /** Days since they last came in. */
  daysSinceLastVisit: number | null
  favouriteItems: Array<{ name: string; quantity: number; spend: number }>
  recentOrders: Array<{
    id: string
    orderNumber: string
    placedAt: string
    total: number
    status: string
    itemCount: number
  }>
}

export async function getCustomerProfile(params: {
  restaurantId: string
  customerId: string
  /** Locations the viewer may see. Null means all of them. */
  branchIds?: string[] | null
}): Promise<CustomerProfile> {
  const customer = await prisma.customer.findFirstOrThrow({
    where: { id: params.customerId, restaurantId: params.restaurantId },
  })

  /*
   * The customer RECORD is restaurant-wide — a guest belongs to the business,
   * not to a site, and their loyalty points are one counter with no ledger
   * behind it, so forking the row per branch would halve a regular's balance
   * with no way to rebuild it.
   *
   * What narrows is who each branch SEES, and what it sees of them: this order
   * list is the branch's own, so a site manager reads what this customer spent
   * at their site rather than across the group.
   */
  const orders = await prisma.order.findMany({
    where: {
      customerId: customer.id,
      restaurantId: params.restaurantId,
      status: { not: 'CANCELLED' },
      ...(params.branchIds ? { branchId: { in: params.branchIds } } : {}),
    },
    orderBy: { placedAt: 'desc' },
    take: 100,
    select: {
      id: true, orderNumber: true, placedAt: true, grandTotal: true, status: true,
      items: {
        where: { status: { not: 'CANCELLED' } },
        select: { name: true, quantity: true, lineTotal: true },
      },
    },
  })

  const favourites = new Map<string, { quantity: number; spend: number }>()
  for (const o of orders) {
    for (const line of o.items) {
      const row = favourites.get(line.name) ?? { quantity: 0, spend: 0 }
      row.quantity += line.quantity
      row.spend += line.lineTotal
      favourites.set(line.name, row)
    }
  }

  /*
   * ── The figures follow the same scope as the list under them ─────────────
   *
   * These four read straight off the group-wide `Customer` counters and were
   * rendered as "Lifetime spend / Visits / Average order / Last visit"
   * directly above an order list that IS branch-filtered. A Colombo manager
   * saw *Visits: 12* over three orders and nothing anywhere admitted the
   * mismatch.
   *
   * Scoped, they answer the question the screen appears to be answering: what
   * this guest has done *here*. Unscoped — an owner on Main admin — they are
   * the counters, which is both correct and cheaper.
   *
   * The aggregate is separate from the `take: 100` order list on purpose: a
   * regular with two hundred visits would otherwise have their spend quietly
   * truncated to the most recent hundred.
   */
  const scoped = params.branchIds !== null && params.branchIds !== undefined
  const branchTotals = scoped
    ? await prisma.order.aggregate({
        where: {
          customerId: customer.id,
          restaurantId: params.restaurantId,
          status: { not: 'CANCELLED' },
          branchId: { in: params.branchIds! },
        },
        _sum: { grandTotal: true },
        _count: true,
        _max: { placedAt: true },
      })
    : null

  const totalSpent = branchTotals ? (branchTotals._sum.grandTotal ?? 0) : customer.totalSpent
  const totalOrders = branchTotals ? branchTotals._count : customer.totalOrders
  const lastOrderAt = branchTotals ? branchTotals._max.placedAt : customer.lastOrderAt

  const days = lastOrderAt
    ? Math.floor((Date.now() - lastOrderAt.getTime()) / 86_400_000)
    : null

  return {
    id: customer.id,
    name: customer.name,
    phone: customer.phone,
    email: customer.email,
    group: customer.group as string,
    marketingConsent: customer.marketingConsent,
    notes: customer.notes,
    totalSpent,
    totalOrders,
    /*
     * Loyalty is the one figure that stays the person's, everywhere.
     *
     * It is a single counter with no ledger behind it, so there is nothing to
     * replay per branch — and a regular should not lose their balance for
     * visiting the other site. The screen labels it as theirs rather than as
     * this branch's.
     */
    loyaltyPoints: customer.loyaltyPoints,
    /** True when the figures above are this branch's rather than the group's. */
    figuresScopedToBranch: scoped,
    lastOrderAt: lastOrderAt?.toISOString() ?? null,
    averageOrder: totalOrders > 0 ? Math.round(totalSpent / totalOrders) : 0,
    daysSinceLastVisit: days,
    favouriteItems: [...favourites.entries()]
      .map(([name, v]) => ({ name, ...v }))
      .sort((a, b) => b.quantity - a.quantity)
      .slice(0, 10),
    recentOrders: orders.slice(0, 20).map((o) => ({
      id: o.id,
      orderNumber: o.orderNumber,
      placedAt: o.placedAt.toISOString(),
      total: o.grandTotal,
      status: o.status,
      itemCount: o.items.length,
    })),
  }
}

export interface CustomerAnalytics {
  totalCustomers: number
  withConsent: number
  newThisPeriod: number
  returning: number
  /** Customers who came once and never again. */
  oneTimers: number
  averageSpend: number
  averageVisits: number
  topSpenders: Array<{ id: string; name: string | null; phone: string | null; spent: number; orders: number }>
  mostFrequent: Array<{ id: string; name: string | null; phone: string | null; orders: number; spent: number }>
  /** Regulars who have not been in for a while — the win-back list. */
  lapsing: Array<{ id: string; name: string | null; phone: string | null; orders: number; daysSince: number }>
  byGroup: Array<{ group: string; count: number; spent: number }>
}

/**
 * The owner's view of the customer base.
 *
 * `lapsing` is the commercially useful list: someone who came four times and
 * then stopped is a problem worth a phone call, while someone who came once
 * and left never was a regular to begin with. The two are counted separately
 * rather than lumped together as "inactive".
 */
export async function getCustomerAnalytics(params: {
  restaurantId: string
  since?: Date
  lapsedAfterDays?: number
  /** Locations the viewer may see. Null means all of them. */
  branchIds?: string[] | null
}): Promise<CustomerAnalytics> {
  const lapsedAfter = params.lapsedAfterDays ?? 45
  const since = params.since ?? new Date(Date.now() - 30 * 86_400_000)
  const lapsedBefore = new Date(Date.now() - lapsedAfter * 86_400_000)

  const customers = await prisma.customer.findMany({
    where: {
      restaurantId: params.restaurantId,
      ...customersAtBranch(params.branchIds ?? null),
    },
    select: {
      id: true, name: true, phone: true, group: true, marketingConsent: true,
      totalSpent: true, totalOrders: true, lastOrderAt: true, createdAt: true,
    },
  })

  const groups = new Map<string, { count: number; spent: number }>()
  let withConsent = 0, newThisPeriod = 0, returning = 0, oneTimers = 0, spend = 0, visits = 0

  for (const c of customers) {
    if (c.marketingConsent) withConsent += 1
    if (c.createdAt >= since) newThisPeriod += 1
    if (c.totalOrders > 1) returning += 1
    if (c.totalOrders === 1) oneTimers += 1
    spend += c.totalSpent
    visits += c.totalOrders

    const g = groups.get(c.group) ?? { count: 0, spent: 0 }
    g.count += 1
    g.spent += c.totalSpent
    groups.set(c.group, g)
  }

  const n = customers.length || 1

  return {
    totalCustomers: customers.length,
    withConsent,
    newThisPeriod,
    returning,
    oneTimers,
    averageSpend: Math.round(spend / n),
    averageVisits: Math.round((visits / n) * 10) / 10,
    topSpenders: [...customers]
      .sort((a, b) => b.totalSpent - a.totalSpent)
      .slice(0, 10)
      .map((c) => ({ id: c.id, name: c.name, phone: c.phone, spent: c.totalSpent, orders: c.totalOrders })),
    mostFrequent: [...customers]
      .sort((a, b) => b.totalOrders - a.totalOrders)
      .slice(0, 10)
      .map((c) => ({ id: c.id, name: c.name, phone: c.phone, orders: c.totalOrders, spent: c.totalSpent })),
    lapsing: customers
      // Two or more visits is what makes someone a regular worth winning back.
      .filter((c) => c.totalOrders >= 2 && c.lastOrderAt && c.lastOrderAt < lapsedBefore)
      .map((c) => ({
        id: c.id,
        name: c.name,
        phone: c.phone,
        orders: c.totalOrders,
        daysSince: Math.floor((Date.now() - c.lastOrderAt!.getTime()) / 86_400_000),
      }))
      .sort((a, b) => b.orders - a.orders)
      .slice(0, 20),
    byGroup: [...groups.entries()]
      .map(([group, v]) => ({ group, ...v }))
      .sort((a, b) => b.spent - a.spent),
  }
}
