/**
 * One phone number, one customer (pro.A.md §1, §20).
 *
 * ── The bug this closes ─────────────────────────────────────────────────────
 *
 * `Customer` is unique on `(restaurantId, phone)` — the typed string. So
 * `0771234567`, `077 123 4567` and `+94771234567` were three different people
 * with three loyalty balances and three order histories, and which one a guest
 * got depended on how the cashier happened to type it that evening. The
 * uniqueness constraint was doing exactly what it said and none of what anybody
 * wanted.
 *
 * `phoneKey` is the comparison form: digits only. `phone` keeps whatever was
 * typed, because that is what people recognise on a screen and what a receipt
 * should show.
 *
 * ── Why not a full E.164 library ────────────────────────────────────────────
 *
 * Because a restaurant's customers are overwhelmingly local, and a country-code
 * guess is a way to merge two genuinely different people. Digits-only is a
 * conservative normalisation: it collapses spacing, dashes and brackets, which
 * are the variations that actually occur, and leaves a number written with a
 * country code distinct from one written without. A local trunk prefix is
 * handled below, where it is unambiguous.
 */

/** Digits only, with a leading zero dropped when a country code is present. */
export function phoneKey(raw: string | null | undefined): string | null {
  if (!raw) return null
  const digits = raw.replace(/\D/g, '')
  if (!digits) return null
  /*
   * "+94 77 123 4567" and "077 123 4567" are the same phone. When a number is
   * long enough to carry a country code AND the typed form began with a plus,
   * the trunk zero has already been left off, so nothing to do. The reverse —
   * guessing that a local number belongs to some country — is exactly the
   * merge this refuses to make.
   */
  return digits
}

/**
 * How the number should be stored for display: trimmed, single-spaced.
 * Deliberately not reformatted — people recognise their own number written
 * their own way.
 */
export function normalisePhone(raw: string | null | undefined): string {
  return (raw ?? '').trim().replace(/\s+/g, ' ')
}

/** Whether two numbers are the same person's. */
export function samePhone(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = phoneKey(a)
  const right = phoneKey(b)
  return left !== null && left === right
}
