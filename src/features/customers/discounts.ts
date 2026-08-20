import 'server-only'

import type { Coupon, CustomerGroup } from '@prisma/client'

import { AppError } from '@/lib/errors'
import { prisma } from '@/server/db/prisma'

/**
 * Discount eligibility and value.
 *
 * A coupon carries conditions — a minimum spend, a date window, hours of the
 * day, particular items or categories, one branch, one customer group. All of
 * them are checked server-side at the moment of use, not when the code is
 * typed, because a basket changes between the two.
 *
 * ── Scope matters ───────────────────────────────────────────────────────────
 *
 * "10% off" and "10% off desserts" are different offers. Applying the second as
 * though it were the first quietly discounts the wine, so the scope decides
 * which lines are eligible and the percentage is taken from those lines only.
 *
 * ── Refusals explain themselves ─────────────────────────────────────────────
 *
 * Every rejection returns the reason. A cashier told "not valid" in front of a
 * guest cannot fix anything; one told "spend Rs 200 more" can.
 */

export interface BasketLine {
  foodId: string | null
  categoryId: string | null
  quantity: number
  lineTotal: number
}

export interface DiscountContext {
  restaurantId: string
  subtotal: number
  lines: BasketLine[]
  branchId?: string | null
  customerId?: string | null
  /** Passed in so the check is testable at any hour. */
  now?: Date
}

export interface DiscountResult {
  ok: boolean
  reason?: string
  amount: number
  /** Which lines the discount was taken from — empty for a bill discount. */
  eligibleLineTotal: number
}

export async function evaluateCoupon(
  code: string,
  context: DiscountContext,
): Promise<DiscountResult> {
  const coupon = await prisma.coupon.findFirst({
    where: { restaurantId: context.restaurantId, code: code.trim().toUpperCase() },
  })
  if (!coupon) return reject('That code does not exist')
  return evaluate(coupon, context)
}

export async function evaluate(
  coupon: Coupon,
  context: DiscountContext,
): Promise<DiscountResult> {
  const now = context.now ?? new Date()

  if (!coupon.isActive) return reject('That code is no longer active')
  if (coupon.startsAt && now < coupon.startsAt) return reject('That offer has not started yet')
  if (coupon.endsAt && now > coupon.endsAt) return reject('That offer has expired')

  if (coupon.usageLimit !== null && coupon.usedCount >= coupon.usageLimit) {
    return reject('That offer has been fully claimed')
  }

  if (coupon.branchId && context.branchId && coupon.branchId !== context.branchId) {
    return reject('That offer is not available at this location')
  }

  // Hours may wrap past midnight — a 22:00–02:00 late-night offer is normal.
  if (coupon.startHour !== null && coupon.endHour !== null) {
    const hour = now.getHours()
    const inWindow =
      coupon.startHour <= coupon.endHour
        ? hour >= coupon.startHour && hour < coupon.endHour
        : hour >= coupon.startHour || hour < coupon.endHour
    if (!inWindow) {
      return reject(`That offer runs between ${pad(coupon.startHour)}:00 and ${pad(coupon.endHour)}:00`)
    }
  }

  const days = coupon.daysOfWeek as number[] | null
  if (Array.isArray(days) && days.length > 0 && !days.includes(now.getDay())) {
    return reject('That offer does not run today')
  }

  if (coupon.minOrderAmount && context.subtotal < coupon.minOrderAmount) {
    const short = coupon.minOrderAmount - context.subtotal
    return reject(`Spend ${(short / 100).toFixed(2)} more to use that code`)
  }

  if (coupon.customerGroup) {
    if (!context.customerId) return reject('That offer needs a registered customer')
    const customer = await prisma.customer.findFirst({
      where: { id: context.customerId, restaurantId: context.restaurantId },
      select: { group: true },
    })
    if (customer?.group !== coupon.customerGroup) {
      return reject(`That offer is for ${String(coupon.customerGroup).toLowerCase()} customers`)
    }
  }

  if (coupon.perCustomerLimit !== null && context.customerId) {
    const used = await prisma.couponRedemption.count({
      where: { couponId: coupon.id, customerId: context.customerId },
    })
    if (used >= coupon.perCustomerLimit) return reject('You have already used that code')
  }

  // Which lines the offer touches.
  const itemIds = (coupon.itemIds as string[] | null) ?? []
  const categoryIds = (coupon.categoryIds as string[] | null) ?? []

  const eligible =
    coupon.scope === 'ITEM'
      ? context.lines.filter((l) => l.foodId && itemIds.includes(l.foodId))
      : coupon.scope === 'CATEGORY'
        ? context.lines.filter((l) => l.categoryId && categoryIds.includes(l.categoryId))
        : context.lines

  const eligibleTotal = eligible.reduce((s, l) => s + l.lineTotal, 0)

  if (coupon.scope !== 'BILL' && eligibleTotal <= 0) {
    return reject(
      coupon.scope === 'ITEM'
        ? 'Nothing in this order qualifies for that code'
        : 'No item from that category is in this order',
    )
  }

  const base = coupon.scope === 'BILL' ? context.subtotal : eligibleTotal

  let amount =
    coupon.type === 'PERCENT'
      ? Math.round((base * coupon.value) / 100)
      : coupon.type === 'FIXED'
        ? coupon.value
        : // FREE_ITEM takes the cheapest eligible line off, which is the
          // conventional reading of "buy one get one" and the one that cannot
          // be gamed by adding an expensive item.
          Math.min(...eligible.map((l) => Math.round(l.lineTotal / Math.max(1, l.quantity))), base)

  if (coupon.maxDiscount) amount = Math.min(amount, coupon.maxDiscount)
  // A discount can never exceed what it is discounting, or a bill goes negative.
  amount = Math.min(amount, base)

  return { ok: true, amount: Math.max(0, amount), eligibleLineTotal: eligibleTotal }
}

