import { z } from 'zod'

/**
 * What the Make Item screen sends (redesignkitchenjob.md).
 *
 * Kept out of `actions.ts` because a `'use server'` module may export nothing
 * but async functions, and the form needs the same shape for its own checks.
 */

export const STOCK_UNITS = [
  'KG', 'GRAM', 'LITRE', 'ML', 'PIECE', 'PACK', 'BOTTLE', 'DOZEN', 'BOX',
] as const

export type StockUnitCode = (typeof STOCK_UNITS)[number]

const line = z.object({
  itemId: z.string().min(1, 'Choose a stock item'),
  quantity: z.coerce.number().positive('Enter how much was used').max(1_000_000_000),
  unit: z.enum(STOCK_UNITS),
})

export const produceItemSchema = z.object({
  /**
   * Minted once by the form when the cook commits, reused on every retry, so a
   * flaky connection cannot make the same batch twice. See `newRequestKey`.
   */
  clientRequestId: z.string().min(8).max(64),
  branchId: z.string().min(1, 'Choose where this was made'),
  output: z.object({
    /** Set when the typed name matched an existing item; the name still travels for the record. */
    itemId: z.string().min(1).nullable().optional(),
    name: z.string().trim().min(2, 'Name what you made').max(80),
    quantity: z.coerce.number().positive('Say how much came out').max(1_000_000_000),
    unit: z.enum(STOCK_UNITS),
  }),
  ingredients: z.array(line).min(1, 'Add at least one ingredient').max(60),
  waste: z
    .array(line.extend({ note: z.string().trim().max(200).optional() }))
    .max(20)
    .default([]),
  notes: z.string().trim().max(500).optional(),
})

export type ProduceItemInput = z.infer<typeof produceItemSchema>
