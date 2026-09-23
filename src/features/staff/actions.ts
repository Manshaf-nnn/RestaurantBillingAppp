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
  canActOnRole,
} from '@/lib/rbac'
import { tenantOrigin } from '@/lib/tenant-url'
import { AUDIT_ACTIONS, audit } from '@/server/audit'
import { adjustPoints } from '@/features/loyalty/service'
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
  inviteStaffSchema,
  setStaffPasswordSchema,
  replyReviewSchema,
  updateStaffSchema,
  staffPermissionsSchema,
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
  const reach = visibleBranchIds(admin)

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
 * The extra locations this person may also work (staff.A.md §4).
 *
 * Bounded by the acting admin's own reach, for exactly the reason
 * `homeBranchFor` is: granting a site is granting sight of its takings, its
 * staff and its audit log, and an admin cannot give away what they do not
 * hold. A site manager listing another branch here is refused by name rather
 * than having it silently dropped, because a silent drop reads as success and
 * the person shows up on Monday unable to see the shop they were told to
 * cover.
 *
 * The home branch is filtered out: it is already reach, and storing it twice
 * would show as a duplicate on the effective-access screen.
 */
async function extraBranchesFor(
  admin: TenantUser,
  requested: string[] | undefined,
  homeBranchId: string | null,
): Promise<string[]> {
  const wanted = [...new Set((requested ?? []).filter((id) => id && id !== homeBranchId))]
  if (wanted.length === 0) return []

  for (const branchId of wanted) await assertBranchAccess(admin, branchId)

  /*
   * Re-read under the acting admin's own restaurant, so a guessed id from
   * another tenant resolves to nothing rather than tying somebody across the
   * boundary — the same rule `homeBranchFor` applies to the home branch.
   */
  const rows = await prisma.branch.findMany({
    where: { id: { in: wanted }, restaurantId: admin.restaurantId, deletedAt: null },
    select: { id: true },
  })
  if (rows.length !== wanted.length) throw new NotFoundError('Location')
  return rows.map((row) => row.id)
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
  const reach = visibleBranchIds(admin)
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
      // Resolved before the write for the same reason the home branch is: a
      // location the admin may not reach must refuse the whole invitation, not
      // create the account and then fail (staff.A.md §4).
      const extraBranchIds = await extraBranchesFor(admin, data.branchIds, branchId)

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
          branchAccess: { create: extraBranchIds.map((id) => ({ branchId: id })) },
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
        after: { email: data.email, role: data.role, branchId, extraBranchIds },
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
      const extraBranchIds = await extraBranchesFor(admin, data.branchIds, branchId)
      const beforeExtras = (
        await prisma.userBranch.findMany({
          where: { userId: data.id },
          select: { branchId: true },
        })
      ).map((row) => row.branchId)

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

        /*
         * Replace, not merge (staff.A.md §4).
         *
         * The form posts the complete set of extra locations, so a branch the
         * owner unticked has to go. Merging would make the checkboxes one-way
         * — every save could only ever widen somebody's reach, and taking a
         * site back would need a database edit.
         *
         * Only when the form said something: `branchIds` is optional, and an
         * absent field means "this caller did not ask about extra locations",
         * which must not read as "remove them all".
         */
        if (data.branchIds !== undefined) {
          await tx.userBranch.deleteMany({
            where: { userId: data.id, branchId: { notIn: extraBranchIds.length ? extraBranchIds : ['-'] } },
          })
          for (const id of extraBranchIds) {
            await tx.userBranch.upsert({
              where: { userId_branchId: { userId: data.id, branchId: id } },
              create: { userId: data.id, branchId: id },
              update: {},
            })
          }
        }

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
        before: {
          role: target.role,
          isActive: target.isActive,
          branchId: target.branchId,
          extraBranchIds: beforeExtras,
        },
        after: {
          role: data.role,
          isActive: data.isActive,
          branchId,
          extraBranchIds: data.branchIds === undefined ? beforeExtras : extraBranchIds,
        },
      })

      revalidatePath('/dashboard/staff')
      return { id: data.id }
    },
    'Staff member updated.',
  )
}

/**
 * What this one person may and may not do, on top of their role (staff.A.md §3).
 *
 * ── Why both halves are here ────────────────────────────────────────────────
 *
 * `allow` has been readable by `permissionsFor` since the column existed and
 * no screen ever wrote it. `deny` is new. Together they are what makes
 * "everyone on Senior POS, except Nila, who must not give discounts"
 * expressible without cloning the role — and a cloned role drifts from its
 * original the first time somebody edits one and not the other.
 *
 * ── The guards are the ones that already exist ──────────────────────────────
 *
 * Same four as every other write on this screen, reused rather than restated:
 * the record's own branch, the owner being untouchable, no editing yourself,
 * and rank. Plus `assertNoEscalation` on the ALLOW half, because granting a
 * permission you do not hold is the whole point of the rule.
 *
 * DENY is deliberately NOT escalation-checked. Taking something away can only
 * narrow, so a manager may deny a permission they do not hold themselves —
 * refusing that would mean a site manager could not stop their own staff doing
 * something only an owner can normally do.
 */
