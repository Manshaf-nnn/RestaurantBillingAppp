import 'server-only'
import type { PaymentMethod, Prisma } from '@prisma/client'
import QRCode from 'qrcode'

import { AppError, NotFoundError } from '@/lib/errors'
import { outstandingOn } from '@/features/orders/pricing'
import { nextCounterValue, yearIn } from '@/server/db/counters'
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

  const due = outstandingOn(order)
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

    /*
     * The tip rides on TOP of the bill, it does not become the bill.
     * grandTotal used to absorb the tip here, which made every revenue figure
     * downstream count the staff's money as the restaurant's income (§110).
     * grandTotal is never written by settlement now; what the guest owes is
     * the charge plus every tip promised so far.
     */
    const tip = Math.max(0, params.tipAmount ?? 0)
    const owed = order.grandTotal + order.tipAmount + tip
    const due = Math.max(0, owed - order.paidTotal)

    /*
     * Exactly what is due, no slack. The ceiling used to be `due + 1`, an
     * off-by-one that let every bill book one extra minor unit of revenue —
     * invisible on a receipt, a standing discrepancy at reconciliation.
     */
    if (params.amount > due) {
      throw new AppError(
        `That is more than the ${formatMoney(due, restaurant.currency)} outstanding on this bill`,
        400,
        'OVERPAYMENT',
      )
    }

    /*
     * Cash handed over must cover what is being booked. A tendered figure
     * below the amount used to sail through and record negative change as
     * zero — the drawer showed money it never held. Card and transfer have no
     * tender, so only cash is checked.
     */
    if (params.method === 'CASH' && params.tenderedAmount != null && params.tenderedAmount < params.amount) {
      throw new AppError(
        `${formatMoney(params.tenderedAmount, restaurant.currency)} handed over does not cover the ${formatMoney(params.amount, restaurant.currency)} being taken`,
        400,
        'SHORT_TENDER',
      )
    }

    const changeAmount =
      params.method === 'CASH' && params.tenderedAmount
        ? Math.max(0, params.tenderedAmount - params.amount)
        : 0

    /*
     * Attribute the takings to whichever drawer this cashier has open, so an
     * end-of-shift count has something to reconcile against. Every method is
     * attributed, not just cash — the close screen reports card and other
     * takings for the same session as context. A cashier with no drawer open
     * is never blocked from taking money; the payment simply carries no
     * session and falls outside drawer reconciliation, and the cash drawer
     * report names the total so it cannot quietly disappear.
     *
     * ── The branch predicate ─────────────────────────────────────────────────
     *
     * This used to match on `openedById` alone. A cashier holding a drawer at
     * Colombo who settled a Kandy bill booked Kandy's cash into Colombo's till:
     * both branches' reconciliations were wrong, one over and one short, and
     * every branch check downstream reads the session and so agreed. Matching
     * the order's branch is what makes the attribution true rather than merely
     * plausible — and when the cashier has no drawer at that branch, the
     * payment is correctly left unattributed instead of landing somewhere else.
     */
    const drawer = params.receivedById
      ? await tx.cashDrawerSession.findFirst({
          where: {
            restaurantId: params.restaurantId,
            openedById: params.receivedById,
            branchId: order.branchId,
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
    const fullySettled = paidTotal >= owed

    const updatedOrder = await tx.order.update({
      where: { id: order.id },
      data: {
        paidTotal,
        tipAmount: order.tipAmount + tip,
        paymentStatus: fullySettled ? 'PAID' : 'PARTIAL',
        // Settling the bill closes the order unless the food is still coming.
        ...(fullySettled && ['SERVED', 'READY'].includes(order.status)
          ? { status: 'COMPLETED' as const, completedAt: new Date() }
          : {}),
      },
    })

    let invoiceNumber: string | null = null
    if (fullySettled) {
      /*
       * Numbered from a per-restaurant counter, in the restaurant's own year.
       * The old `count(this year) + 1` raced (two settlements, same number,
       * one dies on the unique constraint) and the year came from the
       * server's clock — a Colombo restaurant settling at half past midnight
       * on New Year's Day was numbering into the wrong year. An order that
       * already holds an invoice keeps it; the counter only advances when a
       * number will actually be used.
       */
      const existingInvoice = await tx.invoice.findUnique({
        where: { orderId: order.id },
        select: { number: true },
      })
      if (existingInvoice) {
        invoiceNumber = existingInvoice.number
      } else {
        const year = yearIn(restaurant.timezone)
        const sequence = await nextCounterValue(tx, params.restaurantId, `invoice:${year}`)
        invoiceNumber = `INV-${year}-${String(sequence).padStart(5, '0')}`
        await tx.invoice.create({
          data: {
            restaurantId: params.restaurantId,
            orderId: order.id,
            number: invoiceNumber,
            snapshot: buildInvoiceSnapshot(order, restaurant, updatedOrder) as unknown as Prisma.InputJsonValue,
          },
        })
      }

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

    return { payment, order: updatedOrder, fullySettled, invoiceNumber, tableNumber: order.tableNumber ?? order.table?.number ?? null }
  })

  if (result.fullySettled) {
    await settleLoyalty(params.orderId).catch((error) =>
      console.error('[payments] loyalty accrual failed', error),
    )
  }

  realtime.paymentReceived(params.restaurantId, {
    orderId: params.orderId,
    orderNumber: result.order.orderNumber,
    // The till that takes the money belongs to one site; without this the
    // cashier board added another branch's payment to its own day total.
    branchId: result.order.branchId,
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
      tableNumber: order.tableNumber ?? order.table?.number ?? null,
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
  /** Minor units. Absent means everything this payment has left to refund. */
  amount?: number
}) {
  const located = await prisma.payment.findFirst({
    where: { id: params.paymentId, restaurantId: params.restaurantId },
    select: { orderId: true },
  })
  if (!located) throw new NotFoundError('Payment')

  return prisma.$transaction(async (tx) => {
    /*
     * Same lock, same reason, opposite direction. `capturePayment` locks the
     * order so two taps on "Settle" cannot both find the bill unpaid; this
     * used to check-then-act with no lock at all, so two taps on "Refund"
     * both read the payment as PAID and the drawer handed the cash back
     * twice. The order is locked first — the same order capture takes it in —
     * and the payment re-read inside the fence, where the second tap sees
     * REFUNDED and stops.
     */
    await guardLocks(tx)
    const lockedOrder = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM orders
      WHERE id = ${located.orderId} AND "restaurantId" = ${params.restaurantId}
      FOR UPDATE
    `
    if (lockedOrder.length === 0) throw new NotFoundError('Order')

    const payment = await tx.payment.findFirst({
      where: { id: params.paymentId, restaurantId: params.restaurantId },
      include: { order: { include: { restaurant: { select: { currency: true } } } } },
    })
    if (!payment) throw new NotFoundError('Payment')
    if (payment.status !== 'PAID' && payment.status !== 'REFUNDED') {
      throw new AppError('Only settled payments can be refunded', 409, 'NOT_PAID')
    }

    /*
     * The payment row is a fact and stays one. What changes hands comes back
     * as a Refund ROW — several of them for partial refunds — and the payment
     * only flips to REFUNDED when the rows cover it. The old code mutated the
     * payment in place: no amount could be partial, no reason survived a
     * second refund, and the books had an edit where they needed a record.
     */
    const already = await tx.refund.aggregate({
      where: { paymentId: payment.id },
      _sum: { amount: true },
    })
    const refundable = payment.amount - (already._sum.amount ?? 0)
    const amount = params.amount ?? refundable
    if (refundable <= 0) {
      throw new AppError('This payment has already been fully refunded', 409, 'ALREADY_REFUNDED')
    }
    if (amount <= 0 || amount > refundable) {
      throw new AppError(
        `Up to ${formatMoney(refundable, payment.order.restaurant.currency)} can go back on this payment`,
        400,
        'REFUND_TOO_LARGE',
      )
    }

    const refund = await tx.refund.create({
      data: {
        restaurantId: params.restaurantId,
        orderId: payment.orderId,
        paymentId: payment.id,
        amount,
        method: payment.method,
        reason: params.reason,
        refundedById: params.actorId,
      },
    })

    if ((already._sum.amount ?? 0) + amount >= payment.amount) {
      await tx.payment.update({
        where: { id: payment.id },
        data: { status: 'REFUNDED', failureReason: params.reason },
      })
    }

    /*
     * What is paid is what arrived minus what went back — summed fresh, not
     * the old figure minus this one. Subtraction preserves whatever drift the
     * column had accumulated; the sums are self-correcting every time.
     */
    const received = await tx.payment.aggregate({
      where: { orderId: payment.orderId, status: { in: ['PAID', 'REFUNDED'] } },
      _sum: { amount: true },
    })
    const returned = await tx.refund.aggregate({
      where: { orderId: payment.orderId },
      _sum: { amount: true },
    })
    const paidTotal = Math.max(0, (received._sum.amount ?? 0) - (returned._sum.amount ?? 0))
    await tx.order.update({
      where: { id: payment.orderId },
      data: {
        paidTotal,
        paymentStatus:
          paidTotal === 0
            ? 'REFUNDED'
            : paidTotal >= payment.order.grandTotal + payment.order.tipAmount
              ? 'PAID'
              : 'PARTIAL',
      },
    })

    // Cash handed back leaves the drawer that is open right now, which is not
    // necessarily the drawer that took the money — a bill paid this morning can
    // be refunded tonight. Recording it as a movement against the current
    // drawer is what keeps both sessions' counts honest. The order's branch is
    // passed so it lands in a till at the site the money physically left.
    if (payment.method === 'CASH') {
      await recordRefundAgainstOpenDrawer({
        tx,
        restaurantId: params.restaurantId,
        branchId: payment.order.branchId,
        userId: params.actorId,
        amount,
        orderNumber: payment.order.orderNumber,
        // Links the movement back to the payment, so a refund that produced no
        // movement is a visible absence rather than a silence.
        paymentId: payment.id,
      })
    }

    return refund
  })
}
