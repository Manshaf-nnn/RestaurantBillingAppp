'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'

import { runAction, type ActionResult } from '@/lib/action'
import { PERMISSIONS } from '@/lib/rbac'
import { AUDIT_ACTIONS, audit } from '@/server/audit'
import { requirePermission } from '@/server/auth/guard'
import { prisma } from '@/server/db/prisma'
import { requireRestaurant } from '@/server/db/tenant'
import { assertBranchAccess } from '@/server/auth/guard'
import { NotFoundError } from '@/lib/errors'
import { minorUnitFactor } from '@/lib/money'
import { redeemReward } from './service'

/*
 * Not exported. A 'use server' module may only export async functions — Next
 * turns every export into a callable server reference, and a Zod object is not
 * callable. Exporting this threw "A 'use server' file can only export async
 * functions, found object" on the FIRST call into the module, so every action
 * in this file failed with a bare digest and nothing was ever written.
 */
const loyaltySettingsSchema = z.object({
  enabled: z.coerce.boolean().default(true),
  // Points earned per 1 currency unit spent.
  earnRate: z.coerce.number().min(0).max(100).default(1),
  // Value of one point when redeemed, in whole currency units.
  pointValue: z.coerce.number().min(0).max(10_000).default(1),
})
export type LoyaltySettingsInput = z.infer<typeof loyaltySettingsSchema>

/** Update just the loyalty programme (own action so it can live on its own page). */
export async function updateLoyaltySettings(input: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction(
    loyaltySettingsSchema,
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.SETTINGS_MANAGE)

      const updated = await prisma.restaurant.update({
        where: { id: user.restaurantId },
        data: {
          loyaltyEnabled: data.enabled,
          loyaltyEarnRateX100: Math.round(data.earnRate * 100),
          loyaltyPointValue: Math.round(data.pointValue * 100),
        },
      })

      await audit({
        restaurantId: user.restaurantId,
        userId: user.id,
        actorName: user.name,
        action: AUDIT_ACTIONS.SETTINGS_UPDATED,
        entity: 'Restaurant',
        entityId: user.restaurantId,
        after: { loyaltyEnabled: data.enabled, loyaltyEarnRate: data.earnRate },
      })

      revalidatePath('/dashboard/loyalty')
      return { id: updated.id }
    },
    'Loyalty settings saved.',
  )
}

/* ── the rewards catalogue ───────────────────────────────────────────────── */

const rewardSchema = z.object({
  id: z.string().cuid().optional(),
  name: z.string().trim().min(2, 'Name the reward').max(80),
  description: z.string().trim().max(200).optional().or(z.literal('')),
  /** What the guest pays, in points. */
  pointsCost: z.coerce.number().int().positive('A reward has to cost something').max(1_000_000),
  /** What it takes off the bill, in whole currency units. */
  value: z.coerce.number().nonnegative('A reward cannot be worth less than nothing').max(1_000_000),
  /** The smallest bill it may be used on, in whole currency units. */
  minOrderAmount: z.coerce.number().nonnegative().max(1_000_000).default(0),
  expiresAt: z.string().trim().optional().or(z.literal('')),
  isActive: z.coerce.boolean().default(true),
})

/** Create or edit a reward. Retiring one is `isActive: false`; nothing is deleted. */
export async function saveLoyaltyReward(input: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction(
    rewardSchema,
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.SETTINGS_MANAGE)
      const restaurant = await requireRestaurant(user.restaurantId)
      const factor = minorUnitFactor(restaurant.currency)

      const payload = {
        name: data.name,
        description: data.description || null,
        pointsCost: data.pointsCost,
        value: Math.round(data.value * factor),
        minOrderAmount: Math.round(data.minOrderAmount * factor),
        expiresAt: data.expiresAt ? new Date(data.expiresAt) : null,
        isActive: data.isActive,
      }

      const reward = data.id
        ? await prisma.loyaltyReward.update({
            // The id alone is not enough: scoping the write to the tenant is
            // what stops one restaurant editing another's catalogue.
            where: { id: data.id, restaurantId: user.restaurantId },
            data: payload,
          })
        : await prisma.loyaltyReward.create({
            data: { ...payload, restaurantId: user.restaurantId },
          })

      await audit({
        restaurantId: user.restaurantId,
        userId: user.id,
        actorName: user.name,
        action: data.id ? AUDIT_ACTIONS.UPDATE : AUDIT_ACTIONS.CREATE,
        entity: 'LoyaltyReward',
        entityId: reward.id,
        after: {
          name: reward.name, pointsCost: reward.pointsCost, value: reward.value,
          minOrderAmount: reward.minOrderAmount, isActive: reward.isActive,
        },
      })

      revalidatePath('/dashboard/loyalty')
      return { id: reward.id }
    },
    'Reward saved.',
  )
}

/* ── spending one ────────────────────────────────────────────────────────── */

const redeemSchema = z.object({
  orderId: z.string().cuid(),
  rewardId: z.string().cuid(),
})

/**
 * Put a reward on a bill, from the till.
 *
 * `PAYMENT_COLLECT`, not `DISCOUNT_APPLY`: this is not the cashier deciding to
 * take money off, it is the guest spending something they already own. The
 * points are the authority, and the service checks they have them.
 */
export async function redeemLoyaltyReward(
  input: unknown,
): Promise<ActionResult<{ pointsSpent: number; discount: number; balance: number }>> {
  return runAction(
    redeemSchema,
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.PAYMENT_COLLECT)
      const order = await prisma.order.findFirst({
        where: { id: data.orderId, restaurantId: user.restaurantId },
        select: { branchId: true },
      })
      if (!order) throw new NotFoundError('Order')
      await assertBranchAccess(user, order.branchId)

      const result = await redeemReward({
        restaurantId: user.restaurantId,
        orderId: data.orderId,
        rewardId: data.rewardId,
        actorId: user.id,
      })

      if (!result.replayed) {
        await audit({
          restaurantId: user.restaurantId,
          branchId: order.branchId,
          userId: user.id,
          actorName: user.name,
          action: AUDIT_ACTIONS.LOYALTY_REDEEMED,
          entity: 'Order',
          entityId: data.orderId,
          after: { rewardId: data.rewardId, pointsSpent: result.pointsSpent, discount: result.discount },
        })
      }

      revalidatePath('/cashier/pos')
      return { pointsSpent: result.pointsSpent, discount: result.discount, balance: result.balance }
    },
    'Reward applied.',
  )
}
