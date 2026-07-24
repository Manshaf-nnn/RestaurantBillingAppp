import { z } from 'zod'

import { phoneSchema } from '@/features/auth/schema'

export const cartItemSchema = z.object({
  foodId: z.string().cuid('Invalid menu item'),
  quantity: z.coerce.number().int().min(1, 'Quantity must be at least 1').max(50, 'Maximum 50 per item'),
  optionIds: z.array(z.string().cuid()).max(30).default([]),
  notes: z.string().trim().max(200, 'Keep notes under 200 characters').optional().or(z.literal('')),
})
export type CartItemInput = z.infer<typeof cartItemSchema>

export const tableEntrySchema = z.object({
  tableNumber: z
    .string()
    .trim()
    .min(1, 'Enter your table number')
    .max(10, 'That table number looks too long')
    .regex(/^[A-Za-z0-9-]+$/, 'Use letters and numbers only'),
})
export type TableEntryInput = z.infer<typeof tableEntrySchema>

export const placeOrderSchema = z.object({
  tableId: z.string().cuid('Select a table'),
  customerName: z.string().trim().min(2, 'Enter your name').max(60),
  customerPhone: phoneSchema,
  customerEmail: z.string().trim().email('Enter a valid email').max(255).optional().or(z.literal('')),
  guestCount: z.coerce.number().int().min(1).max(50).optional(),
  notes: z.string().trim().max(300).optional().or(z.literal('')),
  couponCode: z.string().trim().toUpperCase().max(32).optional().or(z.literal('')),
  redeemPoints: z.coerce.number().int().min(0).max(1_000_000).default(0),
  items: z.array(cartItemSchema).min(1, 'Your cart is empty').max(60, 'Too many items in one order'),
})
export type PlaceOrderInput = z.infer<typeof placeOrderSchema>

export const staffOrderSchema = placeOrderSchema.extend({
  type: z.enum(['DINE_IN', 'TAKEAWAY', 'DELIVERY']).default('DINE_IN'),
  tableId: z.string().cuid().optional().or(z.literal('')),
  manualDiscount: z.coerce.number().int().min(0).default(0),
})
export type StaffOrderInput = z.infer<typeof staffOrderSchema>

export const updateOrderStatusSchema = z.object({
  orderId: z.string().cuid(),
  status: z.enum(['PENDING', 'ACCEPTED', 'PREPARING', 'READY', 'SERVED', 'COMPLETED', 'CANCELLED']),
  note: z.string().trim().max(200).optional(),
  estimatedMinutes: z.coerce.number().int().min(0).max(240).optional(),
})
export type UpdateOrderStatusInput = z.infer<typeof updateOrderStatusSchema>

export const cancelOrderSchema = z.object({
  orderId: z.string().cuid(),
  reason: z.string().trim().min(3, 'Give a short reason').max(200),
})
export type CancelOrderInput = z.infer<typeof cancelOrderSchema>

export const updateItemStatusSchema = z.object({
  orderId: z.string().cuid(),
  itemId: z.string().cuid(),
  status: z.enum(['QUEUED', 'PREPARING', 'READY', 'SERVED', 'CANCELLED']),
})

export const serviceRequestSchema = z.object({
  tableId: z.string().cuid(),
  type: z.enum(['WATER', 'PLATES', 'BILL', 'HELP', 'CLEAN_TABLE']),
  note: z.string().trim().max(160).optional().or(z.literal('')),
})
export type ServiceRequestInput = z.infer<typeof serviceRequestSchema>

export const orderFilterSchema = z.object({
  search: z.string().trim().max(80).optional(),
  status: z
    .enum(['ALL', 'PENDING', 'ACCEPTED', 'PREPARING', 'READY', 'SERVED', 'COMPLETED', 'CANCELLED'])
    .default('ALL'),
  paymentStatus: z.enum(['ALL', 'UNPAID', 'PARTIAL', 'PAID', 'REFUNDED', 'FAILED']).default('ALL'),
  type: z.enum(['ALL', 'DINE_IN', 'TAKEAWAY', 'DELIVERY']).default('ALL'),
  from: z.string().optional(),
  to: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(10).max(100).default(25),
})
export type OrderFilterInput = z.infer<typeof orderFilterSchema>

export const applyDiscountSchema = z.object({
  orderId: z.string().cuid(),
  amount: z.coerce.number().int().min(0),
  reason: z.string().trim().max(160).optional(),
})
