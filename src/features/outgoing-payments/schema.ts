import { z } from 'zod'

/**
 * Amounts arrive in MAJOR units (what the accountant types: 1500.50) and the
 * action converts through minorUnitFactor — the petty cash convention.
 */
const majorAmount = z.coerce.number().positive('The amount must be above zero').max(100_000_000)

const base = {
  branchId: z.string().min(1, 'Choose a location'),
  amount: majorAmount,
  method: z.enum(['CASH', 'CARD', 'BANK_TRANSFER', 'QR', 'ONLINE', 'WALLET']),
  reference: z.string().trim().max(120).optional().or(z.literal('')),
  description: z.string().trim().min(3, 'Say what this payment is for').max(300),
  /** YYYY-MM-DD */
  paymentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Pick a date'),
}

export const draftPaymentSchema = z
  .object({
    kind: z.enum(['SUPPLIER', 'EXPENSE']),
    supplierId: z.string().cuid().optional().or(z.literal('')),
    purchaseId: z.string().cuid().optional().or(z.literal('')),
    expenseCategoryId: z.string().cuid().optional().or(z.literal('')),
    ...base,
  })
  .refine((data) => data.kind !== 'SUPPLIER' || Boolean(data.supplierId), {
    message: 'Choose the supplier being paid',
    path: ['supplierId'],
  })
  .refine((data) => data.kind !== 'EXPENSE' || Boolean(data.expenseCategoryId), {
    message: 'Choose an expense category',
    path: ['expenseCategoryId'],
  })
export type DraftPaymentInput = z.infer<typeof draftPaymentSchema>

export const updateDraftSchema = z.object({
  paymentId: z.string().cuid(),
  patch: draftPaymentSchema,
})

export const paymentIdSchema = z.object({ paymentId: z.string().cuid() })

export const decidePaymentSchema = z.object({
  paymentId: z.string().cuid(),
  approve: z.coerce.boolean(),
  note: z.string().trim().max(300).optional().or(z.literal('')),
})

export const sendBackSchema = z.object({
  paymentId: z.string().cuid(),
  note: z.string().trim().min(3, 'Say what needs changing').max(300),
})

export const reversePaymentSchema = z.object({
  paymentId: z.string().cuid(),
  reason: z.string().trim().min(3, 'Give a reason').max(300),
})

export const expenseCategorySchema = z.object({
  id: z.string().cuid().optional(),
  name: z.string().trim().min(2, 'Name the category').max(60),
  isActive: z.coerce.boolean().default(true),
})
