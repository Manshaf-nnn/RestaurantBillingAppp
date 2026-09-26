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
  commitAssignment,
  mintRoleLink,
  planAssignment,
  requireRole,
  resolveRoleBranch,
  templateFor,
  type AssignmentPlan,
} from './service'
import { inferPreset, withRequiredPermissions } from './sidebar-access'
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
 * "Start from scratch" still has to land somewhere.
 *
 * The preset decides the landing page, what the edge middleware lets through
 * and whether the member is confined to one site — so a role without one could
 * not sign in. It used to be "the built-in with the fewest permissions", which
 * was Kitchen for everyone, and a Kitchen-based role with POS ticked was a tab
 * the edge refused on every click. Now it is inferred from what was ticked
 * (`inferPreset`): a preset the edge lets into every gated tab that is on,
 * confined by the location when one was chosen, landing on one of its own tabs
 * where it can.
 *
 * Narrowed to what this admin may assign, so the inference can never hand out
 * a landing page they could not have chosen themselves.
 */
function presetFor(
  admin: Awaited<ReturnType<typeof requirePermission>>,
  permissions: string[],
  branchId: string | null | undefined,
): UserRole {
  const options = assignableRoles(admin.role)
  if (options.length === 0) throw new ForbiddenError('You cannot create roles')

  const { preset, blockedBy } = inferPreset(permissions, options, branchId)
  if (preset) return preset
  throw new ForbiddenError(
    `Nothing you can assign opens ${blockedBy.map((m) => m.label).join(' and ')} together — untick one of them.`,
  )
}

/**
 * Every guard a role change has to pass, in one place.
 *
 * Five separate questions, and getting any of them wrong is an escalation or
 * a role that cannot do its job:
 *
 *   rank      may this person hand out this preset at all (`assignableRoles`)
 *   reach     does the preset see more locations than they do
 *   needs     does the list carry what its own tabs require — POS without
 *             Payment details is closed over here, whatever the client sent
 *   power     is every permission one they themselves hold
 *   location  is the branch one they may write to
 *
 * They were written as one helper because create, update and duplicate all
 * need the same five, and three copies is how one of them ends up missing a
 * check that the other two have. The closure runs BEFORE the power check, so
 * a dependency the admin cannot grant refuses the role rather than being
 * quietly left out of it.
 */
async function vet(
  admin: Awaited<ReturnType<typeof requirePermission>>,
  input: { preset?: UserRole | '' | null; branchId?: string | null; permissions: string[] },
) {
  const preset = input.preset || presetFor(admin, input.permissions, input.branchId)

  if (!assignableRoles(admin.role).includes(preset)) {
    throw new ForbiddenError(
      `You cannot create a role based on ${ROLE_LABELS[preset]}`,
    )
  }
  assertPresetScopeAllowed(admin, preset)
  const permissions = withRequiredPermissions(input.permissions, preset)
  assertNoEscalation(admin, permissions)
  const branchId = await resolveRoleBranch(admin, input.branchId, preset)
  // The caller writes the row, so it needs what was settled here — the preset
  // rather than the blank it sent, and the list with its dependencies in it.
  return { branchId, preset, permissions }
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

export async function createRole(
  input: unknown,
): Promise<ActionResult<{ id: string; assigned: number }>> {
  return runAction(
    createRoleSchema,
    input,
    async (data) => {
      const admin = await requirePermission(PERMISSIONS.STAFF_MANAGE)
      const { branchId, preset, permissions } = await vet(admin, data)
      await assertNameFree(admin.restaurantId, data.name)

      /*
       * Every person is vetted BEFORE the role exists — tenant, location,
       * rank, status, and a home site for a preset that needs one — so a
       * refused name leaves nothing behind. Role = what they can access;
       * location = where they can operate; both are settled here.
       */
      const shape = { preset, branchId, isActive: true, permissions }
      const plans: AssignmentPlan[] = []
      for (const row of data.assignments ?? []) {
        plans.push(
          await planAssignment(
            admin,
            { userId: row.userId, branchId: row.branchId, requireActive: true },
            shape,
          ),
        )
      }

      const role = await prisma.staffRole.create({
        data: {
          restaurantId: admin.restaurantId,
          name: data.name,
          description: data.description || null,
          preset,
          branchId,
          permissions,
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

      // Connected straight away: the role is theirs on their next request.
      for (const plan of plans) await commitAssignment(admin, plan, role.id)

      /*
       * A role comes WITH its sign-in link (sidebar.md — role links).
       *
       * Everything needed to make one already existed and reaching it meant
       * leaving this screen for another, so the link every role obviously
       * wants was the one nobody made. Minting it here is what makes the role
       * usable the moment it is saved.
       *
       * Deliberately not fatal. The role is the thing being created and it is
       * already written; a link that could not be minted — a branch rule the
       * preset refuses, say — leaves a "Create sign-in link" button on the
       * card rather than losing the owner's work to an error about something
       * they did not ask for.
       */
      await mintRoleLink(admin, role.id).catch(() => undefined)

      refresh()
      return { id: role.id, assigned: plans.length }
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

      const { branchId, preset, permissions } = await vet(admin, data)
      await assertNameFree(admin.restaurantId, data.name, data.id)

      const role = await prisma.staffRole.update({
        where: { id: data.id },
        data: {
          name: data.name,
          description: data.description || null,
          preset,
          branchId,
          permissions,
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
          branchId: resolved.branchId,
          permissions: resolved.permissions,
          createdById: admin.id,
        },
      })

      await audit({
        restaurantId: admin.restaurantId,
        branchId: resolved.branchId,
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

/**
 * Put somebody in a role, or take them out of one.
 *
 * The guards and the write live in `planAssignment` / `commitAssignment`, so
 * that Create Role — which puts several people on a role that does not exist
 * yet — runs exactly the same checks rather than a second copy of them.
 */
export async function assignRole(input: unknown): Promise<ActionResult<{ userId: string }>> {
  return runAction(
    assignRoleSchema,
    input,
    async (data) => {
      const admin = await requirePermission(PERMISSIONS.STAFF_MANAGE)
      const role = data.staffRoleId ? await requireRole(admin.restaurantId, data.staffRoleId) : null
      const plan = await planAssignment(admin, { userId: data.userId, branchId: data.branchId }, role)
      await commitAssignment(admin, plan, data.staffRoleId ?? null)

      refresh()
      return { userId: plan.target.id }
    },
    'Access updated.',
  )
}
