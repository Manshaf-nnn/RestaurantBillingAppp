import 'server-only'

import type { DateRange } from '@/features/reports/range'
import type { WhatIfDish, WhatIfInput } from './what-if-math'
import { prisma } from '@/server/db/prisma'

/**
 * What-if (acCal.md §12): "if chicken goes from 800 to 900 a kilo, what
 * happens to profit?"
 *
 * READ ONLY, always. This module has no writes at all — not a single create
 * or update — because a simulation that can touch the books is not a
 * simulation. `what-if-test` asserts the row counts are unchanged after a
 * run, so that stays true.
 *
 * The maths is deliberately simple and stated on screen: for each dish whose
 * recipe uses the ingredient, extra cost = units sold × quantity per dish ×
 * the price change. It answers "at last period's sales mix", not "forever".
 */

export type { WhatIfDish, WhatIfInput } from './what-if-math'
export { projectImpact } from './what-if-math'

export async function getIngredientImpact(params: {
  restaurantId: string
  itemId: string
  range: DateRange
  branchIds?: string[] | null
}): Promise<WhatIfInput | null> {
  const { restaurantId, itemId, range, branchIds } = params

  const item = await prisma.inventoryItem.findFirst({
    where: { id: itemId, restaurantId },
    select: { id: true, name: true, unit: true, costPerUnit: true },
  })
  if (!item) return null

  // Every menu recipe that uses this ingredient directly.
  const ingredients = await prisma.recipeIngredient.findMany({
    where: {
      inventoryItemId: itemId,
      recipe: { restaurantId, foodId: { not: null } },
    },
    select: {
      quantity: true,
      wastagePercent: true,
      recipe: {
        select: {
          yieldQty: true,
          food: { select: { id: true, name: true } },
        },
      },
    },
  })
  if (ingredients.length === 0) {
    return {
      itemId: item.id,
      itemName: item.name,
      unit: item.unit,
      currentUnitCost: item.costPerUnit,
      dishes: [],
      totalUnitsUsed: 0,
      rangeLabel: range.label,
    }
  }

  const foodIds = ingredients
    .map((row) => row.recipe.food?.id)
    .filter((id): id is string => Boolean(id))

  // What those dishes actually sold in the period, priced as they sold.
  const sold = await prisma.orderItem.groupBy({
    by: ['foodId'],
    where: {
      foodId: { in: foodIds },
      status: { not: 'CANCELLED' },
      order: {
        restaurantId,
        status: { not: 'CANCELLED' },
        placedAt: { gte: range.from, lte: range.to },
        ...(branchIds ? { branchId: { in: branchIds } } : {}),
      },
    },
    _sum: { quantity: true, lineTotal: true },
  })
  const soldByFood = new Map(
    sold.map((row) => [
      row.foodId ?? '',
      { quantity: row._sum.quantity ?? 0, revenue: row._sum.lineTotal ?? 0 },
    ]),
  )

  // Line-level cost, so the current margin shown is the real one.
  //
  // costPrice is per UNIT, so this cannot be a groupBy sum — it has to be
  // multiplied by the quantity sold, the same way the profit report does it.
  const costRows = await prisma.orderItem.findMany({
    where: {
      foodId: { in: foodIds },
      status: { not: 'CANCELLED' },
      order: {
        restaurantId,
        status: { not: 'CANCELLED' },
        placedAt: { gte: range.from, lte: range.to },
        ...(branchIds ? { branchId: { in: branchIds } } : {}),
      },
    },
    select: { foodId: true, costPrice: true, quantity: true },
  })
  const costByFood = new Map<string, number>()
  for (const row of costRows) {
    const key = row.foodId ?? ''
    costByFood.set(key, (costByFood.get(key) ?? 0) + Math.round(row.costPrice * row.quantity))
  }

  const dishes: WhatIfDish[] = ingredients
    .map((row) => {
      const food = row.recipe.food
      if (!food) return null
      const yieldQty = row.recipe.yieldQty && row.recipe.yieldQty > 0 ? row.recipe.yieldQty : 1
      // Wastage margin is part of what a portion really consumes.
      const perDish = (row.quantity * (1 + (row.wastagePercent ?? 0) / 100)) / yieldQty
      const sales = soldByFood.get(food.id) ?? { quantity: 0, revenue: 0 }
      const cogs = costByFood.get(food.id) ?? 0
      return {
        foodId: food.id,
        name: food.name,
        quantityPerDish: perDish,
        unitsSold: sales.quantity,
        revenue: sales.revenue,
        currentCogs: cogs,
        currentMarginPercent:
          sales.revenue > 0 ? Math.round(((sales.revenue - cogs) / sales.revenue) * 1000) / 10 : null,
      }
    })
    .filter((row): row is WhatIfDish => row !== null)
    .sort((a, b) => b.unitsSold - a.unitsSold)

  return {
    itemId: item.id,
    itemName: item.name,
    unit: item.unit,
    currentUnitCost: item.costPerUnit,
    dishes,
    totalUnitsUsed: dishes.reduce((sum, dish) => sum + dish.quantityPerDish * dish.unitsSold, 0),
    rangeLabel: range.label,
  }
}
