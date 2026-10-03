import 'server-only'

import type { OutgoingPaymentKind, OutgoingPaymentStatus, PaymentMethod } from '@prisma/client'

import { prisma } from '@/server/db/prisma'

/**
 * The money-out report: every payment in a period, and where the money went.
 *
 * ── What counts as money that went ──────────────────────────────────────────
 *
 * Only a PAID payment has left the business. A payment that was paid and then
 * reversed is two rows — the original (REVERSED) and its reversal (PAID,
 * `reversalOfId` set) — and together they are nought, so neither is in
 * "paid out": the original is counted under "reversed" and the reversal is
 * listed as what it is, the money coming back. Everything else (draft,
 * waiting, approved, rejected, cancelled) is listed with its status and
 * counted separately as money that has not moved.
 *
 * Dated by `paymentDate` — when the money moves — which is also the date the
 * accounting period guard reads.
 */

export interface MoneyOutRow {
  id: string
  number: string
  paymentDate: Date
  kind: OutgoingPaymentKind
  status: OutgoingPaymentStatus
  /** The original was undone by this row. */
  isReversal: boolean
  /** Supplier name or expense category. */
  paidTo: string
  purchaseNumber: string | null
  description: string
  /** Minor units; negative on a reversal row, which is money coming back. */
  amount: number
  method: PaymentMethod
  payFromName: string | null
  reference: string | null
  branchName: string
  raisedByName: string
  approvedByName: string | null
  paidByName: string | null
  paidAt: Date | null
  decisionNote: string | null
}

export interface MoneyOutBreakdown {
  label: string
  count: number
  amount: number
}

export interface MoneyOutReport {
  rows: MoneyOutRow[]
  totals: {
    /** PAID and not undone — what actually left. */
    paidOut: number
    paidCount: number
    supplier: number
    expense: number
    /** Paid, then reversed: the money came back. */
    reversed: number
    reversedCount: number
    /** Approved and not yet paid. */
    approvedUnpaid: number
    approvedCount: number
    /** Submitted, waiting for a decision. */
    waiting: number
    waitingCount: number
  }
  /** Each over the money that actually left, largest first. */
  byPaidTo: MoneyOutBreakdown[]
  byMethod: Array<MoneyOutBreakdown & { method: PaymentMethod }>
  byAccount: MoneyOutBreakdown[]
  byBranch: MoneyOutBreakdown[]
}

export async function getMoneyOutReport(params: {
  restaurantId: string
  from: Date
  to: Date
  /** Null is every location the viewer may see. */
  branchIds?: string[] | null
  status?: OutgoingPaymentStatus | null
  kind?: OutgoingPaymentKind | null
  method?: PaymentMethod | null
  /** A payment account id, or 'none' for payments that name no account. */
  accountId?: string | null
}): Promise<MoneyOutReport> {
  const payments = await prisma.outgoingPayment.findMany({
    where: {
      restaurantId: params.restaurantId,
      paymentDate: { gte: params.from, lte: params.to },
      ...(params.branchIds ? { branchId: { in: params.branchIds } } : {}),
      ...(params.status ? { status: params.status } : {}),
      ...(params.kind ? { kind: params.kind } : {}),
      ...(params.method ? { method: params.method } : {}),
      ...(params.accountId
        ? { payFromAccountId: params.accountId === 'none' ? null : params.accountId }
        : {}),
    },
    orderBy: [{ paymentDate: 'desc' }, { createdAt: 'desc' }],
    include: {
      branch: { select: { name: true } },
      supplier: { select: { name: true } },
      purchase: { select: { number: true } },
      expenseCategory: { select: { name: true } },
      payFromAccount: { select: { name: true } },
      decidedBy: { select: { name: true } },
      paidBy: { select: { name: true } },
    },
  })

  const rows: MoneyOutRow[] = payments.map((payment) => {
    const isReversal = payment.reversalOfId !== null
    return {
      id: payment.id,
      number: payment.number,
      paymentDate: payment.paymentDate,
      kind: payment.kind,
      status: payment.status,
      isReversal,
      paidTo: payment.supplier?.name ?? payment.expenseCategory?.name ?? '—',
      purchaseNumber: payment.purchase?.number ?? null,
      description: payment.description,
      amount: isReversal ? -payment.amount : payment.amount,
      method: payment.method,
      payFromName: payment.payFromAccount?.name ?? null,
      reference: payment.reference,
      branchName: payment.branch.name,
      raisedByName: payment.createdByName,
      // Only a ruling that let the money go is an approval; a rejection's
      // `decidedBy` is who refused it, and the status already says so.
      approvedByName:
        payment.status === 'REJECTED' || payment.status === 'DRAFT' || payment.status === 'CANCELLED'
          ? null
          : payment.decidedBy?.name ?? null,
      paidByName: payment.paidBy?.name ?? null,
      paidAt: payment.paidAt,
      decisionNote: payment.decisionNote,
    }
  })

  const totals: MoneyOutReport['totals'] = {
    paidOut: 0, paidCount: 0, supplier: 0, expense: 0,
    reversed: 0, reversedCount: 0,
    approvedUnpaid: 0, approvedCount: 0,
    waiting: 0, waitingCount: 0,
  }
  const paidTo = new Map<string, MoneyOutBreakdown>()
  const method = new Map<PaymentMethod, MoneyOutBreakdown & { method: PaymentMethod }>()
  const account = new Map<string, MoneyOutBreakdown>()
  const branch = new Map<string, MoneyOutBreakdown>()
  const add = <K, V extends MoneyOutBreakdown>(map: Map<K, V>, key: K, seed: V, amount: number) => {
    const entry = map.get(key) ?? seed
    entry.count += 1
    entry.amount += amount
    map.set(key, entry)
  }

  for (const row of rows) {
    if (row.status === 'PAID' && !row.isReversal) {
      totals.paidOut += row.amount
      totals.paidCount += 1
      if (row.kind === 'SUPPLIER') totals.supplier += row.amount
      else totals.expense += row.amount
      add(paidTo, row.paidTo, { label: row.paidTo, count: 0, amount: 0 }, row.amount)
      add(method, row.method, { label: row.method, method: row.method, count: 0, amount: 0 }, row.amount)
      const from = row.payFromName ?? 'Not specified'
      add(account, from, { label: from, count: 0, amount: 0 }, row.amount)
      add(branch, row.branchName, { label: row.branchName, count: 0, amount: 0 }, row.amount)
    } else if (row.status === 'REVERSED') {
      totals.reversed += row.amount
      totals.reversedCount += 1
    } else if (row.status === 'APPROVED') {
      totals.approvedUnpaid += row.amount
      totals.approvedCount += 1
    } else if (row.status === 'SUBMITTED') {
      totals.waiting += row.amount
      totals.waitingCount += 1
    }
  }

  const sorted = <V extends MoneyOutBreakdown>(map: Map<unknown, V>) =>
    [...map.values()].sort((a, b) => b.amount - a.amount)

  return {
    rows,
    totals,
    byPaidTo: sorted(paidTo),
    byMethod: sorted(method),
    byAccount: sorted(account),
    byBranch: sorted(branch),
  }
}
