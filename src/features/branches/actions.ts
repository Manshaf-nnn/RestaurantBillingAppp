'use server'

import { runAction, runSafe, type ActionResult } from '@/lib/action'
import { AppError, NotFoundError } from '@/lib/errors'
import { PERMISSIONS, canManageLocation } from '@/lib/rbac'
import { AUDIT_ACTIONS, audit } from '@/server/audit'
import { assertBranchAccess, requirePermission } from '@/server/auth/guard'
import { prisma } from '@/server/db/prisma'
import { locationSchema, storageLocationSchema, updateLocationSchema } from './schema'
import {
  createBranch,
  requireBranch,
  setBranchManager,
  setDefaultBranch,
  updateBranch,
} from './service'

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

/**
 * Edit a location — its name, address, phone, type, manager, hours, and whether
 * it is still in use.
 *
 * This action existed with no caller at all, so a location was create-only:
 * once made, nothing in the app could rename it, correct its address or switch
 * it off. A typo in a branch name was permanent.
 */
export async function updateLocationAction(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  return runAction(
    updateLocationSchema,
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.BRANCH_MANAGE)
      // A site manager holds BRANCH_MANAGE too, so the permission alone would
      // let them edit any location whose id they could guess.
      await assertBranchAccess(user, data.branchId)

      const before = await requireBranch(user.restaurantId, data.branchId)

      /*
       * The default location is where records with no branch of their own are
       * counted, and `resolveBranchId` only honours a location that is active.
       * Switching the default off would therefore leave the fallback pointing at
       * a closed site, so the swap has to happen the other way round.
       */
      if (data.isActive === false && before.isDefault) {
        throw new AppError(
          'The default location cannot be switched off. Make another location the default first.',
          400,
          'DEFAULT_BRANCH_INACTIVE',
        )
      }

      /*
       * A manager id arriving from the client is never trusted: it is re-read
       * under this restaurant, and the role is checked, so a waiter cannot be
       * installed as a location manager by posting their id.
       */
      let managerId: string | null | undefined
      if (data.managerId !== undefined) {
        managerId = data.managerId || null
        if (managerId) {
          const candidate = await prisma.user.findFirst({
            where: {
              id: managerId,
              restaurantId: user.restaurantId,
              deletedAt: null,
              isActive: true,
            },
            select: { id: true, role: true, permissions: true },
          })
          if (!candidate) throw new NotFoundError('Staff member')
          if (!canManageLocation(candidate)) {
            throw new AppError(
              'Only an owner or a manager can be put in charge of a location',
              400,
              'MANAGER_ROLE',
            )
          }
        }
      }

      const branch = await updateBranch({
        restaurantId: user.restaurantId,
        branchId: data.branchId,
        name: data.name,
        type: data.type,
        address: data.address,
        phone: data.phone,
        isActive: data.isActive,
        openingHours: data.openingHours,
      })

      if (managerId !== undefined) {
        await setBranchManager({
          restaurantId: user.restaurantId,
          branchId: branch.id,
          managerId,
        })
      }

      await audit({
        restaurantId: user.restaurantId, branchId: branch.id, userId: user.id, actorName: user.name,
        action: AUDIT_ACTIONS.UPDATE, entity: 'Branch', entityId: branch.id,
        before: { name: before.name, type: before.type, isActive: before.isActive, managerId: before.managerId },
        after: { name: branch.name, type: data.type, isActive: branch.isActive, managerId },
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
    storageLocationSchema,
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

/**
 * Move the restaurant's default to this location.
 *
 * The default is where anything carrying no branch of its own is counted, and
 * `setDefaultBranch` clears the previous holder in the same transaction so a
 * restaurant is never left with two defaults or none. Until this was wired up
 * the flag was decided once, by whichever location happened to be created
 * first, and could never be moved.
 */
export async function setDefaultLocationAction(branchId: string): Promise<ActionResult<{ ok: true }>> {
  return runSafe(async () => {
    const user = await requirePermission(PERMISSIONS.BRANCH_MANAGE)
    await assertBranchAccess(user, branchId)
    await setDefaultBranch(user.restaurantId, branchId)

    await audit({
      restaurantId: user.restaurantId, branchId, userId: user.id, actorName: user.name,
      action: AUDIT_ACTIONS.UPDATE, entity: 'Branch', entityId: branchId,
      after: { isDefault: true },
    })
    return { ok: true } as const
  }, 'Default location changed.')
}
