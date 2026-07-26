import type { Coupon, Food, SpiceLevel, VariantKind } from '@prisma/client'

import { applyBps, roundToNearestMajor } from '@/lib/money'

/**
 * The single source of truth for money in TableFlow.
 *
 * The guest app renders prices with these functions, and the server recomputes
 * every total with the *same* functions from database records before an order
 * is written. Client-submitted prices are never trusted.
 */

export interface SelectedOption {
  groupId: string
  groupName: string
  optionId: string
  name: string
  priceDelta: number
  kind: VariantKind
}

export interface PricedFood {
  id: string
  price: number
  discountPrice: number | null
  happyHourPrice: number | null
  happyHourStartMin: number | null
  happyHourEndMin: number | null
  happyHourDays: number[]
}

export interface EffectivePrice {
  /** What the guest pays per unit before options. */
  price: number
  /** The struck-through original, when a promotion applies. */
  compareAt: number | null
  reason: 'base' | 'discount' | 'happy-hour'
}

/** Minutes since midnight in the restaurant's timezone. */
export function localMinutes(date: Date, timeZone: string): { minutes: number; day: number } {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hour12: false,
  })
  const parts = formatter.formatToParts(date)
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0)
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? 0)
  const weekday = parts.find((p) => p.type === 'weekday')?.value ?? 'Sun'
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(weekday)
  return { minutes: hour * 60 + minute, day: day < 0 ? 0 : day }
}

export function isHappyHourActive(
  food: PricedFood,
  now: Date = new Date(),
  timeZone = 'Asia/Kolkata',
): boolean {
  if (
    food.happyHourPrice === null ||
    food.happyHourStartMin === null ||
    food.happyHourEndMin === null
  ) {
    return false
  }

  const { minutes, day } = localMinutes(now, timeZone)
  if (food.happyHourDays.length > 0 && !food.happyHourDays.includes(day)) return false

  const start = food.happyHourStartMin
  const end = food.happyHourEndMin
  // A window may wrap past midnight (e.g. 22:00 → 01:00).
  return start <= end ? minutes >= start && minutes < end : minutes >= start || minutes < end
}

export function effectivePrice(
  food: PricedFood,
  now: Date = new Date(),
  timeZone = 'Asia/Kolkata',
): EffectivePrice {
  if (isHappyHourActive(food, now, timeZone) && food.happyHourPrice !== null) {
    return { price: food.happyHourPrice, compareAt: food.price, reason: 'happy-hour' }
  }
  if (food.discountPrice !== null && food.discountPrice < food.price) {
    return { price: food.discountPrice, compareAt: food.price, reason: 'discount' }
  }
  return { price: food.price, compareAt: null, reason: 'base' }
}

export function optionsTotal(options: SelectedOption[]): number {
  return options.reduce((total, option) => total + option.priceDelta, 0)
}

export interface PricedLine {
  unitPrice: number
  optionsTotal: number
  quantity: number
  lineTotal: number
}

export function priceLine(
  food: PricedFood,
  options: SelectedOption[],
  quantity: number,
  now: Date = new Date(),
  timeZone = 'Asia/Kolkata',
): PricedLine {
  const { price } = effectivePrice(food, now, timeZone)
  const extras = optionsTotal(options)
  const qty = Math.max(1, Math.trunc(quantity))
  return {
    unitPrice: price,
    optionsTotal: extras,
    quantity: qty,
    lineTotal: (price + extras) * qty,
  }
}

// ── coupons ──────────────────────────────────────────────────────────────────

export interface CouponEvaluation {
  valid: boolean
  discount: number
  reason?: string
}

export function evaluateCoupon(
  coupon: Pick<
    Coupon,
    | 'type'
    | 'value'
    | 'minOrderAmount'
    | 'maxDiscount'
    | 'startsAt'
    | 'endsAt'
    | 'usageLimit'
    | 'usedCount'
    | 'isActive'
  >,
  subtotal: number,
  now: Date = new Date(),
): CouponEvaluation {
  if (!coupon.isActive) return { valid: false, discount: 0, reason: 'This coupon is no longer active' }
  if (coupon.startsAt && coupon.startsAt > now) {
    return { valid: false, discount: 0, reason: 'This coupon is not valid yet' }
  }
  if (coupon.endsAt && coupon.endsAt < now) {
    return { valid: false, discount: 0, reason: 'This coupon has expired' }
  }
  if (coupon.usageLimit !== null && coupon.usedCount >= coupon.usageLimit) {
    return { valid: false, discount: 0, reason: 'This coupon has reached its usage limit' }
  }
  if (subtotal < coupon.minOrderAmount) {
    return { valid: false, discount: 0, reason: 'Order value is below the coupon minimum' }
  }

  let discount =
    coupon.type === 'PERCENT' ? applyBps(subtotal, coupon.value) : Math.min(coupon.value, subtotal)

  if (coupon.maxDiscount !== null) discount = Math.min(discount, coupon.maxDiscount)
  discount = Math.min(discount, subtotal)

  return { valid: discount > 0, discount, reason: discount > 0 ? undefined : 'No discount applies' }
}

