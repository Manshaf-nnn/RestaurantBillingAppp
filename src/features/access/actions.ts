'use server'

import { revalidatePath } from 'next/cache'

import { ConflictError, ForbiddenError } from '@/lib/errors'
import { runAction, type ActionResult } from '@/lib/action'
import { PERMISSIONS, ROLE_LABELS, assignableRoles } from '@/lib/rbac'
import type { UserRole } from '@prisma/client'
import { AUDIT_ACTIONS, audit } from '@/server/audit'
import { requirePermission } from '@/server/auth/guard'
import { prisma } from '@/server/db/prisma'

import {
  assertNoEscalation,
  assertPresetScopeAllowed,
  requireRole,
  resolveRoleBranch,
  templateFor,
} from './service'
import {
  assignRoleSchema,
  createRoleSchema,
  deleteRoleSchema,
  duplicateRoleSchema,
  setRoleActiveSchema,
  updateRoleSchema,
} from './schema'

/*
 * Nothing but async functions may be exported from a 'use server' module —
 * Next turns every export into a callable server reference, and a stray
 * constant takes every action in the file down with it. The schemas and the
 * service live in siblings for that reason; see `no-bad-server-exports.ts`.
 */

function refresh() {
  revalidatePath('/dashboard/roles')
  revalidatePath('/dashboard/staff')
}

/**
 * Every guard a role change has to pass, in one place.
 *
 * Four separate questions, and getting any of them wrong is an escalation:
 *
 *   rank      may this person hand out this preset at all (`assignableRoles`)
 *   reach     does the preset see more locations than they do
 *   location  is the branch one they may write to
 *   power     is every permission one they themselves hold
 *
 * They were written as one helper because create, update and duplicate all
 * need the same four, and three copies is how one of them ends up missing a
 * check that the other two have.
 */
async function vet(
  admin: Awaited<ReturnType<typeof requirePermission>>,
  input: { preset: UserRole; branchId?: string | null; permissions: string[] },
) {
  if (!assignableRoles(admin.role).includes(input.preset)) {
    throw new ForbiddenError(
      `You cannot create a role based on ${ROLE_LABELS[input.preset]}`,
    )
  }
  assertPresetScopeAllowed(admin, input.preset)
  assertNoEscalation(admin, input.permissions)
  return resolveRoleBranch(admin, input.branchId, input.preset)
}

/** A name is unique per restaurant, and the error should say so plainly. */
async function assertNameFree(restaurantId: string, name: string, exceptId?: string) {
  const clash = await prisma.staffRole.findFirst({
    where: {
      restaurantId,
      name,
      deletedAt: null,
      ...(exceptId ? { id: { not: exceptId } } : {}),
    },
    select: { id: true },
  })
  if (clash) throw new ConflictError(`You already have a role called “${name}”`)
}

export async function createRole(input: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction(
    createRoleSchema,
    input,
    async (data) => {
      const admin = await requirePermission(PERMISSIONS.STAFF_MANAGE)
      const branchId = await vet(admin, data)
      await assertNameFree(admin.restaurantId, data.name)

      const role = await prisma.staffRole.create({
        data: {
          restaurantId: admin.restaurantId,
          name: data.name,
          description: data.description || null,
          preset: data.preset,
          branchId,
          permissions: data.permissions,
          createdById: admin.id,
        },
      })

      await audit({
        restaurantId: admin.restaurantId,
        branchId,
        userId: admin.id,
        actorName: admin.name,
        action: AUDIT_ACTIONS.ROLE_CREATED,
        entity: 'StaffRole',
        entityId: role.id,
        after: { name: role.name, preset: role.preset, permissions: role.permissions },
      })

      refresh()
      return { id: role.id }
    },
    'Role created.',
  )
}

