import 'server-only'

import { prisma } from '@/server/db/prisma'
import { getFoodCost, type FoodCostBreakdown } from '@/features/inventory/food-cost'
import { levelFor } from '@/features/inventory/alerts'
import { resolveRecipe, activeRecipeForFood } from '@/features/inventory/recipe-resolver'

export interface RecipeRow {
  foodId: string
  foodName: string
  price: number
  hasRecipe: boolean
  ingredientCost: number
  foodCostPercent: number | null
  /** Worst stock level among the dish's ingredients, if any. */
  stockWarning: 'OUT_OF_STOCK' | 'LOW_STOCK' | null
  /** Ingredients that are out or low, for the tooltip. */
  shortIngredients: string[]
}

/**
 * The recipe overview.
 *
 * Sorted worst-margin first, because that is the list an owner acts on — the
 * dishes quietly losing money are the point of the screen, not an alphabetical
 * catalogue.
 *
 * Stock warnings are advisory. A dish whose ingredients have run out is
 * flagged, never auto-hidden: a kitchen often has stock the system has not been
 * told about, and silently removing a seller's best dish because a count is
 * stale does more damage than an inaccurate badge.
 */
export async function listRecipeRows(restaurantId: string): Promise<RecipeRow[]> {
  const foods = await prisma.food.findMany({
    where: { restaurantId, deletedAt: null },
    select: { id: true, name: true, price: true },
    orderBy: { name: 'asc' },
  })

  const rows: RecipeRow[] = []

  for (const food of foods) {
    const recipe = await activeRecipeForFood(prisma, restaurantId, food.id)
    if (!recipe) {
      rows.push({
        foodId: food.id, foodName: food.name, price: food.price, hasRecipe: false,
        ingredientCost: 0, foodCostPercent: null, stockWarning: null, shortIngredients: [],
      })
      continue
    }

    const resolved = await resolveRecipe(prisma, { restaurantId, recipeId: recipe.id, portions: 1 })

    const itemIds = resolved.ingredients.map((i) => i.itemId)
    const items = itemIds.length
      ? await prisma.inventoryItem.findMany({
          where: { id: { in: itemIds }, restaurantId },
          select: { id: true, name: true, quantity: true, reorderLevel: true, minStock: true, maxStock: true },
        })
      : []

    let warning: RecipeRow['stockWarning'] = null
    const short: string[] = []
    for (const item of items) {
      const level = levelFor(item)
      if (level === 'OUT_OF_STOCK') { warning = 'OUT_OF_STOCK'; short.push(item.name) }
      else if (level === 'LOW_STOCK') { if (warning !== 'OUT_OF_STOCK') warning = 'LOW_STOCK'; short.push(item.name) }
    }

    rows.push({
      foodId: food.id,
      foodName: food.name,
      price: food.price,
      hasRecipe: true,
      ingredientCost: resolved.totalCost,
      foodCostPercent: food.price > 0 ? Math.round((resolved.totalCost / food.price) * 10000) / 100 : null,
      stockWarning: warning,
      shortIngredients: short,
    })
  }

  return rows.sort((a, b) => (b.foodCostPercent ?? -1) - (a.foodCostPercent ?? -1))
}

export interface RecipeEditorData {
  food: { id: string; name: string; price: number }
  recipeId: string | null
  version: number
  isActive: boolean
  prepNotes: string | null
  lines: Array<{
    inventoryItemId: string | null
    subRecipeId: string | null
    name: string
    quantity: number
    unit: string
    wastagePercent: number
  }>
  cost: FoodCostBreakdown
  items: Array<{ id: string; name: string; unit: string; quantity: number }>
  prepRecipes: Array<{ id: string; name: string | null; yieldQty: number; yieldUnit: string | null }>
  currency: string
}

export async function getRecipeEditorData(params: {
  restaurantId: string
  foodId: string
  currency: string
}): Promise<RecipeEditorData> {
  const food = await prisma.food.findFirstOrThrow({
    where: { id: params.foodId, restaurantId: params.restaurantId },
    select: { id: true, name: true, price: true },
  })

  const recipe = await prisma.recipe.findFirst({
    where: { restaurantId: params.restaurantId, foodId: params.foodId, isActive: true, archivedAt: null },
    orderBy: { version: 'desc' },
    include: {
      ingredients: {
        orderBy: { sortOrder: 'asc' },
        include: {
          inventoryItem: { select: { id: true, name: true } },
          subRecipe: { select: { id: true, name: true } },
        },
      },
    },
  })

  const [items, prepRecipes, cost] = await Promise.all([
    prisma.inventoryItem.findMany({
      where: { restaurantId: params.restaurantId, isActive: true },
      select: { id: true, name: true, unit: true, quantity: true },
      orderBy: { name: 'asc' },
    }),
    prisma.recipe.findMany({
      where: { restaurantId: params.restaurantId, producesItemId: { not: null }, isActive: true },
      select: { id: true, name: true, yieldQty: true, yieldUnit: true },
      orderBy: { name: 'asc' },
    }),
    getFoodCost({ restaurantId: params.restaurantId, foodId: params.foodId }),
  ])

  return {
    food,
    recipeId: recipe?.id ?? null,
    version: recipe?.version ?? 0,
    isActive: recipe?.isActive ?? false,
    prepNotes: recipe?.prepNotes ?? null,
    lines:
      recipe?.ingredients.map((line) => ({
        inventoryItemId: line.inventoryItemId,
        subRecipeId: line.subRecipeId,
        name: line.inventoryItem?.name ?? line.subRecipe?.name ?? 'Unknown',
        quantity: line.quantity,
        unit: line.unit,
        wastagePercent: line.wastagePercent,
      })) ?? [],
    cost,
    items,
    prepRecipes,
    currency: params.currency,
  }
}
