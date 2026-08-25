'use server'

import type { UserRole } from '@prisma/client'
import { revalidatePath } from 'next/cache'
import { generateSignInCode, issueSignInCode, nextStaffCode } from './codes'

import { runAction, runSafe, type ActionResult } from '@/lib/action'
import { requireBranch } from '@/features/branches/service'
import { assertNoEscalation, requireRole } from '@/features/access/service'
import { AppError, ConflictError, ForbiddenError, NotFoundError } from '@/lib/errors'
import {
  assignableRoles,
  canManageLocation,
  PERMISSIONS,
  ROLE_LABELS,
  requiresOwnBranch,
  seesAllLocations,
  visibleBranchIds,
} from '@/lib/rbac'
import { tenantOrigin } from '@/lib/tenant-url'
import { AUDIT_ACTIONS, audit } from '@/server/audit'
import {
  assertBranchAccess,
  assertRecordBranch,
  requirePermission,
  type TenantUser,
} from '@/server/auth/guard'
import { hashPassword } from '@/server/auth/password'
import { isUniqueViolation, prisma } from '@/server/db/prisma'
import { sendMail, staffInviteEmail } from '@/server/mailer'
import { requireRestaurant } from '@/server/db/tenant'
import {
  adjustLoyaltySchema,
  couponSchema,
  customerSchema,
  inviteStaffSchema,
  setStaffPasswordSchema,
  replyReviewSchema,
  updateStaffSchema,
} from './schema'

// ── staff ────────────────────────────────────────────────────────────────────

/**
 * Which location a member of staff works at, checked before it is written.
 *
 * Not exported: a 'use server' module may only export async functions that are
 * meant to be callable from a browser, and this is neither.
 *
 * A branch id from the form is re-read under the acting admin's own restaurant,
 * so a guessed id from another tenant resolves to nothing rather than tying
 * someone across the boundary. `assertBranchAccess` is the second half: a site
 * manager holds STAFF_MANAGE as well, and without it could post another site's
 * id and staff a location they do not run.
 */
async function homeBranchFor(
  admin: TenantUser,
  branchId: string | null | undefined,
  /** The role being given to the account, not the admin's own. */
  role: UserRole,
): Promise<string | null> {
  const reach = visibleBranchIds({ role: admin.role, branchId: admin.branchId })

  if (!branchId) {
    /*
     * Some roles cannot use "every location" — it blinds them.
     *
     * This function only ever asked whether the ADMIN was allowed to grant
     * every location. It never asked whether the new account's role could make
     * any sense of one. For a chef, cashier or waiter `visibleBranchIds`
     * returns `[]` with no branch, so an owner — who may grant anything —
     * could create an account whose every screen is empty, and find out when
     * somebody stood in front of one.
     */
    if (requiresOwnBranch(role)) {
      throw new ForbiddenError(
        `A ${ROLE_LABELS[role].toLowerCase()} must be assigned to a location — without one their screens show nothing at all.`,
      )
    }

    /*
     * "Every location" is only somebody's to grant if they have every location.
     *
     * This used to `return null` unconditionally, and that was an escalation
     * rather than a convenience: a manager confined to Kandy could create an
     * account with no branch, which sees the whole group. Combined with the
     * role rule below it meant a Kandy manager could mint an accountant who
     * reads every branch's revenue, payments and audit log — more reach than
     * the person who created them.
     */
    if (reach === null) return null
    throw new ForbiddenError(
      'You can only add people to your own location — leave the location blank only if you oversee all of them',
    )
  }

  await assertBranchAccess(admin, branchId)
  const branch = await requireBranch(admin.restaurantId, branchId)
  return branch.id
}

/**
 * Nobody may create an account that sees more than they do.
 *
 * The rank rule (`assignableRoles`) stops a manager minting another manager,
 * but rank is not reach: `ACCOUNTANT`, `INVENTORY_MANAGER` and
 * `PURCHASING_MANAGER` are all assignable by a manager AND are all
 * cross-location roles, so a site manager could grant sight of every branch
 * while being confined to one themselves.
 */