export async function updateRole(input: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction(
    updateRoleSchema,
    input,
    async (data) => {
      const admin = await requirePermission(PERMISSIONS.STAFF_MANAGE)
      const existing = await requireRole(admin.restaurantId, data.id)

      /*
       * The role as it stands is vetted too, not only the new list.
       *
       * A manager who may not grant `settings.manage` must not be able to
       * take over a role that already carries it — editing the name would
       * otherwise be a way to adopt somebody else's powerful role and then
       * assign it. So the check runs against the union: what it had, and what
       * it is being given.
       */
      assertNoEscalation(admin, [...existing.permissions, ...data.permissions])

      const branchId = await vet(admin, data)
      await assertNameFree(admin.restaurantId, data.name, data.id)

      const role = await prisma.staffRole.update({
        where: { id: data.id },
        data: {
          name: data.name,
          description: data.description || null,
          preset: data.preset,
          branchId,
          permissions: data.permissions,
          isActive: data.isActive,
        },
      })

      await audit({
        restaurantId: admin.restaurantId,
        branchId,
        userId: admin.id,
        actorName: admin.name,
        action: AUDIT_ACTIONS.ROLE_UPDATED,
        entity: 'StaffRole',
        entityId: role.id,
        before: { name: existing.name, permissions: existing.permissions, isActive: existing.isActive },
        after: { name: role.name, permissions: role.permissions, isActive: role.isActive },
      })

      /*
       * Members feel this on their next request with no re-login, because the
       * session re-reads permissions every time. Nothing to invalidate.
       */
      refresh()
      return { id: role.id }
    },
    'Role updated.',
  )
}

/**
 * Start a new role from an existing one, or from a built-in.
 *
 * Rolelogic asks for both: "duplicate an existing role as a template", and a
 * list of predefined roles to begin from. The two are treated differently on
 * purpose — see the comments inside.
 */
export async function duplicateRole(input: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction(
    duplicateRoleSchema,
    input,
    async (data) => {
      const admin = await requirePermission(PERMISSIONS.STAFF_MANAGE)

      let preset: UserRole
      let permissions: string[]
      let branchId: string | null = null
      let description: string | null = null

      if (data.sourceRoleId) {
        /*
         * Copying a REAL role is exact, and `vet` below refuses it outright if
         * it carries anything this person cannot grant. Silently trimming
         * somebody else's role would produce a copy that quietly does less
         * than the thing it was named after, which is worse than being told
         * no.
         */
        const source = await requireRole(admin.restaurantId, data.sourceRoleId)
        preset = source.preset
        permissions = source.permissions
        branchId = source.branchId
        description = source.description
      } else if (data.sourcePreset) {
        /*
         * A built-in is a STARTING POINT rather than a copy of anything, so it
         * is narrowed to what this person holds instead of refused — a manager
         * cloning Administrator gets a manager's version and can carry on.
         */
        preset = data.sourcePreset
        permissions = templateFor(admin, data.sourcePreset)
      } else {
        throw new ForbiddenError('Choose a role or a template to copy')
      }

      // The copy is vetted exactly as a fresh one, so duplicating cannot be a
      // way around any of the four checks.
      const resolved = await vet(admin, { preset, branchId, permissions })
      await assertNameFree(admin.restaurantId, data.name)

      const role = await prisma.staffRole.create({
        data: {
          restaurantId: admin.restaurantId,
          name: data.name,
          description,
          preset,
          branchId: resolved,
          permissions,
          createdById: admin.id,
        },
      })

      await audit({
        restaurantId: admin.restaurantId,
        branchId: resolved,
        userId: admin.id,
        actorName: admin.name,
        action: AUDIT_ACTIONS.ROLE_CREATED,
        entity: 'StaffRole',
        entityId: role.id,
        after: { name: role.name, copiedFrom: data.sourceRoleId ?? data.sourcePreset },
      })

      refresh()
      return { id: role.id }
    },
    'Role copied.',
  )
}

