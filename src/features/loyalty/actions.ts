'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'

import { runAction, type ActionResult } from '@/lib/action'
import { PERMISSIONS } from '@/lib/rbac'
import { AUDIT_ACTIONS, audit } from '@/server/audit'
import { requirePermission } from '@/server/auth/guard'
import { prisma } from '@/server/db/prisma'

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
