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
): Promise<DestinationTotals[]> {
  const atBranch = branchIds ? { order: { branchId: { in: branchIds } } } : {}

  const [payments, refunds] = await Promise.all([
    prisma.payment.groupBy({
      by: ['destination'],
      where: { restaurantId, status: { in: ['PAID', 'REFUNDED'] }, ...atBranch },
      _sum: { amount: true },
      _count: true,
      _max: { paidAt: true },
    }),
    prisma.refund.groupBy({
      by: ['destination'],
      where: { restaurantId, ...atBranch },
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
