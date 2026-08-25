'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'

import { ConflictError, ForbiddenError, NotFoundError } from '@/lib/errors'
import { runAction, type ActionResult } from '@/lib/action'
import { PERMISSIONS, ROLE_LABELS, assignableRoles } from '@/lib/rbac'
import { AUDIT_ACTIONS, audit } from '@/server/audit'
import { requirePermission, assertBranchAccess } from '@/server/auth/guard'
import { generateToken } from '@/server/auth/password'
import { prisma } from '@/server/db/prisma'
import { issueSignInCode } from '@/features/staff/codes'

import { joinUrl } from './links'
import { tenantOrigin } from '@/lib/tenant-url'
import { assertNoEscalation, requireRole, resolveRoleBranch } from './service'
import { createLinkSchema, linkIdSchema } from './link-schema'

function refresh() {
  revalidatePath('/dashboard/links')
}

/**
 * Everything a link hands out has to be something the creator could hand out
 * directly.
 *
 * A link IS an account: walking through one produces a session. So it passes
 * the same four checks the role builder does, plus the person it points at.
 * This endpoint used to skip all of them — `api/dashboard/invites` cast
 * `body.role` straight out of the request body, so `{"role":"ADMIN"}` was one
 * curl away from an administrator session for anybody holding `staff.manage`.
 */
async function vetLink(
  admin: Awaited<ReturnType<typeof requirePermission>>,
  data: z.infer<typeof createLinkSchema>,
) {
  if (!assignableRoles(admin.role).includes(data.role)) {
    throw new ForbiddenError(`You cannot create a link for the ${ROLE_LABELS[data.role]} role`)
  }

  const staffRole = data.staffRoleId
    ? await requireRole(admin.restaurantId, data.staffRoleId)
    : null
  if (staffRole) {
    if (!staffRole.isActive) throw new ConflictError('That role is switched off')
    // Handing out a role is granting it.
    assertNoEscalation(admin, staffRole.permissions)
  }

  /*
   * A link's branch is the one thing that decides whether the account it makes
   * can see anything at all, so it is resolved through the same helper the
   * role builder uses: a preset that `requiresOwnBranch` must have one, and
   * "all locations" is only grantable by somebody who has all of them.
   */
  const branchId = await resolveRoleBranch(
    admin,
    data.branchId ?? staffRole?.branchId ?? null,
    data.role,
  )

  return { staffRole, branchId }
}

export async function createAccessLink(
  input: unknown,
): Promise<ActionResult<{ id: string; url: string; signInCode: string | null }>> {
  return runAction(
    createLinkSchema,
    input,
    async (data) => {
      const admin = await requirePermission(PERMISSIONS.STAFF_MANAGE)
      const { staffRole, branchId } = await vetLink(admin, data)

      let userId: string | null = null
      let signInCode: string | null = null

      if (data.mode === 'PERSONAL') {
        if (!data.userId) throw new ConflictError('Choose who this link is for')
        const person = await prisma.user.findFirst({
          where: { id: data.userId, restaurantId: admin.restaurantId, deletedAt: null },
          select: { id: true, role: true, signInCode: true, branchId: true },
        })
        if (!person) throw new NotFoundError('Member of staff')
        if (person.role === 'OWNER' || !assignableRoles(admin.role).includes(person.role)) {
          throw new ForbiddenError('You cannot create a link for that person')
        }
        await assertBranchAccess(admin, person.branchId)

        userId = person.id
        /*
         * Issue a code if they have none. The code IS the password
         * (`staff/codes.ts`), so this is not a second credential — it is the
         * one they already sign in with, minted on demand so the owner can
         * hand over a working link and code in one go.
         */
        signInCode = person.signInCode ?? (await issueSignInCode(person.id))
      }

      const token = generateToken(24)
      const link = await prisma.invite.create({
        data: {
          token,
          restaurantId: admin.restaurantId,
          role: data.role,
          mode: data.mode,
          branchId,
          staffRoleId: staffRole?.id ?? null,
          userId,
          label: data.label || null,
          expiresAt: data.days ? new Date(Date.now() + data.days * 86_400_000) : null,
          createdById: admin.id,
        },
      })

      await audit({
        restaurantId: admin.restaurantId,
        branchId,
        userId: admin.id,
        actorName: admin.name,
        action: AUDIT_ACTIONS.STAFF_INVITED,
        entity: 'Invite',
        entityId: link.id,
        after: {
          mode: data.mode,
          role: data.role,
          staffRole: staffRole?.name ?? null,
          branchId,
          label: data.label || null,
        },
      })

      refresh()
      const home = await prisma.restaurant.findUnique({
        where: { id: admin.restaurantId },
        select: { customDomain: true, customDomainVerifiedAt: true },
      })
      return { id: link.id, url: joinUrl(token, tenantOrigin(home)), signInCode }
    },
    'Link created.',
  )
}