export async function setStaffPermissions(
  input: unknown,
): Promise<ActionResult<{ id: string; allow: string[]; deny: string[] }>> {
  return runAction(
    staffPermissionsSchema,
    input,
    async (data) => {
      const admin = await requirePermission(PERMISSIONS.STAFF_MANAGE)

      const target = await prisma.user.findFirst({
        where: { id: data.userId, restaurantId: admin.restaurantId, deletedAt: null },
        select: {
          id: true,
          name: true,
          role: true,
          branchId: true,
          permissions: true,
          deniedPermissions: true,
        },
      })
      if (!target) throw new NotFoundError('Staff member')

      await assertRecordBranch(admin, target, 'staff member')
      if (target.role === 'OWNER') {
        throw new ForbiddenError('The owner account cannot be restricted')
      }
      if (target.id === admin.id) {
        throw new AppError('You cannot change your own access', 400, 'SELF_EDIT')
      }
      if (!canActOnRole(admin.role, target.role)) {
        throw new ForbiddenError(`You cannot change what ${target.name} may do`)
      }

      /*
       * Only keys this build knows about. A typo or a stale key from an old
       * tab would otherwise sit in the column for ever, showing on the
       * effective-access screen as a permission that grants nothing and
       * cannot be explained.
       */
      const known = new Set<string>(Object.values(PERMISSIONS))
      const unknown = [...data.allow, ...data.deny].filter((key) => !known.has(key))
      if (unknown.length > 0) {
        throw new AppError(`Unknown permission: ${unknown[0]}`, 400, 'UNKNOWN_PERMISSION')
      }

      // Granting is bounded by what the grantor holds; taking away is not.
      assertNoEscalation(admin, data.allow)

      const allow = [...new Set(data.allow)].sort()
      const deny = [...new Set(data.deny)].sort()

      await prisma.user.update({
        where: { id: target.id },
        data: { permissions: allow, deniedPermissions: deny },
      })

      await audit({
        restaurantId: admin.restaurantId,
        branchId: target.branchId,
        userId: admin.id,
        actorName: admin.name,
        action: AUDIT_ACTIONS.STAFF_PERMISSIONS_SET,
        entity: 'User',
        entityId: target.id,
        before: { allow: target.permissions, deny: target.deniedPermissions },
        after: { allow, deny },
      })

      /*
       * No session revocation, deliberately. Permissions are re-read from the
       * database on every request (`USER_SELECT`), so this lands on the
       * person's very next click — and cutting their session would sign them
       * out mid-order to deliver a change they would have got anyway.
       */
      revalidatePath('/dashboard/staff')
      revalidatePath(`/dashboard/staff/${target.id}/access`)
      return { id: target.id, allow, deny }
    },
    'Access updated.',
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
  if (!canActOnRole(adminRole as never, target.role as never)) {
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

/*
 * `saveCustomer` moved to `src/features/customers/actions.ts` as
 * `saveCustomerAction` (pro.A.md §6): one customer form, shared by the CRM and
 * the till, so a number typed at the counter and one typed in the back office
 * reach the same record. Creating with a number that already exists now
 * returns that person rather than refusing, and the phone is matched on its
 * normalised key so spacing cannot make a second copy of a regular.
 */

/**
 * A hand correction to a guest's points.
 *
 * The balance and its ledger move together, in `adjustPoints`. This used to
 * write `Customer.loyaltyPoints` on its own and record nothing, so every
 * correction made through this screen desynchronised the balance from the
 * entries that are supposed to explain it — and tripped the accounting
 * integrity check whose whole job is to notice that.
 */
export async function adjustLoyalty(input: unknown): Promise<ActionResult<{ points: number }>> {
  return runAction(
    adjustLoyaltySchema,
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.CUSTOMER_MANAGE)

      const customer = await prisma.customer.findFirst({
        where: { id: data.customerId, restaurantId: user.restaurantId },
        select: { id: true, loyaltyPoints: true },
      })
      if (!customer) throw new NotFoundError('Customer')

      const result = await adjustPoints({
        restaurantId: user.restaurantId,
        customerId: customer.id,
        points: data.points,
        note: data.reason,
        actorId: user.id,
      })

      await audit({
        restaurantId: user.restaurantId,
        userId: user.id,
        actorName: user.name,
        action: AUDIT_ACTIONS.LOYALTY_ADJUSTED,
        entity: 'Customer',
        entityId: customer.id,
        before: { points: customer.loyaltyPoints },
        // What was APPLIED, which is not always what was asked for: a
        // deduction is capped at the balance.
        after: { points: result.balance, applied: result.applied, reason: data.reason },
      })

      revalidatePath('/dashboard/customers')
      return { points: result.balance }
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

      /*
       * A code pinned to a location has to be one this person may reach —
       * otherwise "everywhere" and "Colombo" are the same button for a Kandy
       * manager. Empty stays empty: a group-wide promotion is the default and
       * the common case.
       */
      const branchId = data.branchId || null
      if (branchId) await assertBranchAccess(user, branchId)

      /*
       * The record being edited must be this restaurant's, and at a branch
       * this person reaches. `deleteCoupon` below always scoped its delete;
       * the update by primary key alone could set another restaurant's live
       * promotion to 100% off — with the audit row filed under THIS tenant.
       */
      const existing = data.id
        ? await prisma.coupon.findFirst({
            where: { id: data.id, restaurantId: user.restaurantId },
            select: { id: true, branchId: true },
          })
        : null
      if (data.id && !existing) throw new NotFoundError('Coupon')
      if (existing) await assertRecordBranch(user, existing, 'coupon')

      const payload = {
        code: data.code,
        branchId,
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
        const record = existing
          ? await prisma.coupon.update({ where: { id: existing.id }, data: payload })
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
    /*
     * A coupon that discounted a bill is part of that bill's history: its
     * redemption rows cascade with it, and every order it touched would keep
     * a discount figure with nothing left to explain it. The same rule
     * `deleteStation` applies — used once, it can only be retired.
     */
    const used = await prisma.couponRedemption.count({
      where: { couponId: id, coupon: { restaurantId: user.restaurantId } },
    })
    if (used > 0) {
      throw new ConflictError(
        `This coupon has been used on ${used} bill${used === 1 ? '' : 's'} — deactivate it instead of deleting it`,
      )
    }
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
