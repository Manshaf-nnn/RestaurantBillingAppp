import { z } from 'zod'

export const restaurantSettingsSchema = z.object({
  name: z.string().trim().min(2, 'Name is required').max(80),
  tagline: z.string().trim().max(120).optional().or(z.literal('')),
  description: z.string().trim().max(500).optional().or(z.literal('')),
  logoUrl: z.string().url().max(500).optional().or(z.literal('')),
  coverUrl: z.string().url().max(500).optional().or(z.literal('')),
  email: z.string().email().max(255).optional().or(z.literal('')),
  phone: z.string().trim().max(20).optional().or(z.literal('')),
  addressLine: z.string().trim().max(200).optional().or(z.literal('')),
  city: z.string().trim().max(60).optional().or(z.literal('')),
  state: z.string().trim().max(60).optional().or(z.literal('')),
  postalCode: z.string().trim().max(20).optional().or(z.literal('')),
  currency: z.string().length(3),
  timezone: z.string().min(1).max(60),
  taxLabel: z.string().trim().min(1).max(20),
  taxRatePercent: z.coerce.number().min(0).max(100),
  taxInclusive: z.coerce.boolean().default(false),
  serviceChargePercent: z.coerce.number().min(0).max(100),
  loyaltyEnabled: z.coerce.boolean().default(true),
  loyaltyEarnRate: z.coerce.number().min(0).max(100).default(1),
})
export type RestaurantSettingsInput = z.infer<typeof restaurantSettingsSchema>

export const paymentSettingsSchema = z.object({
  cash: z.coerce.boolean().default(true),
  card: z.coerce.boolean().default(true),
  qr: z.coerce.boolean().default(true),
  online: z.coerce.boolean().default(false),
  upiId: z.string().trim().max(80).optional().or(z.literal('')),
  payeeName: z.string().trim().max(80).optional().or(z.literal('')),
})
export type PaymentSettingsInput = z.infer<typeof paymentSettingsSchema>
