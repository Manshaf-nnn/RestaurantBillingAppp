import type { FoodProfitRow } from '@/features/reports/profit'

/**
 * Menu Intelligence (smart.md §6) — the classic menu-engineering matrix
 * (Kasavana & Smith, 1982): every dish sold in the period is placed on two
 * axes, how many were sold and how much gross profit each one made.
 *
 *   ⭐ Star        popular AND profitable       — protect it
 *   💰 Workhorse   popular, thin margin         — re-cost or re-price
 *   💎 Hidden gem  unpopular, fat margin        — promote it
 *   ⚠️ Problem     unpopular AND thin           — fix or drop
 *
 * The thresholds are the ones the method itself uses: a dish is "popular"
 * when it sold at least 70% of the average dish's units, and "profitable"
 * when its gross profit per unit is at least the menu's weighted average.
 * Both come out of the profit report's own rows — nothing here invents a
 * number, and nothing is read from the database.
 *
 * Two honest extra classes: a dish whose cost is unknown (no recipe, no cost
 * snapshot) would otherwise show as a Star on 100% margin, so it is UNCOSTED
 * and left out of the averages; a dish on the menu that did not sell at all
 * is NOT_SOLD.
 */

export type MenuClass = 'STAR' | 'WORKHORSE' | 'HIDDEN_GEM' | 'PROBLEM' | 'UNCOSTED' | 'NOT_SOLD'

export const POPULARITY_FACTOR = 0.7

export interface MenuThresholds {
  /** Units sold at or above which a dish is "popular". */
  popularity: number
  /** Gross profit per unit (minor units) at or above which a dish is "profitable". */
  profitPerUnit: number
  /** Dishes the thresholds were computed from. */
  itemsSold: number
}

export interface ClassifiedFood extends FoodProfitRow {
  class: MenuClass
  /** COGS ÷ units sold, minor units; null when nothing sold or cost unknown. */
  unitCogs: number | null
  /** Gross profit ÷ units sold, minor units; null when nothing sold or cost unknown. */
  unitGrossProfit: number | null
  /** Revenue ÷ units sold — what the dish actually went out at, after options and discounts. */
  avgSoldPrice: number | null
}

const CLASS_ORDER: Record<MenuClass, number> = {
  STAR: 0, WORKHORSE: 1, HIDDEN_GEM: 2, PROBLEM: 3, UNCOSTED: 4, NOT_SOLD: 5,
}

export function classifyMenu(rows: FoodProfitRow[]): { thresholds: MenuThresholds; rows: ClassifiedFood[] } {
  const sold = rows.filter((row) => row.quantity > 0 && row.uncostedQuantity === 0)
  const units = sold.reduce((sum, row) => sum + row.quantity, 0)
  const grossProfit = sold.reduce((sum, row) => sum + row.grossProfit, 0)
  const popularity = sold.length > 0 ? (POPULARITY_FACTOR * units) / sold.length : 0
  const profitPerUnit = units > 0 ? grossProfit / units : 0

  const classified = rows.map((row): ClassifiedFood => {
    const costed = row.quantity > 0 && row.uncostedQuantity === 0
    const unitCogs = costed ? row.cogs / row.quantity : null
    const unitGrossProfit = costed ? row.grossProfit / row.quantity : null
    const avgSoldPrice = row.quantity > 0 ? Math.round(row.revenue / row.quantity) : null

    let cls: MenuClass
    if (row.quantity <= 0) cls = 'NOT_SOLD'
    else if (!costed) cls = 'UNCOSTED'
    else {
      const popular = row.quantity >= popularity
      const profitable = (unitGrossProfit ?? 0) >= profitPerUnit
      cls = popular ? (profitable ? 'STAR' : 'WORKHORSE') : profitable ? 'HIDDEN_GEM' : 'PROBLEM'
    }
    return { ...row, class: cls, unitCogs, unitGrossProfit, avgSoldPrice }
  })

  classified.sort((a, b) => CLASS_ORDER[a.class] - CLASS_ORDER[b.class] || b.grossProfit - a.grossProfit)

  return {
    thresholds: { popularity: Math.round(popularity * 10) / 10, profitPerUnit: Math.round(profitPerUnit), itemsSold: sold.length },
    rows: classified,
  }
}

