import { z } from 'zod'

export const paymentIntentSchema = z.object({
  orderId: z.string().cuid(),
  method: z.enum(['QR', 'CARD', 'ONLINE']),
})
export type PaymentIntentInput = z.infer<typeof paymentIntentSchema>

export const collectPaymentSchema = z.object({
  orderId: z.string().cuid(),
  /*
   * Every recordable method, including BANK_TRANSFER and OTHER. The spec (§6)
   * forbids processing — no gateways — but forbidding the RECORD meant a bill
   * genuinely settled by bank transfer had to be booked as something it was
   * not. The reference field carries the transfer id or what OTHER was.
   */
  method: z.enum(['CASH', 'CARD', 'QR', 'ONLINE', 'WALLET', 'BANK_TRANSFER', 'OTHER']),
  amount: z.coerce.number().int().min(1, 'Enter an amount'),
  tenderedAmount: z.coerce.number().int().min(0).optional(),
  reference: z.string().trim().max(80).optional().or(z.literal('')),
  tipAmount: z.coerce.number().int().min(0).default(0),
  /*
   * One id per tender attempt, so a retry after a lost response settles the
   * bill once. Optional because the guest-side and legacy paths do not mint
   * one; where it is absent the order lock is still the only protection.
   */
  clientRequestId: z.string().trim().min(8).max(64).optional(),
})
export type CollectPaymentInput = z.infer<typeof collectPaymentSchema>

export const refundPaymentSchema = z.object({
  paymentId: z.string().cuid(),
  reason: z.string().trim().min(3, 'Give a reason for the refund').max(200),
  /** Minor units. Absent refunds everything the payment has left. */
  amount: z.coerce.number().int().min(1).optional(),
  /** One id per refund attempt — see `collectPaymentSchema.clientRequestId`. */
  clientRequestId: z.string().trim().min(8).max(64).optional(),
})

export const guestPaidSchema = z.object({
  orderId: z.string().cuid(),
  reference: z.string().trim().max(80).optional().or(z.literal('')),
})

export const emailReceiptSchema = z.object({
  orderId: z.string().cuid(),
  email: z.string().email('Enter a valid email address'),
})
