import 'server-only'

import type { StockUnit } from '@prisma/client'

import { AppError, NotFoundError } from '@/lib/errors'
import { prisma, type TxClient } from '@/server/db/prisma'
import { convertUnits, toBaseUnits, UnitConversionError } from './units'

/**
 * Turning a recipe into a list of ingredients to remove from stock.
 *
 * A menu recipe yields one portion, so selling two burgers scales it by two. A
 * prep recipe yields a batch — "one batch of sauce makes 2 kg" — so a menu
 * recipe asking for 15 g of that sauce uses 15/2000ths of the batch, and every
 * ingredient inside it scales by that fraction. That ratio is the whole reason
 * yield exists.
 *
 * Wastage is applied on top of the quantity, not taken out of it: a line that
 * needs 100 g on the plate with 5% trim removes 105 g from stock.
 *
 * Nesting is bounded. A recipe that referenced itself, directly or through a
 * chain, would recurse forever, so the path is tracked and a repeat is an error
 * rather than a hung request.
 */

const MAX_DEPTH = 8

export interface ResolvedIngredient {
  itemId: string
  name: string
  unit: StockUnit
  /** Base units to remove from stock. */
  quantity: number
  /** Cost per base unit at resolution time, minor units. */
  costPerUnit: number
}

export interface ResolvedRecipe {
  recipeId: string
  ingredients: ResolvedIngredient[]
  /** Sum of quantity × costPerUnit, minor units. */
  totalCost: number
  /** Anything that could not be resolved, reported rather than silently dropped. */
  problems: string[]
}

type Client = TxClient | typeof prisma

/** The active recipe for a menu item, or null when it has none. */
export async function activeRecipeForFood(
  db: Client,
  restaurantId: string,
  foodId: string,
): Promise<{ id: string } | null> {
  return db.recipe.findFirst({
    where: { restaurantId, foodId, isActive: true, archivedAt: null },
    orderBy: { version: 'desc' },
    select: { id: true },
  })
}

/**
 * Explode a recipe into the stock it consumes.
 *
 * `portions` is how many of the recipe's own yield are wanted — 2 burgers, or
 * 0.0075 of a sauce batch when called recursively.
 */
export async function resolveRecipe(
  db: Client,
  params: {
    restaurantId: string
    recipeId: string
    portions: number
  },
): Promise<ResolvedRecipe> {
  const totals = new Map<string, number>()
  const problems: string[] = []

  await walk(db, params.restaurantId, params.recipeId, params.portions, totals, problems, [])

  const itemIds = [...totals.keys()]
  const items = itemIds.length
    ? await db.inventoryItem.findMany({
        where: { id: { in: itemIds }, restaurantId: params.restaurantId },
        select: { id: true, name: true, unit: true, costPerUnit: true },
      })
    : []
  const byId = new Map(items.map((i) => [i.id, i]))

  const ingredients: ResolvedIngredient[] = []
  let totalCost = 0

  for (const [itemId, quantity] of totals) {
    const item = byId.get(itemId)
    if (!item) {
      problems.push('An ingredient is no longer in inventory and was skipped')
      continue
    }
    const rounded = round(quantity)
    const cost = Math.round(rounded * item.costPerUnit)
    totalCost += cost
    ingredients.push({
      itemId,
      name: item.name,
      unit: item.unit,
      quantity: rounded,
      costPerUnit: item.costPerUnit,
    })
  }

  ingredients.sort((a, b) => a.name.localeCompare(b.name))
  return { recipeId: params.recipeId, ingredients, totalCost, problems }
}