/** Unit COGS moved this much vs the previous period → worth a flag. */
export const COGS_MOVE_PERCENT = 10
/** Margin moved this many points vs the previous period → worth a flag. */
export const MARGIN_MOVE_POINTS = 5
/** Today's recipe cost differs this much from what the sold lines actually cost → worth a flag. */
export const RECIPE_DRIFT_PERCENT = 10

/**
 * Profit Intelligence (smart.md §2): "highlight major cost/profit changes".
 * Plain sentences, each one derived from two numbers the reader can see.
 */
export function flagProfitChanges(
  current: ClassifiedFood,
  previous: FoodProfitRow | undefined,
  recipeCostNow: number | null,
): string[] {
  const flags: string[] = []

  if (current.quantity > 0 && current.uncostedQuantity > 0) {
    flags.push(
      current.uncostedQuantity === current.quantity
        ? 'cost unknown'
        : `${current.uncostedQuantity} of ${current.quantity} sold with no cost`,
    )
  }
  if (current.unitGrossProfit !== null && current.unitGrossProfit < 0) flags.push('sold below cost')

  const previousUnitCogs =
    previous && previous.quantity > 0 && previous.uncostedQuantity === 0 && previous.cogs > 0
      ? previous.cogs / previous.quantity
      : null
  if (current.unitCogs !== null && previousUnitCogs !== null) {
    const percent = ((current.unitCogs - previousUnitCogs) / previousUnitCogs) * 100
    if (Math.abs(percent) >= COGS_MOVE_PERCENT) {
      flags.push(`unit cost ${percent > 0 ? 'up' : 'down'} ${Math.abs(Math.round(percent))}%`)
    }
  }

  if (
    current.class !== 'UNCOSTED' &&
    current.grossMarginPercent !== null &&
    previous?.grossMarginPercent !== null &&
    previous?.grossMarginPercent !== undefined
  ) {
    const points = current.grossMarginPercent - previous.grossMarginPercent
    if (Math.abs(points) >= MARGIN_MOVE_POINTS) {
      flags.push(`margin ${points > 0 ? 'up' : 'down'} ${Math.abs(Math.round(points))} pts`)
    }
  }

  if (recipeCostNow !== null && recipeCostNow > 0 && current.unitCogs !== null && current.unitCogs > 0) {
    const percent = ((recipeCostNow - current.unitCogs) / current.unitCogs) * 100
    if (Math.abs(percent) >= RECIPE_DRIFT_PERCENT) {
      flags.push(`recipe now costs ${Math.abs(Math.round(percent))}% ${percent > 0 ? 'more' : 'less'} than these sold at`)
    }
  }

  return flags
}

export type BadgeTone = 'default' | 'secondary' | 'outline' | 'destructive' | 'success' | 'warning' | 'info' | 'solid'

export const CLASS_META: Record<MenuClass, { label: string; emoji: string; tone: BadgeTone; advice: string }> = {
  STAR: { label: 'Star', emoji: '⭐', tone: 'success', advice: 'Sells well and earns well. Keep it visible and keep the recipe steady.' },
  WORKHORSE: { label: 'Workhorse', emoji: '💰', tone: 'warning', advice: 'Sells well but earns little per plate. Re-cost the recipe or nudge the price.' },
  HIDDEN_GEM: { label: 'Hidden gem', emoji: '💎', tone: 'info', advice: 'Earns well but few order it. Put it where guests will see it.' },
  PROBLEM: { label: 'Problem', emoji: '⚠️', tone: 'destructive', advice: 'Few order it and it earns little. Fix the recipe, the price, or drop it.' },
  UNCOSTED: { label: 'Cost unknown', emoji: '❔', tone: 'secondary', advice: 'Sold without a recipe cost, so its profit cannot be judged. Add a recipe.' },
  NOT_SOLD: { label: 'Not sold', emoji: '—', tone: 'outline', advice: 'On the menu but nobody ordered it in this period.' },
}