function assertScopeAllowed(admin: TenantUser, role: UserRole) {
  const reach = visibleBranchIds({ role: admin.role, branchId: admin.branchId })
  if (reach === null) return

  // Would this role see every location regardless of the branch we pin them to?
  if (seesAllLocations(role, null) && !SITE_SCOPED_WHEN_BRANCH.includes(role)) {
    throw new ForbiddenError(
      `You cannot create a ${ROLE_LABELS[role].toLowerCase()} — that role sees every location and you do not`,
    )
  }
}

/**
 * Roles that see everything only while unassigned, and are confined the moment
 * they are given a branch. Safe for a site manager to create, because the
 * branch check above guarantees they are given one.
 */
const SITE_SCOPED_WHEN_BRANCH: UserRole[] = ['MANAGER']

export async function inviteStaff(
  input: unknown,
): Promise<ActionResult<{ id: string; temporaryPassword: string; emailed: boolean }>> {
  return runAction(
    inviteStaffSchema,
    input,
    async (data) => {
      const admin = await requirePermission(PERMISSIONS.STAFF_MANAGE)
      const restaurant = await requireRestaurant(admin.restaurantId)

      /*
       * A custom role decides the base role, not the form.
       *
       * The decision is that a custom role carries its own base — "Senior
       * Cashier is based on Cashier" — so the person is created as whatever
       * the role says. Trusting `data.role` alongside it would let the two
       * disagree from the first second of the account's life, which is the
       * whole class of bug this change exists to close.
       */
      const staffRole = data.staffRoleId
        ? await requireRole(admin.restaurantId, data.staffRoleId)
        : null
      if (staffRole) {
        if (!staffRole.isActive) throw new ConflictError('That role is switched off')
        // Creating somebody into a role is granting it.
        assertNoEscalation(admin, staffRole.permissions)
      }

      const role = staffRole?.preset ?? data.role

      if (!assignableRoles(admin.role).includes(role)) {
        throw new ForbiddenError('You cannot assign that role')
      }
      // Rank is not reach — see the note on assertScopeAllowed.
      assertScopeAllowed(admin, role)

      const existing = await prisma.user.findUnique({ where: { email: data.email } })
      if (existing) throw new ConflictError('A user with that email already exists')

      // Resolved before anything is written, so a bad location cannot leave a
      // half-made account behind. A role that pins a location wins over the
      // form, for the same reason its preset does.
      const branchId = await homeBranchFor(
        admin,
        staffRole?.branchId ?? data.branchId,
        role,
      )

      /*
       * The sign-in code is the password. A waiter is handed a card with their
       * email and this code on it; nothing else has to be remembered or reset
       * on the first shift.
       */
      const temporaryPassword = generateSignInCode()
      const passwordHash = await hashPassword(temporaryPassword)

      // Issued here so a new hire can be handed a code immediately.
      const staffCode = await nextStaffCode(prisma, admin.restaurantId)
      const user = await prisma.user.create({
        data: {
          restaurantId: admin.restaurantId,
          email: data.email,
          name: data.name,
          phone: data.phone || null,
          role,
          staffRoleId: staffRole?.id ?? null,
          branchId,
          staffCode,
          signInCode: temporaryPassword,
          passwordHash,
          emailVerifiedAt: new Date(),
        },
      })

      const { sent } = await sendMail({
        to: data.email,
        ...staffInviteEmail({
          name: data.name,
          restaurantName: restaurant.name,
          email: data.email,
          temporaryPassword,
          role: data.role,
          // Sign in where their session will actually live.
          origin: tenantOrigin(restaurant),
        }),
      })

      await audit({
        restaurantId: admin.restaurantId,
        userId: admin.id,
        actorName: admin.name,
        action: AUDIT_ACTIONS.STAFF_INVITED,
        entity: 'User',
        entityId: user.id,
        after: { email: data.email, role: data.role, branchId },
      })

      revalidatePath('/dashboard/staff')
      return { id: user.id, temporaryPassword, emailed: sent }
    },
    'Staff member added.',
  )
}

