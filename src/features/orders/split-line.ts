/**
 * "Two pizzas — one of them less spicy."
 *
 * ── The thing this exists for ───────────────────────────────────────────────
 *
 * A cart collapses identical dishes: tap Pizza twice and you get one line of
 * two, which is right, because two identical pizzas ARE one line. The moment
 * one of them differs it stops being right, and the guest saying so is the
 * ordinary case rather than the exception — "same again but no onions" is how
 * people order.
 *
 * The guest's own menu has always handled this, because every dish opens a
 * sheet with a notes box before it is added. The two STAFF tills did not: they
 * add a dish with no option groups straight to the cart, deliberately, because
 * a dialog in front of a cashier with nothing in it but a Confirm button is how
 * a till gets slow. That trade is worth keeping — so the answer is not to slow
 * the add, it is to make the LINE editable afterwards, which is also where the
 * conversation actually happens.
 *
 * ── Why a split and not an edit ─────────────────────────────────────────────
 *
 * Editing a line of two would change both pizzas. What the cashier means is
 * "one of these two is different", so one unit moves out of the original line
 * and into a new one carrying the note. Take every unit and the original line
 * simply becomes the new one, which is the same operation with nothing left
 * behind rather than a special case.
 *
 * Kept out of the components because both tills need exactly this arithmetic
 * and two copies is how they come to disagree about the edge cases — taking
 * every unit, splitting onto a line that already exists, and a note that turns
 * out to match a line already in the cart.
 */

export interface SplittableLine<T> {
  key: string
  quantity: number
  line: T
}

/**
 * Move `quantity` units out of `sourceKey` onto a line described by `nextKey`.
 *
 * `merge` is called when the destination already exists — splitting a pizza
 * onto "no onions" when another "no onions" pizza is already in the cart must
 * add to it, not create a second identical line, or the cart grows a duplicate
 * that the collapse rule would never have produced.
 */
export function splitLine<T extends { key: string; quantity: number }>(
  lines: T[],
  params: {
    sourceKey: string
    /** How many units move. Clamped to what the source actually has. */
    quantity: number
    /** The key the moved units will live under. */
    nextKey: string
    /** Build the new line, when the destination does not exist yet. */
    create: (moved: number) => T
    /** Fold the moved units into an existing destination line. */
    merge: (existing: T, moved: number) => T
  },
): T[] {
  const source = lines.find((line) => line.key === params.sourceKey)
  if (!source) return lines

  const moved = Math.max(1, Math.min(params.quantity, source.quantity))

  /*
   * Splitting a line onto its own key is a no-op, not a doubling.
   *
   * It happens whenever a cashier opens the dialog and confirms without
   * changing anything, which is a perfectly ordinary thing to do — and
   * without this guard the units would be added to the line they were taken
   * from and the cart would quietly grow.
   */
  if (params.nextKey === params.sourceKey) return lines

  const remaining = source.quantity - moved
  const destination = lines.find((line) => line.key === params.nextKey)

  let out = lines
    .map((line) =>
      line.key === params.sourceKey ? { ...line, quantity: remaining } : line,
    )
    // A line nothing is left on is gone, not a zero sitting in the cart.
    .filter((line) => line.quantity > 0)

  if (destination) {
    out = out.map((line) =>
      line.key === params.nextKey ? params.merge(line, moved) : line,
    )
  } else {
    /*
     * Placed where the original was, not at the end.
     *
     * A cashier reading the order back to a guest follows the order they rang
     * it in; sending the split half to the bottom of a twelve-line bill means
     * the two pizzas are no longer next to each other on the screen they are
     * reading from.
     */
    const at = lines.findIndex((line) => line.key === params.sourceKey)
    const insertAt = remaining > 0 ? at + 1 : at
    out = [...out.slice(0, insertAt), params.create(moved), ...out.slice(insertAt)]
  }

  return out
}
