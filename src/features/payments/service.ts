import 'server-only'
import type { PaymentMethod, Prisma } from '@prisma/client'
import QRCode from 'qrcode'

import { AppError, NotFoundError } from '@/lib/errors'
import { assertPeriodOpen } from '@/features/accounting/service'
import { outstandingOn, derivePaymentStatus } from '@/features/orders/pricing'
import { nextCounterValue, yearIn } from '@/server/db/counters'
import { formatMoney, minorUnitFactor } from '@/lib/money'
import { prisma, guardLocks, type TxClient } from '@/server/db/prisma'
import { recordRefundAgainstOpenDrawer } from '@/features/cashdrawer/service'
import { requireRestaurant } from '@/server/db/tenant'
import { notify } from '@/server/notifications'
import { realtime } from '@/server/realtime/emitter'
import { freeTable, otherOpenOrders, type FreedTable } from '@/features/floor/service'
import { emitOutbox } from '@/server/realtime/outbox'
import { EVENTS } from '@/lib/realtime/events'
import { settleLoyalty } from '@/features/orders/service'
import { readOptions } from '@/features/orders/queries'
import { accountForMethod } from './accounts-ledger'

import {
  DEFAULT_DESTINATIONS,
  DEFAULT_METHOD_DESTINATIONS,
  METHOD_LABELS,
  destinationForMethod,
  destinationName,
  readPaymentConfig,
  type PaymentConfig,
  type PaymentDestination,
} from './destinations'

/*
 * Re-exported so `payments/service` stays the one import path the rest of the
 * app already uses; the definitions moved out only so a client screen could
 * reach them. See `./destinations`.
 */
