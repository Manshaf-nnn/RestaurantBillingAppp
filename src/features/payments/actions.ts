'use server'

import { revalidatePath } from 'next/cache'

import { runAction, runSafe, type ActionResult } from '@/lib/action'
import { AppError, NotFoundError } from '@/lib/errors'
import { formatMoney } from '@/lib/money'
import { PERMISSIONS } from '@/lib/rbac'
import { AUDIT_ACTIONS, audit } from '@/server/audit'
import { assertRecordBranch, requirePermission } from '@/server/auth/guard'
import { prisma } from '@/server/db/prisma'
import { resolvePublicTenant } from '@/server/db/tenant'
import { receiptEmail, sendMail } from '@/server/mailer'
import { notify } from '@/server/notifications'
import { enforceRateLimit } from '@/server/security/rate-limit'
import { appUrl } from '@/lib/env'
import { tenantOrigin } from '@/lib/tenant-url'
import { getOrderForGuest, readOptions } from '@/features/orders/queries'
import {
  collectPaymentSchema,
  emailReceiptSchema,
  guestPaidSchema,
  paymentIntentSchema,
  refundPaymentSchema,
} from './schema'
import { capturePayment, createPaymentIntent, refundPayment } from './service'

// ── guest ────────────────────────────────────────────────────────────────────

/** Generates the dynamic payment QR shown on the guest bill screen. */
export async function requestPaymentQr(input: unknown) {
  return runAction(paymentIntentSchema, input, async (data) => {
    await enforceRateLimit('mutation')

    const restaurant = await resolvePublicTenant()
    if (!restaurant) throw new NotFoundError('Restaurant')

    // Guests may only raise an intent against their own order.
    const order = await getOrderForGuest(restaurant.id, data.orderId)
    if (!order) throw new NotFoundError('Order')

    const intent = await createPaymentIntent({
      restaurantId: restaurant.id,
      orderId: order.id,
      method: data.method,
    })

    return {
      intentId: intent.intentId,
      amount: intent.amount,
      qrDataUrl: intent.qrDataUrl,
      currency: intent.currency,
    }
  })
}

/**
 * The guest says they have paid.
 *
 * This never marks the bill settled by itself — a cashier confirms receipt.
 * Self-service settlement without a gateway callback would be trivially abusable.
 */
export async function declareGuestPayment(input: unknown): Promise<ActionResult<{ notified: true }>> {
  return runAction(
    guestPaidSchema,
    input,
    async (data) => {
      await enforceRateLimit('mutation')

      const restaurant = await resolvePublicTenant()
      if (!restaurant) throw new NotFoundError('Restaurant')

      const order = await getOrderForGuest(restaurant.id, data.orderId)
      if (!order) throw new NotFoundError('Order')
      if (order.paymentStatus === 'PAID') {
        throw new AppError('This bill is already settled', 409, 'ALREADY_PAID')
      }

      await prisma.payment.updateMany({
        where: { orderId: order.id, status: 'UNPAID' },
        data: { reference: data.reference || 'Guest reported payment' },
      })

      await notify({
        restaurantId: restaurant.id,
        branchId: order.branchId,
        type: 'PAYMENT_RECEIVED',
        title: `Table ${order.table?.number ?? '—'} says they have paid`,
        body: `${order.orderNumber} · ${formatMoney(order.grandTotal - order.paidTotal, restaurant.currency)} — please verify`,
        audience: 'CASHIER',
        data: { orderId: order.id, orderNumber: order.orderNumber, needsVerification: true },
      })

      return { notified: true as const }
    },
    'Thanks — our cashier will confirm shortly.',
  )
}

export async function emailReceipt(input: unknown): Promise<ActionResult<{ sent: boolean }>> {
  return runAction(
    emailReceiptSchema,
    input,
    async (data) => {
      const restaurant = await resolvePublicTenant()
      if (!restaurant) throw new NotFoundError('Restaurant')

      const order = await getOrderForGuest(restaurant.id, data.orderId)
      if (!order) throw new NotFoundError('Order')

      const { sent } = await sendMail({
        to: data.email,
        ...receiptEmail({
          customerName: order.customerName,
          restaurantName: restaurant.name,
          orderNumber: order.orderNumber,
          total: formatMoney(order.grandTotal, restaurant.currency),
          invoiceUrl: `${tenantOrigin(restaurant)}/order/bill/${order.id}`,
          rows: order.items.map((item) => ({
            name: item.name,
            qty: item.quantity,
            amount: formatMoney(item.lineTotal, restaurant.currency),
          })),
        }),
      })

      if (order.invoice) {
        await prisma.invoice.update({
          where: { id: order.invoice.id },
          data: { emailedAt: new Date() },
        })
      }

      return { sent }
    },
    'Receipt sent.',
  )
}

