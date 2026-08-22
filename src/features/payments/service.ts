import 'server-only'
import type { PaymentMethod, Prisma } from '@prisma/client'
import QRCode from 'qrcode'

import { AppError, NotFoundError } from '@/lib/errors'
import { formatMoney, minorUnitFactor } from '@/lib/money'
import { prisma, guardLocks } from '@/server/db/prisma'
import { recordRefundAgainstOpenDrawer } from '@/features/cashdrawer/service'
import { requireRestaurant } from '@/server/db/tenant'
import { notify } from '@/server/notifications'
import { realtime } from '@/server/realtime/emitter'
import { settleLoyalty } from '@/features/orders/service'
import { readOptions } from '@/features/orders/queries'

export interface PaymentConfig {
  cash?: boolean
  card?: boolean
  qr?: boolean
  online?: boolean
  upiId?: string
  payeeName?: string
  // Direct bank / online transfer — the owner's account shown to guests.
  bankTransfer?: boolean
  bankName?: string
  accountName?: string
  accountNumber?: string
  bankBranch?: string
  /// WhatsApp number guests send their transfer receipt to.
  receiptWhatsapp?: string
}

export function readPaymentConfig(value: unknown): PaymentConfig {
  if (!value || typeof value !== 'object') return { cash: true, card: true, qr: true }
  return value as PaymentConfig
}

/**
 * Builds the payload encoded in a dynamic payment QR.
 *
 * For INR this is a standards-compliant UPI intent URI that every Indian
 * banking app understands. Elsewhere we fall back to a structured payload that
 * a gateway or the cashier's terminal can parse.
 */
export function buildQrPayload(params: {
  currency: string
  amountMinor: number
  orderNumber: string
  restaurantName: string
  config: PaymentConfig
}): string {
  const amount = (params.amountMinor / minorUnitFactor(params.currency)).toFixed(2)

  if (params.currency.toUpperCase() === 'INR' && params.config.upiId) {
    const query = new URLSearchParams({
      pa: params.config.upiId,
      pn: params.config.payeeName ?? params.restaurantName,
      am: amount,
      cu: 'INR',
      tn: `Order ${params.orderNumber}`,
    })
    return `upi://pay?${query.toString()}`
  }

  return JSON.stringify({
    type: 'restaurantos.payment',
    merchant: params.restaurantName,
    order: params.orderNumber,
    amount,
    currency: params.currency,
  })
}

export async function toQrDataUrl(payload: string): Promise<string> {
  return QRCode.toDataURL(payload, {
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 420,
    color: { dark: '#111111', light: '#ffffff' },
  })
}

/** Creates (or reuses) an open payment intent for an order. */
export async function createPaymentIntent(params: {
  restaurantId: string
  orderId: string
  method: PaymentMethod
}) {
  const restaurant = await requireRestaurant(params.restaurantId)

  const order = await prisma.order.findFirst({
    where: { id: params.orderId, restaurantId: params.restaurantId },
    include: { payments: true },
  })
  if (!order) throw new NotFoundError('Order')
  if (order.paymentStatus === 'PAID') throw new AppError('This bill is already settled', 409, 'ALREADY_PAID')

  const due = Math.max(0, order.grandTotal - order.paidTotal)
  if (due <= 0) throw new AppError('Nothing left to pay on this bill', 409, 'NOTHING_DUE')

  const existing = order.payments.find(
    (payment) => payment.method === params.method && payment.status === 'UNPAID' && payment.amount === due,
  )
  if (existing?.qrPayload) {
    return {
      paymentId: existing.id,
      intentId: existing.intentId!,
      amount: existing.amount,
      payload: existing.qrPayload,
      qrDataUrl: await toQrDataUrl(existing.qrPayload),
      currency: restaurant.currency,
    }
  }

  const payload = buildQrPayload({
    currency: restaurant.currency,
    amountMinor: due,
    orderNumber: order.orderNumber,
    restaurantName: restaurant.name,
    config: readPaymentConfig(restaurant.paymentConfig),
  })

  const intentId = `pi_${order.id.slice(-8)}_${Date.now().toString(36)}`

  const payment = await prisma.payment.create({
    data: {
      restaurantId: params.restaurantId,
      orderId: order.id,
      method: params.method,
      status: 'UNPAID',
      amount: due,
      intentId,
      qrPayload: payload,
    },
  })

  return {
    paymentId: payment.id,
    intentId,
    amount: due,
    payload,
    qrDataUrl: await toQrDataUrl(payload),
    currency: restaurant.currency,
  }
}

/**
 * Marks a payment as received and settles the order.
 *
 * Runs in a transaction so the payment row, the order's paid total, loyalty
 * accrual and the invoice can never drift apart.
 */
