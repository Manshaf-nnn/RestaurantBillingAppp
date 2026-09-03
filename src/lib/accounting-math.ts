import { BPS_DENOMINATOR, applyBps } from '@/lib/money'

/**
 * The calculator's math (acCal.md §2) — pure, client-safe, and in the house
 * units: money in integer minor units, rates in basis points. Every function
 * here mirrors how the billing engine itself computes, so the calculator can
 * never disagree with a real bill.
 *
 * Division returns null when the denominator is zero — the UI shows a dash,
 * never NaN, never a made-up number.
 */

/** Add tax on top of a net amount (tax-exclusive pricing). */
export function taxOnNet(net: number, rateBps: number): { tax: number; gross: number } {
  const tax = applyBps(net, rateBps)
  return { tax, gross: net + tax }
}

/**
 * Pull the tax out of a tax-inclusive amount. Identity: for any net,
 * taxInGross(taxOnNet(net, r).gross, r).net === net (up to rounding, proven
 * by calc-math-test).
 */
export function taxInGross(gross: number, rateBps: number): { net: number; tax: number } {
  const net = Math.round((gross * BPS_DENOMINATOR) / (BPS_DENOMINATOR + rateBps))
  return { net, tax: gross - net }
}

/** A discount taken off an amount. */
export function discountOf(amount: number, rateBps: number): { off: number; after: number } {
  const off = applyBps(amount, rateBps)
  return { off, after: amount - off }
}

/** Margin: profit as a share of the SELLING price, in bps. */
export function marginBps(revenue: number, cost: number): number | null {
  if (revenue === 0) return null
  return Math.round(((revenue - cost) * BPS_DENOMINATOR) / revenue)
}

/** Markup: profit as a share of the COST, in bps. */
export function markupBps(revenue: number, cost: number): number | null {
  if (cost === 0) return null
  return Math.round(((revenue - cost) * BPS_DENOMINATOR) / cost)
}

/** The selling price that gives a wanted margin on a cost. */
export function priceForMargin(cost: number, wantedMarginBps: number): number | null {
  if (wantedMarginBps >= BPS_DENOMINATOR) return null
  return Math.round((cost * BPS_DENOMINATOR) / (BPS_DENOMINATOR - wantedMarginBps))
}

/** The selling price that gives a wanted markup on a cost. */
export function priceForMarkup(cost: number, wantedMarkupBps: number): number {
  return Math.round((cost * (BPS_DENOMINATOR + wantedMarkupBps)) / BPS_DENOMINATOR)
}

/** 40% margin is a 66.7% markup — the two words are not the same number. */
export function marginToMarkup(bps: number): number | null {
  if (bps >= BPS_DENOMINATOR) return null
  return Math.round((bps * BPS_DENOMINATOR) / (BPS_DENOMINATOR - bps))
}

export function markupToMargin(bps: number): number {
  return Math.round((bps * BPS_DENOMINATOR) / (BPS_DENOMINATOR + bps))
}

/** Food cost: ingredient cost as a share of revenue, in bps. */
export function foodCostBps(cogs: number, revenue: number): number | null {
  if (revenue === 0) return null
  return Math.round((cogs * BPS_DENOMINATOR) / revenue)
}

/** What percentage is `part` of `whole`, in bps. */
export function shareBps(part: number, whole: number): number | null {
  if (whole === 0) return null
  return Math.round((part * BPS_DENOMINATOR) / whole)
}

/**
 * Manual-rate currency conversion. The rate is fixed-point micro-units
 * (rate × 1,000,000) so 291.7350 LKR/USD is exact; TableFlow never fetches
 * exchange rates — the accountant types the rate they were quoted.
 */
export function toRateMicro(rate: number): number {
  return Math.round(rate * 1_000_000)
}

export function convertAtRate(amount: number, rateMicro: number): number {
  return Math.round((amount * rateMicro) / 1_000_000)
}
