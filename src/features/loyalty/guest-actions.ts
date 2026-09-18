'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'

import { runAction, type ActionResult } from '@/lib/action'
import { AppError, NotFoundError } from '@/lib/errors'
import { AUDIT_ACTIONS, audit } from '@/server/audit'
import { prisma } from '@/server/db/prisma'
import { resolvePublicTenant } from '@/server/db/tenant'
import { getGuestSessionId } from '@/server/auth/session'
import { enforceRateLimit } from '@/server/security/rate-limit'
import { balanceForPhone, listRewards, redeemReward, type RewardOffer } from './service'

/**
 * Loyalty for a guest with a phone and no account.
 *
 * ── The thing to understand before changing this ──────────────────────────
 *
 * A phone number is not proof of anything. The public order schema has
 * refused a `redeemPoints` field since the day somebody noticed that it let
 * anyone spend a stranger's points by typing their number, and that reasoning
 * has not changed.
 *
 * What makes this safe enough to offer is not the phone — it is the ORDER.
 * A guest may only spend against a bill their own browser session placed, and
 * only while it is unpaid. Somebody who knows your number still cannot take
 * your points: they would have to be sitting at a table with an open bill of
 * their own, and the reward lands on THAT bill, which the staff are about to
 * hand them. It is a till transaction with a guest-facing button, not an
 * anonymous API for spending other people's balances.
 *
 * The lookup is separately rate-limited, per device and per venue, because it
 * takes a number and returns a balance and nothing else guards it.
 */

const lookupSchema = z.object({
  phone: z
    .string()
    .trim()
    .min(7, 'Enter the mobile number you use here')
    .max(20)
    .regex(/^[+\d][\d\s-]{6,}$/, 'Enter a valid mobile number'),
  /** The bill being looked at, so the list can say what is usable on it. */
  orderId: z.string().cuid().optional().or(z.literal('')),
})

export interface GuestLoyaltyView {
  found: boolean
  name: string | null
  points: number
  rewards: RewardOffer[]
}

/**
 * What this number has, and what it can have.
 *
 * An unknown number comes back as a zero balance rather than "no such guest":
 * the screen must not become a way to find out who is a member.
 */
export async function lookupLoyalty(input: unknown, slug?: string): Promise<ActionResult<GuestLoyaltyView>> {
  return runAction(
    lookupSchema,
    input,
    async (data) => {
      const session = await getGuestSessionId().catch(() => null)
      await enforceRateLimit('loyaltyLookup', session ? `guest:${session}` : undefined)
      await enforceRateLimit('loyaltyLookupBurst')

      const restaurant = await resolvePublicTenant(slug)
      if (!restaurant) throw new NotFoundError('Restaurant')
      if (!restaurant.loyaltyEnabled) {
        throw new AppError('Loyalty is not running here', 400, 'LOYALTY_OFF')
      }

      const holder = await balanceForPhone({ restaurantId: restaurant.id, phone: data.phone })

      // The bill decides which rewards are usable, so it has to be one of
      // theirs — an id from somebody else's table tells them nothing.
      let orderTotal: number | undefined
      if (data.orderId && session) {
        const order = await prisma.order.findFirst({
          where: { id: data.orderId, restaurantId: restaurant.id, guestSessionId: session },
          select: { subtotal: true },
        })
        orderTotal = order?.subtotal
      }

      const rewards = await listRewards({
        restaurantId: restaurant.id,
        points: holder.points,
        orderTotal,
      })

      return { found: holder.customerId !== null, name: holder.name, points: holder.points, rewards }
    },
    undefined,
    'lookupLoyalty',
  )
}

const guestRedeemSchema = z.object({
  orderId: z.string().cuid(),
  rewardId: z.string().cuid(),
  phone: z.string().trim().min(7).max(20),
})

/**
 * Spend a reward on the bill this guest is sitting with.
 *
 * Three things have to line up: the order belongs to this browser session, the
 * phone belongs to the customer on that order, and the points are there. The
 * middle one is what stops a guest typing a stranger's number at a table and
 * spending their points — the bill already names whose it is.
 */
export async function redeemRewardAsGuest(
  input: unknown,
  slug?: string,
): Promise<ActionResult<{ pointsSpent: number; discount: number; balance: number }>> {
  return runAction(
    guestRedeemSchema,
    input,
    async (data) => {
      const session = await getGuestSessionId().catch(() => null)
      if (!session) throw new AppError('Open your order first', 400, 'NO_SESSION')
      await enforceRateLimit('loyaltyLookup', `guest:${session}`)

      const restaurant = await resolvePublicTenant(slug)
      if (!restaurant) throw new NotFoundError('Restaurant')
      if (!restaurant.loyaltyEnabled) {
        throw new AppError('Loyalty is not running here', 400, 'LOYALTY_OFF')
      }

      const order = await prisma.order.findFirst({
        where: { id: data.orderId, restaurantId: restaurant.id, guestSessionId: session },
        select: { id: true, branchId: true, customerId: true, customer: { select: { phone: true } } },
      })
      if (!order) throw new NotFoundError('Order')
      if (!order.customerId || !order.customer) {
        throw new AppError(
          'This order has no mobile number on it, so there is no account to spend from',
          400,
          'LOYALTY_NO_CUSTOMER',
        )
      }
      /*
       * The bill says whose it is. Knowing a number is not enough — it has to
       * be the number this order was placed with.
       */
      if (order.customer.phone !== data.phone.trim()) {
        throw new AppError(
          'That mobile number does not match the one on this order',
          403,
          'LOYALTY_PHONE_MISMATCH',
        )
      }

      const result = await redeemReward({
        restaurantId: restaurant.id,
        orderId: order.id,
        rewardId: data.rewardId,
      })

      if (!result.replayed) {
        await audit({
          restaurantId: restaurant.id,
          branchId: order.branchId,
          action: AUDIT_ACTIONS.LOYALTY_REDEEMED,
          entity: 'Order',
          entityId: order.id,
          after: {
            rewardId: data.rewardId,
            pointsSpent: result.pointsSpent,
            discount: result.discount,
            by: 'guest',
          },
        })
      }

      revalidatePath(`/order/track/${order.id}`)
      return { pointsSpent: result.pointsSpent, discount: result.discount, balance: result.balance }
    },
    'Reward applied to your bill.',
  )
}
