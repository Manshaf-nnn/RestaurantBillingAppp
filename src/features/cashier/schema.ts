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

/** The till's yes to a QR / online order (abc.md §5). */
export const acceptGuestOrderSchema = z.object({
  orderId: z.string().min(1),
})

/** The till's no: a cancellation, and the guest is told why. */
export const rejectGuestOrderSchema = z.object({
  orderId: z.string().min(1),
  reason: z.string().trim().min(2, 'Tell the guest why').max(200),
})

/** New dishes joining a bill from the till (order editing). */
export const addItemsSchema = z.object({
  orderId: z.string().min(1),
  items: z
    .array(
      z.object({
        foodId: z.string().min(1),
        quantity: z.coerce.number().int().min(1).max(50),
        optionIds: z.array(z.string()).default([]),
        notes: z.string().trim().max(160).optional().or(z.literal('')),
      }),
    )
    .min(1, 'Add at least one item')
    .max(20),
})

export const voidItemSchema = z.object({
  orderId: z.string().min(1),
  itemId: z.string().min(1),
  reason: z.string().trim().min(2, 'Give a reason').max(200),
})

/**
 * A discount on one line of a bill (pro.A.md §10).
 *
 * The amount is in MINOR units and is the whole reduction for that line, not
 * per unit — "two burgers, 100 off" is 100, not 200. Zero clears it, which is
 * how a cashier takes a discount back off.
 */
export const setItemDiscountSchema = z.object({
  orderId: z.string().cuid(),
  itemId: z.string().cuid(),
  amount: z.coerce.number().int().min(0, 'A discount cannot be negative').max(100_000_00),
  reason: z.string().trim().max(160).optional().or(z.literal('')),
})
