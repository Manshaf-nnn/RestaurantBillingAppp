'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'

import { runAction, type ActionResult } from '@/lib/action'
import { PERMISSIONS } from '@/lib/rbac'
import { assertBranchAccess, requirePermission } from '@/server/auth/guard'
import { saveLocation, setLocationActive } from './locations'

/**
 * The owner's delivery locations, managed from the dashboard.
 *
 * Gated on `QR_MANAGE`, the permission the route's own feature owns.
 *
 * Not `SETTINGS_MANAGE`, which was the first instinct and is wrong for a
 * reason `no-unguarded-feature-pages` states better than this comment could:
 * the sidebar and the URL must ask the same question. A route under
 * `/dashboard/qr` that asked for a settings permission would appear in the
 * sidebar for one group of people and open for a different one.
 *
 * It is also the more honest reading. Deciding where deliveries go is part of
 * configuring the codes that ask for it, not a separate act of administration.
 */

const saveSchema = z.object({
  id: z.string().cuid().optional().or(z.literal('')),
  name: z
    .string()
    .trim()
    .min(1, 'Give the place a name')
    .max(60, 'Keep it short enough to read on a phone'),
  groupName: z.string().trim().max(40).optional().or(z.literal('')),
  /** Shown to the rider on the ticket, never to the guest in the picker. */
  note: z.string().trim().max(120).optional().or(z.literal('')),
  categoryId: z.string().cuid().optional().or(z.literal('')),
  branchId: z.string().cuid().optional().or(z.literal('')),
  sortOrder: z.coerce.number().int().min(0).max(9999).default(0),
  isActive: z.coerce.boolean().default(true),
})

export async function saveDeliveryLocation(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  return runAction(saveSchema, input, async (data) => {
    const user = await requirePermission(PERMISSIONS.SETTINGS_MANAGE)

    // A location pinned to a branch this person cannot reach would be invisible
    // to them the moment it was saved — and is a write into another site.
    if (data.branchId) await assertBranchAccess(user, data.branchId)

    const saved = await saveLocation({
      restaurantId: user.restaurantId,
      input: {
        id: data.id || null,
        name: data.name,
        groupName: data.groupName || null,
        note: data.note || null,
        categoryId: data.categoryId || null,
        branchId: data.branchId || null,
        sortOrder: data.sortOrder,
        isActive: data.isActive,
      },
    })

    revalidatePath('/dashboard/qr/locations')
    return saved
  })
}

const activeSchema = z.object({
  id: z.string().cuid(),
  isActive: z.coerce.boolean(),
})

/**
 * Retire or restore one location.
 *
 * Never a delete. Orders point at it, and "where did last month's deliveries
 * go" stops being answerable the moment the row is gone — the snapshotted name
 * on the order survives, but the grouping does not.
 */
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
    revalidatePath('/dashboard/qr/locations')
    return { id: data.id }
  })
}
