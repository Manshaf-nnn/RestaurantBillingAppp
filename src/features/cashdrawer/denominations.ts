import { minorUnitFactor } from '@/lib/money'

/**
 * The notes and coins a cashier physically counts (correctionA.md §4).
 *
 * ── Why this is derived from the currency ──────────────────────────────────
 *
 * §4 lists 5000 / 2000 / 1000 / 500 / 100 / 50 / 20 / 10 / 5, which is Sri
 * Lankan money. `Restaurant.currency` defaults to INR and this app is
 * deployed for more than one country, so hardcoding that list would hand an
 * Indian restaurant a 2000 note it has and a 5000 note it does not, and a
 * cashier reconciling against a denomination that does not exist has to be
 * told to ignore a row — which is how a count starts being done on paper.
 *
 * Not a settings screen either. §12 asks for no unnecessary settings, and
 * "which notes exist in this country" is not a business decision an owner
 * should have to make: it is a fact about their currency. A currency nobody
 * has listed falls back to a reasonable ladder rather than to nothing, so a
 * new market gets a usable count on day one and a better one when somebody
 * adds four lines here.
 *
 * ── Values are in MINOR units ──────────────────────────────────────────────
 *
 * Everything else about money in this codebase is, and a denomination list
 * that quietly used major units would be the one place a multiplication is
 * off by a hundred — in the exact arithmetic that decides whether a drawer
 * balances.
 */

export interface Denomination {
  /** Face value in minor units. */
  value: number
  /** What it says on the note or coin, in major units. */
  label: string
  kind: 'note' | 'coin'
}

/** Face values in MAJOR units, largest first. */
const BY_CURRENCY: Record<string, { notes: number[]; coins: number[] }> = {
  LKR: { notes: [5000, 1000, 500, 100, 50, 20], coins: [10, 5, 2, 1] },
  INR: { notes: [500, 200, 100, 50, 20, 10], coins: [20, 10, 5, 2, 1] },
  USD: { notes: [100, 50, 20, 10, 5, 1], coins: [0.25, 0.1, 0.05, 0.01] },
  EUR: { notes: [500, 200, 100, 50, 20, 10, 5], coins: [2, 1, 0.5, 0.2, 0.1, 0.05] },
  GBP: { notes: [50, 20, 10, 5], coins: [2, 1, 0.5, 0.2, 0.1, 0.05] },
  AED: { notes: [1000, 500, 200, 100, 50, 20, 10, 5], coins: [1, 0.5, 0.25] },
  AUD: { notes: [100, 50, 20, 10, 5], coins: [2, 1, 0.5, 0.2, 0.1, 0.05] },
}

/**
 * A ladder for a currency nobody has listed.
 *
 * Deliberately plausible rather than correct: it is better for a cashier in a
 * new market to count against approximately the right notes and for somebody
 * to fix the list, than for the count box to be empty and the feature to look
 * broken on the first day it is used.
 */
const FALLBACK = { notes: [1000, 500, 100, 50, 20, 10], coins: [5, 2, 1] }

export function denominationsFor(currency: string): Denomination[] {
  const set = BY_CURRENCY[currency?.toUpperCase()] ?? FALLBACK
  const factor = minorUnitFactor(currency)

  const build = (values: number[], kind: 'note' | 'coin'): Denomination[] =>
    values.map((face) => ({
      value: Math.round(face * factor),
      // Trailing zeros dropped: "0.5" reads as a coin, "0.50" reads as money
      // somebody has formatted, and these are labels on a counting grid.
      label: String(face),
      kind,
    }))

  return [...build(set.notes, 'note'), ...build(set.coins, 'coin')]
    // Largest first, because that is the order cash is counted in — and a
    // duplicate face value across notes and coins (₹10 and ₹20 are both) is
    // kept, because a cashier really does hold both.
    .sort((a, b) => b.value - a.value)
}

/** What was counted, from how many of each. */
export function totalFromCounts(
  currency: string,
  counts: Record<string, number>,
): number {
  return denominationsFor(currency).reduce((sum, denomination) => {
    const count = counts[String(denomination.value)] ?? 0
    return sum + denomination.value * (Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0)
  }, 0)
}

/**
 * A count with nothing invented in it.
 *
 * Only keys the currency actually has, only whole non-negative numbers.
 * Without this, a hand-made request can post `{"999999999": 1}` and the
 * drawer's physical total becomes whatever the sender chose — which is the
 * one number in this flow that must come from counting.
 */
export function sanitiseCounts(
  currency: string,
  counts: Record<string, unknown>,
): Record<string, number> {
  const known = new Set(denominationsFor(currency).map((d) => String(d.value)))
  const clean: Record<string, number> = {}
  for (const [key, raw] of Object.entries(counts ?? {})) {
    if (!known.has(key)) continue
    const count = Number(raw)
    if (!Number.isFinite(count) || count <= 0) continue
    clean[key] = Math.trunc(count)
  }
  return clean
}
