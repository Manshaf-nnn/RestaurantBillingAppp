import 'server-only'

import type { Recipe, StockUnit } from '@prisma/client'

import { AppError, NotFoundError } from '@/lib/errors'
import { prisma } from '@/server/db/prisma'
import { resolveRecipe } from '@/features/inventory/recipe-resolver'
import { toBaseUnits } from '@/features/inventory/units'

/**
 * Recipe editing.
 *
 * Saving never mutates an existing recipe in place once it has been used. A new
 * version is written and the previous one deactivated, because historical
 * orders point at the old row for their cost and their depletion. An unused
 * draft is edited directly — there is no history worth preserving yet, and
 * versioning every keystroke would make the version number meaningless.
 */

export interface IngredientInput {
  inventoryItemId?: string | null
  subRecipeId?: string | null
  quantity: number
  unit: StockUnit
  wastagePercent?: number
  notes?: string | null
}

interface SaveParams {
  restaurantId: string
  userId?: string | null
  /** Menu-item recipe. */
  foodId?: string | null
  /** Prep recipe producing this stock item. */
  producesItemId?: string | null
  name?: string | null
  yieldQty?: number
  yieldUnit?: StockUnit | null
  /** Days the finished item keeps, for a make-ahead recipe. */
  shelfLifeDays?: number | null
  prepNotes?: string | null
  ingredients: IngredientInput[]
}

/**
 * Everything a recipe must satisfy before it is worth saving.
 *
 * The unit check is the one that matters, and it is the reason this is `async`.
 * `toBaseUnits` throws when a line is written in a unit that cannot be resolved
 * to the item's own — "2 BOX of flour" where flour has no pack size — and it
 * used to throw at the moment stock was consumed, inside the transaction. So
 * the recipe saved happily and a kitchen job days later failed with someone
 * standing at the mixer. Catching it here means the person who wrote the
 * mistake is the person who is told about it.
 *
 * Self-reference, duplicate lines and yield were checked on the production side
 * only. Both screens are the same model now, so both get all three.
 */
async function validate(params: SaveParams) {
  if (!params.foodId && !params.producesItemId) {
    throw new AppError('A recipe must belong to a dish or produce a stock item', 400, 'RECIPE_NO_OWNER')
  }
  if (params.ingredients.length === 0) {
    throw new AppError('Add at least one ingredient', 400, 'RECIPE_EMPTY')
  }

  const seenItems = new Set<string>()
  const seenRecipes = new Set<string>()

  for (const line of params.ingredients) {
    if (!line.inventoryItemId && !line.subRecipeId) {
      throw new AppError('Every line needs an ingredient or a make-ahead recipe', 400, 'RECIPE_LINE_EMPTY')
    }
    if (line.inventoryItemId && line.subRecipeId) {
      throw new AppError('A line is either an ingredient or a make-ahead recipe, not both', 400, 'RECIPE_LINE_BOTH')
    }
    if (!(line.quantity > 0)) {
      throw new AppError('Every ingredient needs a quantity above zero', 400, 'RECIPE_LINE_QTY')
    }

    // Nothing may make itself: it would consume its own output for ever.
    if (line.inventoryItemId && line.inventoryItemId === params.producesItemId) {
      throw new AppError(
        'A recipe cannot use the thing it makes as one of its own ingredients',
        400,
        'RECIPE_SELF_REFERENCE',
      )
    }

    const key = line.inventoryItemId ?? line.subRecipeId!
    const seen = line.inventoryItemId ? seenItems : seenRecipes
    if (seen.has(key)) {
      throw new AppError('The same ingredient is listed twice', 400, 'RECIPE_DUPLICATE_LINE')
    }
    seen.add(key)
  }

  if (params.producesItemId) {
    // A make-ahead recipe is measured in batches of something, so it must say
    // what, and how much one batch makes.
    if (!params.yieldUnit) {
      throw new AppError(
        'Say what this recipe makes — grams, litres, pieces',
        400,
        'RECIPE_NO_YIELD_UNIT',
      )
    }
    if (params.yieldQty !== undefined && !(params.yieldQty > 0)) {
      throw new AppError('Say how much one batch makes', 400, 'RECIPE_BAD_YIELD')
    }
  }

  const itemIds = [...seenItems]
  if (itemIds.length === 0) return

  const items = await prisma.inventoryItem.findMany({
    where: { id: { in: itemIds }, restaurantId: params.restaurantId },
    select: { id: true, name: true, unit: true, purchaseUnit: true, unitsPerPurchaseUnit: true },
  })
  if (items.length !== itemIds.length) throw new NotFoundError('Ingredient')

  const byId = new Map(items.map((i) => [i.id, i]))
  for (const line of params.ingredients) {
    const item = line.inventoryItemId ? byId.get(line.inventoryItemId) : null
    if (!item || line.unit === item.unit) continue
    // Throws UnitConversionError with a message naming the item and the fix.
    toBaseUnits(line.quantity, line.unit, item)
  }
}

