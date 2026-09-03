/**
 * The what-if arithmetic (acCal.md §12), kept apart from the query so the
 * browser can recompute as the accountant types — and so the numbers on the
 * screen come from the same function the test proves.
 *
 * Client-safe: pure functions and types, no database, no writes.
 */

export interface WhatIfDish {
  foodId: string
  name: string
  /** How much of the ingredient one portion uses, incl. its wastage margin. */
  quantityPerDish: number
  unitsSold: number
  revenue: number
  currentCogs: number
  currentMarginPercent: number | null
}

export interface WhatIfInput {
  itemId: string
  itemName: string
  unit: string
  currentUnitCost: number
  dishes: WhatIfDish[]
  /** Units of the ingredient the period's sales consumed. */
  totalUnitsUsed: number
  rangeLabel: string
}

/**
 * What a new ingredient price would have done, at the sales that actually
 * happened: extra cost = units sold × quantity per dish × the price change.
 */
export function projectImpact(input: WhatIfInput, newUnitCost: number) {
  const delta = newUnitCost - input.currentUnitCost
  const dishes = input.dishes.map((dish) => {
    const extraPerDish = Math.round(dish.quantityPerDish * delta)
    const extraTotal = Math.round(dish.quantityPerDish * dish.unitsSold * delta)
    const newCogs = dish.currentCogs + extraTotal
    return {
      ...dish,
      extraPerDish,
      extraTotal,
      newCogs,
      newMarginPercent:
        dish.revenue > 0 ? Math.round(((dish.revenue - newCogs) / dish.revenue) * 1000) / 10 : null,
    }
  })
  const totalExtra = dishes.reduce((sum, dish) => sum + dish.extraTotal, 0)
  const revenue = dishes.reduce((sum, dish) => sum + dish.revenue, 0)
  const currentProfit = dishes.reduce((sum, dish) => sum + (dish.revenue - dish.currentCogs), 0)
  return {
    delta,
    dishes,
    totalExtra,
    revenue,
    currentProfit,
    newProfit: currentProfit - totalExtra,
    newMarginPercent:
      revenue > 0 ? Math.round(((currentProfit - totalExtra) / revenue) * 1000) / 10 : null,
  }
}