export {
  DEFAULT_DESTINATIONS,
  DEFAULT_METHOD_DESTINATIONS,
  METHOD_LABELS,
  destinationForMethod,
  destinationName,
  readPaymentConfig,
}
export type { PaymentConfig, PaymentDestination }

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
  /**
   * One id per tender attempt, reused across retries. Given one, this function
   * is safe to call twice: the second call returns the first call's payment
   * instead of taking the money again.
   */
  clientRequestId?: string | null
}) {
  const restaurant = await requireRestaurant(params.restaurantId)

  /*
   * Where this money is allocated (bill.md §2).
   *
   * Resolved out here rather than inside the transaction: it is configuration,
   * not contended state, and `requireRestaurant` already has `paymentConfig` in
   * hand — so the check costs nothing and refuses before the bill is locked.
   *
   * Refusing is the point. A payment recorded against no account is money the
   * books cannot place, and finding that out at month end — across a hundred
   * settlements nobody can now remember — is far worse than a cashier being
   * told, once, to go and ask somebody.
   */
  /*
   * Resolved to a real ACCOUNT ROW now, not a JSON entry (bank.md).
   *
   * An account holds a balance and a staff list, so the mapping has to land on
   * one that exists and is still in use. A method pointed at a code with no
   * account behind it, or at a retired one, is refused here exactly as an
   * unmapped method always was — which is also what stops an account being
   * retired out from under a till mid-service.
   */
  const paymentConfig = readPaymentConfig(restaurant.paymentConfig)
  const destination = await accountForMethod(prisma, {
    restaurantId: params.restaurantId,
    method: params.method,
    config: paymentConfig,
  })
  if (!destination) {
    throw new AppError(
      `${METHOD_LABELS[params.method] ?? params.method} has no accounting destination set up. ` +
        'Ask an administrator to choose one in Settings → Payments before taking this payment.',
      409,
      'NO_PAYMENT_DESTINATION',
    )
  }

  let freedTable: FreedTable | null = null
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

    /*
     * A retry of a capture that already succeeded.
     *
     * Read inside the fence, so a genuinely concurrent pair of same-key
     * requests serialises on the order lock above and the loser sees the
     * winner's row rather than racing it. The unique index on
     * (restaurantId, clientRequestId) is the backstop if anything ever reaches
     * the insert without passing here.
     *
     * The replay returns the payment that was taken and reports the order as
     * it now stands; it deliberately does NOT re-run settlement, so loyalty is
     * not accrued twice and the cashier is not told twice that money arrived.
     */
    if (params.clientRequestId) {
      const already = await tx.payment.findFirst({
        where: { restaurantId: params.restaurantId, clientRequestId: params.clientRequestId },
      })
      if (already) {
        const current = await tx.order.findFirstOrThrow({
          where: { id: already.orderId, restaurantId: params.restaurantId },
          include: { table: true, invoice: { select: { number: true } } },
        })
        return {
          payment: already,
          order: current,
          fullySettled: current.paymentStatus === 'PAID',
          invoiceNumber: current.invoice?.number ?? null,
          tableNumber: current.tableNumber ?? current.table?.number ?? null,
          replayed: true as const,
        }
      }
    }

    const order = await tx.order.findFirst({
      where: { id: params.orderId, restaurantId: params.restaurantId },
      include: { items: true, table: true },
    })
    if (!order) throw new NotFoundError('Order')
    if (order.status === 'CANCELLED') {
      throw new AppError('This order was cancelled', 409, 'ORDER_CANCELLED')
    }

    /*
     * Money may not land in a period the books have signed off (§59, §2).
     * Dated by the order it settles, so a bill from a sealed January cannot be
     * quietly settled today into January's numbers; a refund or correction
     * dated now still lands in today's open period, which is how accounting
     * corrections are supposed to work.
     */
    await assertPeriodOpen(tx, params.restaurantId, order.placedAt, 'This payment')

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
    // FOR SHARE: a close in progress holds the row FOR UPDATE, so this waits
    // for it and then sees the drawer closed — rather than reading OPEN a
    // moment before the close froze its expected cash without this payment.
    const drawer = params.receivedById
      ? (
          await tx.$queryRaw<Array<{ id: string }>>`
            SELECT id FROM cash_drawer_sessions
            WHERE "restaurantId" = ${params.restaurantId}
              AND "openedById" = ${params.receivedById}
              AND "branchId" = ${order.branchId}
              AND status = 'OPEN'
            ORDER BY "openedAt" DESC
            LIMIT 1
            FOR SHARE
          `
        )[0] ?? null
      : null

    const payment = params.paymentId
      ? await (async () => {
          /*
           * Fenced on restaurant, order and status, not just the id. The
           * plain update by primary key would have settled any tenant's
           * intent row onto this bill — latent, since no caller passed a
           * foreign id, and latent is not the same as safe.
           */
          const claimed = await tx.payment.updateMany({
            where: {
              id: params.paymentId,
              restaurantId: params.restaurantId,
              orderId: order.id,
              status: 'UNPAID',
            },
            data: {
              status: 'PAID',
              amount: params.amount,
              tenderedAmount: params.tenderedAmount ?? null,
              changeAmount,
              reference: params.reference || null,
              // Stamped on the settling branch as well as the creating one: a QR
              // intent row is created UNPAID long before it is settled, and the
              // destination belongs to the settlement, not to the intent.
              destination: destination.code,
              receivedById: params.receivedById ?? null,
              paidAt: new Date(),
              cashDrawerSessionId: drawer?.id ?? null,
              clientRequestId: params.clientRequestId ?? null,
            },
          })
          if (claimed.count === 0) throw new NotFoundError('Payment')
          return tx.payment.findUniqueOrThrow({ where: { id: params.paymentId } })
        })()
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
            destination: destination.code,
            receivedById: params.receivedById ?? null,
            paidAt: new Date(),
            cashDrawerSessionId: drawer?.id ?? null,
            clientRequestId: params.clientRequestId ?? null,
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
      invoiceNumber = await ensureInvoice(tx, {
        restaurantId: params.restaurantId,
        orderId: order.id,
      })

      /*
       * Settled in full, the food already out, and nothing else open: the
       * sitting is over and the table is Empty for the next party (abc.md §3,
       * aO.md §2) — through the one writer. A bill paid while the food is
       * still coming does NOT empty the table: the order completes, and frees
       * it, when it is served (see `updateOrderStatus`).
       */
      if (order.tableId && updatedOrder.status === 'COMPLETED') {
        const open = await otherOpenOrders(tx, {
          restaurantId: params.restaurantId, tableId: order.tableId, exceptOrderId: order.id,
        })
        if (open === 0) {
          freedTable = await freeTable(tx, { restaurantId: params.restaurantId, tableId: order.tableId })
        }
      }
    }

    /*
     * The event commits with the money (production.md §5).
     *
     * This used to be raised only after the transaction returned, by a
     * `realtime.paymentReceived(...)` call that is a no-op on the serverless
     * host — so a settled bill produced no durable record that anything had
     * happened, and a till that missed the moment had no way to find out.
     * Written here, the payment row and the event describing it commit or roll
     * back together.
     */
    await emitOutbox(tx, {
      restaurantId: params.restaurantId,
      branchId: order.branchId,
      type: EVENTS.PAYMENT_RECEIVED,
      entity: 'Payment',
      entityId: payment.id,
      payload: {
        orderId: order.id,
        orderNumber: order.orderNumber,
        amount: payment.amount,
        method: payment.method,
        fullySettled,
      },
    })

    return {
      payment,
      order: updatedOrder,
      fullySettled,
      invoiceNumber,
      tableNumber: order.tableNumber ?? order.table?.number ?? null,
      replayed: false as const,
    }
  })

  // After commit, so no screen hears of a table freed by a rolled-back payment.
  // (Read through a cast: the checker cannot see the assignment inside the
  // transaction callback and narrows the variable to its initial null.)
  const freed = freedTable as FreedTable | null
  if (freed) {
    realtime.tableUpdated(params.restaurantId, {
      id: freed.id, number: freed.number, status: 'AVAILABLE', branchId: freed.branchId,
    })
  }

  /*
   * A replay has no news. The money arrived once, the loyalty was accrued
   * once, and the cashier was told once — repeating any of that is exactly the
   * double-count the idempotency key exists to prevent.
   */
  if (result.replayed) return result

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

