import 'server-only'

import { prisma } from '@/server/db/prisma'

/**
 * The one place that knows every queue a decision can be waiting in
 * (acCal.md §14). Five queues, five owners — this module only counts and
 * lists; deciding stays with each domain's own guarded action.
 */

export interface ApprovalsInboxCount {
  /** Requests waiting for someone's decision, across every queue. */
  count: number
  /** The money asked for, where the request carries an amount. */
  amount: number
  byQueue: Array<{ queue: string; count: number }>
}

export interface InboxItem {
  queue: string
  id: string
  title: string
  amount: number | null
  requestedByName: string
  requestedAt: Date
  /** What approving actually does — stated honestly, never oversold. */
  consequence: string
  href: string
}

/**
 * Everything waiting on a decision, in one list (acCal.md §14).
 *
 * The inbox itself writes nothing: each row links to the screen whose own
 * guarded action owns that decision. That keeps every permission check and
 * every side effect where it already lives — and it is why the consequence
 * line can be honest about the queues where approving only records a
 * decision rather than doing anything.
 */
export async function getApprovalsInbox(
  restaurantId: string,
  branchIds?: string[] | null,
): Promise<InboxItem[]> {
  const atBranch = branchIds ? { branchId: { in: branchIds } } : {}
  const atBranchOrGlobal = branchIds
    ? { OR: [{ branchId: { in: branchIds } }, { branchId: null }] }
    : {}

  const [generic, outgoing, petty, counts, purchases] = await Promise.all([
    prisma.approvalRequest.findMany({
      where: { restaurantId, status: 'PENDING', ...atBranchOrGlobal },
      select: {
        id: true, kind: true, amount: true, reason: true, createdAt: true,
        requestedBy: { select: { name: true } },
      },
      orderBy: { createdAt: 'asc' },
      take: 100,
    }),
    prisma.outgoingPayment.findMany({
      where: { restaurantId, status: 'SUBMITTED', ...atBranch },
      select: {
        id: true, number: true, amount: true, description: true,
        submittedAt: true, createdAt: true, createdByName: true,
      },
      orderBy: { createdAt: 'asc' },
      take: 100,
    }),
    prisma.pettyCashRequest.findMany({
      where: { restaurantId, status: 'PENDING', ...atBranch },
      select: {
        id: true, amount: true, description: true, requestedAt: true,
        requestedBy: { select: { name: true } },
      },
      orderBy: { requestedAt: 'asc' },
      take: 100,
    }),
    prisma.stockCount.findMany({
      where: { restaurantId, status: 'AWAITING_APPROVAL', ...atBranch },
      select: { id: true, reference: true, createdAt: true, countedBy: { select: { name: true } } },
      orderBy: { createdAt: 'asc' },
      take: 100,
    }),
    prisma.purchase.findMany({
      where: { restaurantId, status: 'PENDING_APPROVAL', ...atBranch },
      select: {
        id: true, number: true, total: true, createdAt: true,
        supplier: { select: { name: true } },
      },
      orderBy: { createdAt: 'asc' },
      take: 100,
    }),
  ])

  const items: InboxItem[] = [
    ...outgoing.map((row) => ({
      queue: 'Payment out',
      id: row.id,
      title: `${row.number} — ${row.description}`,
      amount: row.amount,
      requestedByName: row.createdByName,
      requestedAt: row.submittedAt ?? row.createdAt,
      consequence: 'Approving releases it for payment. The person who submitted it cannot approve it.',
      href: '/dashboard/accounting/approvals',
    })),
    ...generic.map((row) => ({
      queue: row.kind === 'STOCK_TRANSFER' ? 'Stock transfer' : row.kind === 'REFUND' ? 'Refund' : 'Discount / override',
      id: row.id,
      title: row.reason,
      amount: row.amount,
      requestedByName: row.requestedBy?.name ?? 'Someone',
      requestedAt: row.createdAt,
      consequence:
        row.kind === 'STOCK_TRANSFER'
          ? 'Approving dispatches the transfer.'
          : 'Records the decision — no automatic change is made to the bill.',
      href: '/dashboard/approvals',
    })),
    ...petty.map((row) => ({
      queue: 'Petty cash',
      id: row.id,
      title: row.description,
      amount: row.amount,
      requestedByName: row.requestedBy?.name ?? 'Someone',
      requestedAt: row.requestedAt,
      consequence: 'Approving allows the cash to be paid out of the tin.',
      href: '/dashboard/petty-cash',
    })),
    ...purchases.map((row) => ({
      queue: 'Purchase order',
      id: row.id,
      title: `${row.number} — ${row.supplier?.name ?? 'supplier'}`,
      amount: row.total,
      requestedByName: 'Purchasing',
      requestedAt: row.createdAt,
      consequence: 'Approving lets the order be placed and the goods received.',
      href: `/dashboard/purchases/${row.id}`,
    })),
    ...counts.map((row) => ({
      queue: 'Stock count',
      id: row.id,
      title: `Count ${row.reference}`,
      amount: null,
      requestedByName: row.countedBy?.name ?? 'Someone',
      requestedAt: row.createdAt,
      consequence: 'Approving posts stock adjustments — review the counted lines first.',
      href: `/dashboard/inventory/counts/${row.id}`,
    })),
  ]

  return items.sort((a, b) => a.requestedAt.getTime() - b.requestedAt.getTime())
}

export async function getApprovalsInboxCount(
  restaurantId: string,
  branchIds?: string[] | null,
): Promise<ApprovalsInboxCount> {
  const atBranch = branchIds ? { branchId: { in: branchIds } } : {}
  // ApprovalRequest.branchId is nullable — a restaurant-wide request belongs
  // to every branch view, same rule the approvals page uses.
  const atBranchOrGlobal = branchIds
    ? { OR: [{ branchId: { in: branchIds } }, { branchId: null }] }
    : {}

  const [generic, genericAmount, outgoing, petty, counts, purchases] = await Promise.all([
    prisma.approvalRequest.count({
      where: { restaurantId, status: 'PENDING', ...atBranchOrGlobal },
    }),
    prisma.approvalRequest.aggregate({
      where: { restaurantId, status: 'PENDING', ...atBranchOrGlobal },
      _sum: { amount: true },
    }),
    prisma.outgoingPayment.aggregate({
      where: { restaurantId, status: 'SUBMITTED', ...atBranch },
      _count: true,
      _sum: { amount: true },
    }),
    prisma.pettyCashRequest.aggregate({
      where: { restaurantId, status: 'PENDING', ...atBranch },
      _count: true,
      _sum: { amount: true },
    }),
    prisma.stockCount.count({
      where: { restaurantId, status: 'AWAITING_APPROVAL', ...atBranch },
    }),
    prisma.purchase.count({
      where: { restaurantId, status: 'PENDING_APPROVAL', ...atBranch },
    }),
  ])

  const byQueue = [
    { queue: 'Payments out', count: outgoing._count },
    { queue: 'Refunds & discounts', count: generic },
    { queue: 'Petty cash', count: petty._count },
    { queue: 'Stock counts', count: counts },
    { queue: 'Purchase orders', count: purchases },
  ].filter((row) => row.count > 0)

  return {
    count: generic + outgoing._count + petty._count + counts + purchases,
    amount:
      (genericAmount._sum.amount ?? 0) +
      (outgoing._sum.amount ?? 0) +
      (petty._sum.amount ?? 0),
    byQueue,
  }
}
