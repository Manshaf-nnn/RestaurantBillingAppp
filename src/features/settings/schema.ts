import { z } from 'zod'

import { imageUrlField } from '@/lib/media-url'

export const restaurantSettingsSchema = z.object({
  name: z.string().trim().min(2, 'Name is required').max(80),
  tagline: z.string().trim().max(120).optional().or(z.literal('')),
  description: z.string().trim().max(500).optional().or(z.literal('')),
  logoUrl: imageUrlField(),
  coverUrl: imageUrlField(),
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
  allowNegativeStock: z.coerce.boolean().default(false),
  serviceChargePercent: z.coerce.number().min(0).max(100),
  loyaltyEnabled: z.coerce.boolean().default(true),
  loyaltyEarnRate: z.coerce.number().min(0).max(100).default(1),
  // Value of one point when redeemed, in whole currency units (e.g. 0.10 = ₹0.10).
  loyaltyPointValue: z.coerce.number().min(0).max(10_000).default(1),
})
export type RestaurantSettingsInput = z.infer<typeof restaurantSettingsSchema>

export const paymentSettingsSchema = z.object({
  cash: z.coerce.boolean().default(true),
  card: z.coerce.boolean().default(true),
  qr: z.coerce.boolean().default(true),
  online: z.coerce.boolean().default(false),
  upiId: z.string().trim().max(80).optional().or(z.literal('')),
  payeeName: z.string().trim().max(80).optional().or(z.literal('')),
  // Direct bank / online transfer.
  bankTransfer: z.coerce.boolean().default(false),
  bankName: z.string().trim().max(80).optional().or(z.literal('')),
  accountName: z.string().trim().max(80).optional().or(z.literal('')),
  accountNumber: z.string().trim().max(40).optional().or(z.literal('')),
  bankBranch: z.string().trim().max(80).optional().or(z.literal('')),
  receiptWhatsapp: z.string().trim().max(24).optional().or(z.literal('')),
})
export type PaymentSettingsInput = z.infer<typeof paymentSettingsSchema>

/**
 * Receipt and kitchen-ticket paper width, in millimetres.
 *
 * 58 mm and 80 mm are the two standard thermal roll sizes. The width decides the
 * page size and font scale of the printed document, so a receipt formatted for
 * 58 mm on an 80 mm printer wastes a third of the paper and prints small.
 */
export const printerSettingsSchema = z.object({
  receiptWidth: z.coerce.number().refine((v) => v === 58 || v === 80, 'Choose 58 mm or 80 mm'),
  kitchenWidth: z.coerce.number().refine((v) => v === 58 || v === 80, 'Choose 58 mm or 80 mm'),
})
export type PrinterSettingsInput = z.infer<typeof printerSettingsSchema>

/**
 * The cash controls.
 *
 * Amounts are entered in major units — the owner types what they would say out
 * loud, "five hundred rupees" as `500` — and the action converts with the
 * restaurant's own currency factor. Zero means "never": a variance threshold of
 * zero sends nothing for review, which is the pre-existing behaviour and has to
 * stay expressible.
 */
export const cashControlsSchema = z.object({
  cashVarianceAbove: z.coerce.number().min(0).max(9_999_999),
  pettyCashApprovalAbove: z.coerce.number().min(0).max(9_999_999),
  requireCashierSession: z.coerce.boolean().default(true),
})
export type CashControlsInput = z.infer<typeof cashControlsSchema>