export async function capturePayment(params: {
  restaurantId: string
  orderId: string
  method: PaymentMethod
  amount: number
  tenderedAmount?: number | null
  reference?: string | null
  tipAmount?: number
  receivedById?: string | null
  paymentId?: string
}) {
  const restaurant = await requireRestaurant(params.restaurantId)

  const result = await prisma.$transaction(async (tx) => {
    /*
     * Lock the bill before reading what is outstanding.
     *
     * Without this, two taps on "Settle" — or a cashier and a QR guest paying at
     * the same moment — both read `paidTotal = 0`, both find the full amount
     * outstanding, both pass the overpayment check and both write a PAID row.
     * The order settles once, but the drawer and the payment-mix report count
     * the money twice, and the reconciliation at close of service is short by a
     * bill that was never taken. The same pattern already guards goods receipt.
     */
    await guardLocks(tx)
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM orders
      WHERE id = ${params.orderId} AND "restaurantId" = ${params.restaurantId}
      FOR UPDATE
    `
    if (locked.length === 0) throw new NotFoundError('Order')

    const order = await tx.order.findFirst({
      where: { id: params.orderId, restaurantId: params.restaurantId },
      include: { items: true, table: true },
    })
    if (!order) throw new NotFoundError('Order')
    if (order.status === 'CANCELLED') {
      throw new AppError('This order was cancelled', 409, 'ORDER_CANCELLED')
    }

    const tip = Math.max(0, params.tipAmount ?? 0)
    const grandTotal = order.grandTotal + tip
    const due = Math.max(0, grandTotal - order.paidTotal)

    if (params.amount > due + 1) {
      throw new AppError(
        `That is more than the ${formatMoney(due, restaurant.currency)} outstanding on this bill`,
        400,
        'OVERPAYMENT',
      )
    }

    const changeAmount =
      params.method === 'CASH' && params.tenderedAmount
        ? Math.max(0, params.tenderedAmount - params.amount)
        : 0

    // Attribute the takings to whichever drawer this cashier has open, so an
    // end-of-shift count has something to reconcile against. Every method is
    // attributed, not just cash — the close screen reports card and other
    // takings for the same session as context. A cashier with no drawer open
    // is never blocked from taking money; the payment simply carries no
    // session and falls outside drawer reconciliation.
    const drawer = params.receivedById
      ? await tx.cashDrawerSession.findFirst({
          where: {
            restaurantId: params.restaurantId,
            openedById: params.receivedById,
            status: 'OPEN',
          },
          orderBy: { openedAt: 'desc' },
          select: { id: true },
        })
      : null

    const payment = params.paymentId
      ? await tx.payment.update({
          where: { id: params.paymentId },
          data: {
            status: 'PAID',
            amount: params.amount,
            tenderedAmount: params.tenderedAmount ?? null,
            changeAmount,
            reference: params.reference || null,
            receivedById: params.receivedById ?? null,
            paidAt: new Date(),
            cashDrawerSessionId: drawer?.id ?? null,
          },
        })
      : await tx.payment.create({
          data: {
            restaurantId: params.restaurantId,
            orderId: order.id,
            method: params.method,
            status: 'PAID',
            amount: params.amount,
            tenderedAmount: params.tenderedAmount ?? null,
            changeAmount,
            reference: params.reference || null,
            receivedById: params.receivedById ?? null,
            paidAt: new Date(),
            cashDrawerSessionId: drawer?.id ?? null,
          },
        })

    const paidTotal = order.paidTotal + params.amount
    const fullySettled = paidTotal >= grandTotal

    const updatedOrder = await tx.order.update({
      where: { id: order.id },
      data: {
        paidTotal,
        tipAmount: order.tipAmount + tip,
        grandTotal,
        paymentStatus: fullySettled ? 'PAID' : 'PARTIAL',
        // Settling the bill closes the order unless the food is still coming.
        ...(fullySettled && ['SERVED', 'READY'].includes(order.status)
          ? { status: 'COMPLETED' as const, completedAt: new Date() }
          : {}),
      },
    })

    let invoiceNumber: string | null = null
    if (fullySettled) {
      const startOfYear = new Date(new Date().getFullYear(), 0, 1)
      const issued = await tx.invoice.count({
        where: { restaurantId: params.restaurantId, issuedAt: { gte: startOfYear } },
      })
      invoiceNumber = `INV-${new Date().getFullYear()}-${String(issued + 1).padStart(5, '0')}`

      await tx.invoice.upsert({
        where: { orderId: order.id },
        create: {
          restaurantId: params.restaurantId,
          orderId: order.id,
          number: invoiceNumber,
          snapshot: buildInvoiceSnapshot(order, restaurant, updatedOrder) as unknown as Prisma.InputJsonValue,
        },
        update: {},
      })

      // Free the table when nothing else is open on it.
      if (order.tableId) {
        const open = await tx.order.count({
          where: {
            restaurantId: params.restaurantId,
            tableId: order.tableId,
            id: { not: order.id },
            status: { notIn: ['COMPLETED', 'CANCELLED'] },
          },
        })
        if (open === 0) {
          await tx.restaurantTable.update({
            where: { id: order.tableId },
            data: { status: 'CLEANING' },
          })
        }
      }
    }

    return { payment, order: updatedOrder, fullySettled, invoiceNumber, tableNumber: order.table?.number ?? null }
  })

  if (result.fullySettled) {
    await settleLoyalty(params.orderId).catch((error) =>
      console.error('[payments] loyalty accrual failed', error),
    )
  }

  realtime.paymentReceived(params.restaurantId, {
    orderId: params.orderId,
    orderNumber: result.order.orderNumber,
    paymentId: result.payment.id,
    method: result.payment.method,
    amount: result.payment.amount,
    tableNumber: result.tableNumber,
    at: new Date().toISOString(),
  })

  await notify({
    restaurantId: params.restaurantId,
    // A payment belongs to the site whose bill it settled.
    branchId: result.order.branchId,
    type: 'PAYMENT_RECEIVED',
    title: `Payment received — ${result.order.orderNumber}`,
    body: `${formatMoney(result.payment.amount, restaurant.currency)} via ${result.payment.method.toLowerCase()}`,
    audience: 'CASHIER',
    orderId: params.orderId,
    data: {
      orderId: params.orderId,
      orderNumber: result.order.orderNumber,
      amount: result.payment.amount,
    },
  })

  await notify({
    restaurantId: params.restaurantId,
    branchId: result.order.branchId,
    type: 'PAYMENT_RECEIVED',
    title: `Payment received — ${result.order.orderNumber}`,
    body: formatMoney(result.payment.amount, restaurant.currency),
    audience: 'MANAGEMENT',
    data: { orderId: params.orderId },
  })

  return result
}

export interface InvoiceSnapshot {
  restaurant: {
    name: string
    addressLine: string | null
    city: string | null
    phone: string | null
    taxLabel: string
    currency: string
  }
  order: {
    number: string
    placedAt: string
    tableNumber: string | null
    customerName: string
    customerPhone: string
  }
  lines: Array<{ name: string; options: string; quantity: number; unitPrice: number; lineTotal: number }>
  totals: {
    subtotal: number
    discountTotal: number
    loyaltyDiscount: number
    serviceCharge: number
    taxTotal: number
    tipAmount: number
    roundingAdj: number
    grandTotal: number
  }
}

function buildInvoiceSnapshot(
  order: Prisma.OrderGetPayload<{ include: { items: true; table: true } }>,
  restaurant: { name: string; addressLine: string | null; city: string | null; phone: string | null; taxLabel: string; currency: string },
  updated: { grandTotal: number; tipAmount: number },
): InvoiceSnapshot {
  return {
    restaurant: {
      name: restaurant.name,
      addressLine: restaurant.addressLine,
      city: restaurant.city,
      phone: restaurant.phone,
      taxLabel: restaurant.taxLabel,
      currency: restaurant.currency,
    },
    order: {
      number: order.orderNumber,
      placedAt: order.placedAt.toISOString(),
      tableNumber: order.table?.number ?? null,
      customerName: order.customerName,
      customerPhone: order.customerPhone,
    },
    lines: order.items.map((item) => ({
      name: item.name,
      options: readOptions(item.options)
        .map((option) => option.name)
        .join(', '),
      quantity: item.quantity,
      unitPrice: item.unitPrice + item.optionsTotal,
      lineTotal: item.lineTotal,
    })),
    totals: {
      subtotal: order.subtotal,
      discountTotal: order.discountTotal,
      loyaltyDiscount: order.loyaltyDiscount,
      serviceCharge: order.serviceCharge,
      taxTotal: order.taxTotal,
      tipAmount: updated.tipAmount,
      roundingAdj: order.roundingAdj,
      grandTotal: updated.grandTotal,
    },
  }
}

export async function refundPayment(params: {
  restaurantId: string
  paymentId: string
  reason: string
  actorId: string
}) {
  const payment = await prisma.payment.findFirst({
    where: { id: params.paymentId, restaurantId: params.restaurantId },
    include: { order: true },
  })
  if (!payment) throw new NotFoundError('Payment')
  if (payment.status !== 'PAID') throw new AppError('Only settled payments can be refunded', 409, 'NOT_PAID')

  return prisma.$transaction(async (tx) => {
    const refunded = await tx.payment.update({
      where: { id: payment.id },
      data: { status: 'REFUNDED', failureReason: params.reason },
    })

    const paidTotal = Math.max(0, payment.order.paidTotal - payment.amount)
    await tx.order.update({
      where: { id: payment.orderId },
      data: {
        paidTotal,
        paymentStatus: paidTotal === 0 ? 'REFUNDED' : 'PARTIAL',
      },
    })

    // Cash handed back leaves the drawer that is open right now, which is not
    // necessarily the drawer that took the money — a bill paid this morning can
    // be refunded tonight. Recording it as a movement against the current
    // drawer is what keeps both sessions' counts honest.
    if (payment.method === 'CASH') {
      await recordRefundAgainstOpenDrawer({
        tx,
        restaurantId: params.restaurantId,
        userId: params.actorId,
        amount: payment.amount,
        orderNumber: payment.order.orderNumber,
      })
    }

    return refunded
  })
}
