'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'

import { runAction, type ActionResult } from '@/lib/action'
import { PERMISSIONS } from '@/lib/rbac'
import { AUDIT_ACTIONS, audit } from '@/server/audit'
import { assertBranchAccess, requirePermission } from '@/server/auth/guard'
import { saveRecipe } from '@/features/recipes/service'
import {
  completeProduction, createProductionOrder, setMakeAheadRecipeActive, setProductionStatus,
} from './service'
import { prisma } from '@/server/db/prisma'

const UNITS = ['KG', 'GRAM', 'LITRE', 'ML', 'PIECE', 'PACK', 'BOTTLE', 'DOZEN', 'BOX'] as const
const REASONS = ['PRODUCTION_LOSS', 'DAMAGED', 'INGREDIENT_SHORTAGE', 'QUALITY_ISSUE', 'OTHER'] as const

/*
 * Not exported. A 'use server' module may export nothing but async functions,
 * and exporting a schema from one does not fail a lint — it breaks every action
 * in the file at runtime. Four features in this app were dead for weeks that
 * way.
 */
const recipeShape = {
  name: z.string().trim().min(2, 'Name the recipe').max(80),
  producesItemId: z.string().min(1, 'Choose what it makes'),
  yieldQty: z.coerce.number().positive('Say how much one batch makes'),
  shelfLifeDays: z.coerce.number().int().min(0).max(3650).optional(),
  notes: z.string().trim().max(300).optional().or(z.literal('')),
  items: z.array(z.object({
    itemId: z.string().min(1),
    quantity: z.coerce.number().positive(),
    unit: z.enum(UNITS).optional(),
  })).min(1, 'Add at least one ingredient'),
}

/**
 * Save a make-ahead recipe — what the kitchen makes in advance and puts on the
 * shelf.
 *
 * This writes a `Recipe` with `producesItemId` set: the same model a dish recipe
 * uses, so it versions, it nests, and completed jobs keep pointing at the exact
 * version they were made against. It used to write a separate `ProductionSpec`
 * table with none of that, which is how one product ended up describable — and
 * costable — two different ways.
 */
export async function saveMakeAheadRecipeAction(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  return runAction(
    z.object({ recipeId: z.string().optional(), ...recipeShape }),
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.PRODUCTION_MANAGE)

      const produces = await prisma.inventoryItem.findFirst({
        where: { id: data.producesItemId, restaurantId: user.restaurantId },
        select: { unit: true },
      })
      if (!produces) throw new Error('That stock item no longer exists')

      const recipe = await saveRecipe({
        restaurantId: user.restaurantId,
        userId: user.id,
        producesItemId: data.producesItemId,
        name: data.name,
        yieldQty: data.yieldQty,
        // A make-ahead recipe is measured in whatever the finished item is
        // measured in — there is no second unit for the owner to get wrong.
        yieldUnit: produces.unit,
        prepNotes: data.notes || null,
        shelfLifeDays: data.shelfLifeDays ?? null,
        ingredients: data.items.map((line) => ({
          inventoryItemId: line.itemId,
          quantity: line.quantity,
          unit: (line.unit ?? produces.unit) as never,
        })),
      })

      await audit({
        restaurantId: user.restaurantId, userId: user.id, actorName: user.name,
        action: AUDIT_ACTIONS.PRODUCTION_SPEC_UPDATED, entity: 'Recipe', entityId: recipe.id,
        after: { name: recipe.name, makes: recipe.yieldQty, lines: data.items.length },
      })
      revalidatePath('/dashboard/production')
      return { id: recipe.id }
    },
    'Recipe saved.',
  )
}

/** Retire a recipe, or bring it back. Never deleted — finished jobs point at it. */
export async function setMakeAheadRecipeActiveAction(
  input: unknown,
): Promise<ActionResult<{ id: string; isActive: boolean }>> {
  return runAction(
    z.object({ recipeId: z.string().min(1), isActive: z.coerce.boolean() }),
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.PRODUCTION_MANAGE)
      // The "still in use" guard lives in the service, so it holds however this
      // is reached and is covered by the service tests.
      const recipe = await setMakeAheadRecipeActive({
        restaurantId: user.restaurantId,
        recipeId: data.recipeId,
        isActive: data.isActive,
      })
      revalidatePath('/dashboard/production')
      return { id: recipe.id, isActive: recipe.isActive }
    },
    'Recipe updated.',
  )
}

