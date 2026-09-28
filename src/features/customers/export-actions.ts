'use server'

import { z } from 'zod'

import { type ActionResult, runAction } from '@/lib/action'
import { PERMISSIONS } from '@/lib/rbac'
import { requirePermission } from '@/server/auth/guard'
import { selectedBranch } from '@/features/dashboard/selected-branch'

import { categoryFilterFrom, listCustomerNumbers } from './export'
import { customerSegmentSchema } from './schema'

const countSchema = z.object({
  segment: customerSegmentSchema,
  category: z.string().trim().max(40).optional().or(z.literal('')),
  mobileOnly: z.boolean().default(true),
  branchId: z.string().trim().max(40).optional().or(z.literal('')),
})

/**
 * How many numbers the export would contain, so the dialog can say "142
 * numbers" before the owner downloads a file with 3 in it. The same
 * permission as the download, so the count cannot be used to learn what
 * the file would hold by someone who may not have the file.
 */
export async function countCustomerNumbersAction(
  input: unknown,
): Promise<ActionResult<{ count: number; skipped: { invalid: number; blocked: number; landline: number; duplicate: number }; truncated: boolean }>> {
  return runAction(
    countSchema,
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.CUSTOMER_EXPORT)
      const { branchIds } = await selectedBranch(user, data.branchId ? { branch: data.branchId } : {})
      const { segment } = data
      const result = await listCustomerNumbers({
        restaurantId: user.restaurantId,
        branchIds,
        segment: {
          ...(segment.q ? { q: segment.q } : {}),
          ...(segment.minVisits !== undefined ? { minVisits: segment.minVisits } : {}),
          ...(segment.maxVisits !== undefined ? { maxVisits: segment.maxVisits } : {}),
          ...(segment.minSpent !== undefined ? { minSpent: segment.minSpent } : {}),
          ...(segment.maxSpent !== undefined ? { maxSpent: segment.maxSpent } : {}),
          ...(segment.notSeenForDays !== undefined ? { notSeenForDays: segment.notSeenForDays } : {}),
          ...(segment.seenWithinDays !== undefined ? { seenWithinDays: segment.seenWithinDays } : {}),
          ...(segment.minPoints !== undefined ? { minPoints: segment.minPoints } : {}),
          ...(segment.kind ? { kind: segment.kind } : {}),
        },
        category: categoryFilterFrom(data.category),
        mobileOnly: data.mobileOnly,
      })
      return { count: result.rows.length, skipped: result.skipped, truncated: result.truncated }
    },
    undefined,
    'countCustomerNumbers',
  )
}
