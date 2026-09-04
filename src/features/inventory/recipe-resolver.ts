import 'server-only'

import type { StockUnit } from '@prisma/client'

import { AppError, NotFoundError } from '@/lib/errors'
import { prisma, type TxClient } from '@/server/db/prisma'
import { convertUnits, toBaseUnits, UnitConversionError, type ConvertibleItem } from './units'
import { roundQty } from '@/lib/quantity'

/**
 * Turning a recipe into a list of ingredients to remove from stock.
 *
 * A menu recipe yields one portion, so selling two burgers scales it by two. A
 * make-ahead recipe yields a batch — "one batch of sauce makes 2 kg" — so a menu
 * recipe asking for 15 g of that sauce uses 15/2000ths of the batch. That ratio
 * is the whole reason yield exists.
 *
 * Wastage is applied on top of the quantity, not taken out of it: a line that
 * needs 100 g on the plate with 5% trim removes 105 g from stock.
 *
 * ── The one rule for make-ahead recipes ─────────────────────────────────────
 *
 * A line pointing at a make-ahead recipe deducts **the item that recipe
 * produces**. It never explodes into that recipe's own ingredients.
 *
 * This used to recurse unconditionally, which double-counted: the kitchen makes
 * a batch of sauce (tomatoes leave stock, sauce arrives), then selling a burger
 * deducted the tomatoes a *second* time while the sauce sat untouched for ever.
 * Exploding is still correct for a recipe that produces nothing trackable —
 * a pure sub-assembly — which is the only case left below.
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

/** Everything the per-line rule needs about an ingredient, already loaded. */
type LineItem = ConvertibleItem & { id: string }

/**
 * One recipe line, hydrated. The same shape whether it came out of the database
 * or is still being typed into the editor — which is the point: there is one
 * implementation of the arithmetic below, and both paths go through it.
 */
export interface HydratedLine {
  quantity: number
  unit: StockUnit
  wastagePercent: number
  inventoryItem: LineItem | null
  subRecipe: {
    id: string
    name: string | null
    yieldQty: number
    yieldUnit: StockUnit | null
    producesItem: LineItem | null
  } | null
}

/** What `walk`/`consumeLines` need to load a nested recipe. */
const LINE_INCLUDE = {
  inventoryItem: {
    select: { id: true, name: true, unit: true, purchaseUnit: true, unitsPerPurchaseUnit: true },
  },
  subRecipe: {
    select: {
      id: true,
      name: true,
      yieldQty: true,
      yieldUnit: true,
      producesItem: {
        select: { id: true, name: true, unit: true, purchaseUnit: true, unitsPerPurchaseUnit: true },
      },
    },
  },
} as const

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

  const { ingredients, totalCost } = await priceTotals(db, params.restaurantId, totals, problems)
  return { recipeId: params.recipeId, ingredients, totalCost, problems }
}

/**
 * What a set of lines costs and consumes, without them being saved first.
 *
 * The recipe editor needs this: it prices what the user is typing, and there is
 * no row to point at yet. It exists so the editor does not grow its own copy of
 * the arithmetic — which is exactly what it had, missing both the unit
 * conversion and the yield division, so a 200 g line on a LKR 250/kg item read
 * as LKR 50,000 instead of LKR 50.
 */
export async function costDraftLines(
  db: Client,
  params: {
    restaurantId: string
    yieldQty: number
    lines: Array<{
      inventoryItemId?: string | null
      subRecipeId?: string | null
      quantity: number
      unit: StockUnit
      wastagePercent?: number
    }>
  },
): Promise<{ totalCost: number; ingredients: ResolvedIngredient[]; problems: string[] }> {
  const totals = new Map<string, number>()
  const problems: string[] = []

  const hydrated = await hydrate(db, params.restaurantId, params.lines)
  const yieldQty = params.yieldQty > 0 ? params.yieldQty : 1

  await consumeLines(db, params.restaurantId, hydrated, 1 / yieldQty, totals, problems, [])

  const { ingredients, totalCost } = await priceTotals(db, params.restaurantId, totals, problems)
  return { totalCost, ingredients, problems }
}

