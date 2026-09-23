import 'server-only'

import { AppError, NotFoundError } from '@/lib/errors'
import { guardLocks, prisma } from '@/server/db/prisma'
import { recalculateOrderTotals } from '@/features/cashier/service'

/**
 * Spending points on something a guest recognises.
 *
 * Points already bought a flat rate off a bill — a number of points, a value
 * per point, applied at placement. That is the arithmetic, not the offer. A
 * reward is what the guest is actually told about: "500 points, a free
 * dessert". This module turns one into the other, and it does so against a
 * bill that already exists, so the same path serves the till, the QR screen
 * and a takeaway.
 *
 * ── What is reused, and must not be rebuilt ────────────────────────────────
 *
 * The ledger (`LoyaltyEntry`), the balance column and its CHECK constraint,
 * `recalculateOrderTotals` for the money, and the accounting integrity check
 * that holds `loyaltyPoints === SUM(entries)`. Nothing here keeps a second
 * tally of anything.
 */

export interface RewardOffer {
  id: string
  name: string
  description: string | null
  pointsCost: number
  value: number
  minOrderAmount: number
  expiresAt: string | null
  /** The guest has the points for it. */
  affordable: boolean
  /** How many more points they need; 0 when they can have it. */
  pointsNeeded: number
  /** The bill is big enough. */
  meetsMinimum: boolean
}

/**
 * The rewards on offer, and what stands between the guest and each one.
 *
 * Returned whether or not they can be had: "1,200 points — 300 to go" is the
 * thing that makes somebody come back, and a list that hides what they cannot
 * afford yet cannot say it.
 */
