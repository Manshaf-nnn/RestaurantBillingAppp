import type { PaymentMethod, PaymentStatus } from '@prisma/client'

import { prisma } from '@/server/db/prisma'

export interface OnlinePaymentRow {
  id: string
  status: PaymentStatus
  method: PaymentMethod
  amount: number
  reference: string | null
  createdAt: string
  orderId: string
  orderNumber: string
  tableNumber: string | null
  customerName: string
  grandTotal: number
  paidTotal: number
  orderPaymentStatus: PaymentStatus
}

/**
 * Every payment a guest settled (or declared) online — bank transfer or gateway
 * — so the owner can cross-check them against the bank and confirm receipts.
 */
export async function getOnlinePayments(
  restaurantId: string,
  branchIds?: string[] | null,
): Promise<OnlinePaymentRow[]> {
  const rows = await prisma.payment.findMany({
    where: {
      restaurantId,
      OR: [{ method: 'ONLINE' }, { reference: { contains: 'transfer', mode: 'insensitive' } }],
      // A payment reaches its location through the bill it settled. Without
      // this, every branch's online receipts and the customer names on them
      // were readable by anyone holding PAYMENT_COLLECT.
      ...(branchIds ? { order: { branchId: { in: branchIds } } } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: 80,
    include: {
      order: {
        select: {
          id: true,
          orderNumber: true,
          grandTotal: true,
          paidTotal: true,
          paymentStatus: true,
          customerName: true,
          table: { select: { number: true } },
        },
      },
    },
  })

  return rows.map((p) => ({
    id: p.id,
    status: p.status,
    method: p.method,
    amount: p.amount,
    reference: p.reference,
    createdAt: p.createdAt.toISOString(),
    orderId: p.order.id,
    orderNumber: p.order.orderNumber,
    tableNumber: p.order.table?.number ?? null,
    customerName: p.order.customerName,
    grandTotal: p.order.grandTotal,
    paidTotal: p.order.paidTotal,
    orderPaymentStatus: p.order.paymentStatus,
  }))
}

/**
 * What has actually landed in each account (bill.md §2).
 *
 * ── Why "collected" is PAID *and* REFUNDED ──────────────────────────────────
 *
 * A payment that was later refunded still arrived: the money hit the account
 * and then left it. Counting only PAID would quietly erase the arrival and
 * leave the account's figure disagreeing with the bank statement it exists to
 * be checked against. So both are collected, and what went back is subtracted
 * as `refunded` — the same rule `getPaymentsReport` uses, which is what keeps
 * this screen and the reports telling one story.
 *
 * A partial refund is why refunds are read from the refunds ledger rather than
 * from the REFUNDED status: a payment half returned still reads PAID.
 */
export interface DestinationTotals {
  /** Null for money taken before destinations existed — shown as Unassigned. */
  destination: string | null
  collected: number
  refunded: number
  count: number
  lastAt: string | null
}

export async function getDestinationTotals(
  restaurantId: string,
  branchIds?: string[] | null,
  /*
   * Bounded, like every sibling report. Unbounded, this was a lifetime
   * aggregate over payments ⋈ orders on a page that re-rendered every eight
   * seconds during service — the slowest page in the app, slower every day.
   */
  range?: { from: Date; to: Date },
): Promise<DestinationTotals[]> {
  const atBranch = branchIds ? { order: { branchId: { in: branchIds } } } : {}
  const paidWithin = range ? { paidAt: { gte: range.from, lte: range.to } } : {}
  const refundedWithin = range ? { createdAt: { gte: range.from, lte: range.to } } : {}

  const [payments, refunds] = await Promise.all([
    prisma.payment.groupBy({
      by: ['destination'],
      where: { restaurantId, status: { in: ['PAID', 'REFUNDED'] }, ...atBranch, ...paidWithin },
      _sum: { amount: true },
      _count: true,
      _max: { paidAt: true },
    }),
    prisma.refund.groupBy({
      by: ['destination'],
      where: { restaurantId, ...atBranch, ...refundedWithin },
      _sum: { amount: true },
    }),
  ])

  const returned = new Map(
    refunds.map((row) => [row.destination, row._sum.amount ?? 0] as const),
  )

  return payments
    .map((row) => ({
      destination: row.destination,
      collected: row._sum.amount ?? 0,
      refunded: returned.get(row.destination) ?? 0,
      count: row._count,
      lastAt: row._max.paidAt?.toISOString() ?? null,
    }))
    .sort((a, b) => b.collected - a.collected)
}

export interface DestinationPaymentRow {
  id: string
  paidAt: string | null
  method: PaymentMethod
  status: PaymentStatus
  amount: number
  refunded: number
  reference: string | null
  orderId: string
  orderNumber: string
  invoiceNumber: string | null
  branchName: string | null
}

/**
 * Every payment filed under one account, newest first.
 *
 * `destination: null` is a real query, not a missing filter — it is how the
 * money taken before any of this existed is read, and it has to be reachable
 * or that money is invisible rather than merely unassigned.
 */
export async function getDestinationPayments(
  restaurantId: string,
  destination: string | null,
  branchIds?: string[] | null,
  take = 200,
): Promise<DestinationPaymentRow[]> {
  const rows = await prisma.payment.findMany({
    where: {
      restaurantId,
      destination,
      status: { in: ['PAID', 'REFUNDED'] },
      ...(branchIds ? { order: { branchId: { in: branchIds } } } : {}),
    },
    orderBy: [{ paidAt: 'desc' }, { createdAt: 'desc' }],
    take,
    select: {
      id: true,
      paidAt: true,
      method: true,
      status: true,
      amount: true,
      reference: true,
      refunds: { select: { amount: true } },
      order: {
        select: {
          id: true,
          orderNumber: true,
          invoice: { select: { number: true } },
          branch: { select: { name: true } },
        },
      },
    },
  })

  return rows.map((row) => ({
    id: row.id,
    paidAt: row.paidAt?.toISOString() ?? null,
    method: row.method,
    status: row.status,
    amount: row.amount,
    refunded: row.refunds.reduce((sum, refund) => sum + refund.amount, 0),
    reference: row.reference,
    orderId: row.order.id,
    orderNumber: row.order.orderNumber,
    invoiceNumber: row.order.invoice?.number ?? null,
    branchName: row.order.branch?.name ?? null,
  }))
}

// ── the invoices list (abc.md §2) ───────────────────────────────────────────

export type InvoiceStatusFilter = 'ALL' | 'OUTSTANDING' | 'SETTLED' | 'REFUNDED' | 'FAILED'

/** How a settlement status on the screen maps to the order's payment status. */
const INVOICE_STATUS_MAP: Record<Exclude<InvoiceStatusFilter, 'ALL'>, PaymentStatus[]> = {
  OUTSTANDING: ['UNPAID', 'PARTIAL'],
  SETTLED: ['PAID'],
  REFUNDED: ['REFUNDED'],
  FAILED: ['FAILED'],
}

/** The hard ceiling on one page, including "All": a safety limit, not a horizon. */
export const INVOICE_LIST_MAX_ROWS = 5000

export interface InvoiceListTotals {
  count: number
  /** Σ (grand total + tip) — what the invoices are for. */
  amount: number
  /** Σ collected. */
  collected: number
  /** amount − collected, never negative: the service refuses overpayment. */
  outstanding: number
}

export interface InvoiceListRow {
  id: string
  number: string
  issuedAt: Date
  emailedAt: Date | null
  order: {
    id: string
    orderNumber: string
    customerName: string
    paymentStatus: PaymentStatus
    grandTotal: number
    tipAmount: number
    paidTotal: number
    branchId: string
  }
}

/**
 * Invoices issued in a period, at some locations, with a settlement status —
 * and the whole set's money from the same predicate.
 *
 * ── Why the totals come from here ───────────────────────────────────────────
 *
 * The screen used to take the newest 200 invoices and add them up in the
 * browser, so "still to collect" on a busy month was the newest 200's, not
 * the month's. `totals` is an aggregate over the orders whose invoice sits
 * inside exactly the rows' predicate (an invoice is 1:1 with its order, so
 * the counts agree), whichever page is showing.
 *
 * `branchIds` follows the house convention: null is every location, an array
 * narrows through the order's branch, and an empty array is nothing.
 */
export async function listInvoices(params: {
  restaurantId: string
  branchIds: string[] | null
  range: { from: Date; to: Date }
  status?: InvoiceStatusFilter
  page?: number
  perPage?: number | 'ALL'
}): Promise<{
  invoices: InvoiceListRow[]
  total: number
  page: number
  perPage: number | 'ALL'
  pageCount: number
  totals: InvoiceListTotals
}> {
  const page = Math.max(1, params.page ?? 1)
  const all = params.perPage === 'ALL'
  const perPage = all
    ? INVOICE_LIST_MAX_ROWS
    : Math.min(INVOICE_LIST_MAX_ROWS, Math.max(10, typeof params.perPage === 'number' ? params.perPage : 50))
  const statuses = params.status && params.status !== 'ALL' ? INVOICE_STATUS_MAP[params.status] : null

  // One predicate, written once for the order side and once for the invoice
  // side of the same 1:1 relation.
  const orderSide = {
    restaurantId: params.restaurantId,
    ...(params.branchIds ? { branchId: { in: params.branchIds } } : {}),
    ...(statuses ? { paymentStatus: { in: statuses } } : {}),
  }
  const issued = { gte: params.range.from, lte: params.range.to }

  const [rows, aggregate] = await Promise.all([
    prisma.invoice.findMany({
      where: { restaurantId: params.restaurantId, issuedAt: issued, order: orderSide },
      orderBy: { issuedAt: 'desc' },
      skip: (page - 1) * perPage,
      take: perPage,
      select: {
        id: true,
        number: true,
        issuedAt: true,
        emailedAt: true,
        order: {
          select: {
            id: true,
            orderNumber: true,
            customerName: true,
            paymentStatus: true,
            grandTotal: true,
            tipAmount: true,
            paidTotal: true,
            branchId: true,
          },
        },
      },
    }),
    prisma.order.aggregate({
      where: { ...orderSide, invoice: { is: { restaurantId: params.restaurantId, issuedAt: issued } } },
      _count: { _all: true },
      _sum: { grandTotal: true, tipAmount: true, paidTotal: true },
    }),
  ])

  const total = aggregate._count._all
  const amount = (aggregate._sum.grandTotal ?? 0) + (aggregate._sum.tipAmount ?? 0)
  const collected = aggregate._sum.paidTotal ?? 0
  return {
    invoices: rows,
    total,
    page,
    perPage: all ? 'ALL' : perPage,
    pageCount: all ? 1 : Math.max(1, Math.ceil(total / perPage)),
    totals: { count: total, amount, collected, outstanding: Math.max(0, amount - collected) },
  }
}