export async function updateStaff(input: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction(
    updateStaffSchema,
    input,
    async (data) => {
      const admin = await requirePermission(PERMISSIONS.STAFF_MANAGE)

      const target = await prisma.user.findFirst({
        where: { id: data.id, restaurantId: admin.restaurantId },
      })
      if (!target) throw new NotFoundError('Staff member')
      /*
       * Whose staff member, not just whose restaurant.
       *
       * `homeBranchFor` below already guards the branch this edit sends them
       * TO. Nothing guarded the branch they are already AT, so a Branch 01
       * manager holding STAFF_MANAGE could rename a Main Branch cashier,
       * change their role, or move them to Branch 01 — by id alone.
       */
      await assertRecordBranch(admin, target, 'staff member')
      if (target.role === 'OWNER') throw new ForbiddenError('The owner account cannot be edited here')
      if (target.id === admin.id) throw new AppError('Use your profile to edit your own account', 400, 'SELF_EDIT')
      if (!assignableRoles(admin.role).includes(data.role)) {
        throw new ForbiddenError('You cannot assign that role')
      }
      assertScopeAllowed(admin, data.role)

      const branchId = await homeBranchFor(admin, data.branchId, data.role)

      /*
       * Two facts have to stay in step: `User.branchId` decides what someone
       * can SEE, and `Branch.managerId` decides what a location says about
       * itself. `setBranchManager` on the locations screen has always written
       * both. This screen wrote only the first, so moving a named manager to
       * another site — or switching them off — left their old location still
       * captioned "managed by X" while X was scoped somewhere else entirely.
       *
       * Done in one transaction with the update, because a caption that
       * survives a failed write is the same bug in a smaller window.
       */
      const runs = await prisma.branch.findFirst({
        where: { restaurantId: admin.restaurantId, managerId: data.id, deletedAt: null },
        select: { id: true },
      })
      const stillRunsIt = runs && runs.id === branchId && data.isActive

      await prisma.$transaction(async (tx) => {
        await tx.user.update({
          where: { id: data.id },
          data: {
            name: data.name,
            phone: data.phone || null,
            role: data.role,
            branchId,
            isActive: data.isActive,
          },
        })

        if (runs && !stillRunsIt) {
          await tx.branch.update({ where: { id: runs.id }, data: { managerId: null } })
        }

        /*
         * And name them on the location they have just been moved to, if it has
         * nobody. Not if it already has a manager — that is a decision for the
         * location's own screen, not a side effect of editing a staff record.
         */
        if (branchId && branchId !== runs?.id) {
          await tx.branch.updateMany({
            where: { id: branchId, restaurantId: admin.restaurantId, managerId: null },
            data: { managerId: canManageLocation({ role: data.role }) ? data.id : null },
          })
        }
      })

      // Deactivating a user must also cut their live sessions.
      if (!data.isActive) {
        await prisma.session.updateMany({
          where: { userId: data.id, revokedAt: null },
          data: { revokedAt: new Date() },
        })
      }

      await audit({
        restaurantId: admin.restaurantId,
        userId: admin.id,
        actorName: admin.name,
        action: AUDIT_ACTIONS.UPDATE,
        entity: 'User',
        entityId: data.id,
        before: { role: target.role, isActive: target.isActive, branchId: target.branchId },
        after: { role: data.role, isActive: data.isActive, branchId },
      })

      revalidatePath('/dashboard/staff')
      return { id: data.id }
    },
    'Staff member updated.',
  )
}

/**
 * Who the acting admin is allowed to change the credentials of.
 *
 * Stricter than STAFF_MANAGE alone. Without the role check a manager could
 * reset the owner's password and take the restaurant — `assignableRoles` already
 * encodes who outranks whom, so it is reused rather than restated.
 */
async function credentialTarget(admin: TenantUser, userId: string) {
  const target = await prisma.user.findFirst({
    where: { id: userId, restaurantId: admin.restaurantId, deletedAt: null },
    select: { id: true, name: true, email: true, role: true, staffCode: true, branchId: true },
  })
  if (!target) throw new NotFoundError('Staff member')
  // Resetting somebody's sign-in code is the strongest thing on this screen —
  // it hands over their account — so it is guarded by location as well as rank.
  await assertRecordBranch(admin, target, 'staff member')
  const adminRole = admin.role
  const adminId = admin.id
  if (target.id === adminId) {
    throw new AppError('Use your own profile to change your password', 400, 'SELF_EDIT')
  }
  if (!assignableRoles(adminRole as never).includes(target.role as never)) {
    throw new ForbiddenError(`You cannot change the sign-in details of ${target.name}`)
  }
  return target
}

