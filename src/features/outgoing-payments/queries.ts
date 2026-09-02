import 'server-only'

import type { OutgoingPaymentStatus } from '@prisma/client'

import { prisma } from '@/server/db/prisma'

/** One row of the worklist / approval queue. */
export interface OutgoingRow {
  id: string
  number: string
  kind: string
  status: OutgoingPaymentStatus
  amount: number
  method: string
  reference: string | null
  description: string
  paymentDate: string
  branchName: string
  supplierName: string | null
  purchaseNumber: string | null
  categoryName: string | null
  createdByName: string
  submittedAt: string | null
  decidedAt: string | null
  decisionNote: string | null
  paidAt: string | null
  reversalOfNumber: string | null
  supplierPaymentId: string | null
}

const ROW_INCLUDE = {
  branch: { select: { name: true } },
  supplier: { select: { name: true } },
  purchase: { select: { number: true } },
  expenseCategory: { select: { name: true } },
  reversalOf: { select: { number: true } },
} as const

function toRow(payment: {
  id: string
  number: string
  kind: string
  status: OutgoingPaymentStatus
  amount: number
  method: string
  reference: string | null
  description: string
  paymentDate: Date
  branch: { name: string }
  supplier: { name: string } | null
  purchase: { number: string } | null
  expenseCategory: { name: string } | null
  reversalOf: { number: string } | null
  createdByName: string
  submittedAt: Date | null
  decidedAt: Date | null
  decisionNote: string | null
  paidAt: Date | null
  supplierPaymentId: string | null
}): OutgoingRow {
  return {
    id: payment.id,
    number: payment.number,
    kind: payment.kind,
    status: payment.status,
    amount: payment.amount,
    method: payment.method,
    reference: payment.reference,
    description: payment.description,
    paymentDate: payment.paymentDate.toISOString(),
    branchName: payment.branch.name,
    supplierName: payment.supplier?.name ?? null,
    purchaseNumber: payment.purchase?.number ?? null,
    categoryName: payment.expenseCategory?.name ?? null,
    createdByName: payment.createdByName,
    submittedAt: payment.submittedAt?.toISOString() ?? null,
    decidedAt: payment.decidedAt?.toISOString() ?? null,
    decisionNote: payment.decisionNote,
    paidAt: payment.paidAt?.toISOString() ?? null,
    reversalOfNumber: payment.reversalOf?.number ?? null,
    supplierPaymentId: payment.supplierPaymentId,
  }
}

export async function listOutgoingPayments(params: {
  restaurantId: string
  branchIds?: string[] | null
  status?: OutgoingPaymentStatus[]
  limit?: number
}): Promise<OutgoingRow[]> {
  const rows = await prisma.outgoingPayment.findMany({
    where: {
      restaurantId: params.restaurantId,
      ...(params.branchIds ? { branchId: { in: params.branchIds } } : {}),
      ...(params.status?.length ? { status: { in: params.status } } : {}),
    },
    include: ROW_INCLUDE,
    orderBy: { createdAt: 'desc' },
    take: params.limit ?? 200,
  })
  return rows.map(toRow)
}

/** The §7 approval-center totals: what is waiting, decided, and paid. */
export interface ApprovalTotals {
  pending: number
  pendingCount: number
  approved: number
  rejected: number
  paid: number
  byBranch: Array<{ branch: string; amount: number }>
  byTarget: Array<{ target: string; amount: number }>
}

export async function getApprovalTotals(params: {
  restaurantId: string
  branchIds?: string[] | null
}): Promise<ApprovalTotals> {
  const atBranch = params.branchIds ? { branchId: { in: params.branchIds } } : {}
  const base = { restaurantId: params.restaurantId, ...atBranch }

  const [byStatus, pendingRows] = await Promise.all([
    prisma.outgoingPayment.groupBy({
      by: ['status'],
      where: base,
      _sum: { amount: true },
      _count: true,
    }),
    prisma.outgoingPayment.findMany({
      where: { ...base, status: 'SUBMITTED' },
      include: {
        branch: { select: { name: true } },
        supplier: { select: { name: true } },
        expenseCategory: { select: { name: true } },
      },
    }),
  ])

  const sum = (status: OutgoingPaymentStatus) =>
    byStatus.find((row) => row.status === status)?._sum.amount ?? 0

  const byBranch = new Map<string, number>()
  const byTarget = new Map<string, number>()
  for (const row of pendingRows) {
    byBranch.set(row.branch.name, (byBranch.get(row.branch.name) ?? 0) + row.amount)
    const target = row.supplier?.name ?? row.expenseCategory?.name ?? 'Uncategorised'
    byTarget.set(target, (byTarget.get(target) ?? 0) + row.amount)
  }

  return {
    pending: sum('SUBMITTED'),
    pendingCount: byStatus.find((row) => row.status === 'SUBMITTED')?._count ?? 0,
    approved: sum('APPROVED'),
    rejected: sum('REJECTED'),
    paid: sum('PAID'),
    byBranch: [...byBranch.entries()]
      .map(([branch, amount]) => ({ branch, amount }))
      .sort((a, b) => b.amount - a.amount),
    byTarget: [...byTarget.entries()]
      .map(([target, amount]) => ({ target, amount }))
      .sort((a, b) => b.amount - a.amount),
  }
}

/** The full trail of one payment, from the append-only audit log. */
export async function getPaymentHistory(params: {
  restaurantId: string
  paymentId: string
}): Promise<Array<{ action: string; actorName: string | null; at: string; detail: unknown }>> {
  const rows = await prisma.auditLog.findMany({
    where: {
      restaurantId: params.restaurantId,
      entity: 'OutgoingPayment',
      entityId: params.paymentId,
    },
    orderBy: { createdAt: 'asc' },
    select: { action: true, actorName: true, createdAt: true, after: true },
  })
  return rows.map((row) => ({
    action: row.action,
    actorName: row.actorName,
    at: row.createdAt.toISOString(),
    detail: row.after,
  }))
}

export async function listExpenseCategories(restaurantId: string) {
  return prisma.expenseCategory.findMany({
    where: { restaurantId },
    orderBy: [{ isActive: 'desc' }, { sortOrder: 'asc' }, { name: 'asc' }],
    select: { id: true, name: true, isActive: true },
  })
}
