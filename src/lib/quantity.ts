/**
 * Quantity arithmetic.
 *
 * Money is exact — integer minor units, see `money.ts`. Quantities are not:
 * they are Float, because a recipe legitimately calls for 0.375 kg and a
 * delivery legitimately arrives as 12.5 litres, and there is no unit small
 * enough to make every kitchen measure an integer. Float multiplication and
 * division therefore drift, and `roundQty` is where that drift is cut off.
 *
 * ── Why six places ──────────────────────────────────────────────────────────
 *
 * Six is far finer than any kitchen scale, so it never loses a real
 * measurement, and it is coarse enough to absorb the 1e-15 residue that unit
 * conversion and recipe scaling produce. The ledger's replay check compares
 * cached balance against the sum of movements with a 1e-6 tolerance, so the
 * rounding precision and the equality tolerance are deliberately the same
 * number — round finer than you compare and the replay starts reporting drift
 * that is not there.
 *
 * ── Why it lives here ───────────────────────────────────────────────────────
 *
 * This function was copy-pasted, character for character, into twelve feature
 * modules: the ledger, units, depletion, batches, location stock, stock
 * counts, the recipe resolver, traceability, transfers, production, purchasing
 * queries and purchase suggestions. Every one of them is arithmetic on the
 * SAME quantities, and the balance a movement writes has to agree with the
 * conversion that produced it and with the replay that checks it. Twelve
 * copies meant twelve chances for those to stop agreeing — change the
 * precision in one and the ledger silently disagrees with its own audit.
 *
 * Percentages are a different problem with a different answer: they are
 * rounded to two places for display and are never summed back into a balance.
 * `roundPercent` is separate for exactly that reason — the two must not be
 * confused again.
 */

/** The precision quantities are held to, and compared at. */
export const QTY_PRECISION = 1e6

/** Cut Float drift off a quantity. Six decimal places. */
export function roundQty(value: number): number {
  return Math.round(value * QTY_PRECISION) / QTY_PRECISION
}

/**
 * Do two quantities mean the same measurement?
 *
 * The tolerance matches `roundQty`'s precision on purpose: two values that
 * round to the same six places are the same quantity, whatever their Float
 * representations look like.
 */
export function sameQty(a: number, b: number): boolean {
  return Math.abs(a - b) < 1 / QTY_PRECISION
}

/**
 * Round a percentage for display. Two places.
 *
 * Deliberately NOT `roundQty`. A percentage is a presented ratio — a food-cost
 * percent, a margin, a share of cost — and nothing sums it back into a stored
 * balance, so two places is right and coarser than quantities on purpose.
 */
export function roundPercent(value: number): number {
  return Math.round(value * 100) / 100
}
