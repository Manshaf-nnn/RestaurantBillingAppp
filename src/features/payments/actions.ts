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
import { needsApproval, requestApproval } from '@/features/approvals/service'
import { ensureInvoice, capturePayment, createPaymentIntent, refundPayment } from './service'

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

      /*
       * The claim becomes a ROW, not just a toast. When the guest paid by a
       * method that never opened an intent — a bank transfer from their own
       * app — there was no UNPAID row to annotate, so the reference they
       * typed went nowhere and the cashier had nothing to confirm against.
       * An UNPAID BANK_TRANSFER row for the outstanding amount is the
       * cashier's worklist item; capturing it settles the bill, deleting it
       * rejects the claim. Nothing is booked as paid here — a guest saying
       * so is a claim, and only staff confirmation moves money (§6).
       */
      const annotated = await prisma.payment.updateMany({
        where: { orderId: order.id, status: 'UNPAID' },
        data: { reference: data.reference || 'Guest reported payment' },
      })
      if (annotated.count === 0) {
        await prisma.payment.create({
          data: {
            restaurantId: restaurant.id,
            orderId: order.id,
            method: 'BANK_TRANSFER',
            status: 'UNPAID',
            amount: Math.max(0, order.grandTotal + order.tipAmount - order.paidTotal),
            reference: data.reference || 'Guest reported payment',
          },
        })
      }

      await notify({
        restaurantId: restaurant.id,
        branchId: order.branchId,
        type: 'PAYMENT_RECEIVED',
        title: `Table ${order.table?.number ?? '—'} says they have paid`,
        body: `${order.orderNumber} · ${formatMoney(order.grandTotal + order.tipAmount - order.paidTotal, restaurant.currency)} — please verify`,
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

/**
 * Presenting the bill finalises its invoice (§Invoice-at-presentation).
 *
 * Called by the till the moment a bill is printed for a guest: the invoice is
 * numbered and its snapshot frozen THEN, so the document in the guest's hand
 * has a number and "outstanding invoices" means something before settlement.
 * Idempotent — a re-print keeps the number the guest already saw.
 */
export async function presentBill(input: unknown): Promise<ActionResult<{ invoiceNumber: string }>> {
  return runAction(guestPaidSchema.pick({ orderId: true }), input, async (data) => {
    const user = await requirePermission(PERMISSIONS.PAYMENT_COLLECT)
    const order = await prisma.order.findFirst({
      where: { id: data.orderId, restaurantId: user.restaurantId },
      select: { branchId: true, status: true },
    })
    if (!order) throw new NotFoundError('Order')
    await assertRecordBranch(user, order, 'order')
    if (order.status === 'CANCELLED') {
      throw new AppError('This order was cancelled', 409, 'ORDER_CANCELLED')
    }

    const invoiceNumber = await prisma.$transaction((tx) =>
      ensureInvoice(tx, { restaurantId: user.restaurantId, orderId: data.orderId }),
    )
    return { invoiceNumber }
  })
}

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
        clientRequestId: data.clientRequestId ?? null,
      })

      /*
       * A replay is not a new event, so it does not get a new audit row — the
       * capture it replays already wrote one. Auditing it again would make one
       * payment look like two takings to anyone reading the trail.
       */
      if (result.replayed) {
        return {
          paymentId: result.payment.id,
          change: result.payment.changeAmount,
          settled: result.fullySettled,
        }
      }

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
        select: {
          amount: true,
          refunds: { select: { amount: true } },
          order: { select: { branchId: true } },
        },
      })
      if (!original) throw new NotFoundError('Payment')
      await assertRecordBranch(user, original.order, 'payment')

      /*
       * Past the restaurant's threshold, the money stops here until a manager
       * has signed it off — the same gate discounts go through. The retry
       * after approval finds the signed request and goes through.
       */
      const refundable =
        original.amount - original.refunds.reduce((sum, row) => sum + row.amount, 0)
      const amount = data.amount ?? Math.max(0, refundable)
      if (
        await needsApproval({ restaurantId: user.restaurantId, kind: 'REFUND', amount })
      ) {
        const approved = await prisma.approvalRequest.findFirst({
          where: {
            restaurantId: user.restaurantId,
            entity: 'Payment',
            entityId: data.paymentId,
            kind: 'REFUND',
            status: 'APPROVED',
            amount: { gte: amount },
          },
        })
        if (!approved) {
          await requestApproval({
            restaurantId: user.restaurantId,
            branchId: original.order.branchId,
            kind: 'REFUND',
            entity: 'Payment',
            entityId: data.paymentId,
            amount,
            reason: data.reason,
            userId: user.id,
          })
          throw new AppError(
            'Sent for approval. A refund this size needs a manager to sign off — they can do that from the approvals screen, then refund again.',
            403,
            'APPROVAL_REQUIRED',
          )
        }
      }

      const refund = await refundPayment({
        restaurantId: user.restaurantId,
        paymentId: data.paymentId,
        reason: data.reason,
        actorId: user.id,
        amount: data.amount,
        clientRequestId: data.clientRequestId ?? null,
      })

      await audit({
        restaurantId: user.restaurantId,
        userId: user.id,
        actorName: user.name,
        action: AUDIT_ACTIONS.PAYMENT_REFUNDED,
        entity: 'Payment',
        entityId: data.paymentId,
        after: { reason: data.reason, amount: refund.amount, refundId: refund.id },
      })

      revalidatePath('/cashier')
      revalidatePath('/dashboard/orders')
      return { id: refund.id }
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
