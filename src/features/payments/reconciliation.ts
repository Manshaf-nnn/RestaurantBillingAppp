import 'server-only'

import type { DateRange } from '@/features/reports/range'
import { prisma } from '@/server/db/prisma'

/**
 * Payment reconciliation (acCal.md §5): every bill in the period, classified
 * by the same arithmetic the settlement engine uses.
 *
 *   billed   = grandTotal + tip
 *   received = Σ payments PAID/REFUNDED
 *   returned = Σ refunds
 *   net      = received − returned
 *
 * Five buckets, first match wins:
 *   MISMATCH — the cached paidTotal disagrees with the payment ledger, or
 *              the stored paymentStatus disagrees with the math. This is the
 *              bug class the integrity checker hunts; it should be zero.
 *   OVERPAID — net > billed. In this system over-capture is refused at the
 *              till, so an overpayment always means the bill was edited DOWN
 *              after settlement (a voided line) without a matching refund.
 *   PAID / PARTIAL / UNPAID — the ordinary three.
 */

export type PaymentBucket = 'MISMATCH' | 'OVERPAID' | 'PARTIAL' | 'UNPAID' | 'PAID'

export interface PaymentReconRow {
  orderId: string
  orderNumber: string
  invoiceNumber: string | null
  branchName: string | null
  placedAt: Date
  billed: number
  net: number
  /** billed − net: positive means collect, negative means refund. */
  gap: number
  bucket: PaymentBucket
  /** The fix, in words. */
  action: string
}

export interface PaymentReconciliation {
  counts: Record<PaymentBucket, number>
  /** Only the rows needing eyes: mismatch, overpaid, partial. Worst first. */
  problems: PaymentReconRow[]
  /** True when there were more orders than the scan cap. */
  truncated: boolean
}

const SCAN_CAP = 2_000

export async function getPaymentReconciliation(params: {
  restaurantId: string
  range: DateRange
  branchIds?: string[] | null
  money: (minor: number) => string
}): Promise<PaymentReconciliation> {
  const { restaurantId, range, branchIds, money } = params

  const orders = await prisma.order.findMany({
    where: {
      restaurantId,
      status: { not: 'CANCELLED' },
      placedAt: { gte: range.from, lte: range.to },
      ...(branchIds ? { branchId: { in: branchIds } } : {}),
    },
    select: {
      id: true,
      orderNumber: true,
      placedAt: true,
      grandTotal: true,
      tipAmount: true,
      paidTotal: true,
      paymentStatus: true,
      branch: { select: { name: true } },
      invoice: { select: { number: true } },
      payments: {
        where: { status: { in: ['PAID', 'REFUNDED'] } },
        select: { amount: true },
      },
      refunds: { select: { amount: true } },
    },
    orderBy: { placedAt: 'desc' },
    take: SCAN_CAP + 1,
  })

  const truncated = orders.length > SCAN_CAP
  const scanned = truncated ? orders.slice(0, SCAN_CAP) : orders

  const counts: Record<PaymentBucket, number> = {
    MISMATCH: 0,
    OVERPAID: 0,
    PARTIAL: 0,
    UNPAID: 0,
    PAID: 0,
  }
  const problems: PaymentReconRow[] = []

  for (const order of scanned) {
    const billed = order.grandTotal + order.tipAmount
    const received = order.payments.reduce((sum, row) => sum + row.amount, 0)
    const returned = order.refunds.reduce((sum, row) => sum + row.amount, 0)
    const net = received - returned

    let bucket: PaymentBucket
    let action = ''
    const ledgerDrift = order.paidTotal !== Math.max(0, net)
    const statusDisagrees =
      (order.paymentStatus === 'PAID' && net < billed) ||
      (order.paymentStatus === 'UNPAID' && net > 0) ||
      (order.paymentStatus === 'PARTIAL' && (net <= 0 || net >= billed))

    if (ledgerDrift || (statusDisagrees && order.paymentStatus !== 'REFUNDED')) {
      bucket = 'MISMATCH'
      action = ledgerDrift
        ? `The bill's cached total (${money(order.paidTotal)}) disagrees with its payment records (${money(Math.max(0, net))}) — open the order and check its payments.`
        : `The bill is marked ${order.paymentStatus.toLowerCase()} but its payments say otherwise — open the order.`
    } else if (order.paymentStatus === 'REFUNDED' && net === 0) {
      // Fully refunded on purpose — the story is closed, nothing to collect.
      bucket = 'PAID'
    } else if (net > billed) {
      bucket = 'OVERPAID'
      action = `Refund ${money(net - billed)} — the bill shrank after it was settled.`
    } else if (billed > 0 && net === billed) {
      bucket = 'PAID'
    } else if (net > 0 && net < billed) {
      bucket = 'PARTIAL'
      action = `Collect ${money(billed - net)} still owing.`
    } else if (net <= 0 && billed > 0) {
      bucket = 'UNPAID'
      action = `Collect ${money(billed)}.`
    } else {
      // A zero bill fully returned, or a zero-value order: settled.
      bucket = 'PAID'
    }

    counts[bucket] += 1
    if (bucket === 'MISMATCH' || bucket === 'OVERPAID' || bucket === 'PARTIAL') {
      problems.push({
        orderId: order.id,
        orderNumber: order.orderNumber,
        invoiceNumber: order.invoice?.number ?? null,
        branchName: order.branch?.name ?? null,
        placedAt: order.placedAt,
        billed,
        net,
        gap: billed - net,
        bucket,
        action,
      })
    }
  }

  const severity: Record<PaymentBucket, number> = { MISMATCH: 0, OVERPAID: 1, PARTIAL: 2, UNPAID: 3, PAID: 4 }
  problems.sort((a, b) => severity[a.bucket] - severity[b.bucket] || Math.abs(b.gap) - Math.abs(a.gap))

  return { counts, problems: problems.slice(0, 200), truncated }
}