// ── staff ────────────────────────────────────────────────────────────────────

export async function collectPayment(
  input: unknown,
): Promise<ActionResult<{ paymentId: string; change: number; settled: boolean }>> {
  return runAction(
    collectPaymentSchema,
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.PAYMENT_COLLECT)

      /*
       * Whose bill. `capturePayment` looks the order up by id and restaurant,
       * so a cashier confined to Kandy could settle a Colombo bill — and,
       * through the drawer attached to it, book the cash at Kandy.
       */
      const bill = await prisma.order.findFirst({
        where: { id: data.orderId, restaurantId: user.restaurantId },
        select: { branchId: true },
      })
      await assertRecordBranch(user, bill, 'order')

      const result = await capturePayment({
        restaurantId: user.restaurantId,
        orderId: data.orderId,
        method: data.method,
        amount: data.amount,
        tenderedAmount: data.tenderedAmount ?? null,
        reference: data.reference || null,
        tipAmount: data.tipAmount,
        receivedById: user.id,
      })

      await audit({
        restaurantId: user.restaurantId,
        userId: user.id,
        actorName: user.name,
        action: AUDIT_ACTIONS.PAYMENT_COLLECTED,
        entity: 'Payment',
        entityId: result.payment.id,
        after: { method: data.method, amount: data.amount, orderId: data.orderId },
      })

      revalidatePath('/cashier')
      revalidatePath('/dashboard/orders')

      return {
        paymentId: result.payment.id,
        change: result.payment.changeAmount,
        settled: result.fullySettled,
      }
    },
    'Payment recorded.',
  )
}

export async function refundOrderPayment(input: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction(
    refundPaymentSchema,
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.PAYMENT_REFUND)

      // Same rule as collecting, and it matters more: a refund moves money out.
      const original = await prisma.payment.findFirst({
        where: { id: data.paymentId, restaurantId: user.restaurantId },
        select: { order: { select: { branchId: true } } },
      })
      if (!original) throw new NotFoundError('Payment')
      await assertRecordBranch(user, original.order, 'payment')

      const refunded = await refundPayment({
        restaurantId: user.restaurantId,
        paymentId: data.paymentId,
        reason: data.reason,
        actorId: user.id,
      })

      await audit({
        restaurantId: user.restaurantId,
        userId: user.id,
        actorName: user.name,
        action: AUDIT_ACTIONS.PAYMENT_REFUNDED,
        entity: 'Payment',
        entityId: refunded.id,
        after: { reason: data.reason, amount: refunded.amount },
      })

      revalidatePath('/cashier')
      revalidatePath('/dashboard/orders')
      return { id: refunded.id }
    },
    'Refund recorded.',
  )
}

/** Cashier-side QR: same intent flow, but scoped by staff permissions. */
export async function createStaffPaymentQr(input: unknown) {
  return runAction(paymentIntentSchema, input, async (data) => {
    const user = await requirePermission(PERMISSIONS.PAYMENT_COLLECT)
    const intent = await createPaymentIntent({
      restaurantId: user.restaurantId,
      orderId: data.orderId,
      method: data.method,
    })
    return {
      intentId: intent.intentId,
      amount: intent.amount,
      qrDataUrl: intent.qrDataUrl,
      currency: intent.currency,
    }
  })
}

export async function issueInvoiceEmail(orderId: string, email: string) {
  return runSafe(async () => {
    const user = await requirePermission(PERMISSIONS.INVOICE_VIEW)

    const order = await prisma.order.findFirst({
      where: { id: orderId, restaurantId: user.restaurantId },
      include: {
        items: true,
        restaurant: {
          select: {
            name: true,
            currency: true,
            customDomain: true,
            customDomainVerifiedAt: true,
          },
        },
        invoice: true,
      },
    })
    if (!order) throw new NotFoundError('Order')

    const { sent } = await sendMail({
      to: email,
      ...receiptEmail({
        customerName: order.customerName,
        restaurantName: order.restaurant.name,
        orderNumber: order.orderNumber,
        total: formatMoney(order.grandTotal, order.restaurant.currency),
        invoiceUrl: `${tenantOrigin(order.restaurant)}/dashboard/orders/${order.id}/invoice`,
        rows: order.items.map((item) => ({
          name: `${item.name}${readOptions(item.options).length ? ` (${readOptions(item.options).map((o) => o.name).join(', ')})` : ''}`,
          qty: item.quantity,
          amount: formatMoney(item.lineTotal, order.restaurant.currency),
        })),
      }),
    })

    if (order.invoice) {
      await prisma.invoice.update({ where: { id: order.invoice.id }, data: { emailedAt: new Date() } })
    }

    return { sent }
  }, 'Receipt emailed.')
}
