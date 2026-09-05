import type { StockUnit } from '@prisma/client'

import { formatQuantity } from '@/features/inventory/units'
import { roundQty } from '@/lib/quantity'

/**
 * Smart Inventory maths (smart.md §4): how fast an item is being used, how
 * long what is on the shelf will last, and how much to order.
 *
 * Client-safe and pure — the numbers come in, the answers go out, nothing is
 * read or written. The server side (`queries.ts`) feeds it from the stock
 * ledger: "usage" is what left stock through trade — sales, kitchen
 * consumption, and what went into prepared items — net of sale reversals.
 * Waste, transfers and hand adjustments are deliberately NOT usage: they say
 * nothing about how fast the kitchen goes through an ingredient.
 *
 * The window is 28 days (four full weeks, so weekday and weekend patterns
 * both appear), clipped to the item's own first movement so a product that
 * arrived last Tuesday is not averaged over days it did not exist.
 *
 * The reorder rule never re-implements the threshold rule that already lives
 * in `purchasing/suggestions.ts`: it takes that suggestion as given and only
 * raises it when the usage rate says the shelf will not last until the next
 * delivery plus a week of cover.
 */

export const USAGE_WINDOW_DAYS = 28
/** Days of stock to hold beyond the supplier's lead time. */
export const COVER_DAYS = 7
export const DAY_MS = 86_400_000

/** Movement types that count as usage. SALE_REVERSAL is positive and nets out. */
export const USAGE_TYPES = ['SALE', 'CONSUMPTION', 'PRODUCTION_CONSUMPTION', 'SALE_REVERSAL'] as const

export interface UsageInput {
  /** −Σ signed quantity over USAGE_TYPES in the window, base units. */
  used: number
  windowStart: Date
  now: Date
  /** MIN(createdAt) over every movement of the item, or null when it has none. */
  firstMovementAt: Date | null
  /** What is on the shelf now — the branch shelf, or the restaurant total. */
  available: number
}

export interface UsageStats {
  /** Days the average is taken over: the window, or less for a newer item. Never below 1. */
  observedDays: number
  /** Base units per day. */
  avgDailyUsage: number
  /** available ÷ avgDailyUsage, one decimal. Null when nothing was used; 0 when the shelf is empty. */
  daysRemaining: number | null
}

export function computeUsage(input: UsageInput): UsageStats {
  const start = Math.max(
    input.windowStart.getTime(),
    input.firstMovementAt ? input.firstMovementAt.getTime() : input.windowStart.getTime(),
  )
  const observedDays = Math.max(1, (input.now.getTime() - start) / DAY_MS)
  const avgDailyUsage = roundQty(Math.max(0, input.used) / observedDays)
  const daysRemaining =
    avgDailyUsage <= 0
      ? null
      : input.available <= 0
        ? 0
        : Math.round((input.available / avgDailyUsage) * 10) / 10
  return { observedDays, avgDailyUsage, daysRemaining }
}

export interface ReorderInput {
  available: number
  avgDailyUsage: number
  /** SupplierItem.leadTimeDays via the reorder suggestion, else null (treated as 0). */
  leadTimeDays: number | null
  /** `getReorderSuggestions().suggestedQty` for this item, else null. Already honours minOrderQty. */
  thresholdSuggestedQty: number | null
  /** InventoryItem.unitsPerPurchaseUnit — the order is rounded UP to whole purchase units when set. */
  unitsPerPurchaseUnit: number | null
}

export interface Recommendation {
  /** What the usage rate alone asks for, base units. */
  usageBasedQty: number
  /** What to order, base units, after the purchase-unit rounding. */
  recommendedQty: number
  /** Whole purchase units, when the item has a purchase pack size. */
  purchaseUnits: number | null
  basis: 'usage' | 'threshold' | 'none'
}

export function recommendReorder(input: ReorderInput): Recommendation {
  const need = input.avgDailyUsage * ((input.leadTimeDays ?? 0) + COVER_DAYS)
  const usageBasedQty = roundQty(Math.max(0, need - input.available))
  const threshold = input.thresholdSuggestedQty ?? 0
  const raw = Math.max(usageBasedQty, threshold)
  const basis: Recommendation['basis'] =
    raw <= 0 ? 'none' : usageBasedQty >= threshold ? 'usage' : 'threshold'

  const pack = input.unitsPerPurchaseUnit
  if (pack && pack > 0 && raw > 0) {
    // ceil with a hair of tolerance so an exact multiple is not pushed up by
    // floating-point noise (50 / 25 must be 2, not 3).
    const purchaseUnits = Math.ceil(raw / pack - 1e-9)
    return { usageBasedQty, recommendedQty: roundQty(purchaseUnits * pack), purchaseUnits, basis }
  }
  return { usageBasedQty, recommendedQty: roundQty(raw), purchaseUnits: null, basis }
}

export type StockOutlook = 'OUT' | 'URGENT' | 'SOON' | 'OK' | 'NO_USAGE'

export function outlookFor(stats: UsageStats, leadTimeDays: number | null): StockOutlook {
  if (stats.daysRemaining === null) return 'NO_USAGE'
  if (stats.daysRemaining <= 0) return 'OUT'
  const lead = leadTimeDays ?? 0
  if (stats.daysRemaining <= Math.max(2, lead)) return 'URGENT'
  if (stats.daysRemaining <= lead + COVER_DAYS) return 'SOON'
  return 'OK'
}

export const OUTLOOK_META: Record<StockOutlook, { label: string; tone: 'destructive' | 'warning' | 'success' | 'secondary' | 'outline' }> = {
  OUT: { label: 'Out of stock', tone: 'destructive' },
  URGENT: { label: 'Order now', tone: 'destructive' },
  SOON: { label: 'Order soon', tone: 'warning' },
  OK: { label: 'Fine', tone: 'success' },
  NO_USAGE: { label: 'No usage', tone: 'secondary' },
}

/** "Chicken: 0.6 days remaining — recommend ordering 50 kg". */
export function outlookSentence(
  name: string,
  unit: StockUnit,
  stats: UsageStats,
  recommendation: Recommendation,
): string {
  if (stats.daysRemaining === null) {
    return recommendation.recommendedQty > 0
      ? `${name}: no usage in the last ${USAGE_WINDOW_DAYS} days — below its reorder level, recommend ordering ${formatQuantity(recommendation.recommendedQty, unit)}`
      : `${name}: no usage in the last ${USAGE_WINDOW_DAYS} days`
  }
  const when =
    stats.daysRemaining === 0
      ? 'out of stock'
      : `${stats.daysRemaining} day${stats.daysRemaining === 1 ? '' : 's'} remaining`
  const action =
    recommendation.recommendedQty > 0
      ? `recommend ordering ${formatQuantity(recommendation.recommendedQty, unit)}`
      : 'stock is sufficient'
  return `${name}: ${when} — ${action}`
}