/**
 * What one portion of each of these recipes costs, in minor units.
 *
 * For reports that price thousands of sold lines across a few dozen recipes:
 * resolve each recipe once, then look the answer up per line.
 */
export async function costRecipes(
  db: Client,
  restaurantId: string,
  recipeIds: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  for (const recipeId of [...new Set(recipeIds)]) {
    try {
      const resolved = await resolveRecipe(db, { restaurantId, recipeId, portions: 1 })
      out.set(recipeId, resolved.totalCost)
    } catch {
      // A cycle, a missing recipe or a bad nesting depth costs nothing rather
      // than failing a whole report over one dish.
      out.set(recipeId, 0)
    }
  }
  return out
}

/** Turn accumulated base-unit totals into priced ingredient rows. */
async function priceTotals(
  db: Client,
  restaurantId: string,
  totals: Map<string, number>,
  problems: string[],
): Promise<{ ingredients: ResolvedIngredient[]; totalCost: number }> {
  const itemIds = [...totals.keys()]
  const items = itemIds.length
    ? await db.inventoryItem.findMany({
        where: { id: { in: itemIds }, restaurantId },
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
    const rounded = roundQty(quantity)
    totalCost += Math.round(rounded * item.costPerUnit)
    ingredients.push({
      itemId,
      name: item.name,
      unit: item.unit,
      quantity: rounded,
      costPerUnit: item.costPerUnit,
    })
  }

  ingredients.sort((a, b) => a.name.localeCompare(b.name))
  return { ingredients, totalCost }
}

/** Load the items and sub-recipes a draft set of lines refers to. */
async function hydrate(
  db: Client,
  restaurantId: string,
  lines: Array<{
    inventoryItemId?: string | null
    subRecipeId?: string | null
    quantity: number
    unit: StockUnit
    wastagePercent?: number
  }>,
): Promise<HydratedLine[]> {
  const itemIds = lines.map((l) => l.inventoryItemId).filter((id): id is string => Boolean(id))
  const recipeIds = lines.map((l) => l.subRecipeId).filter((id): id is string => Boolean(id))

  const [items, recipes] = await Promise.all([
    itemIds.length
      ? db.inventoryItem.findMany({
          where: { id: { in: itemIds }, restaurantId },
          select: { id: true, name: true, unit: true, purchaseUnit: true, unitsPerPurchaseUnit: true },
        })
      : [],
    recipeIds.length
      ? db.recipe.findMany({
          where: { id: { in: recipeIds }, restaurantId },
          select: LINE_INCLUDE.subRecipe.select,
        })
      : [],
  ])

  const itemById = new Map(items.map((i) => [i.id, i]))
  const recipeById = new Map(recipes.map((r) => [r.id, r]))

  return lines.map((line) => ({
    quantity: line.quantity,
    unit: line.unit,
    wastagePercent: line.wastagePercent ?? 0,
    inventoryItem: line.inventoryItemId ? itemById.get(line.inventoryItemId) ?? null : null,
    subRecipe: line.subRecipeId ? recipeById.get(line.subRecipeId) ?? null : null,
  }))
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
      'This recipe refers to itself through one of its make-ahead recipes',
      400,
      'RECIPE_CYCLE',
    )
  }
  if (path.length >= MAX_DEPTH) {
    throw new AppError('Recipes are nested too deeply', 400, 'RECIPE_TOO_DEEP')
  }

  const recipe = await db.recipe.findFirst({
    where: { id: recipeId, restaurantId },
    include: { ingredients: { include: LINE_INCLUDE, orderBy: { sortOrder: 'asc' } } },
  })
  if (!recipe) throw new NotFoundError('Recipe')

  // A yield of zero would divide by zero; treat it as one batch and say so.
  const yieldQty = recipe.yieldQty > 0 ? recipe.yieldQty : 1

  await consumeLines(db, restaurantId, recipe.ingredients, portions / yieldQty, totals, problems, [
    ...path,
    recipeId,
  ])
}

/**
 * The per-line rule — the single place a recipe line becomes stock to remove.
 *
 * `scale` is how many of the recipe's yields are wanted, already divided by the
 * yield: a menu recipe selling 2 burgers passes 2, and a nested call passes the
 * fraction of a batch its parent asked for.
 */