export async function createProductionOrderAction(
  input: unknown,
): Promise<ActionResult<{ id: string; number: string }>> {
  return runAction(
    z.object({
      branchId: z.string().min(1, 'Choose the production house'),
      recipeId: z.string().min(1, 'Choose what to make'),
      plannedQty: z.coerce.number().positive('Say how many to make'),
      notes: z.string().trim().max(300).optional().or(z.literal('')),
    }),
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.PRODUCTION_MANAGE)
      await assertBranchAccess(user, data.branchId)
      const order = await createProductionOrder({
        restaurantId: user.restaurantId, branchId: data.branchId, recipeId: data.recipeId,
        plannedQty: data.plannedQty, notes: data.notes || null, userId: user.id,
      })
      await audit({
        restaurantId: user.restaurantId, branchId: data.branchId, userId: user.id, actorName: user.name,
        action: AUDIT_ACTIONS.PRODUCTION_CREATED, entity: 'ProductionOrder', entityId: order.id,
        after: { number: order.number, planned: data.plannedQty },
      })
      revalidatePath('/dashboard/production')
      return { id: order.id, number: order.number }
    },
    'Kitchen job created.',
  )
}

export async function setProductionStatusAction(input: unknown): Promise<ActionResult<{ status: string }>> {
  return runAction(
    z.object({
      orderId: z.string().min(1),
      // Three reachable states: to make, approved, cancelled. PLANNED and
      // IN_PROGRESS existed in the enum but no screen could ever produce them.
      status: z.enum(['DRAFT', 'APPROVED', 'CANCELLED']),
    }),
    input,
    async (data) => {
      // Approving commits ingredients; a separate permission from planning.
      const needed = data.status === 'APPROVED' ? PERMISSIONS.PRODUCTION_APPROVE : PERMISSIONS.PRODUCTION_MANAGE
      const user = await requirePermission(needed)
      // Whose production house is this? The permission never asked.
      await assertBranchAccess(user, await houseOf(user.restaurantId, data.orderId))
      const order = await setProductionStatus({
        restaurantId: user.restaurantId, orderId: data.orderId, status: data.status, userId: user.id,
      })
      revalidatePath('/dashboard/production')
      return { status: order.status }
    },
    'Job updated.',
  )
}

/**
 * Finish a job: ingredients leave, the finished item appears, cost is worked
 * out. The only step here that moves stock.
 */
export async function completeProductionAction(
  input: unknown,
): Promise<ActionResult<{ produced: number; unitCost: number; variance: number }>> {
  return runAction(
    z.object({
      orderId: z.string().min(1),
      actualQty: z.coerce.number().positive('Say how many came out'),
      /*
       * Labour, power, gas — everything the job cost that is not an ingredient.
       * The costing already added it to the divisor's numerator; there was
       * simply no way to enter it, so it was always zero and every finished
       * item looked cheaper to make than it was.
       */
      overheadCost: z.coerce.number().int().min(0).max(100_000_000).optional(),
      varianceReason: z.enum(REASONS).optional(),
      varianceNote: z.string().trim().max(200).optional().or(z.literal('')),
      batchNumber: z.string().trim().max(60).optional().or(z.literal('')),
    }),
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.PRODUCTION_MANAGE)
      await assertBranchAccess(user, await houseOf(user.restaurantId, data.orderId))

      /*
       * Overhead goes in as a parameter rather than being written first. It used
       * to be saved in its own statement before this call, so a job that failed
       * to finish — short of stock, already completed by somebody else — kept
       * the overhead anyway and carried it into the next attempt.
       */
      const result = await completeProduction({
        restaurantId: user.restaurantId, orderId: data.orderId, actualQty: data.actualQty,
        overheadCost: data.overheadCost,
        varianceReason: data.varianceReason ?? null, varianceNote: data.varianceNote || null,
        batchNumber: data.batchNumber || null, userId: user.id,
      })
      await audit({
        restaurantId: user.restaurantId, userId: user.id, actorName: user.name,
        action: AUDIT_ACTIONS.PRODUCTION_COMPLETED, entity: 'ProductionOrder', entityId: data.orderId,
        after: {
          produced: result.producedQty, cost: result.totalCost,
          unitCost: result.unitCost, variance: result.variance, batch: result.batchNumber,
        },
      })
      revalidatePath('/dashboard/production')
      revalidatePath('/dashboard/inventory')
      return { produced: result.producedQty, unitCost: result.unitCost, variance: result.variance }
    },
    'Job finished — stock updated.',
  )
}

/**
 * Which production house a job belongs to.
 *
 * Read separately so the branch check happens BEFORE the service starts a
 * transaction — refusing after the stock has begun moving would be a rollback
 * where a plain refusal will do.
 */
async function houseOf(restaurantId: string, orderId: string): Promise<string | null> {
  const order = await prisma.productionOrder.findFirst({
    where: { id: orderId, restaurantId },
    select: { branchId: true },
  })
  return order?.branchId ?? null
}