/** Issue a fresh sign-in code. The previous one stops working immediately. */
export async function regenerateSignInCode(
  userId: string,
): Promise<ActionResult<{ id: string; name: string; code: string }>> {
  return runSafe(async () => {
    const admin = await requirePermission(PERMISSIONS.STAFF_MANAGE)
    const target = await credentialTarget(admin, userId)

    const code = await issueSignInCode(target.id)

    // A new credential must not leave the old one usable through a live session.
    await prisma.session.updateMany({
      where: { userId: target.id, revokedAt: null },
      data: { revokedAt: new Date() },
    })

    await audit({
      restaurantId: admin.restaurantId,
      userId: admin.id,
      actorName: admin.name,
      action: AUDIT_ACTIONS.UPDATE,
      entity: 'User',
      entityId: target.id,
      // Never the code itself — the audit log is read by more people than the
      // staff page is.
      after: { signInCodeReissued: true, staffCode: target.staffCode },
    })

    revalidatePath('/dashboard/staff/codes')
    revalidatePath('/dashboard/staff')
    return { id: target.id, name: target.name, code }
  }, 'New sign-in code issued.')
}

/**
 * The owner sets a password by hand.
 *
 * For the member of staff who would rather have something memorable than a
 * printed code. It clears `signInCode`, because a card showing a code that is no
 * longer the password is worse than no card at all.
 */
export async function setStaffPassword(input: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction(
    setStaffPasswordSchema,
    input,
    async (data) => {
      const admin = await requirePermission(PERMISSIONS.STAFF_MANAGE)
      const target = await credentialTarget(admin, data.userId)

      await prisma.user.update({
        where: { id: target.id },
        data: {
          passwordHash: await hashPassword(data.password),
          signInCode: null,
          failedLogins: 0,
          lockedUntil: null,
        },
      })
      await prisma.session.updateMany({
        where: { userId: target.id, revokedAt: null },
        data: { revokedAt: new Date() },
      })

      await audit({
        restaurantId: admin.restaurantId,
        userId: admin.id,
        actorName: admin.name,
        action: AUDIT_ACTIONS.UPDATE,
        entity: 'User',
        entityId: target.id,
        after: { passwordSetByOwner: true },
      })

      revalidatePath('/dashboard/staff')
      revalidatePath('/dashboard/staff/codes')
      return { id: target.id }
    },
    'Password updated.',
  )
}

export async function removeStaff(id: string): Promise<ActionResult<{ id: string }>> {
  return runSafe(async () => {
    const admin = await requirePermission(PERMISSIONS.STAFF_MANAGE)

    const target = await prisma.user.findFirst({
      where: { id, restaurantId: admin.restaurantId },
    })
    if (!target) throw new NotFoundError('Staff member')
    await assertRecordBranch(admin, target, 'staff member')
    if (target.role === 'OWNER') throw new ForbiddenError('The owner account cannot be removed')
    if (target.id === admin.id) throw new AppError('You cannot remove your own account', 400, 'SELF_DELETE')

    await prisma.$transaction([
      prisma.user.update({
        where: { id },
        data: { isActive: false, deletedAt: new Date(), email: `deleted+${id}@removed.local` },
      }),
      prisma.session.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } }),
    ])

    await audit({
      restaurantId: admin.restaurantId,
      userId: admin.id,
      actorName: admin.name,
      action: AUDIT_ACTIONS.DELETE,
      entity: 'User',
      entityId: id,
    })

    revalidatePath('/dashboard/staff')
    return { id }
  }, 'Staff member removed.')
}

// ── customers ────────────────────────────────────────────────────────────────

export async function saveCustomer(input: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction(
    customerSchema,
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.CUSTOMER_MANAGE)

      const payload = {
        name: data.name,
        phone: data.phone,
        email: data.email || null,
        notes: data.notes || null,
        isBlocked: data.isBlocked,
      }

      try {
        const record = data.id
          ? await prisma.customer.update({
              where: { id: data.id },
              data: payload,
            })
          : await prisma.customer.create({ data: { ...payload, restaurantId: user.restaurantId } })

        revalidatePath('/dashboard/customers')
        return { id: record.id }
      } catch (error) {
        if (isUniqueViolation(error)) throw new ConflictError('A customer with that phone already exists')
        throw error
      }
    },
    'Customer saved.',
  )
}

