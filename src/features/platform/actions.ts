'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'

import { runAction, type ActionResult } from '@/lib/action'
import { NotFoundError } from '@/lib/errors'
import { audit } from '@/server/audit'
import { requireSuperAdmin } from '@/server/auth/guard'
import { prisma } from '@/server/db/prisma'
import { notify } from '@/server/notifications'

const idSchema = z.object({ restaurantId: z.string().cuid() })
const rejectSchema = idSchema.extend({ reason: z.string().trim().min(3, 'Give a reason').max(300) })

/**
 * Approve a pending restaurant: enable it, start its trial, and notify the
 * owner. Idempotent — approving an already-active tenant is a no-op.
 */
export async function approveRestaurant(input: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction(
    idSchema,
    input,
    async (data) => {
      const admin = await requireSuperAdmin()

      const restaurant = await prisma.restaurant.findUnique({ where: { id: data.restaurantId } })
      if (!restaurant) throw new NotFoundError('Restaurant')

      await prisma.restaurant.update({
        where: { id: restaurant.id },
        data: {
          status: 'ACTIVE',
          isActive: true,
          approvedAt: new Date(),
          approvedById: admin.id,
          rejectionReason: null,
          trialEndsAt: restaurant.trialEndsAt ?? new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
        },
      })

      await notify({
        restaurantId: restaurant.id,
        type: 'SYSTEM',
        title: 'Your restaurant is approved 🎉',
        body: 'Welcome to RestaurantOS. Your dashboard is now live.',
        audience: 'MANAGEMENT',
      })

      await audit({
        restaurantId: restaurant.id,
        userId: admin.id,
        actorName: admin.name,
        action: 'platform.approved',
        entity: 'Restaurant',
        entityId: restaurant.id,
      })

      revalidatePath('/admin')
      return { id: restaurant.id }
    },
    'Restaurant approved.',
  )
}

export async function rejectRestaurant(input: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction(
    rejectSchema,
    input,
    async (data) => {
      const admin = await requireSuperAdmin()

      const result = await prisma.restaurant.updateMany({
        where: { id: data.restaurantId },
        data: { status: 'REJECTED', isActive: false, rejectionReason: data.reason },
      })
      if (result.count === 0) throw new NotFoundError('Restaurant')

      await audit({
        restaurantId: data.restaurantId,
        userId: admin.id,
        actorName: admin.name,
        action: 'platform.rejected',
        entity: 'Restaurant',
        entityId: data.restaurantId,
        after: { reason: data.reason },
      })

      revalidatePath('/admin')
      return { id: data.restaurantId }
    },
    'Registration rejected.',
  )
}

export async function suspendRestaurant(input: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction(
    idSchema,
    input,
    async (data) => {
      const admin = await requireSuperAdmin()

      const result = await prisma.restaurant.updateMany({
        where: { id: data.restaurantId },
        data: { status: 'SUSPENDED', isActive: false },
      })
      if (result.count === 0) throw new NotFoundError('Restaurant')

      // Cut every live staff session for the suspended tenant.
      await prisma.session.updateMany({
        where: { user: { restaurantId: data.restaurantId }, revokedAt: null },
        data: { revokedAt: new Date() },
      })

      await audit({
        restaurantId: data.restaurantId,
        userId: admin.id,
        actorName: admin.name,
        action: 'platform.suspended',
        entity: 'Restaurant',
        entityId: data.restaurantId,
      })

      revalidatePath('/admin')
      return { id: data.restaurantId }
    },
    'Restaurant suspended.',
  )
}

export async function reactivateRestaurant(input: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction(
    idSchema,
    input,
    async (data) => {
      const admin = await requireSuperAdmin()

      const result = await prisma.restaurant.updateMany({
        where: { id: data.restaurantId },
        data: { status: 'ACTIVE', isActive: true },
      })
      if (result.count === 0) throw new NotFoundError('Restaurant')

      await audit({
        restaurantId: data.restaurantId,
        userId: admin.id,
        actorName: admin.name,
        action: 'platform.reactivated',
        entity: 'Restaurant',
        entityId: data.restaurantId,
      })

      revalidatePath('/admin')
      return { id: data.restaurantId }
    },
    'Restaurant reactivated.',
  )
}
