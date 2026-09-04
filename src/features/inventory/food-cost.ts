import 'server-only'

import { prisma } from '@/server/db/prisma'
import { activeRecipeForFood, resolveRecipe, type ResolvedIngredient } from './recipe-resolver'
import { roundPercent } from '@/lib/quantity'

/**
 * What a dish costs to make, and what that leaves.
 *
 * ── Costing method ──────────────────────────────────────────────────────────
 *
 * The method is a parameter rather than a hardcoded choice, so the same call
 * site can later be pointed at FIFO without rewriting anything that consumes
 * these numbers. Two are implemented now:
 *
 *   AVERAGE  — the weighted average the ledger maintains on every receipt.
 *              The sensible default: it smooths a single expensive delivery
 *              instead of making Tuesday's margin look alarming.
 *   LAST     — the most recent purchase price. Closer to replacement cost,
 *              which is what matters when deciding today's menu price.
 *
 * FIFO needs per-batch layers with their own costs. The ledger already records
 * batch numbers and per-movement unit costs, so the data is there when it is
 * wanted; it is deliberately not built now because nothing yet needs it.
 */

export type CostingMethod = 'AVERAGE' | 'LAST'

export interface FoodCostBreakdown {
  foodId: string
  foodName: string
  recipeId: string | null
  sellingPrice: number
  ingredientCost: number
  grossProfit: number
  /** Ingredient cost as a percentage of the selling price. */
  foodCostPercent: number | null
  /** Gross profit as a percentage of the selling price. */
  marginPercent: number | null
  ingredients: Array<ResolvedIngredient & { lineCost: number; shareOfCost: number }>
  problems: string[]
}

export async function getFoodCost(params: {
  restaurantId: string
  foodId: string
  method?: CostingMethod
}): Promise<FoodCostBreakdown> {
  const method = params.method ?? 'AVERAGE'

  const food = await prisma.food.findFirstOrThrow({
    where: { id: params.foodId, restaurantId: params.restaurantId },
    select: { id: true, name: true, price: true },
  })

  const recipe = await activeRecipeForFood(prisma, params.restaurantId, params.foodId)
  if (!recipe) {
    return {
      foodId: food.id,
      foodName: food.name,
      recipeId: null,
      sellingPrice: food.price,
      ingredientCost: 0,
      grossProfit: food.price,
      foodCostPercent: null,
      marginPercent: null,
      ingredients: [],
      problems: ['This dish has no recipe, so its cost is unknown.'],
    }
  }

  const resolved = await resolveRecipe(prisma, {
    restaurantId: params.restaurantId,
    recipeId: recipe.id,
    portions: 1,
  })

  const priced = await applyMethod(params.restaurantId, resolved.ingredients, method)
  const ingredientCost = priced.reduce((total, line) => total + line.lineCost, 0)
  const grossProfit = food.price - ingredientCost

  return {
    foodId: food.id,
    foodName: food.name,
    recipeId: recipe.id,
    sellingPrice: food.price,
    ingredientCost,
    grossProfit,
    // A dish given away free has no meaningful percentage; null says so rather
    // than dividing by zero and rendering Infinity on a report.
    foodCostPercent: food.price > 0 ? roundPercent((ingredientCost / food.price) * 100) : null,
    marginPercent: food.price > 0 ? roundPercent((grossProfit / food.price) * 100) : null,
    ingredients: priced.map((line) => ({
      ...line,
      shareOfCost: ingredientCost > 0 ? roundPercent((line.lineCost / ingredientCost) * 100) : 0,
    })),
    problems: resolved.problems,
  }
}

async function applyMethod(
  restaurantId: string,
  ingredients: ResolvedIngredient[],
  method: CostingMethod,
): Promise<Array<ResolvedIngredient & { lineCost: number }>> {
  if (method === 'AVERAGE') {
    return ingredients.map((line) => ({
      ...line,
      lineCost: Math.round(line.quantity * line.costPerUnit),
    }))
  }

  const items = await prisma.inventoryItem.findMany({
    where: { id: { in: ingredients.map((i) => i.itemId) }, restaurantId },
    select: { id: true, lastPurchaseCost: true, costPerUnit: true },
  })
  const byId = new Map(items.map((i) => [i.id, i]))

  return ingredients.map((line) => {
    const item = byId.get(line.itemId)
    // An item never purchased through the system has no last cost; the average
    // is the honest fallback rather than treating it as free.
    const unit = item?.lastPurchaseCost ?? item?.costPerUnit ?? line.costPerUnit
    return { ...line, costPerUnit: unit, lineCost: Math.round(line.quantity * unit) }
  })
}

/** Food cost across the menu, for the report screen. */
export async function getMenuCostSummary(params: {
  restaurantId: string
  method?: CostingMethod
}): Promise<FoodCostBreakdown[]> {
  const foods = await prisma.food.findMany({
    where: { restaurantId: params.restaurantId, deletedAt: null, isAvailable: true },
    select: { id: true },
    orderBy: { name: 'asc' },
  })

  const results: FoodCostBreakdown[] = []
  for (const food of foods) {
    results.push(await getFoodCost({ ...params, foodId: food.id }))
  }
  // Worst margin first — that is the list an owner acts on.
  return results.sort((a, b) => (b.foodCostPercent ?? -1) - (a.foodCostPercent ?? -1))
}