async function consumeLines(
  db: Client,
  restaurantId: string,
  lines: HydratedLine[],
  scale: number,
  totals: Map<string, number>,
  problems: string[],
  path: string[],
): Promise<void> {
  const add = (itemId: string, base: number) =>
    totals.set(itemId, (totals.get(itemId) ?? 0) + base)

  for (const line of lines) {
    const withWastage = line.quantity * (1 + Math.max(0, line.wastagePercent) / 100)
    const needed = withWastage * scale

    if (line.subRecipe) {
      const sub = line.subRecipe
      const label = sub.name ?? 'A make-ahead recipe'

      /*
       * The rule. What the kitchen made ahead is real stock, so take it off the
       * shelf — do not take its ingredients off a second time.
       */
      if (sub.producesItem) {
        try {
          add(sub.producesItem.id, toBaseUnits(needed, line.unit, sub.producesItem))
        } catch (error) {
          if (error instanceof UnitConversionError) {
            problems.push(error.message)
            continue
          }
          throw error
        }
        continue
      }

      /*
       * No produced item: a sub-assembly nobody counts, so it has no shelf to
       * come off and its ingredients are the only real stock involved.
       */
      if (!sub.yieldUnit) {
        problems.push(`${label} makes nothing measurable, so it was skipped`)
        continue
      }
      try {
        // How many of the sub-recipe's own yield units this line wants.
        const inYieldUnits = convertUnits(needed, line.unit, sub.yieldUnit)
        await walk(db, restaurantId, sub.id, inYieldUnits, totals, problems, path)
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
      add(line.inventoryItem.id, toBaseUnits(needed, line.unit, line.inventoryItem))
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
 */
export async function resolveOrderConsumption(
  db: Client,
  params: { restaurantId: string; orderId: string },
): Promise<{ totals: Map<string, number>; problems: string[] }> {
  const lines = await db.orderItem.findMany({
    where: { orderId: params.orderId, status: { not: 'CANCELLED' } },
    select: { foodId: true, quantity: true, recipeId: true, options: true },
  })

  /*
   * What the chosen options consume (§29). "Extra chicken" is chicken leaving
   * the kitchen; until options could name a recipe, nothing ever depleted or
   * costed it — the largest silent margin overstatement in the system. One
   * query resolves every selected option on the order to its recipe.
   */
  const optionIds = [
    ...new Set(
      lines.flatMap((line) =>
        (Array.isArray(line.options) ? (line.options as Array<{ optionId?: string }>) : [])
          .map((option) => option.optionId)
          .filter((id): id is string => Boolean(id)),
      ),
    ),
  ]
  const optionRecipes = optionIds.length
    ? new Map(
        (
          await db.variantOption.findMany({
            where: { id: { in: optionIds }, recipeId: { not: null } },
            select: { id: true, recipeId: true },
          })
        ).map((row) => [row.id, row.recipeId!]),
      )
    : new Map<string, string>()

  const totals = new Map<string, number>()
  const problems: string[] = []

  const addRecipe = async (recipeId: string, portions: number) => {
    const resolved = await resolveRecipe(db, {
      restaurantId: params.restaurantId,
      recipeId,
      portions,
    })
    problems.push(...resolved.problems)
    for (const ingredient of resolved.ingredients) {
      totals.set(ingredient.itemId, (totals.get(ingredient.itemId) ?? 0) + ingredient.quantity)
    }
  }

  for (const line of lines) {
    if (line.foodId) {
      // Pinned version first: a line sold in January must keep costing and
      // depleting against January's recipe even after the recipe changes.
      const recipeId =
        line.recipeId ??
        (await activeRecipeForFood(db, params.restaurantId, line.foodId))?.id ??
        null
      if (recipeId) await addRecipe(recipeId, line.quantity)
    }

    // Options ride per line: two burgers with extra cheese consume two extras.
    for (const option of Array.isArray(line.options)
      ? (line.options as Array<{ optionId?: string }>)
      : []) {
      const recipeId = option.optionId ? optionRecipes.get(option.optionId) : undefined
      if (recipeId) await addRecipe(recipeId, line.quantity)
    }
  }

  for (const [itemId, quantity] of totals) totals.set(itemId, roundQty(quantity))
  return { totals, problems }
}