/**
 * The invoice exists from the moment the bill is PRESENTED, not paid.
 *
 * It used to be minted only at full settlement, which made "outstanding
 * invoices" a contradiction: every unpaid bill had no invoice to be
 * outstanding against, and a guest handed a printed bill was holding a
 * document with no number. Presentation finalises it — numbered from the
 * per-restaurant counter in the restaurant's own year (the old
 * `count(this year)+1` raced two settlements onto one number, and used the
 * server's clock for the year), snapshotting the bill as presented. An order
 * that already holds one keeps it: the number never changes after it is
 * first shown to a guest.
 */
export async function ensureInvoice(
  tx: TxClient,
  params: { restaurantId: string; orderId: string },
): Promise<string> {
  const existing = await tx.invoice.findUnique({
    where: { orderId: params.orderId },
    select: { number: true },
  })
  if (existing) return existing.number

  const order = await tx.order.findFirst({
    where: { id: params.orderId, restaurantId: params.restaurantId },
    // A voided line is not on the invoice: the document has to add up from
    // the lines printed on it.
    include: { items: { where: { status: { not: 'CANCELLED' } } }, table: true },
  })
  if (!order) throw new NotFoundError('Order')
  const restaurant = await tx.restaurant.findUniqueOrThrow({
    where: { id: params.restaurantId },
    select: {
      name: true, addressLine: true, city: true, phone: true,
      taxLabel: true, currency: true, timezone: true,
    },
  })

  const year = yearIn(restaurant.timezone)
  const sequence = await nextCounterValue(tx, params.restaurantId, `invoice:${year}`)
  const number = `INV-${year}-${String(sequence).padStart(5, '0')}`
  await tx.invoice.create({
    data: {
      restaurantId: params.restaurantId,
      orderId: order.id,
      number,
      snapshot: buildInvoiceSnapshot(
        order,
        restaurant,
        { grandTotal: order.grandTotal, tipAmount: order.tipAmount },
      ) as unknown as Prisma.InputJsonValue,
    },
  })
  return number
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

/**
 * The marker that says a bill's loyalty has already been unwound.
 *
 * A stable token rather than the opening words of a sentence: the guard used
 * to be `note.startsWith('Refunded in full')`, which a reworded note — or a
 * translated one — would have turned off without anybody noticing, and the
 * points would have come back twice.
 */
const REFUND_REVERSAL_MARK = '[loyalty-reversed]'

export async function refundPayment(params: {
  restaurantId: string
  paymentId: string
  reason: string
  actorId: string
  /** Minor units. Absent means everything this payment has left to refund. */
  amount?: number
  /**
   * One id per refund attempt, reused across retries — so a retried refund
   * returns the refund already given instead of handing the money back twice.
   */
  clientRequestId?: string | null
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

    /*
     * Signed books do not quietly change (§59). A refund belongs to the day it
     * is GIVEN (owner decision, 2026-09-13), so the seal that matters is the
     * one over today — every sibling (capture, cancel, void, discount) had
     * this guard and this one did not.
     */
    await assertPeriodOpen(tx, params.restaurantId, new Date(), 'This refund')

    /*
     * A retry of a refund that already went out. Read inside the fence for the
     * same reason capture does, and the unique index on
     * (restaurantId, clientRequestId) is the backstop.
     */
    if (params.clientRequestId) {
      const already = await tx.refund.findFirst({
        where: { restaurantId: params.restaurantId, clientRequestId: params.clientRequestId },
      })
      if (already) return already
    }

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
        /*
         * Money goes back where it came from — the destination is inherited
         * from the payment rather than looked up afresh, so re-pointing Card
         * at a new bank today cannot send last month's refund to it.
         */
        destination: payment.destination,
        reason: params.reason,
        refundedById: params.actorId,
        clientRequestId: params.clientRequestId ?? null,
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
        paymentStatus: derivePaymentStatus({
          paidTotal,
          grandTotal: payment.order.grandTotal,
          tipAmount: payment.order.tipAmount,
          current: paidTotal === 0 ? 'REFUNDED' : payment.order.paymentStatus,
        }),
      },
    })

    /*
     * Every rupee came back, so the loyalty on the bill is unwound — both
     * halves of it (owner decision 2026-09-13, extended for the rewards work).
     *
     *   the points it EARNED are taken back, because the sale did not happen;
     *   the points it SPENT are given back, because the guest paid for a meal
     *     they no longer have — `cancelOrder` has always done this, and a bill
     *     that was refunded rather than cancelled left the guest short.
     *
     * Once, however many refunds it took to get here. The guard is the ledger
     * itself — a RETURNED entry against this order that carries the marker —
     * rather than the prefix of a sentence, which used to be the guard and
     * would have been silently switched off by a reworded note.
     */
    if (paidTotal === 0 && payment.order.customerId) {
      const reversed = await tx.loyaltyEntry.findFirst({
        where: { orderId: payment.orderId, kind: 'RETURNED', note: { contains: REFUND_REVERSAL_MARK } },
        select: { id: true },
      })
      if (!reversed) {
        const entries = await tx.loyaltyEntry.findMany({
          where: { orderId: payment.orderId, kind: { in: ['EARNED', 'REDEEMED'] } },
          select: { points: true, kind: true },
        })
        const earned = entries
          .filter((entry) => entry.kind === 'EARNED')
          .reduce((total, entry) => total + entry.points, 0)
        const spent = entries
          .filter((entry) => entry.kind === 'REDEEMED')
          .reduce((total, entry) => total + Math.abs(entry.points), 0)

        const holder = await tx.customer.findUnique({
          where: { id: payment.order.customerId },
          select: { loyaltyPoints: true, totalSpent: true },
        })
        /*
         * Taking back more than they hold would drive the balance negative,
         * so the take is clamped — and the ENTRY records what was actually
         * moved, not what was owed, because the balance has to stay the sum
         * of its entries.
         */
        const take = Math.min(Math.max(0, earned), holder?.loyaltyPoints ?? 0)
        const net = spent - take

        if (net !== 0) {
          await tx.customer.update({
            where: { id: payment.order.customerId },
            data: { loyaltyPoints: { increment: net } },
          })
        }
        await tx.customer.update({
          where: { id: payment.order.customerId },
          data: { totalSpent: { decrement: Math.min(payment.order.grandTotal, holder?.totalSpent ?? 0) } },
        })
        await tx.loyaltyEntry.create({
          data: {
            restaurantId: params.restaurantId,
            customerId: payment.order.customerId,
            orderId: payment.orderId,
            points: net,
            kind: 'RETURNED',
            note:
              `${payment.order.orderNumber} refunded in full — ` +
              `${take} earned point${take === 1 ? '' : 's'} taken back` +
              (spent > 0 ? `, ${spent} spent returned` : '') +
              ` ${REFUND_REVERSAL_MARK}`,
            actorId: params.actorId,
          },
        })
      }
    }

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

    // Money going back is an event too, and for the same reason.
    await emitOutbox(tx, {
      restaurantId: params.restaurantId,
      branchId: payment.order.branchId,
      type: EVENTS.PAYMENT_RECEIVED,
      entity: 'Refund',
      entityId: refund.id,
      payload: {
        orderId: payment.orderId,
        orderNumber: payment.order.orderNumber,
        paymentId: payment.id,
        amount: -amount,
        method: payment.method,
      },
    })

    return refund
  })
}
