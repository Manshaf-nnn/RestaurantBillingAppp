'use server'

import { runAction, type ActionResult } from '@/lib/action'
import { NotFoundError } from '@/lib/errors'
import { requirePermission } from '@/server/auth/guard'
import { prisma } from '@/server/db/prisma'
import { resolvePublicTenant } from '@/server/db/tenant'
import { enforceRateLimit } from '@/server/security/rate-limit'
import { PERMISSIONS } from '@/lib/rbac'
import { feedbackSchema } from './schema'

/** Public — a guest leaves quick, anonymous feedback from their phone. */
export async function submitFeedback(input: unknown): Promise<ActionResult<{ ok: true }>> {
  return runAction(
    feedbackSchema,
    input,
    async (data) => {
      await enforceRateLimit('mutation')
      const restaurant = await resolvePublicTenant()
      if (!restaurant) throw new NotFoundError('Restaurant')

      await prisma.feedback.create({
        data: {
          restaurantId: restaurant.id,
          category: data.category ?? 'FOOD',
          rating: data.rating,
          comment: data.comment || null,
          tableNumber: data.tableNumber || null,
        },
      })
      return { ok: true as const }
    },
    'Thanks for your feedback!',
  )
}

export async function submitSystemFeedback(input: unknown): Promise<ActionResult<{ ok: true }>> {
  return runAction(
    feedbackSchema,
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.REVIEW_MANAGE)
      await prisma.feedback.create({
        data: {
          restaurantId: user.restaurantId,
          category: 'SYSTEM',
          rating: data.rating,
          comment: data.comment || null,
          tableNumber: null,
        },
      })
      return { ok: true as const }
    },
    'Thanks for the system feedback!',
  )
}
