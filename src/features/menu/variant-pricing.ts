import type { VariantKind } from '@prisma/client'

/**
 * What a size actually costs, versus what is stored.
 *
 * ── Two different questions ─────────────────────────────────────────────────
 *
 * `VariantOption.priceDelta` holds a DIFFERENCE from the dish's own price: a
 * full portion of an Rs 850 rice is stored as `+550`. That is the right thing
 * to store — a price rise on the dish carries every portion with it, an offer
 * price applies to all of them, and there is one number to change rather than
 * three.
 *
 * It is the wrong thing to SHOW. Nobody prints "Full +550" on a menu, and an
 * owner asked "what do we charge for a full portion" should not have to add two
 * numbers together. `menuelogic.md` writes it the way people say it:
 *
 *     Normal — Rs. 850
 *     Full   — Rs. 1,400
 *
 * So the storage stays a delta and every screen reads an absolute. These two
 * functions are the only place that conversion happens, which is what stops the
 * editor, the guest sheet and the till from disagreeing about the same dish.
 *
 * ── Sizes and add-ons are shown differently, on purpose ─────────────────────
 *
 * A `VARIANT` REPLACES the price — choosing Full instead of Normal means the
 * dish costs Rs 1,400, not Rs 850 plus something. An `ADDON` genuinely is an
 * extra on top: extra cheese is `+Rs 300` however large the pizza. So one reads
 * as a price and the other as an addition, and `kind` already tells them apart.
 * `labelForOption` is the single rule.
 */

/** The price a guest pays for this option, given the dish's own price. */
export function absolutePrice(basePrice: number, priceDelta: number): number {
  return basePrice + priceDelta
}

/**
 * The delta to store, given a price somebody typed.
 *
 * May be negative, and that is not an error: a half portion priced below the
 * dish's own price is exactly how "Half / Full" is expressed when Full is the
 * headline price. The column is signed for this reason.
 */
export function deltaFor(basePrice: number, absolute: number): number {
  return Math.round(absolute) - Math.round(basePrice)
}

/**
 * Does this group replace the price, or add to it?
 *
 * Single-select variants replace; add-ons and any multi-select group add. A
 * `VARIANT` group with `maxSelect > 1` is a strange thing to configure, but if
 * somebody does, two selections cannot each *be* the price — so it reads as
 * additive, which is the only arithmetic that makes sense.
 */
export function replacesPrice(group: { kind: VariantKind | string; maxSelect: number }): boolean {
  return group.kind === 'VARIANT' && group.maxSelect <= 1
}

/**
 * The lowest price a dish can be bought at, and how many sizes it comes in.
 *
 * What a menu card needs to say "from Rs 850 · 2 sizes" instead of printing one
 * price whether the dish has three sizes or none. A guest has no reason to open
 * a sheet they do not know contains a choice.
 *
 * Only required single-select groups count. An optional group has a "choose
 * nothing" path, so the dish really does start at its own price, and add-ons
 * can only push it up — neither changes the number a card should lead with.
 */
export function priceRange(
  basePrice: number,
  groups: Array<{
    kind: VariantKind | string
    isRequired: boolean
    maxSelect: number
    options: Array<{ priceDelta: number; isAvailable: boolean }>
  }>,
): { from: number; sizeCount: number } {
  let from = basePrice
  let sizeCount = 0

  for (const group of groups) {
    if (!group.isRequired || !replacesPrice(group)) continue
    const available = group.options.filter((option) => option.isAvailable)
    if (available.length === 0) continue

    /*
     * The cheapest choice becomes the dish's starting price, because a required
     * group means one of them WILL be picked — the dish cannot be had at its
     * own price. With two such groups the cheapest of each stack up, which is
     * why this adds the delta rather than replacing `from` outright.
     */
    const cheapest = Math.min(...available.map((option) => option.priceDelta))
    from += cheapest
    sizeCount += available.length
  }

  return { from, sizeCount: sizeCount > 1 ? sizeCount : 0 }
}

/**
 * How one option reads next to its name.
 *
 * Returns the absolute price for a size and a signed delta for an add-on. A
 * zero-delta add-on returns null — "Extra napkins +Rs 0" is noise, and the
 * option's name already says what it is.
 */
export function optionPriceLabel(
  option: { priceDelta: number },
  group: { kind: VariantKind | string; maxSelect: number },
  basePrice: number,
  money: (minor: number) => string,
): string | null {
  if (replacesPrice(group)) return money(absolutePrice(basePrice, option.priceDelta))
  if (option.priceDelta === 0) return null
  return `${option.priceDelta > 0 ? '+' : '−'}${money(Math.abs(option.priceDelta))}`
}
