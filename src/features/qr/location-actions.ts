'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'

import { runAction, type ActionResult } from '@/lib/action'
import { PERMISSIONS } from '@/lib/rbac'
import { assertBranchAccess, requirePermission } from '@/server/auth/guard'
import { saveLocation, setLocationActive } from './locations'

/**
 * The owner's delivery places, managed from inside the QR code editor.
 *
 * Gated on `QR_MANAGE`, the permission the editor's own feature owns: deciding
 * where deliveries go is part of configuring the code that asks for it, and
 * the list lives on that screen now rather than on one of its own.
 */

const saveSchema = z.object({
  id: z.string().cuid().optional().or(z.literal('')),
  name: z.string().trim().min(1, 'Give the place a name').max(60),
  /** Shown to the rider on the ticket, never to the guest in the picker. */
  note: z.string().trim().max(120).optional().or(z.literal('')),
  /** The main place this sits under. Empty makes it a main place. */
  parentId: z.string().cuid().optional().or(z.literal('')),
  branchId: z.string().cuid().optional().or(z.literal('')),
  sortOrder: z.coerce.number().int().min(0).max(9999).default(0),
  isActive: z.coerce.boolean().default(true),
})

export async function saveDeliveryLocation(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  return runAction(saveSchema, input, async (data) => {
    const user = await requirePermission(PERMISSIONS.QR_MANAGE)
    if (data.branchId) await assertBranchAccess(user, data.branchId)

    const saved = await saveLocation({
      restaurantId: user.restaurantId,
      input: {
        id: data.id || null,
        name: data.name,
        note: data.note || null,
        parentId: data.parentId || null,
        branchId: data.branchId || null,
        sortOrder: data.sortOrder,
        isActive: data.isActive,
      },
    })

    revalidatePath('/dashboard/qr', 'layout')
    return saved
  })
}

const activeSchema = z.object({
  id: z.string().cuid(),
  isActive: z.coerce.boolean(),
})

/** Retire or restore one place — and, for a main place, everything under it. */
export async function setDeliveryLocationActive(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  return runAction(activeSchema, input, async (data) => {
    const user = await requirePermission(PERMISSIONS.QR_MANAGE)
    await setLocationActive({
      restaurantId: user.restaurantId,
      id: data.id,
      isActive: data.isActive,
    })
    revalidatePath('/dashboard/qr', 'layout')
    return { id: data.id }
  })
}
