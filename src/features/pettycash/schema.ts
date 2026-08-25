import { z } from 'zod'

/**
 * Petty cash amounts are typed in major units, like every other cash figure a
 * person enters. The action converts using the restaurant's own currency.
 */
const majorAmount = z
  .number({ invalid_type_error: 'Enter an amount' })
  .positive('Amount must be more than zero')
  .max(99_999_999, 'That amount looks wrong')

const shortText = z.string().trim().max(200).optional().or(z.literal(''))

export const pettyRequestSchema = z.object({
  category: z.string().trim().min(1, 'Pick a category').max(60),
  description: z.string().trim().min(2, 'Say what the money was for').max(300),
  amount: majorAmount,
  reference: shortText,
  /** Which tin it comes out of. The fund unless somebody says otherwise. */
  paidFrom: z.enum(['DRAWER', 'PETTY_FUND']).default('PETTY_FUND'),
  branchId: z.string().min(1).optional().or(z.literal('')),
  draft: z.boolean().optional(),
})

export const pettyDecisionSchema = z.object({
  requestId: z.string().min(1),
  approve: z.boolean(),
  note: shortText,
})

export const pettyIdSchema = z.object({
  requestId: z.string().min(1),
})

export const pettyPaySchema = z.object({
  requestId: z.string().min(1),
  sessionId: z.string().min(1),
})

export type PettyRequestInput = z.infer<typeof pettyRequestSchema>
export type PettyDecisionInput = z.infer<typeof pettyDecisionSchema>
export type PettyPayInput = z.infer<typeof pettyPaySchema>
