'use server'

import { runAction, runSafe, type ActionResult } from '@/lib/action'
import { AppError, ForbiddenError, NotFoundError } from '@/lib/errors'
import { PERMISSIONS, assignableRoles, canManageLocation } from '@/lib/rbac'
import { AUDIT_ACTIONS, audit } from '@/server/audit'
import { assertBranchAccess, assertRecordBranch, requirePermission } from '@/server/auth/guard'
import { hashPassword } from '@/server/auth/password'
import { prisma } from '@/server/db/prisma'
import { tenantOrigin } from '@/lib/tenant-url'
import { requireRestaurant } from '@/server/db/tenant'
import { generateSignInCode, nextStaffCode } from '@/features/staff/codes'
import { sendMail, staffInviteEmail } from '@/server/mailer'
import {
  locationFeaturesSchema,
  locationSchema,
  storageLocationSchema,
  updateLocationSchema,
  updateStorageLocationSchema,
} from './schema'
import {
  assertNoEscalation,
  assertPresetScopeAllowed,
  resolveRoleBranch,
} from '@/features/access/service'
import { assignRole } from '@/features/access/actions'
import {
  createLocationWithManager,
  locationRemovalBlockers,
  removeBranch,
  requireBranch,
  setBranchManager,
  setDefaultBranch,
  updateBranch,
  type RemovalBlocker,
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
export async function createLocationAction(input: unknown): Promise<
  ActionResult<{
    id: string
    name: string
    /** Returned once, so the owner can hand the card over. Never fetched again. */
    manager: { name: string; email: string; signInCode: string; emailed: boolean } | null
  }>
> {
  return runAction(locationSchema, input, async (data) => {
    const user = await requirePermission(PERMISSIONS.BRANCH_MANAGE)

    /*
     * Minting a manager is a bigger power than adding a location, so it is
     * checked separately and by the same rank rule the Staff screen uses:
     * nobody may create their own rank or above. A site manager can hold
     * BRANCH_MANAGE and still must not be able to create another manager.
     *
     * Checked here rather than left to the Staff service so the refusal is a
     * sentence about what happened, not a schema error about a field.
     */
    if (data.managerMode === 'NEW' && !assignableRoles(user.role).includes('MANAGER')) {
      throw new ForbiddenError('Only an owner or admin can create a manager account')
    }
    if (data.managerMode === 'EXISTING' && data.managerId) {
      const candidate = await prisma.user.findFirst({
        where: { id: data.managerId, restaurantId: user.restaurantId, deletedAt: null },
        select: { role: true, permissions: true },
      })
      if (!candidate) throw new NotFoundError('Manager')
      // Never trust the posted id: re-check that this person may actually run a
      // location, exactly as the edit path does.
      if (!canManageLocation(candidate)) {
        throw new AppError('That person cannot manage a location', 400, 'MANAGER_ROLE')
      }
    }

    const result = await createLocationWithManager({
      restaurantId: user.restaurantId,
      name: data.name,
      code: data.code,
      type: data.type,
      address: data.address || null,
      phone: data.phone || null,
      manager:
        data.managerMode === 'NEW'
          ? {
              mode: 'NEW',
              name: data.managerName ?? '',
              email: data.managerEmail ?? '',
              phone: data.managerPhone || null,
            }
          : data.managerMode === 'EXISTING' && data.managerId
            ? { mode: 'EXISTING', userId: data.managerId }
            : { mode: 'NONE' },
      // The same helpers the Staff screen uses, so there is one kind of
      // credential in this system and not two.
      issueCredentials: async () => {
        const signInCode = generateSignInCode()
        return { signInCode, passwordHash: await hashPassword(signInCode) }
      },
      nextStaffCode: (tx) => nextStaffCode(tx, user.restaurantId),
    })

    const branch = result.branch
    let emailed = false

    if (result.created) {
      const restaurant = await requireRestaurant(user.restaurantId)
      const sent = await sendMail({
        to: result.created.email,
        ...staffInviteEmail({
          name: result.created.name,
          restaurantName: restaurant.name,
          email: result.created.email,
          temporaryPassword: result.created.signInCode,
          role: 'MANAGER',
        }),
      })
      emailed = sent.sent

      await audit({
        restaurantId: user.restaurantId,
        branchId: branch.id,
        userId: user.id,
        actorName: user.name,
        action: AUDIT_ACTIONS.STAFF_INVITED,
        entity: 'User',
        entityId: result.created.userId,
        // The code itself is never audited — the audit log is widely readable.
        after: { email: result.created.email, role: 'MANAGER', branchId: branch.id },
      })
    }

    await audit({
      restaurantId: user.restaurantId, branchId: branch.id, userId: user.id, actorName: user.name,
      action: AUDIT_ACTIONS.CREATE, entity: 'Branch', entityId: branch.id,
      after: {
        name: branch.name,
        code: branch.code,
        type: data.type,
        managerId: branch.managerId,
      },
    })

    return {
      id: branch.id,
      name: branch.name,
      manager: result.created
        ? {
            name: result.created.name,
            email: result.created.email,
            signInCode: result.created.signInCode,
            emailed,
          }
        : null,
    }
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
            /*
       * Switching a location off strands whatever is still happening there.
       *
       * The only check was the default-branch one below. A site with an open
       * till or a half-eaten dinner could be switched off from under the people
       * standing in it: the branch vanishes from the switcher and from
       * `resolveBranchId`, so nobody can reach the drawer to close it.
       *
       * Stock and staff are deliberately NOT blockers here — unlike removal.
       * Switching off is the reversible option, and "we are closed for
       * refurbishment, the stock stays on the shelf" is exactly what it is for.
       */
      if (data.isActive === false && !before.isDefault) {
        const [openOrders, openDrawers] = await Promise.all([
          prisma.order.count({
            where: { branchId: data.branchId, status: { notIn: ['COMPLETED', 'CANCELLED'] } },
          }),
          prisma.cashDrawerSession.count({ where: { branchId: data.branchId, status: 'OPEN' } }),
        ])
        if (openOrders > 0 || openDrawers > 0) {
          const parts = [
            openOrders > 0 ? `${openOrders} open order${openOrders === 1 ? '' : 's'}` : null,
            openDrawers > 0 ? `${openDrawers} open cash drawer${openDrawers === 1 ? '' : 's'}` : null,
          ].filter(Boolean)
          throw new AppError(
            `Finish up here first — this location still has ${parts.join(' and ')}.`,
            409,
            'BRANCH_STILL_BUSY',
          )
        }
      }

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
 * Rename a storage area, or take it out of use.
 *
 * Storage areas could be created and then never touched again — no rename, no
 * deactivate, no remove — so a typo in "Cold Room" was permanent and a shelf
 * that had been torn out stayed in every picker.
 *
 * The branch is deliberately not editable. A shelf does not move between
 * buildings, and letting it would silently relocate every batch, count and
 * receipt recorded against it.
 */
export async function updateStorageLocationAction(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  return runAction(
    updateStorageLocationSchema,
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.BRANCH_MANAGE)

      const store = await prisma.storageLocation.findFirst({
        where: { id: data.storageLocationId, restaurantId: user.restaurantId, deletedAt: null },
        select: { id: true, branchId: true, name: true },
      })
      if (!store) throw new NotFoundError('Storage area')
      await assertRecordBranch(user, store, 'storage area')

      await prisma.storageLocation.update({
        where: { id: store.id },
        data: {
          ...(data.name !== undefined ? { name: data.name } : {}),
          ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
        },
      })
      return { id: store.id }
    },
    'Storage area updated.',
  )
}

/**
 * Remove a storage area.
 *
 * Refused while it still holds stock — the same rule as a location, for the
 * same reason: the shelf is where a balance lives, and deleting it would leave
 * the stock recorded nowhere. Soft, so the movements that reference it stay
 * readable.
 */
export async function removeStorageLocationAction(
  storageLocationId: string,
): Promise<ActionResult<{ id: string }>> {
  return runSafe(async () => {
    const user = await requirePermission(PERMISSIONS.BRANCH_MANAGE)

    const store = await prisma.storageLocation.findFirst({
      where: { id: storageLocationId, restaurantId: user.restaurantId, deletedAt: null },
      select: { id: true, branchId: true, name: true, isDefault: true },
    })
    if (!store) throw new NotFoundError('Storage area')
    await assertRecordBranch(user, store, 'storage area')

    if (store.isDefault) {
      throw new AppError(
        'This is the default storage area for its location — make another one the default first.',
        409,
        'STORAGE_IS_DEFAULT',
      )
    }

    const held = await prisma.inventoryStock.count({
      where: {
        storageLocationId,
        OR: [{ available: { not: 0 } }, { reserved: { not: 0 } }, { inTransit: { not: 0 } }],
      },
    })
    if (held > 0) {
      throw new AppError(
        `${held} item${held === 1 ? '' : 's'} still hold stock on this shelf — move it first.`,
        409,
        'STORAGE_HAS_STOCK',
      )
    }

    await prisma.storageLocation.update({
      where: { id: store.id },
      data: { deletedAt: new Date(), isActive: false },
    })
    return { id: store.id }
  }, 'Storage area removed.')
}

/**
 * What is standing in the way of removing a location, if anything.
 *
 * Read before the button is offered, so the screen can say "3 items still hold
 * stock here" rather than presenting a delete that will fail.
 */
export async function locationRemovalBlockersAction(
  branchId: string,
): Promise<ActionResult<{ blockers: RemovalBlocker[] }>> {
  return runSafe(async () => {
    const user = await requirePermission(PERMISSIONS.BRANCH_MANAGE)
    await assertBranchAccess(user, branchId)
    return { blockers: await locationRemovalBlockers(user.restaurantId, branchId) }
  })
}

/**
 * Remove a location.
 *
 * Soft — the history stays readable — and refused outright while anything is
 * still live there. The refusal names what is in the way; see
 * `locationRemovalBlockers`.
 */
export async function removeLocationAction(branchId: string): Promise<ActionResult<{ id: string }>> {
  return runSafe(async () => {
    const user = await requirePermission(PERMISSIONS.BRANCH_MANAGE)
    await assertBranchAccess(user, branchId)
    const before = await requireBranch(user.restaurantId, branchId)

    const result = await removeBranch({ restaurantId: user.restaurantId, branchId })

    await audit({
      restaurantId: user.restaurantId,
      branchId,
      userId: user.id,
      actorName: user.name,
      action: AUDIT_ACTIONS.DELETE,
      entity: 'Branch',
      entityId: branchId,
      before: { name: before.name, code: before.code, isActive: before.isActive },
      after: { removed: true },
    })

    return result
  }, 'Location removed.')
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

/**
 * Set what this location's manager can do.
 *
 * ── One permission system, reached from two screens ─────────────────────────
 *
 * The grid on the Locations screen writes an ordinary `StaffRole` — pinned to
 * this branch, based on MANAGER — and assigns it to whoever manages the place.
 * Nothing new is invented: the role is editable afterwards under Roles &
 * access, it resolves through the same `permissionsFor`, and it drives the same
 * sidebar. `Branch.staffRoles` has existed since the model was written and was
 * never queried from the Branch side; this is what it is for.
 *
 * ── The escalation check is the whole point ─────────────────────────────────
 *
 * `BRANCH_MANAGE` is held by site managers (`rbac.ts:503-505`), and this screen
 * hands out permissions. Without `assertNoEscalation` a branch manager could
 * open their own location page and grant themselves `settings.manage` — a
 * privilege escalation reachable in three clicks by design rather than by bug.
 * `assertPresetScopeAllowed` and `resolveRoleBranch` are the two other guards
 * the roles screen runs, and they run here for the same reasons.
 */
export async function setLocationFeaturesAction(
  input: unknown,
): Promise<ActionResult<{ roleId: string; assigned: boolean }>> {
  return runAction(
    locationFeaturesSchema,
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.BRANCH_MANAGE)
      await assertBranchAccess(user, data.branchId)

      const branch = await requireBranch(user.restaurantId, data.branchId)

      // Handing a permission out is granting it.
      assertNoEscalation(user, data.permissions)
      assertPresetScopeAllowed(user, 'MANAGER')
      // Re-resolves the branch through the same helper the role builder uses,
      // so a pin this person may not set is refused here too.
      const branchId = await resolveRoleBranch(user, branch.id, 'MANAGER')

      /*
       * One role per location, found by its pin rather than by its name.
       *
       * Matching on the name would break the moment somebody renamed the
       * location or the role, and would then quietly create a second role for
       * the same branch — two answers to one question, which is the failure
       * this whole change exists to remove.
       */
      const existing = await prisma.staffRole.findFirst({
        where: {
          restaurantId: user.restaurantId,
          branchId,
          preset: 'MANAGER',
          deletedAt: null,
        },
        orderBy: { createdAt: 'asc' },
      })

      const name = `${branch.name} manager`
      const role = existing
        ? await prisma.staffRole.update({
            where: { id: existing.id },
            data: { permissions: data.permissions, isActive: true },
          })
        : await prisma.staffRole.create({
            data: {
              restaurantId: user.restaurantId,
              // The unique index is `[restaurantId, name]`, and two locations
              // can share a name in principle. The code disambiguates.
              name: `${name} (${branch.code})`,
              description: `What the manager of ${branch.name} can do.`,
              preset: 'MANAGER',
              branchId,
              permissions: data.permissions,
              createdById: user.id,
            },
          })

      /*
       * Assign it, when there is somebody to assign it to. `assignRole` writes
       * the base role and the branch onto the person as well as the role id —
       * the fix from `629c0fc` — so this is the whole story, not half of it.
       */
      let assigned = false
      if (branch.managerId) {
        const result = await assignRole({ userId: branch.managerId, staffRoleId: role.id })
        assigned = result.ok
      }

      await audit({
        restaurantId: user.restaurantId,
        branchId,
        userId: user.id,
        actorName: user.name,
        action: AUDIT_ACTIONS.ROLE_UPDATED,
        entity: 'StaffRole',
        entityId: role.id,
        after: {
          location: branch.name,
          role: role.name,
          permissions: data.permissions.length,
          assignedTo: assigned ? branch.managerId : null,
        },
      })

      return { roleId: role.id, assigned }
    },
    'Saved.',
  )
}