/** The active recipe for a dish or prep item, with its lines. */
export async function getRecipe(restaurantId: string, recipeId: string) {
  const recipe = await prisma.recipe.findFirst({
    where: { id: recipeId, restaurantId },
    include: {
      ingredients: {
        orderBy: { sortOrder: 'asc' },
        include: {
          inventoryItem: { select: { id: true, name: true, unit: true, costPerUnit: true } },
          subRecipe: { select: { id: true, name: true, yieldQty: true, yieldUnit: true } },
        },
      },
      food: { select: { id: true, name: true, price: true } },
      producesItem: { select: { id: true, name: true, unit: true } },
    },
  })
  if (!recipe) throw new NotFoundError('Recipe')
  return recipe
}

/**
 * Create a recipe, or supersede the active one with a new version.
 *
 * Whether a version is created depends on whether the current one has ever been
 * used: an untouched draft is edited, anything an order references is kept.
 */
export async function saveRecipe(params: SaveParams): Promise<Recipe> {
  await validate(params)

  const current = await prisma.recipe.findFirst({
    where: {
      restaurantId: params.restaurantId,
      ...(params.foodId ? { foodId: params.foodId } : { producesItemId: params.producesItemId }),
      isActive: true,
      archivedAt: null,
    },
    orderBy: { version: 'desc' },
  })

  /*
   * Has anything been costed or depleted against this version?
   *
   * If so it is history and must be superseded rather than edited, or last
   * month's margin silently re-prices itself.
   *
   * Counting order lines alone was not enough. `OrderItem.recipeId` is only ever
   * pinned for a *menu* recipe, so a prep recipe — burger sauce, a marinade —
   * always counted as unused and was edited in place for ever, staying at
   * version 1. Every menu recipe nesting it then re-costed and re-depleted
   * against ingredients it never actually used. Three questions, not one:
   *
   *   was it sold directly?
   *   is it an ingredient of a recipe that was sold?
   *   has a production run been completed against it?
   */
  const used = current
    ? (await prisma.orderItem.count({ where: { recipeId: current.id } })) > 0 ||
      (await prisma.recipeIngredient.count({
        where: {
          subRecipeId: current.id,
          recipe: { orderItems: { some: {} } },
        },
      })) > 0 ||
      (await prisma.productionOrder.count({
        where: {
          // Scoped to the tenant. Without this, another restaurant completing a
          // run against an item with the same id decided whether THIS recipe was
          // edited in place or superseded.
          restaurantId: params.restaurantId,
          recipeId: current.id,
          status: { in: ['COMPLETED', 'PARTIALLY_COMPLETED'] },
        },
      })) > 0
    : false

  return prisma.$transaction(async (tx) => {
    if (current && !used) {
      // Nothing has been sold against it — edit in place.
      await tx.recipeIngredient.deleteMany({ where: { recipeId: current.id } })
      const updated = await tx.recipe.update({
        where: { id: current.id },
        data: {
          name: params.name ?? current.name,
          yieldQty: params.yieldQty ?? current.yieldQty,
          yieldUnit: params.yieldUnit ?? current.yieldUnit,
          shelfLifeDays: params.shelfLifeDays ?? current.shelfLifeDays,
          prepNotes: params.prepNotes ?? null,
          ingredients: { create: lineData(params.ingredients) },
        },
      })
      return updated
    }

    if (current) {
      await tx.recipe.update({ where: { id: current.id }, data: { isActive: false } })
    }

    return tx.recipe.create({
      data: {
        restaurantId: params.restaurantId,
        foodId: params.foodId ?? null,
        producesItemId: params.producesItemId ?? null,
        name: params.name ?? null,
        version: (current?.version ?? 0) + 1,
        isActive: true,
        yieldQty: params.yieldQty ?? 1,
        yieldUnit: params.yieldUnit ?? null,
        shelfLifeDays: params.shelfLifeDays ?? null,
        prepNotes: params.prepNotes ?? null,
        createdById: params.userId ?? null,
        ingredients: { create: lineData(params.ingredients) },
      },
    })
  })
}

