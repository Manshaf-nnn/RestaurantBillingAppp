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

/**
 * Starting a batch (correctionA.md §10).
 *
 * The same shape as `produceItemSchema` minus the certainty: `quantity` is
 * what the cook INTENDS to make. What actually came out is supplied later, by
 * `completeBatchSchema`, and the gap between the two is the yield variance
 * that the one-step flow has no way to express.
 */
export const startBatchSchema = z.object({
  clientRequestId: z.string().min(8).max(64),
  branchId: z.string().min(1, 'Choose where this is being made'),
  output: z.object({
    itemId: z.string().min(1).nullable().optional(),
    name: z.string().trim().min(2, 'Name what you are making').max(80),
    quantity: z.coerce.number().positive('Say how much you are aiming for').max(1_000_000_000),
    unit: z.enum(STOCK_UNITS),
  }),
  ingredients: z.array(line).min(1, 'Add at least one ingredient').max(60),
  waste: z
    .array(line.extend({ note: z.string().trim().max(200).optional() }))
    .max(20)
    .default([]),
  notes: z.string().trim().max(500).optional(),
})

export const completeBatchSchema = z.object({
  clientRequestId: z.string().min(8).max(64),
  batchId: z.string().min(1),
  /** What actually came out. Zero is a real answer — the batch failed. */
  actualQuantity: z.coerce.number().min(0, 'How much did you make?').max(1_000_000_000),
  /** The unit it was measured in (aO.md §5); the plan's unit when omitted. */
  actualUnit: z.enum(STOCK_UNITS).optional(),
  varianceReason: z
    // The enum the database already has, not a parallel vocabulary.
    .enum(['PRODUCTION_LOSS', 'DAMAGED', 'INGREDIENT_SHORTAGE', 'QUALITY_ISSUE', 'OTHER'])
    .nullable()
    .optional(),
  varianceNote: z.string().trim().max(300).optional(),
  notes: z.string().trim().max(500).optional(),
})

export const cancelBatchSchema = z.object({ batchId: z.string().min(1) })

/** Make more of a prepared item from its own recipe (aO.md §5). */
export const makeMoreSchema = z.object({
  clientRequestId: z.string().min(8).max(64),
  branchId: z.string().min(1, 'Choose where this is being made'),
  itemId: z.string().min(1),
  quantity: z.coerce.number().positive('How much did you make?').max(1_000_000_000),
  unit: z.enum(STOCK_UNITS),
  notes: z.string().trim().max(500).optional(),
})