export async function adjustLoyalty(input: unknown): Promise<ActionResult<{ points: number }>> {
  return runAction(
    adjustLoyaltySchema,
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.CUSTOMER_MANAGE)

      const customer = await prisma.customer.findFirst({
        where: { id: data.customerId, restaurantId: user.restaurantId },
      })
      if (!customer) throw new NotFoundError('Customer')

      const nextPoints = Math.max(0, customer.loyaltyPoints + data.points)
      await prisma.customer.update({
        where: { id: customer.id },
        data: { loyaltyPoints: nextPoints },
      })

      await audit({
        restaurantId: user.restaurantId,
        userId: user.id,
        actorName: user.name,
        action: 'loyalty.adjusted',
        entity: 'Customer',
        entityId: customer.id,
        before: { points: customer.loyaltyPoints },
        after: { points: nextPoints, reason: data.reason },
      })

      revalidatePath('/dashboard/customers')
      return { points: nextPoints }
    },
    'Loyalty points updated.',
  )
}

// ── coupons ──────────────────────────────────────────────────────────────────

export async function saveCoupon(input: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction(
    couponSchema,
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.COUPON_MANAGE)

      const payload = {
        code: data.code,
        description: data.description || null,
        type: data.type,
        value: data.value,
        minOrderAmount: data.minOrderAmount,
        maxDiscount: data.maxDiscount ?? null,
        startsAt: data.startsAt ? new Date(data.startsAt) : null,
        endsAt: data.endsAt ? new Date(data.endsAt) : null,
        usageLimit: data.usageLimit ?? null,
        perCustomerLimit: data.perCustomerLimit ?? null,
        isActive: data.isActive,
      }

      try {
        const record = data.id
          ? await prisma.coupon.update({ where: { id: data.id }, data: payload })
          : await prisma.coupon.create({ data: { ...payload, restaurantId: user.restaurantId } })

        await audit({
          restaurantId: user.restaurantId,
          userId: user.id,
          actorName: user.name,
          action: data.id ? AUDIT_ACTIONS.UPDATE : AUDIT_ACTIONS.CREATE,
          entity: 'Coupon',
          entityId: record.id,
          after: { code: data.code },
        })

        revalidatePath('/dashboard/coupons')
        return { id: record.id }
      } catch (error) {
        if (isUniqueViolation(error)) throw new ConflictError('That coupon code already exists')
        throw error
      }
    },
    'Coupon saved.',
  )
}

export async function deleteCoupon(id: string): Promise<ActionResult<{ id: string }>> {
  return runSafe(async () => {
    const user = await requirePermission(PERMISSIONS.COUPON_MANAGE)
    const result = await prisma.coupon.deleteMany({ where: { id, restaurantId: user.restaurantId } })
    if (result.count === 0) throw new NotFoundError('Coupon')
    revalidatePath('/dashboard/coupons')
    return { id }
  }, 'Coupon deleted.')
}

// ── reviews ──────────────────────────────────────────────────────────────────

export async function replyToReview(input: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction(
    replyReviewSchema,
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.REVIEW_MANAGE)
      const result = await prisma.review.updateMany({
        where: { id: data.id, restaurantId: user.restaurantId },
        data: { reply: data.reply, repliedAt: new Date() },
      })
      if (result.count === 0) throw new NotFoundError('Review')
      revalidatePath('/dashboard/reviews')
      return { id: data.id }
    },
    'Reply posted.',
  )
}

export async function toggleReviewPublished(id: string, isPublished: boolean) {
  return runSafe(async () => {
    const user = await requirePermission(PERMISSIONS.REVIEW_MANAGE)
    await prisma.review.updateMany({
      where: { id, restaurantId: user.restaurantId },
      data: { isPublished },
    })
    revalidatePath('/dashboard/reviews')
    return { id }
  })
}