export async function setRoleActive(input: unknown): Promise<ActionResult<{ isActive: boolean }>> {
  return runAction(
    setRoleActiveSchema,
    input,
    async (data) => {
      const admin = await requirePermission(PERMISSIONS.STAFF_MANAGE)
      const existing = await requireRole(admin.restaurantId, data.id)
      assertNoEscalation(admin, existing.permissions)

      const role = await prisma.staffRole.update({
        where: { id: data.id },
        data: { isActive: data.isActive },
      })

      await audit({
        restaurantId: admin.restaurantId,
        userId: admin.id,
        actorName: admin.name,
        action: AUDIT_ACTIONS.ROLE_UPDATED,
        entity: 'StaffRole',
        entityId: role.id,
        before: { isActive: existing.isActive },
        after: { isActive: role.isActive },
      })

      refresh()
      return { isActive: role.isActive }
    },
  )
}

/**
 * Remove a role.
 *
 * Soft-deleted, and the members are demoted to their preset rather than left
 * pointing at a row that no longer resolves. The database would do the second
 * half on its own — the foreign key is ON DELETE SET NULL — but a soft delete
 * does not fire it, so it is done here explicitly.
 */
export async function deleteRole(input: unknown): Promise<ActionResult<{ demoted: number }>> {
  return runAction(
    deleteRoleSchema,
    input,
    async (data) => {
      const admin = await requirePermission(PERMISSIONS.STAFF_MANAGE)
      const existing = await requireRole(admin.restaurantId, data.id)
      assertNoEscalation(admin, existing.permissions)

      const [demoted] = await prisma.$transaction([
        prisma.user.updateMany({
          where: { staffRoleId: data.id, restaurantId: admin.restaurantId },
          data: { staffRoleId: null },
        }),
        prisma.staffRole.update({
          where: { id: data.id },
          data: { deletedAt: new Date(), isActive: false },
        }),
      ])

      await audit({
        restaurantId: admin.restaurantId,
        userId: admin.id,
        actorName: admin.name,
        action: AUDIT_ACTIONS.ROLE_DELETED,
        entity: 'StaffRole',
        entityId: data.id,
        before: { name: existing.name, permissions: existing.permissions },
        after: { demoted: demoted.count },
      })

      refresh()
      return { demoted: demoted.count }
    },
    'Role removed.',
  )
}

/** Put somebody in a role, or take them out of one. */
export async function assignRole(input: unknown): Promise<ActionResult<{ userId: string }>> {
  return runAction(
    assignRoleSchema,
    input,
    async (data) => {
      const admin = await requirePermission(PERMISSIONS.STAFF_MANAGE)

      const target = await prisma.user.findFirst({
        where: { id: data.userId, restaurantId: admin.restaurantId, deletedAt: null },
        select: { id: true, role: true, staffRoleId: true, name: true },
      })
      if (!target) throw new ForbiddenError('No such member of staff')

      // The same rank rule as editing them any other way: an owner's account
      // is not somebody a manager may re-scope.
      if (target.role === 'OWNER' || !assignableRoles(admin.role).includes(target.role)) {
        throw new ForbiddenError('You cannot change that person’s access')
      }

      if (data.staffRoleId) {
        const role = await requireRole(admin.restaurantId, data.staffRoleId)
        if (!role.isActive) throw new ConflictError('That role is switched off')
        // Assigning is granting, so it passes the same power check as building.
        assertNoEscalation(admin, role.permissions)
      }

      await prisma.user.update({
        where: { id: data.userId },
        data: { staffRoleId: data.staffRoleId ?? null },
      })

      await audit({
        restaurantId: admin.restaurantId,
        userId: admin.id,
        actorName: admin.name,
        action: AUDIT_ACTIONS.ROLE_ASSIGNED,
        entity: 'User',
        entityId: target.id,
        before: { staffRoleId: target.staffRoleId },
        after: { staffRoleId: data.staffRoleId ?? null, staff: target.name },
      })

      refresh()
      return { userId: target.id }
    },
    'Access updated.',
  )
}
