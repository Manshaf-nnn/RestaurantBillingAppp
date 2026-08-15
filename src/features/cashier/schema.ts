import { z } from 'zod'

export const holdBillSchema = z.object({
  orderId: z.string().min(1),
  reason: z.string().trim().max(160).optional().or(z.literal('')),
})

export const resumeBillSchema = z.object({
  orderId: z.string().min(1),
})

export const splitBillSchema = z.object({
  orderId: z.string().min(1),
  selections: z
    .array(
      z.object({
        itemId: z.string().min(1),
        quantity: z.number().int().min(1).max(999),
      }),
    )
    .min(1, 'Choose at least one item to move'),
})

export const mergeBillsSchema = z.object({
  targetId: z.string().min(1),
  sourceIds: z.array(z.string().min(1)).min(1, 'Choose at least one bill to merge in'),
})

export type HoldBillInput = z.infer<typeof holdBillSchema>
export type SplitBillInput = z.infer<typeof splitBillSchema>
export type MergeBillsInput = z.infer<typeof mergeBillsSchema>