async function walk(
  db: Client,
  restaurantId: string,
  recipeId: string,
  portions: number,
  totals: Map<string, number>,
  problems: string[],
  path: string[],
): Promise<void> {
  if (path.includes(recipeId)) {
    throw new AppError(
      'This recipe refers to itself through one of its prep recipes',
      400,
      'RECIPE_CYCLE',
    )
  }
  if (path.length >= MAX_DEPTH) {
    throw new AppError('Recipes are nested too deeply', 400, 'RECIPE_TOO_DEEP')
  }

  const recipe = await db.recipe.findFirst({
    where: { id: recipeId, restaurantId },
    include: {
      ingredients: {
        include: {
          inventoryItem: { select: { id: true, name: true, unit: true, purchaseUnit: true, unitsPerPurchaseUnit: true } },
          subRecipe: { select: { id: true, yieldQty: true, yieldUnit: true, name: true } },
        },
        orderBy: { sortOrder: 'asc' },
      },
    },
  })
  if (!recipe) throw new NotFoundError('Recipe')

  // A yield of zero would divide by zero; treat it as one batch and say so.
  const yieldQty = recipe.yieldQty > 0 ? recipe.yieldQty : 1
  const scale = portions / yieldQty

  for (const line of recipe.ingredients) {
    const withWastage = line.quantity * (1 + Math.max(0, line.wastagePercent) / 100)
    const needed = withWastage * scale

    if (line.subRecipe) {
      const sub = line.subRecipe
      const subYieldUnit = sub.yieldUnit
      if (!subYieldUnit) {
        problems.push(`${sub.name ?? 'A prep recipe'} has no yield unit, so it was skipped`)
        continue
      }
      try {
        // How many of the sub-recipe's own yield units this line wants.
        const inYieldUnits = convertUnits(needed, line.unit, subYieldUnit)
        await walk(db, restaurantId, sub.id, inYieldUnits, totals, problems, [...path, recipeId])
      } catch (error) {
        if (error instanceof UnitConversionError) {
          problems.push(error.message)
          continue
        }
        throw error
      }
      continue
    }

    if (!line.inventoryItem) {
      problems.push('A recipe line points at nothing and was skipped')
      continue
    }

    try {
      const base = toBaseUnits(needed, line.unit, line.inventoryItem)
      totals.set(line.inventoryItem.id, (totals.get(line.inventoryItem.id) ?? 0) + base)
    } catch (error) {
      if (error instanceof UnitConversionError) {
        problems.push(error.message)
        continue
      }
      throw error
    }
  }
}

/**
 * What a whole order should consume, per inventory item.
 *
 * Falls back to the legacy flat `RecipeItem` table for foods that have not been
 * given a versioned recipe yet, so restaurants already running keep their
 * automatic deduction while they migrate.
 */
export async function resolveOrderConsumption(
  db: Client,
  params: { restaurantId: string; orderId: string },
): Promise<{ totals: Map<string, number>; problems: string[] }> {
  const lines = await db.orderItem.findMany({
    where: { orderId: params.orderId, status: { not: 'CANCELLED' } },
    select: { foodId: true, quantity: true, recipeId: true },
  })

  const totals = new Map<string, number>()
  const problems: string[] = []

  for (const line of lines) {
    if (!line.foodId) continue

    // Pinned version first: a line sold in January must keep costing and
    // depleting against January's recipe even after the recipe changes.
    const recipeId =
      line.recipeId ??
      (await activeRecipeForFood(db, params.restaurantId, line.foodId))?.id ??
      null

    if (recipeId) {
      const resolved = await resolveRecipe(db, {
        restaurantId: params.restaurantId,
        recipeId,
        portions: line.quantity,
      })
      problems.push(...resolved.problems)
      for (const ingredient of resolved.ingredients) {
        totals.set(ingredient.itemId, (totals.get(ingredient.itemId) ?? 0) + ingredient.quantity)
      }
      continue
    }

    const legacy = await db.recipeItem.findMany({
      where: { foodId: line.foodId },
      select: { itemId: true, quantity: true },
    })
    for (const entry of legacy) {
      totals.set(entry.itemId, (totals.get(entry.itemId) ?? 0) + entry.quantity * line.quantity)
    }
  }

  for (const [itemId, quantity] of totals) totals.set(itemId, round(quantity))
  return { totals, problems }
}

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6
}