/** The link, confirmed to be this restaurant's and within the admin's reach. */
async function requireLink(
  admin: Awaited<ReturnType<typeof requirePermission>>,
  id: string,
) {
  const link = await prisma.invite.findFirst({
    where: { id, restaurantId: admin.restaurantId },
  })
  if (!link) throw new NotFoundError('Link')
  // A link pinned to another branch is not this person's to touch.
  await assertBranchAccess(admin, link.branchId)
  return link
}

/**
 * Issue a fresh token and kill the old one.
 *
 * Rolelogic's "regenerate the link". The row is reused rather than replaced so
 * the label, role, branch and usage history survive — what changes is the one
 * thing that leaked.
 */
export async function regenerateAccessLink(
  input: unknown,
): Promise<ActionResult<{ url: string }>> {
  return runAction(
    linkIdSchema,
    input,
    async (data) => {
      const admin = await requirePermission(PERMISSIONS.STAFF_MANAGE)
      await requireLink(admin, data.id)

      const token = generateToken(24)
      await prisma.invite.update({
        where: { id: data.id },
        data: { token, isActive: true, useCount: 0, lastUsedAt: null },
      })

      await audit({
        restaurantId: admin.restaurantId,
        userId: admin.id,
        actorName: admin.name,
        action: AUDIT_ACTIONS.ROLE_UPDATED,
        entity: 'Invite',
        entityId: data.id,
        after: { regenerated: true },
      })

      refresh()
      const home = await prisma.restaurant.findUnique({
        where: { id: admin.restaurantId },
        select: { customDomain: true, customDomainVerifiedAt: true },
      })
      return { url: joinUrl(token, tenantOrigin(home)) }
    },
    'New link issued. The old one no longer works.',
  )
}

/**
 * Issue a fresh sign-in code for the person a personal link points at.
 *
 * Separate from regenerating the link because the two leak separately: a
 * forwarded message exposes the URL, a photographed card exposes the code, and
 * replacing both when only one is compromised means reprinting cards nobody
 * needed to reprint.
 */
export async function regenerateLinkCode(
  input: unknown,
): Promise<ActionResult<{ signInCode: string }>> {
  return runAction(
    linkIdSchema,
    input,
    async (data) => {
      const admin = await requirePermission(PERMISSIONS.STAFF_MANAGE)
      const link = await requireLink(admin, data.id)
      if (!link.userId) throw new ConflictError('This link has no sign-in code')

      const person = await prisma.user.findFirst({
        where: { id: link.userId, restaurantId: admin.restaurantId, deletedAt: null },
        select: { id: true, role: true },
      })
      if (!person) throw new NotFoundError('Member of staff')
      if (person.role === 'OWNER' || !assignableRoles(admin.role).includes(person.role)) {
        throw new ForbiddenError('You cannot change that person’s code')
      }

      const signInCode = await issueSignInCode(person.id)

      await audit({
        restaurantId: admin.restaurantId,
        userId: admin.id,
        actorName: admin.name,
        action: AUDIT_ACTIONS.PASSWORD_CHANGED,
        entity: 'User',
        entityId: person.id,
        after: { signInCodeReissued: true, via: 'access link' },
      })

      refresh()
      return { signInCode }
    },
    'New code issued.',
  )
}

export async function setAccessLinkActive(
  input: unknown,
): Promise<ActionResult<{ isActive: boolean }>> {
  return runAction(
    linkIdSchema.extend({ isActive: z.coerce.boolean() }),
    input,
    async (data) => {
      const admin = await requirePermission(PERMISSIONS.STAFF_MANAGE)
      await requireLink(admin, data.id)

      await prisma.invite.update({
        where: { id: data.id },
        data: { isActive: data.isActive },
      })

      refresh()
      return { isActive: data.isActive }
    },
  )
}

/**
 * Revoke a link for good.
 *
 * Deleted rather than switched off, because "revoke" should not leave a row
 * somebody can switch back on. Switching off is the reversible one and has its
 * own action above.
 */
export async function revokeAccessLink(input: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction(
    linkIdSchema,
    input,
    async (data) => {
      const admin = await requirePermission(PERMISSIONS.STAFF_MANAGE)
      const link = await requireLink(admin, data.id)

      await prisma.invite.delete({ where: { id: data.id } })

      await audit({
        restaurantId: admin.restaurantId,
        branchId: link.branchId,
        userId: admin.id,
        actorName: admin.name,
        action: AUDIT_ACTIONS.ROLE_DELETED,
        entity: 'Invite',
        entityId: data.id,
        before: { mode: link.mode, role: link.role, label: link.label },
      })

      refresh()
      return { id: data.id }
    },
    'Link revoked.',
  )
}
