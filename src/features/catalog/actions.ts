'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'

import { runAction, type ActionResult } from '@/lib/action'
import { PERMISSIONS } from '@/lib/rbac'
import { AUDIT_ACTIONS, audit } from '@/server/audit'
import { requirePermission } from '@/server/auth/guard'
import {
  saveStockCategory,
  setStockCategoryActive,
  setUnitActive,
  updateUnit,
} from './service'

/*
 * Nothing but async functions may be exported from a 'use server' module.
 * Exporting a schema from one does not fail a lint — it breaks every action in
 * the file at runtime, which is how four features in this app were dead for
 * weeks. `no-bad-server-exports` guards it; these stay const.
 */
const unitSchema = z.object({
  unitId: z.string().min(1),
  name: z.string().trim().min(1, 'Name the unit').max(30),
  symbol: z.string().trim().min(1, 'Give it a symbol').max(10),
  sortOrder: z.coerce.number().int().min(0).max(9999).default(0),
})

const categorySchema = z.object({
  id: z.string().min(1).optional(),
  name: z.string().trim().min(2, 'Name the category').max(40),
  description: z.string().trim().max(160).optional().or(z.literal('')),
  sortOrder: z.coerce.number().int().min(0).max(9999).default(0),
})

function touch() {
  revalidatePath('/dashboard/inventory/setup')
  revalidatePath('/dashboard/inventory')
}

export async function updateUnitAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction(
    unitSchema,
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.INVENTORY_MANAGE)
      const unit = await updateUnit({ restaurantId: user.restaurantId, ...data })
      await audit({
        restaurantId: user.restaurantId,
        userId: user.id,
        actorName: user.name,
        action: AUDIT_ACTIONS.UNIT_UPDATED,
        entity: 'Unit',
        entityId: unit.id,
        after: { code: unit.code, name: unit.name, symbol: unit.symbol },
      })
      touch()
      return { id: unit.id }
    },
    'Unit saved.',
  )
}

export async function setUnitActiveAction(
  input: unknown,
): Promise<ActionResult<{ id: string; isActive: boolean }>> {
  return runAction(
    z.object({ unitId: z.string().min(1), isActive: z.coerce.boolean() }),
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.INVENTORY_MANAGE)
      const unit = await setUnitActive({ restaurantId: user.restaurantId, ...data })
      await audit({
        restaurantId: user.restaurantId,
        userId: user.id,
        actorName: user.name,
        action: AUDIT_ACTIONS.UNIT_UPDATED,
        entity: 'Unit',
        entityId: unit.id,
        after: { code: unit.code, isActive: unit.isActive },
      })
      touch()
      return { id: unit.id, isActive: unit.isActive }
    },
    'Unit updated.',
  )
}

export async function saveStockCategoryAction(
  input: unknown,
): Promise<ActionResult<{ id: string; name: string }>> {
  return runAction(
    categorySchema,
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.INVENTORY_MANAGE)
      const category = await saveStockCategory({
        restaurantId: user.restaurantId,
        id: data.id,
        name: data.name,
        description: data.description || null,
        sortOrder: data.sortOrder,
      })
      await audit({
        restaurantId: user.restaurantId,
        userId: user.id,
        actorName: user.name,
        action: data.id ? AUDIT_ACTIONS.CATEGORY_UPDATED : AUDIT_ACTIONS.CATEGORY_CREATED,
        entity: 'InventoryCategory',
        entityId: category.id,
        after: { name: category.name },
      })
      touch()
      return { id: category.id, name: category.name }
    },
    'Category saved.',
  )
}

export async function setStockCategoryActiveAction(
  input: unknown,
): Promise<ActionResult<{ id: string; isActive: boolean }>> {
  return runAction(
    z.object({ id: z.string().min(1), isActive: z.coerce.boolean() }),
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.INVENTORY_MANAGE)
      const category = await setStockCategoryActive({ restaurantId: user.restaurantId, ...data })
      await audit({
        restaurantId: user.restaurantId,
        userId: user.id,
        actorName: user.name,
        action: AUDIT_ACTIONS.CATEGORY_UPDATED,
        entity: 'InventoryCategory',
        entityId: category.id,
        after: { name: category.name, isActive: category.isActive },
      })
      touch()
      return { id: category.id, isActive: category.isActive }
    },
    'Category updated.',
  )
}
