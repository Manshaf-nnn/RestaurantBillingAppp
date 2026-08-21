'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'

import { runAction, type ActionResult } from '@/lib/action'
import { PERMISSIONS } from '@/lib/rbac'
import { AUDIT_ACTIONS, audit } from '@/server/audit'
import { requirePermission } from '@/server/auth/guard'
import { duplicateRecipe, saveRecipe, setRecipeActive } from './service'

const UNITS = ['KG', 'GRAM', 'LITRE', 'ML', 'PIECE', 'PACK', 'BOTTLE', 'DOZEN', 'BOX'] as const

const ingredientSchema = z.object({
  inventoryItemId: z.string().min(1).optional().or(z.literal('')),
  subRecipeId: z.string().min(1).optional().or(z.literal('')),
  quantity: z.coerce.number().positive('Quantity must be above zero').max(1_000_000),
  unit: z.enum(UNITS),
  wastagePercent: z.coerce.number().min(0).max(100).default(0),
  notes: z.string().trim().max(200).optional().or(z.literal('')),
})

/*
 * Not exported. A 'use server' module may only export async functions — Next
 * turns every export into a callable server reference, and a Zod object is not
 * callable. Exporting this threw "A 'use server' file can only export async
 * functions, found object" on the FIRST call into the module, so every action
 * in this file failed with a bare digest and nothing was ever written.
 */
const saveRecipeSchema = z.object({
  foodId: z.string().min(1).optional().or(z.literal('')),
  producesItemId: z.string().min(1).optional().or(z.literal('')),
  name: z.string().trim().max(80).optional().or(z.literal('')),
  yieldQty: z.coerce.number().positive().max(1_000_000).default(1),
  yieldUnit: z.enum(UNITS).optional(),
  prepNotes: z.string().trim().max(500).optional().or(z.literal('')),
  ingredients: z.array(ingredientSchema).min(1, 'Add at least one ingredient').max(60),
})

export async function saveRecipeAction(input: unknown): Promise<ActionResult<{ id: string; version: number }>> {
  return runAction(saveRecipeSchema, input, async (data) => {
    const user = await requirePermission(PERMISSIONS.MENU_MANAGE)

    const recipe = await saveRecipe({
      restaurantId: user.restaurantId,
      userId: user.id,
      foodId: data.foodId || null,
      producesItemId: data.producesItemId || null,
      name: data.name || null,
      yieldQty: data.yieldQty,
      yieldUnit: data.yieldUnit,
      prepNotes: data.prepNotes || null,
      ingredients: data.ingredients.map((line) => ({
        inventoryItemId: line.inventoryItemId || null,
        subRecipeId: line.subRecipeId || null,
        quantity: line.quantity,
        unit: line.unit,
        wastagePercent: line.wastagePercent,
        notes: line.notes || null,
      })),
    })

    await audit({
      restaurantId: user.restaurantId, userId: user.id, actorName: user.name,
      action: AUDIT_ACTIONS.UPDATE, entity: 'Recipe', entityId: recipe.id,
      after: { version: recipe.version, foodId: data.foodId, lines: data.ingredients.length },
    })

    revalidatePath('/dashboard/menu')
    revalidatePath('/dashboard/recipes')
    return { id: recipe.id, version: recipe.version }
  }, 'Recipe saved.')
}

export async function duplicateRecipeAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction(
    z.object({ recipeId: z.string().min(1), toFoodId: z.string().min(1) }),
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.MENU_MANAGE)
      const recipe = await duplicateRecipe({
        restaurantId: user.restaurantId,
        recipeId: data.recipeId,
        toFoodId: data.toFoodId,
        userId: user.id,
      })
      revalidatePath('/dashboard/recipes')
      return { id: recipe.id }
    },
    'Recipe copied.',
  )
}

export async function setRecipeActiveAction(input: unknown): Promise<ActionResult<{ isActive: boolean }>> {
  return runAction(
    z.object({ recipeId: z.string().min(1), isActive: z.boolean() }),
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.MENU_MANAGE)
      const recipe = await setRecipeActive({
        restaurantId: user.restaurantId,
        recipeId: data.recipeId,
        isActive: data.isActive,
      })
      revalidatePath('/dashboard/recipes')
      return { isActive: recipe.isActive }
    },
    'Recipe updated.',
  )
}
