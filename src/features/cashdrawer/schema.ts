import { z } from 'zod'

import { MANUAL_MOVEMENT_TYPES } from './movement-types'

/**
 * Drawer amounts are entered by a cashier in major units — they type what is
 * written on the notes in their hand, e.g. `5000` for Rs 5,000. The actions
 * convert to the integer minor units the database stores. Keeping the boundary
 * here rather than in the component means every caller converts identically.
 */
const majorAmount = z
  .number({ invalid_type_error: 'Enter an amount' })
  .nonnegative('Amount cannot be negative')
  .max(99_999_999, 'That amount looks wrong')

const optionalId = z.string().min(1).optional().or(z.literal(''))
const shortText = z.string().trim().max(200).optional().or(z.literal(''))

export const openDrawerSchema = z.object({
  openingFloat: majorAmount,
  /** The petty cash tin, kept separate from the float on purpose. */
  openingPettyCash: majorAmount.optional(),
  branchId: optionalId,
  registerId: optionalId,
  note: shortText,
})

/*
 * Only the types a person is allowed to pick. CASH_REFUND and PETTY_CASH_PAID
 * are written by the code that performs those actions, so accepting them here
 * would be a way to post the same rupees to the ledger twice.
 */
const manualType = z.enum(
  MANUAL_MOVEMENT_TYPES as unknown as [string, ...string[]],
) as z.ZodType<(typeof MANUAL_MOVEMENT_TYPES)[number]>

export const cashMovementSchema = z.object({
  sessionId: z.string().min(1),
  type: manualType,
  amount: majorAmount.refine((v) => v > 0, 'Amount must be more than zero'),
  reason: z.string().trim().min(2, 'Give a reason').max(200),
  reference: shortText,
})

/**
 * Closing.
 *
 * `varianceReason` is validated in the service rather than here, because
 * whether it is required depends on the variance — which depends on the
 * expected cash, which only the server knows. A `refine` on this object could
 * only ever check the shape, and a client that skipped the field would still
 * have to be refused server-side. One rule, in the place that can enforce it.
 */
export const closeDrawerSchema = z.object({
  sessionId: z.string().min(1),
  countedCash: majorAmount,
  varianceReason: shortText,
  note: shortText,
})

export const reviewDrawerSchema = z.object({
  sessionId: z.string().min(1),
  note: shortText,
})

export const registerSchema = z.object({
  branchId: z.string().min(1),
  name: z.string().trim().min(1, 'Give the till a name').max(60),
})

export const registerActiveSchema = z.object({
  registerId: z.string().min(1),
  isActive: z.boolean(),
})

export type OpenDrawerInput = z.infer<typeof openDrawerSchema>
export type CashMovementInput = z.infer<typeof cashMovementSchema>
export type CloseDrawerInput = z.infer<typeof closeDrawerSchema>
export type ReviewDrawerInput = z.infer<typeof reviewDrawerSchema>