export async function listRewards(params: {
  restaurantId: string
  points?: number
  orderTotal?: number
  now?: Date
}): Promise<RewardOffer[]> {
  const now = params.now ?? new Date()
  const rows = await prisma.loyaltyReward.findMany({
    where: {
      restaurantId: params.restaurantId,
      isActive: true,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    orderBy: [{ pointsCost: 'asc' }, { name: 'asc' }],
  })
  const points = params.points ?? 0
  return rows.map((reward) => ({
    id: reward.id,
    name: reward.name,
    description: reward.description,
    pointsCost: reward.pointsCost,
    value: reward.value,
    minOrderAmount: reward.minOrderAmount,
    expiresAt: reward.expiresAt?.toISOString() ?? null,
    affordable: points >= reward.pointsCost,
    pointsNeeded: Math.max(0, reward.pointsCost - points),
    meetsMinimum: params.orderTotal === undefined || params.orderTotal >= reward.minOrderAmount,
  }))
}

/**
 * Spend a reward against an open bill.
 *
 * ── Once, whatever happens ────────────────────────────────────────────────
 *
 * A guest tapping twice, a dropped connection, two tills on the same bill:
 * all of them end with one redemption. The guard is the ledger itself — a
 * REDEEMED entry already naming this order and this reward means it is done —
 * read inside a `FOR UPDATE` on the order so two callers cannot both find
 * nothing. There is no separate redemption table to keep in step.
 *
 * ── And never on points the guest does not have ───────────────────────────
 *
 * The debit is a conditional update: it finds the row only while the balance
 * still covers the cost, exactly as placement-time redemption does. If two
 * bills spend the same points at once, the loser is told so rather than
 * driving the balance negative — and the CHECK constraint underneath is the
 * last line if this is ever bypassed.
 */
export async function redeemReward(params: {
  restaurantId: string
  orderId: string
  rewardId: string
  actorId?: string | null
}): Promise<{ pointsSpent: number; discount: number; balance: number; replayed: boolean }> {
  return prisma.$transaction(async (tx) => {
    await guardLocks(tx)
    await tx.$queryRaw`SELECT id FROM orders WHERE id = ${params.orderId} AND "restaurantId" = ${params.restaurantId} FOR UPDATE`

    const order = await tx.order.findFirst({
      where: { id: params.orderId, restaurantId: params.restaurantId },
      select: {
        id: true, orderNumber: true, customerId: true, status: true,
        paymentStatus: true, subtotal: true, loyaltyDiscount: true,
      },
    })
    if (!order) throw new NotFoundError('Order')
    if (!order.customerId) {
      throw new AppError(
        'This bill has no guest on it — add their phone number first',
        400,
        'LOYALTY_NO_CUSTOMER',
      )
    }
    if (order.status === 'CANCELLED') {
      throw new AppError('That bill was cancelled', 409, 'ORDER_CANCELLED')
    }
    if (order.paymentStatus !== 'UNPAID') {
      throw new AppError(
        'This bill has been paid — a reward has to be used before it is settled',
        409,
        'ORDER_PAID',
      )
    }

    const reward = await tx.loyaltyReward.findFirst({
      where: { id: params.rewardId, restaurantId: params.restaurantId },
    })
    if (!reward) throw new NotFoundError('Reward')

    // Already done. Idempotent by the ledger, not by a second table.
    const already = await tx.loyaltyEntry.findFirst({
      where: { orderId: order.id, kind: 'REDEEMED', note: { contains: `[reward:${reward.id}]` } },
      select: { points: true },
    })
    if (already) {
      const holder = await tx.customer.findUniqueOrThrow({
        where: { id: order.customerId },
        select: { loyaltyPoints: true },
      })
      return {
        pointsSpent: Math.abs(already.points),
        discount: reward.value,
        balance: holder.loyaltyPoints,
        replayed: true,
      }
    }

    if (!reward.isActive) throw new AppError('That reward is no longer offered', 409, 'REWARD_RETIRED')
    if (reward.expiresAt && reward.expiresAt <= new Date()) {
      throw new AppError('That reward has expired', 409, 'REWARD_EXPIRED')
    }
    if (order.subtotal < reward.minOrderAmount) {
      throw new AppError(
        `That reward needs a bill of at least ${reward.minOrderAmount / 100}`,
        409,
        'REWARD_MIN_ORDER',
      )
    }

    /*
     * The discount can never exceed what is left of the bill. A reward worth
     * more than the food would otherwise hand back the difference in cash,
     * which is not what a free dessert is.
     */
    const room = Math.max(0, order.subtotal - order.loyaltyDiscount)
    if (room <= 0) {
      throw new AppError('This bill is already fully covered', 409, 'REWARD_NO_ROOM')
    }
    const discount = Math.min(reward.value, room)

    const spent = await tx.customer.updateMany({
      where: { id: order.customerId, loyaltyPoints: { gte: reward.pointsCost } },
      data: { loyaltyPoints: { decrement: reward.pointsCost } },
    })
    if (spent.count === 0) {
      throw new AppError(
        'There are not enough points on that account for this reward',
        409,
        'LOYALTY_INSUFFICIENT',
      )
    }

    await tx.loyaltyEntry.create({
      data: {
        restaurantId: params.restaurantId,
        customerId: order.customerId,
        orderId: order.id,
        points: -reward.pointsCost,
        kind: 'REDEEMED',
        // The marker is what makes a second attempt a replay rather than a
        // second redemption.
        note: `${reward.name} on ${order.orderNumber} [reward:${reward.id}]`,
        actorId: params.actorId ?? null,
      },
    })

    await tx.order.update({
      where: { id: order.id },
      data: { loyaltyDiscount: order.loyaltyDiscount + discount },
    })
    // The one writer for a bill's money. It re-clamps and, if the bill cannot
    // absorb it all, returns the points that no longer buy anything.
    await recalculateOrderTotals(tx, order.id)

    const holder = await tx.customer.findUniqueOrThrow({
      where: { id: order.customerId },
      select: { loyaltyPoints: true },
    })
    return { pointsSpent: reward.pointsCost, discount, balance: holder.loyaltyPoints, replayed: false }
  })
}

/**
 * Spend a number of points against a bill, at the restaurant's own rate.
 *
 * ── Why this exists alongside rewards ──────────────────────────────────────
 *
 * A reward is a named offer — "500 points, a free dessert" — and it is the
 * right thing to put in front of a guest. It is the wrong thing to put in
 * front of a cashier whose customer has 1,340 points and says "take some off".
 * The restaurant already has a rate for that (`loyaltyPointValue`), the
 * settings screen already asks for it, and `discounts.ts` has had the
 * arithmetic since the ledger was built — with, until now, nothing calling it.
 *
 * `websiteconnect.md` says why it was left unwired rather than finished:
 * "spending points is a till operation, where a person checks who is asking".
 * This is that till operation.
 *
 * ── Everything sharp is borrowed from `redeemReward` ───────────────────────
 *
 * The same order lock, the same refusals, the same conditional debit so two
 * bills racing for one balance cannot both win, the same ledger row, the same
 * single money writer. The only differences are that the amount comes from a
 * rate rather than a catalogue row, and that this one is deliberately NOT
 * idempotent by marker: "take 200 points off" twice is a cashier asking for
 * 400 points off, which is a legitimate thing to want. The guard against a
 * double-tap is the balance itself and the room left on the bill.
 */
export async function redeemPointsOnOrder(params: {
  restaurantId: string
  orderId: string
  points: number
  actorId?: string | null
}): Promise<{ pointsSpent: number; discount: number; balance: number }> {
  const wanted = Math.floor(params.points)
  if (!Number.isFinite(wanted) || wanted <= 0) {
    throw new AppError('Say how many points to take off', 400, 'LOYALTY_NO_POINTS')
  }

  return prisma.$transaction(async (tx) => {
    await guardLocks(tx)
    await tx.$queryRaw`SELECT id FROM orders WHERE id = ${params.orderId} AND "restaurantId" = ${params.restaurantId} FOR UPDATE`

    const order = await tx.order.findFirst({
      where: { id: params.orderId, restaurantId: params.restaurantId },
      select: {
        id: true, orderNumber: true, customerId: true, status: true,
        paymentStatus: true, subtotal: true, loyaltyDiscount: true,
      },
    })
    if (!order) throw new NotFoundError('Order')
    if (!order.customerId) {
      throw new AppError(
        'This bill has no guest on it — add their phone number first',
        400,
        'LOYALTY_NO_CUSTOMER',
      )
    }
    if (order.status === 'CANCELLED') {
      throw new AppError('That bill was cancelled', 409, 'ORDER_CANCELLED')
    }
    if (order.paymentStatus !== 'UNPAID') {
      throw new AppError(
        'This bill has been paid — points have to be spent before it is settled',
        409,
        'ORDER_PAID',
      )
    }

    const restaurant = await tx.restaurant.findUniqueOrThrow({
      where: { id: params.restaurantId },
      select: { loyaltyEnabled: true, loyaltyPointValue: true },
    })
    if (!restaurant.loyaltyEnabled) {
      throw new AppError('Loyalty is switched off', 400, 'LOYALTY_OFF')
    }
    if (restaurant.loyaltyPointValue <= 0) {
      throw new AppError(
        'A point is worth nothing until somebody sets its value in Settings',
        400,
        'LOYALTY_NO_RATE',
      )
    }

    /*
     * Never more than the bill can absorb. Points that would hand back change
     * in cash are left on the account rather than burnt — the same rule
     * `redeemReward` applies, and the reason `recalculateOrderTotals` returns
     * anything it cannot use.
     */
    const room = Math.max(0, order.subtotal - order.loyaltyDiscount)
    if (room <= 0) {
      throw new AppError('This bill is already fully covered', 409, 'LOYALTY_NO_ROOM')
    }
    const affordableByBill = Math.floor(room / restaurant.loyaltyPointValue)
    if (affordableByBill <= 0) {
      throw new AppError('This bill is too small to take a point off', 409, 'LOYALTY_NO_ROOM')
    }
    const points = Math.min(wanted, affordableByBill)
    const discount = Math.min(points * restaurant.loyaltyPointValue, room)

    // Conditional, so a balance cannot be driven negative by two tills at once.
    const spent = await tx.customer.updateMany({
      where: { id: order.customerId, loyaltyPoints: { gte: points } },
      data: { loyaltyPoints: { decrement: points } },
    })
    if (spent.count === 0) {
      const holder = await tx.customer.findUniqueOrThrow({
        where: { id: order.customerId },
        select: { loyaltyPoints: true },
      })
      throw new AppError(
        `Only ${holder.loyaltyPoints} points on that account`,
        409,
        'LOYALTY_INSUFFICIENT',
      )
    }

    await tx.loyaltyEntry.create({
      data: {
        restaurantId: params.restaurantId,
        customerId: order.customerId,
        orderId: order.id,
        points: -points,
        kind: 'REDEEMED',
        note: `${points} points on ${order.orderNumber}`,
        actorId: params.actorId ?? null,
      },
    })

    await tx.order.update({
      where: { id: order.id },
      data: { loyaltyDiscount: order.loyaltyDiscount + discount },
    })
    // The one writer for a bill's money, exactly as the reward path uses it.
    await recalculateOrderTotals(tx, order.id)

    const holder = await tx.customer.findUniqueOrThrow({
      where: { id: order.customerId },
      select: { loyaltyPoints: true },
    })
    return { pointsSpent: points, discount, balance: holder.loyaltyPoints }
  })
}

/**
 * A hand correction to somebody's balance.
 *
 * ── Why this exists as a service ──────────────────────────────────────────
 *
 * The staff screen used to write `Customer.loyaltyPoints` directly and record
 * nothing, so every hand correction desynchronised the balance from its
 * ledger and tripped the accounting integrity check that exists to notice
 * exactly that. The enum has had an `ADJUSTED` kind for this all along; it was
 * never written. A balance has to be the sum of its entries, including the
 * ones a person made up.
 */
export async function adjustPoints(params: {
  restaurantId: string
  customerId: string
  points: number
  note: string
  actorId?: string | null
}): Promise<{ balance: number; applied: number }> {
  const delta = Math.trunc(params.points)
  if (delta === 0) throw new AppError('Say how many points to add or take', 400, 'LOYALTY_NO_CHANGE')
  if (params.note.trim().length < 2) {
    throw new AppError('Give a reason for the adjustment', 400, 'LOYALTY_NO_REASON')
  }

  return prisma.$transaction(async (tx) => {
    const customer = await tx.customer.findFirst({
      where: { id: params.customerId, restaurantId: params.restaurantId },
      select: { id: true, loyaltyPoints: true },
    })
    if (!customer) throw new NotFoundError('Customer')

    /*
     * A deduction is capped at what they hold rather than refused, because a
     * manager correcting a mistake should not have to work out the balance
     * first — but the ENTRY records what was actually applied, not what was
     * asked for, or the ledger would stop explaining the balance.
     */
    const applied = delta < 0 ? -Math.min(-delta, customer.loyaltyPoints) : delta
    if (applied === 0) {
      throw new AppError('That account has no points to take', 409, 'LOYALTY_INSUFFICIENT')
    }

    await tx.customer.update({
      where: { id: customer.id },
      data: { loyaltyPoints: { increment: applied } },
    })
    await tx.loyaltyEntry.create({
      data: {
        restaurantId: params.restaurantId,
        customerId: customer.id,
        points: applied,
        kind: 'ADJUSTED',
        note: params.note.trim(),
        actorId: params.actorId ?? null,
      },
    })
    return { balance: customer.loyaltyPoints + applied, applied }
  })
}

/**
 * What a guest has, looked up by the phone they gave.
 *
 * Read-only and deliberately incurious: an unknown number reads as a zero
 * balance rather than "no such guest", so the screen cannot be used to find
 * out who is a member.
 */
export async function balanceForPhone(params: {
  restaurantId: string
  phone: string
}): Promise<{ customerId: string | null; name: string | null; points: number }> {
  const phone = params.phone.trim()
  if (!phone) return { customerId: null, name: null, points: 0 }

  const customer = await prisma.customer.findUnique({
    where: { restaurantId_phone: { restaurantId: params.restaurantId, phone } },
    select: { id: true, name: true, loyaltyPoints: true, isBlocked: true },
  })
  if (!customer || customer.isBlocked) return { customerId: null, name: null, points: 0 }
  return { customerId: customer.id, name: customer.name, points: customer.loyaltyPoints }
}

/** A guest's own history, newest first — what they earned and what they spent. */
export async function historyFor(params: {
  restaurantId: string
  customerId: string
  limit?: number
}) {
  return prisma.loyaltyEntry.findMany({
    where: { restaurantId: params.restaurantId, customerId: params.customerId },
    orderBy: { createdAt: 'desc' },
    take: params.limit ?? 20,
    select: { id: true, points: true, kind: true, note: true, createdAt: true },
  })
}