function lineData(ingredients: IngredientInput[]) {
  return ingredients.map((line, index) => ({
    inventoryItemId: line.inventoryItemId ?? null,
    subRecipeId: line.subRecipeId ?? null,
    quantity: line.quantity,
    unit: line.unit,
    wastagePercent: Math.max(0, line.wastagePercent ?? 0),
    notes: line.notes?.trim() || null,
    sortOrder: index,
  }))
}

/** Copy a recipe onto another dish — the fastest way to build a variant. */
export async function duplicateRecipe(params: {
  restaurantId: string
  recipeId: string
  toFoodId: string
  userId?: string | null
}): Promise<Recipe> {
  const source = await getRecipe(params.restaurantId, params.recipeId)

  const food = await prisma.food.findFirst({
    where: { id: params.toFoodId, restaurantId: params.restaurantId },
    select: { id: true },
  })
  if (!food) throw new NotFoundError('Dish')

  return saveRecipe({
    restaurantId: params.restaurantId,
    userId: params.userId,
    foodId: params.toFoodId,
    name: source.name,
    yieldQty: source.yieldQty,
    yieldUnit: source.yieldUnit,
    prepNotes: source.prepNotes,
    ingredients: source.ingredients.map((line) => ({
      inventoryItemId: line.inventoryItemId,
      subRecipeId: line.subRecipeId,
      quantity: line.quantity,
      unit: line.unit,
      wastagePercent: line.wastagePercent,
      notes: line.notes,
    })),
  })
}

/**
 * Turn a recipe on or off.
 *
 * Deactivating stops new orders depleting against it; it never deletes, because
 * orders already sold still point at it.
 */
export async function setRecipeActive(params: {
  restaurantId: string
  recipeId: string
  isActive: boolean
}): Promise<Recipe> {
  const recipe = await prisma.recipe.findFirst({
    where: { id: params.recipeId, restaurantId: params.restaurantId },
  })
  if (!recipe) throw new NotFoundError('Recipe')

  return prisma.$transaction(async (tx) => {
    if (params.isActive) {
      // Only one version may be active for the same owner at a time.
      await tx.recipe.updateMany({
        where: {
          restaurantId: params.restaurantId,
          ...(recipe.foodId ? { foodId: recipe.foodId } : { producesItemId: recipe.producesItemId }),
          id: { not: recipe.id },
        },
        data: { isActive: false },
      })
    }
    return tx.recipe.update({ where: { id: recipe.id }, data: { isActive: params.isActive } })
  })
}

/** Cost a set of proposed lines without saving — powers the live editor total. */
export async function previewRecipeCost(params: {
  restaurantId: string
  recipeId: string
}): Promise<{ totalCost: number; problems: string[] }> {
  const resolved = await resolveRecipe(prisma, {
    restaurantId: params.restaurantId,
    recipeId: params.recipeId,
    portions: 1,
  })
  return { totalCost: resolved.totalCost, problems: resolved.problems }
}

/** All prep recipes, for the "use a prep recipe" picker. */
export async function listPrepRecipes(restaurantId: string) {
  return prisma.recipe.findMany({
    where: { restaurantId, producesItemId: { not: null }, isActive: true, archivedAt: null },
    select: { id: true, name: true, yieldQty: true, yieldUnit: true },
    orderBy: { name: 'asc' },
  })
}
