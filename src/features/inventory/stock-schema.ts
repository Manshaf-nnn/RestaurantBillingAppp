import { z } from 'zod'

const UNITS = ['KG', 'GRAM', 'LITRE', 'ML', 'PIECE', 'PACK', 'BOTTLE', 'DOZEN', 'BOX'] as const

const quantity = z.coerce
  .number({ invalid_type_error: 'Enter a quantity' })
  .positive('Quantity must be more than zero')
  .max(1_000_000, 'That quantity looks wrong')

export const receiveStockSchema = z.object({
  itemId: z.string().min(1),
  quantity,
  unit: z.enum(UNITS).optional(),
  /** Cost per base unit in major units; converted in the action. */
  unitCost: z.coerce.number().nonnegative().max(10_000_000).optional(),
  batchNo: z.string().trim().max(60).optional().or(z.literal('')),
  notes: z.string().trim().max(200).optional().or(z.literal('')),
})

/*
 * There is no wastageSchema here.
 *
 * One lived here with a free-text reason and another in wastage-actions.ts with
 * the reason enum, feeding two different code paths for the same event — and
 * the path through this file wrote no WastageRecord, so wastage logged that way
 * never reached the wastage report. The enum version in wastage-actions.ts is
 * the only one.
 */

export const adjustStockSchema = z.object({
  itemId: z.string().min(1),
  quantity,
  unit: z.enum(UNITS).optional(),
  direction: z.enum(['IN', 'OUT']),
  reason: z.string().trim().min(2, 'Give a reason').max(200),
})

export const openingBalanceSchema = z.object({
  itemId: z.string().min(1),
  quantity,
  unit: z.enum(UNITS).optional(),
  unitCost: z.coerce.number().nonnegative().max(10_000_000).optional(),
})

export const countLinesSchema = z.object({
  stockCountId: z.string().min(1),
  lines: z
    .array(
      z.object({
        itemId: z.string().min(1),
        countedQty: z.coerce.number().nonnegative().max(1_000_000),
        unit: z.enum(UNITS).optional(),
        notes: z.string().trim().max(200).optional().or(z.literal('')),
      }),
    )
    .min(1, 'Add at least one item'),
})

export const approveCountSchema = z.object({
  stockCountId: z.string().min(1),
  notes: z.string().trim().max(200).optional().or(z.literal('')),
})
