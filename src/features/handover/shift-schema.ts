import { z } from 'zod'

/**
 * What the shift handover screen posts (recorrection.md §2).
 *
 * Kept out of the actions module because a `'use server'` file may export
 * nothing but async functions.
 */

const shortText = z.string().trim().max(300).optional().or(z.literal(''))

export const startShiftHandoverSchema = z.object({
  toUserId: z.string().min(1, 'Pick who is taking over'),
  /**
   * Only meaningful for somebody who works across every location; a confined
   * person's branch comes from their session and this is ignored for them.
   */
  branchId: z.string().min(1).optional().or(z.literal('')),
  notes: z.string().trim().max(1000).optional().or(z.literal('')),
  /**
   * Major units, like the drawer screens. Required by the service when the
   * outgoing person has a drawer open — the till goes with the shift.
   */
  countedAmount: z
    .number({ invalid_type_error: 'Enter what you counted' })
    .nonnegative('Counted cash cannot be negative')
    .max(99_999_999, 'That amount looks wrong')
    .nullable()
    .optional(),
  varianceReason: shortText,
  /**
   * Face value in minor units → how many were counted (shifthandover.md
   * "Cash drawer — critical"). The till screens post this and never a total,
   * so the sum is the server's and the variance is never shown before it is.
   */
  counts: z.record(z.string(), z.number().int().min(0).max(100_000)).nullable().optional(),
})

export const shiftHandoverIdSchema = z.object({
  handoverId: z.string().min(1),
})

export const rejectShiftHandoverSchema = shiftHandoverIdSchema.extend({
  reason: z.string().trim().min(2, 'Say why you are not accepting it').max(300),
})

export const previewShiftHandoverSchema = z.object({
  branchId: z.string().min(1).optional().or(z.literal('')),
})

export type StartShiftHandoverInput = z.infer<typeof startShiftHandoverSchema>
