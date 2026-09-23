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
  /** The owner's own category, when they are in one (pro.A.md §1). */
  categoryName: string | null
  address: string | null
  birthday: string | null
  anniversary: string | null
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
    /** The whole bill (pro.A.md §2), so the history reads without opening each order. */
    type: string
    channel: string
    paymentStatus: string
    branchName: string | null
    cashierName: string | null
    subtotal: number
    discountTotal: number
    itemDiscount: number
    loyaltyDiscount: number
    serviceCharge: number
    taxTotal: number
    tipAmount: number
    paidTotal: number
    items: Array<{ name: string; quantity: number; lineTotal: number; discountAmount: number }>
    payments: Array<{ id: string; method: string; amount: number; paidAt: string | null }>
    refunds: Array<{ id: string; amount: number; createdAt: string; reason: string | null }>
    loyaltyEarned: number
    loyaltyRedeemed: number
  }>
  /** How many of their orders were cancelled, and how many refunded (§2). */
  cancelledOrders: number
  refundedOrders: number
  firstOrderAt: string | null
  /** Anything still owed across their open bills. */
  outstanding: number
}

export async function getCustomerProfile(params: {
  restaurantId: string
  customerId: string
  /** Locations the viewer may see. Null means all of them. */
  branchIds?: string[] | null
}): Promise<CustomerProfile> {
  const customer = await prisma.customer.findFirstOrThrow({
    where: { id: params.customerId, restaurantId: params.restaurantId },
    include: { category: { select: { name: true } } },
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
      /*
       * The whole bill, not just its total (pro.A.md §2). Somebody asking
       * "what did they have and what did they pay" should not have to open
       * each order in turn to find out.
       */
      type: true, channel: true, paymentStatus: true,
      subtotal: true, discountTotal: true, itemDiscount: true, loyaltyDiscount: true,
      serviceCharge: true, taxTotal: true, tipAmount: true, paidTotal: true,
      branch: { select: { name: true } },
      createdBy: { select: { name: true } },
      items: {
        where: { status: { not: 'CANCELLED' } },
        select: { name: true, quantity: true, lineTotal: true, discountAmount: true },
      },
      payments: {
        where: { status: { in: ['PAID', 'REFUNDED'] } },
        select: { id: true, method: true, amount: true, paidAt: true },
      },
      refunds: { select: { id: true, amount: true, createdAt: true, reason: true } },
    },
  })

  /*
   * Points earned and spent on each of those bills.
   *
   * `LoyaltyEntry` carries `orderId` but Order has no back-relation to it, so
   * this is one extra query for the whole page rather than an include — and
   * emphatically not one query per order.
   */
  const loyaltyByOrder = new Map<string, { earned: number; redeemed: number }>()
  if (orders.length > 0) {
    const entries = await prisma.loyaltyEntry.findMany({
      where: { restaurantId: params.restaurantId, orderId: { in: orders.map((order) => order.id) } },
      select: { orderId: true, points: true, kind: true },
    })
    for (const entry of entries) {
      if (!entry.orderId) continue
      const bucket = loyaltyByOrder.get(entry.orderId) ?? { earned: 0, redeemed: 0 }
      if (entry.kind === 'EARNED') bucket.earned += entry.points
      if (entry.kind === 'REDEEMED') bucket.redeemed += Math.abs(entry.points)
      loyaltyByOrder.set(entry.orderId, bucket)
    }
  }

  /*
   * The counts §2 asks for, which the order list above cannot answer: it
   * excludes cancelled orders by design, and is capped at 100 rows.
   */
  const reach = params.branchIds ? { branchId: { in: params.branchIds } } : {}
  const [cancelledOrders, refundedOrders, outstandingAgg] = await Promise.all([
    prisma.order.count({
      where: { customerId: customer.id, restaurantId: params.restaurantId, status: 'CANCELLED', ...reach },
    }),
    prisma.order.count({
      where: {
        customerId: customer.id,
        restaurantId: params.restaurantId,
        refunds: { some: {} },
        ...reach,
      },
    }),
    prisma.order.findMany({
      where: {
        customerId: customer.id,
        restaurantId: params.restaurantId,
        status: { not: 'CANCELLED' },
        paymentStatus: { in: ['UNPAID', 'PARTIAL'] },
        ...reach,
      },
      select: { grandTotal: true, tipAmount: true, paidTotal: true },
    }),
  ])
  const outstanding = outstandingAgg.reduce(
    (sum, order) => sum + Math.max(0, order.grandTotal + order.tipAmount - order.paidTotal),
    0,
  )

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
    categoryName: customer.category?.name ?? null,
    address: customer.address,
    birthday: customer.birthday?.toISOString() ?? null,
    anniversary: customer.anniversary?.toISOString() ?? null,
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
      type: o.type as string,
      channel: o.channel as string,
      paymentStatus: o.paymentStatus as string,
      branchName: o.branch?.name ?? null,
      cashierName: o.createdBy?.name ?? null,
      subtotal: o.subtotal,
      discountTotal: o.discountTotal,
      itemDiscount: o.itemDiscount,
      loyaltyDiscount: o.loyaltyDiscount,
      serviceCharge: o.serviceCharge,
      taxTotal: o.taxTotal,
      tipAmount: o.tipAmount,
      paidTotal: o.paidTotal,
      items: o.items.map((item) => ({
        name: item.name,
        quantity: item.quantity,
        lineTotal: item.lineTotal,
        discountAmount: item.discountAmount,
      })),
      payments: o.payments.map((payment) => ({
        id: payment.id,
        method: payment.method as string,
        amount: payment.amount,
        paidAt: payment.paidAt?.toISOString() ?? null,
      })),
      refunds: o.refunds.map((refund) => ({
        id: refund.id,
        amount: refund.amount,
        createdAt: refund.createdAt.toISOString(),
        reason: refund.reason,
      })),
      loyaltyEarned: loyaltyByOrder.get(o.id)?.earned ?? 0,
      loyaltyRedeemed: loyaltyByOrder.get(o.id)?.redeemed ?? 0,
    })),
    cancelledOrders,
    refundedOrders,
    firstOrderAt: customer.firstOrderAt?.toISOString() ?? null,
    outstanding,
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
/**
 * Superseded by `getCustomerInsights` (`./insights.ts`) for anything a person
 * reads (pro.A.md §3).
 *
 * This version adds up `Customer.totalSpent` in JavaScript over every row. That
 * counter includes tax and service charge and ignores partial refunds, so its
 * "spend" cannot be reconciled against the sales report — which is why the
 * screen no longer uses it. It survives only as a cheap smoke probe for the
 * health endpoint and two suites, where the point is that the query runs at
 * all rather than what it returns.
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
