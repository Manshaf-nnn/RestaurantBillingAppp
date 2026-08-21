'use server'

import { z } from 'zod'

import { runAction, runSafe, type ActionResult } from '@/lib/action'
import { PERMISSIONS } from '@/lib/rbac'
import { AUDIT_ACTIONS, audit } from '@/server/audit'
import { requirePermission } from '@/server/auth/guard'
import { prisma } from '@/server/db/prisma'
import { createBranch, setDefaultBranch, updateBranch } from './service'

/*
 * These actions deliberately do NOT call `revalidatePath`.
 *
 * Every route in this app is `force-dynamic` and none uses ISR, so there is no
 * cached render for it to invalidate — but calling it sets `pathWasRevalidated`,
 * which makes Next re-render the whole route *inside the action's own POST*
 * before replying. For /dashboard/locations that meant the layout's queries, a
 * second session lookup, and listLocations' join over every stock row, stacked
 * on the action's own work inside a 10-second serverless budget. When it did not
 * fit, the function returned a non-RSC body and the client saw a bare "that did
 * not work" with the record already written.
 *
 * The forms call `router.refresh()` when the action succeeds, which fetches the
 * new page on its own budget instead.
 */

const TYPES = ['BRANCH', 'PRODUCTION_HOUSE', 'CENTRAL_WAREHOUSE'] as const

/*
 * Not exported. A 'use server' module may only export async functions — Next
 * turns every export into a callable server reference, and a Zod object is not
 * callable. Exporting this threw "A 'use server' file can only export async
 * functions, found object" on the FIRST call into the module, so every action
 * in this file failed with a bare digest and nothing was ever written.
 */
const locationSchema = z.object({
  name: z.string().trim().min(2, 'Give the location a name').max(60),
  code: z.string().trim().min(1, 'Give it a short code').max(12),
  type: z.enum(TYPES),
  address: z.string().trim().max(200).optional().or(z.literal('')),
  phone: z.string().trim().max(30).optional().or(z.literal('')),
})

/**
 * Create a location — a branch, production house or central warehouse.
 *
 * All three are the same record with a different type, so a warehouse gets
 * storage locations, stock and transfers for free rather than needing a
 * parallel system.
 */
export async function createLocationAction(
  input: unknown,
): Promise<ActionResult<{ id: string; name: string }>> {
  return runAction(locationSchema, input, async (data) => {
    const user = await requirePermission(PERMISSIONS.BRANCH_MANAGE)

    const branch = await createBranch({
      restaurantId: user.restaurantId,
      name: data.name,
      code: data.code,
      address: data.address || null,
      phone: data.phone || null,
    })

    // createBranch does not know about types, so the type is applied here.
    await prisma.branch.update({ where: { id: branch.id }, data: { type: data.type } })

    await audit({
      restaurantId: user.restaurantId, branchId: branch.id, userId: user.id, actorName: user.name,
      action: AUDIT_ACTIONS.CREATE, entity: 'Branch', entityId: branch.id,
      after: { name: branch.name, code: branch.code, type: data.type },
    })

    return { id: branch.id, name: branch.name }
  }, 'Location created.')
}

export async function updateLocationAction(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  return runAction(
    locationSchema.partial().extend({ branchId: z.string().min(1) }),
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.BRANCH_MANAGE)
      const branch = await updateBranch({
        restaurantId: user.restaurantId,
        branchId: data.branchId,
        name: data.name,
        address: data.address ?? null,
        phone: data.phone ?? null,
      })
      if (data.type) {
        await prisma.branch.update({ where: { id: branch.id }, data: { type: data.type } })
      }
      await audit({
        restaurantId: user.restaurantId, branchId: branch.id, userId: user.id, actorName: user.name,
        action: AUDIT_ACTIONS.UPDATE, entity: 'Branch', entityId: branch.id,
        after: { name: branch.name, type: data.type },
      })
      return { id: branch.id }
    },
    'Location updated.',
  )
}

/** Add a storage area — cold room, dry store, bar — inside a location. */
export async function createStorageLocationAction(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  return runAction(
    z.object({
      branchId: z.string().min(1),
      name: z.string().trim().min(2, 'Name the storage area').max(60),
      code: z.string().trim().min(1).max(12),
    }),
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.BRANCH_MANAGE)

      // The branch must belong to this restaurant — never trust the id.
      const branch = await prisma.branch.findFirst({
        where: { id: data.branchId, restaurantId: user.restaurantId, deletedAt: null },
        select: { id: true },
      })
      if (!branch) throw new Error('Location not found')

      const store = await prisma.storageLocation.create({
        data: {
          restaurantId: user.restaurantId,
          branchId: branch.id,
          name: data.name,
          code: data.code.trim().toUpperCase(),
        },
      })
      return { id: store.id }
    },
    'Storage area added.',
  )
}

export async function setDefaultLocationAction(branchId: string): Promise<ActionResult<{ ok: true }>> {
  return runSafe(async () => {
    const user = await requirePermission(PERMISSIONS.BRANCH_MANAGE)
    await setDefaultBranch(user.restaurantId, branchId)
    return { ok: true } as const
  })
}