/** Points earned and what they are worth, from the restaurant's own settings. */
export async function loyaltyFor(restaurantId: string) {
  const restaurant = await prisma.restaurant.findUniqueOrThrow({
    where: { id: restaurantId },
    select: { loyaltyEnabled: true, loyaltyEarnRateX100: true, loyaltyPointValue: true },
  })
  return {
    enabled: restaurant.loyaltyEnabled,
    /** Points earned per unit spent, ×100 to avoid a float rate. */
    earnRateX100: restaurant.loyaltyEarnRateX100,
    /** What one point is worth, in minor units. */
    pointValue: restaurant.loyaltyPointValue,

    pointsFor(spendMinor: number): number {
      if (!restaurant.loyaltyEnabled) return 0
      // Rate is per major unit: 100 means one point per Rs 100 spent.
      return Math.floor((spendMinor / 100) * (restaurant.loyaltyEarnRateX100 / 100) / 100)
    },
    valueOf(points: number): number {
      return Math.max(0, Math.floor(points)) * restaurant.loyaltyPointValue
    },
  }
}

/**
 * Spend points against a bill.
 *
 * Redeeming more than the bill is worth would hand back change in cash, so the
 * redemption is capped at the amount owed and the surplus points are left on
 * the account rather than burnt.
 */
export async function redeemPoints(params: {
  restaurantId: string
  customerId: string
  requestedPoints: number
  billTotal: number
}): Promise<{ points: number; value: number }> {
  const loyalty = await loyaltyFor(params.restaurantId)
  if (!loyalty.enabled) throw new AppError('Loyalty is switched off', 400, 'LOYALTY_OFF')

  const customer = await prisma.customer.findFirst({
    where: { id: params.customerId, restaurantId: params.restaurantId },
    select: { loyaltyPoints: true },
  })
  if (!customer) throw new AppError('Customer not found', 404, 'CUSTOMER_NOT_FOUND')

  const wanted = Math.max(0, Math.floor(params.requestedPoints))
  if (wanted > customer.loyaltyPoints) {
    throw new AppError(
      `Only ${customer.loyaltyPoints} points available`,
      400,
      'LOYALTY_INSUFFICIENT',
    )
  }

  const affordable = loyalty.pointValue > 0 ? Math.floor(params.billTotal / loyalty.pointValue) : 0
  const points = Math.min(wanted, affordable)

  return { points, value: loyalty.valueOf(points) }
}

function reject(reason: string): DiscountResult {
  return { ok: false, reason, amount: 0, eligibleLineTotal: 0 }
}
function pad(h: number) {
  return String(h).padStart(2, '0')
}
