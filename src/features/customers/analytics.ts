import 'server-only'

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
}): Promise<CustomerProfile> {
  const customer = await prisma.customer.findFirstOrThrow({
    where: { id: params.customerId, restaurantId: params.restaurantId },
  })

  const orders = await prisma.order.findMany({
    where: {
      customerId: customer.id,
      restaurantId: params.restaurantId,
      status: { not: 'CANCELLED' },
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

  const days = customer.lastOrderAt
    ? Math.floor((Date.now() - customer.lastOrderAt.getTime()) / 86_400_000)
    : null

  return {
    id: customer.id,
    name: customer.name,
    phone: customer.phone,
    email: customer.email,
    group: customer.group as string,
    marketingConsent: customer.marketingConsent,
    notes: customer.notes,
    totalSpent: customer.totalSpent,
    totalOrders: customer.totalOrders,
    loyaltyPoints: customer.loyaltyPoints,
    lastOrderAt: customer.lastOrderAt?.toISOString() ?? null,
    averageOrder: customer.totalOrders > 0 ? Math.round(customer.totalSpent / customer.totalOrders) : 0,
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
}): Promise<CustomerAnalytics> {
  const lapsedAfter = params.lapsedAfterDays ?? 45
  const since = params.since ?? new Date(Date.now() - 30 * 86_400_000)
  const lapsedBefore = new Date(Date.now() - lapsedAfter * 86_400_000)

  const customers = await prisma.customer.findMany({
    where: { restaurantId: params.restaurantId },
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
