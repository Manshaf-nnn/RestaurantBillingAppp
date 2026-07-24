'use server'

import { revalidatePath } from 'next/cache'

import { runAction, runSafe, type ActionResult } from '@/lib/action'
import { AppError, ConflictError, ForbiddenError, NotFoundError } from '@/lib/errors'
import { assignableRoles, PERMISSIONS } from '@/lib/rbac'
import { AUDIT_ACTIONS, audit } from '@/server/audit'
import { requirePermission } from '@/server/auth/guard'
import { generateToken, hashPassword } from '@/server/auth/password'
import { isUniqueViolation, prisma } from '@/server/db/prisma'
import { sendMail, staffInviteEmail } from '@/server/mailer'
import { requireRestaurant } from '@/server/db/tenant'
import {
  adjustLoyaltySchema,
  couponSchema,
  customerSchema,
  inviteStaffSchema,
  replyReviewSchema,
  updateStaffSchema,
} from './schema'

// ── staff ────────────────────────────────────────────────────────────────────

export async function inviteStaff(
  input: unknown,
): Promise<ActionResult<{ id: string; temporaryPassword: string; emailed: boolean }>> {
  return runAction(
    inviteStaffSchema,
    input,
    async (data) => {
      const admin = await requirePermission(PERMISSIONS.STAFF_MANAGE)
      const restaurant = await requireRestaurant(admin.restaurantId)

      if (!assignableRoles(admin.role).includes(data.role)) {
        throw new ForbiddenError('You cannot assign that role')
      }

      const existing = await prisma.user.findUnique({ where: { email: data.email } })
      if (existing) throw new ConflictError('A user with that email already exists')

      // A temporary password is generated and emailed; the invitee changes it.
      const temporaryPassword = `${generateToken(4)}A1!`
      const passwordHash = await hashPassword(temporaryPassword)

      const user = await prisma.user.create({
        data: {
          restaurantId: admin.restaurantId,
          email: data.email,
          name: data.name,
          phone: data.phone || null,
          role: data.role,
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
        }),
      })

      await audit({
        restaurantId: admin.restaurantId,
        userId: admin.id,
        actorName: admin.name,
        action: AUDIT_ACTIONS.STAFF_INVITED,
        entity: 'User',
        entityId: user.id,
        after: { email: data.email, role: data.role },
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
      if (target.role === 'OWNER') throw new ForbiddenError('The owner account cannot be edited here')
      if (target.id === admin.id) throw new AppError('Use your profile to edit your own account', 400, 'SELF_EDIT')
      if (!assignableRoles(admin.role).includes(data.role)) {
        throw new ForbiddenError('You cannot assign that role')
      }

      await prisma.user.update({
        where: { id: data.id },
        data: {
          name: data.name,
          phone: data.phone || null,
          role: data.role,
          isActive: data.isActive,
        },
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
        after: { role: data.role, isActive: data.isActive },
      })

      revalidatePath('/dashboard/staff')
      return { id: data.id }
    },
    'Staff member updated.',
  )
}

export async function removeStaff(id: string): Promise<ActionResult<{ id: string }>> {
  return runSafe(async () => {
    const admin = await requirePermission(PERMISSIONS.STAFF_MANAGE)

    const target = await prisma.user.findFirst({
      where: { id, restaurantId: admin.restaurantId },
    })
    if (!target) throw new NotFoundError('Staff member')
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
