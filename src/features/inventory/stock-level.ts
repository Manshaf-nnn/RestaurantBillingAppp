import type { StockAlertLevel } from '@prisma/client'

/**
 * How healthy one item's balance is.
 *
 * ── Why this is not in `alerts.ts` ──────────────────────────────────────────
 *
 * It was, and `alerts.ts` is `server-only`, so the stock list could not reach
 * it and wrote its own rule instead: `quantity <= reorderLevel`. That is true
 * for `0 <= 0`, so every item sitting at zero with no threshold set — which is
 * every item the moment it is created — was badged "Low" permanently. Two
 * definitions of the same word, and the one on the busiest screen was the wrong
 * one.
 *
 * A pure function of numbers has no business being server-only. It lives here
 * so the list, the reports and the alert feed all answer the question the same
 * way; `alerts.ts` re-exports it so existing importers do not move.
 *
 * ── The order of the checks is the logic ────────────────────────────────────
 *
 * Nothing on the shelf is OUT OF STOCK, never "low" — including a negative
 * balance, which means the books are wrong rather than that the shelf is nearly
 * empty. LOW only means something once somebody has said what low is, hence
 * `floor > 0`. OVERSTOCK needs a par level for the same reason.
 */
export function levelFor(item: {
  quantity: number
  reorderLevel: number
  minStock: number
  maxStock: number | null
}): StockAlertLevel | null {
  if (item.quantity <= 0) return 'OUT_OF_STOCK'
  const floor = alertThreshold(item)
  if (floor > 0 && item.quantity <= floor) return 'LOW_STOCK'
  if (item.maxStock && item.maxStock > 0 && item.quantity > item.maxStock) return 'OVERSTOCK'
  return null
}

/**
 * The single low-stock threshold, from the two columns that carry it.
 *
 * The item form used to ask for a "Reorder level" and a "Minimum stock" and
 * then explain that the higher of the two wins — a question about the software
 * rather than about the business. It now asks once and writes both, and every
 * reader takes the max, which also merges the pair sensibly for items created
 * before the change.
 */
export function alertThreshold(item: { reorderLevel: number; minStock: number }): number {
  return Math.max(item.reorderLevel, item.minStock)
}