// ── order totals ─────────────────────────────────────────────────────────────

export interface TotalsInput {
  lines: Array<{ lineTotal: number }>
  taxRateBps: number
  serviceChargeBps: number
  taxInclusive: boolean
  couponDiscount?: number
  manualDiscount?: number
  loyaltyDiscount?: number
  tipAmount?: number
  currency?: string
  roundTotal?: boolean
}

export interface OrderTotals {
  subtotal: number
  discountTotal: number
  loyaltyDiscount: number
  taxableBase: number
  serviceCharge: number
  taxTotal: number
  tipAmount: number
  roundingAdj: number
  grandTotal: number
}

/**
 * Computes an order's totals.
 *
 * Order of operations: discounts reduce the taxable base, service charge is
 * levied on the discounted base, and tax applies to base + service charge —
 * which is the standard treatment for restaurant billing.
 */
export function computeTotals(input: TotalsInput): OrderTotals {
  const subtotal = input.lines.reduce((total, line) => total + line.lineTotal, 0)

  const requestedDiscount = (input.couponDiscount ?? 0) + (input.manualDiscount ?? 0)
  const discountTotal = Math.min(Math.max(0, requestedDiscount), subtotal)

  const loyaltyDiscount = Math.min(
    Math.max(0, input.loyaltyDiscount ?? 0),
    subtotal - discountTotal,
  )

  const taxableBase = subtotal - discountTotal - loyaltyDiscount
  const serviceCharge = applyBps(taxableBase, input.serviceChargeBps)

  let taxTotal: number
  if (input.taxInclusive) {
    // Prices already contain tax — back it out for reporting.
    const gross = taxableBase + serviceCharge
    taxTotal = gross - Math.round((gross * 10_000) / (10_000 + input.taxRateBps))
  } else {
    taxTotal = applyBps(taxableBase + serviceCharge, input.taxRateBps)
  }

  const tipAmount = Math.max(0, input.tipAmount ?? 0)

  const beforeRounding =
    taxableBase + serviceCharge + (input.taxInclusive ? 0 : taxTotal) + tipAmount

  const { total, adjustment } = input.roundTotal
    ? roundToNearestMajor(beforeRounding, input.currency ?? 'INR')
    : { total: beforeRounding, adjustment: 0 }

  return {
    subtotal,
    discountTotal,
    loyaltyDiscount,
    taxableBase,
    serviceCharge,
    taxTotal,
    tipAmount,
    roundingAdj: adjustment,
    grandTotal: total,
  }
}

// ── loyalty ──────────────────────────────────────────────────────────────────

/** Points earned on a settled order. */
export function pointsEarned(grandTotal: number, earnRateX100: number, currencyFactor = 100): number {
  if (earnRateX100 <= 0) return 0
  const majorUnits = grandTotal / currencyFactor
  return Math.floor((majorUnits * earnRateX100) / 100)
}

/** Currency value of redeeming `points`, capped at the redeemable ceiling. */
export function pointsValue(points: number, pointValueMinor: number): number {
  return Math.max(0, Math.floor(points) * pointValueMinor)
}

/** Guests may settle at most half a bill with points. */
export const MAX_LOYALTY_SHARE_BPS = 5_000

export function maxRedeemablePoints(
  subtotal: number,
  availablePoints: number,
  pointValueMinor: number,
): number {
  if (pointValueMinor <= 0) return 0
  const ceiling = applyBps(subtotal, MAX_LOYALTY_SHARE_BPS)
  return Math.max(0, Math.min(availablePoints, Math.floor(ceiling / pointValueMinor)))
}

// ── misc presentation helpers ────────────────────────────────────────────────

export const SPICE_LABELS: Record<SpiceLevel, string> = {
  NONE: 'Not spicy',
  MILD: 'Mild',
  MEDIUM: 'Medium',
  HOT: 'Hot',
  EXTRA_HOT: 'Extra hot',
}

/** Kitchen ETA: the longest single item plus a small buffer per extra item. */
export function estimatePrepMinutes(
  items: Array<{ prepTimeMinutes: number; quantity: number }>,
  activeOrders = 0,
): number {
  if (!items.length) return 0
  const longest = Math.max(...items.map((item) => item.prepTimeMinutes))
  const extra = Math.ceil(items.reduce((n, item) => n + item.quantity, 0) / 4) * 2
  const queue = Math.min(activeOrders * 2, 20)
  return Math.min(90, longest + extra + queue)
}

export type MenuFood = Food
