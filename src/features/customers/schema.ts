import { z } from 'zod'

/**
 * What the customer screens post (pro.A.md §1, §5, §6).
 *
 * Kept out of the actions module because a `'use server'` file may export
 * nothing but async functions.
 *
 * Only the phone is required. Everything else is optional, deliberately: a
 * cashier with a queue at the counter types a number and moves on, and the
 * details get filled in over time by the people who have time.
 */

const optionalText = (max: number) => z.string().trim().max(max).optional().or(z.literal(''))

/** An ISO date, or nothing. Empty strings come from an untouched date input. */
const optionalDate = z
  .string()
  .trim()
  .optional()
  .or(z.literal(''))
  .transform((value) => (value ? new Date(value) : null))
  .refine((value) => value === null || !Number.isNaN(value.getTime()), 'That is not a date')

export const customerFields = {
  phone: z
    .string()
    .trim()
    .min(7, 'A phone number is needed')
    .max(20)
    .regex(/^[+]?[0-9\s()-]{7,20}$/, 'That does not look like a phone number'),
  name: optionalText(80),
  email: z.string().trim().email('That does not look like an email').optional().or(z.literal('')),
  notes: optionalText(500),
  address: optionalText(200),
  categoryId: z.string().cuid().optional().or(z.literal('')),
  birthday: optionalDate,
  anniversary: optionalDate,
}

export const saveCustomerSchema = z.object({
  id: z.string().cuid().optional(),
  ...customerFields,
  isBlocked: z.boolean().optional(),
})

export const findCustomerSchema = z.object({
  phone: z.string().trim().min(3).max(20),
})

export const attachCustomerSchema = z.object({
  orderId: z.string().cuid(),
  customerId: z.string().cuid(),
})

export const saveCustomerCategorySchema = z.object({
  id: z.string().cuid().optional(),
  name: z.string().trim().min(2, 'Give the category a name').max(40),
  colour: optionalText(20),
  sortOrder: z.coerce.number().int().min(0).max(999).optional(),
})

export const customerCategoryIdSchema = z.object({
  id: z.string().cuid(),
})

export const setCustomerCategoryActiveSchema = customerCategoryIdSchema.extend({
  isActive: z.boolean(),
})

export type SaveCustomerInput = z.infer<typeof saveCustomerSchema>

/** The filter the insights screen builds, and a campaign saves (pro.A.md §3, §4). */
export const customerSegmentSchema = z.object({
  q: z.string().trim().max(80).optional(),
  categoryId: z.string().cuid().optional().or(z.literal('')),
  minVisits: z.coerce.number().int().min(0).max(100_000).optional(),
  maxVisits: z.coerce.number().int().min(0).max(100_000).optional(),
  minSpent: z.coerce.number().int().min(0).optional(),
  maxSpent: z.coerce.number().int().min(0).optional(),
  notSeenForDays: z.coerce.number().int().min(0).max(3650).optional(),
  seenWithinDays: z.coerce.number().int().min(0).max(3650).optional(),
  firstSeenFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal('')),
  firstSeenTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal('')),
  minPoints: z.coerce.number().int().min(0).optional(),
  active: z.boolean().optional(),
  kind: z.enum(['new', 'returning', 'repeat', 'regular', 'lapsed']).optional().or(z.literal('')),
})

/**
 * A discount aimed at a group (pro.A.md §4).
 *
 * It is a coupon with a segment on it — not a second discount engine — so
 * every rule the engine already enforces (dates, minimum, per-customer limit,
 * usage cap, branch) applies unchanged.
 */
export const createCampaignSchema = z.object({
  /**
   * Optional, and normally absent.
   *
   * A code was required here because a coupon is looked up by one — it is the
   * primary key of the redemption path. But nobody ever says this code out
   * loud: the offer is aimed at a named group, and the till now shows it to
   * the cashier the moment the guest's phone is recognised. Asking an owner to
   * invent "REGULARS10" was asking them to name something they would never use
   * again, and to keep it unique by hand.
   *
   * So the column stays — the redemption path, the audit trail and the
   * existing coupon history all depend on it — and it is generated when this
   * is blank. Still accepted, because a restaurant that DOES want a sayable
   * code for a poster should be able to have one.
   */
  code: z
    .string()
    .trim()
    .max(24)
    .regex(/^[A-Za-z0-9_-]+$/, 'Letters, numbers, dashes')
    .optional()
    .or(z.literal('')),
  description: z.string().trim().max(160).optional().or(z.literal('')),
  type: z.enum(['PERCENT', 'FIXED']),
  /** Percent in basis points, or a fixed amount in minor units. */
  value: z.coerce.number().int().min(1, 'Set how much comes off'),
  minOrderAmount: z.coerce.number().int().min(0).default(0),
  maxDiscount: z.coerce.number().int().min(0).nullable().optional(),
  startsAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal('')),
  endsAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal('')),
  usageLimit: z.coerce.number().int().min(0).nullable().optional(),
  perCustomerLimit: z.coerce.number().int().min(0).nullable().optional(),
  segment: customerSegmentSchema,
})

/**
 * The basket a guest is standing in front of, for the offers question
 * (pro.A.md §4).
 *
 * The cart is posted rather than read from anywhere, because at the Orders tab
 * there is no order yet — the basket only exists in the browser. Nothing here
 * is trusted for money: it decides which offers to SHOW, and placement
 * re-evaluates every one of them against the real lines before a rupee moves.
 */
export const offersForCustomerSchema = z.object({
  customerId: z.string().cuid(),
  branchId: z.string().trim().max(40).optional().or(z.literal('')),
  lines: z
    .array(
      z.object({
        foodId: z.string().max(40).nullable().optional(),
        categoryId: z.string().max(40).nullable().optional(),
        quantity: z.coerce.number().int().min(0).max(1000),
        lineTotal: z.coerce.number().int().min(0),
      }),
    )
    .max(120)
    .default([]),
})
