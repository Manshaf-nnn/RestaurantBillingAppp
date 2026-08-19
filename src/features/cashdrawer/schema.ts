import { z } from 'zod'

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

export const openDrawerSchema = z.object({
  openingFloat: majorAmount,
  branchId: z.string().min(1).optional().or(z.literal('')),
  note: z.string().trim().max(200).optional().or(z.literal('')),
})

export const cashMovementSchema = z.object({
  sessionId: z.string().min(1),
  type: z.enum(['CASH_IN', 'CASH_OUT']),
  amount: majorAmount.refine((v) => v > 0, 'Amount must be more than zero'),
  reason: z.string().trim().min(2, 'Give a reason').max(200),
})

export const closeDrawerSchema = z.object({
  sessionId: z.string().min(1),
  countedCash: majorAmount,
  note: z.string().trim().max(200).optional().or(z.literal('')),
})

export type OpenDrawerInput = z.infer<typeof openDrawerSchema>
export type CashMovementInput = z.infer<typeof cashMovementSchema>
export type CloseDrawerInput = z.infer<typeof closeDrawerSchema>
