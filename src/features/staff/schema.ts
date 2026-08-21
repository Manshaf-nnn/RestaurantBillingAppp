import { z } from 'zod'

import { emailSchema, passwordSchema, phoneSchema } from '@/features/auth/schema'

const STAFF_ROLES = ['MANAGER', 'KITCHEN', 'CASHIER', 'WAITER'] as const

export const inviteStaffSchema = z.object({
  name: z.string().trim().min(2, 'Name is required').max(80),
  email: emailSchema,
  phone: phoneSchema.optional().or(z.literal('')),
  role: z.enum(STAFF_ROLES),
})
export type InviteStaffInput = z.infer<typeof inviteStaffSchema>

export const updateStaffSchema = z.object({
  id: z.string().cuid(),
  name: z.string().trim().min(2).max(80),
  phone: phoneSchema.optional().or(z.literal('')),
  role: z.enum(STAFF_ROLES),
  isActive: z.coerce.boolean(),
})
export type UpdateStaffInput = z.infer<typeof updateStaffSchema>

export const customerSchema = z.object({
  id: z.string().cuid().optional(),
  name: z.string().trim().min(2, 'Name is required').max(60),
  phone: phoneSchema,
  email: z.string().email().max(255).optional().or(z.literal('')),
  notes: z.string().trim().max(300).optional().or(z.literal('')),
  isBlocked: z.coerce.boolean().default(false),
})
export type CustomerInput = z.infer<typeof customerSchema>

export const adjustLoyaltySchema = z.object({
  customerId: z.string().cuid(),
  points: z.coerce.number().int(),
  reason: z.string().trim().max(160).optional(),
})

export const couponSchema = z
  .object({
    id: z.string().cuid().optional(),
    code: z
      .string()
      .trim()
      .toUpperCase()
      .min(3, 'Code must be at least 3 characters')
      .max(24)
      .regex(/^[A-Z0-9]+$/, 'Letters and numbers only'),
    description: z.string().trim().max(160).optional().or(z.literal('')),
    type: z.enum(['PERCENT', 'FIXED', 'FREE_ITEM']),
    value: z.coerce.number().int().min(1, 'Enter a value'),
    minOrderAmount: z.coerce.number().int().min(0).default(0),
    maxDiscount: z.coerce.number().int().min(0).optional().nullable(),
    startsAt: z.string().optional().or(z.literal('')),
    endsAt: z.string().optional().or(z.literal('')),
    usageLimit: z.coerce.number().int().min(0).optional().nullable(),
    perCustomerLimit: z.coerce.number().int().min(0).optional().nullable(),
    isActive: z.coerce.boolean().default(true),
  })
  .refine((data) => data.type !== 'PERCENT' || data.value <= 10000, {
    message: 'Percentage cannot exceed 100%',
    path: ['value'],
  })
export type CouponInput = z.infer<typeof couponSchema>

export const replyReviewSchema = z.object({
  id: z.string().cuid(),
  reply: z.string().trim().min(1, 'Write a reply').max(500),
})

/**
 * An owner setting a member of staff's password by hand.
 *
 * Held to the same strength rules as any other password (`passwordSchema`), so
 * the manual route cannot become the weak one — the generated sign-in codes it
 * replaces are 8 characters of random.
 */
export const setStaffPasswordSchema = z.object({
  userId: z.string().min(1),
  password: passwordSchema,
})
