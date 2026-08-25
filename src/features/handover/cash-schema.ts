import { z } from 'zod'

const majorAmount = z
  .number({ invalid_type_error: 'Enter an amount' })
  .nonnegative('Amount cannot be negative')
  .max(99_999_999, 'That amount looks wrong')

const shortText = z.string().trim().max(200).optional().or(z.literal(''))

/**
 * There is no branch field here, and that is deliberate.
 *
 * The new session inherits branch and register from the session being handed
 * over, so "do not allow handovers between branches" is not a rule anybody has
 * to remember to check — there is nothing to post that could break it. The one
 * thing that is checked is that the incoming cashier can reach that branch.
 */
export const handoverRequestSchema = z.object({
  sessionId: z.string().min(1),
  toUserId: z.string().min(1, 'Pick who is taking over'),
  countedAmount: majorAmount,
  varianceReason: shortText,
  note: shortText,
})

export const handoverIdSchema = z.object({
  handoverId: z.string().min(1),
})

export type HandoverRequestInput = z.infer<typeof handoverRequestSchema>
