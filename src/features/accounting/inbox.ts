import 'server-only'

import { prisma } from '@/server/db/prisma'

/**
 * The one place that knows every queue a decision can be waiting in
 * (acCal.md §14). Five queues, five owners — this module only counts and
 * lists; deciding stays with each domain's own guarded action.
 */

/** What each generic request is, in the words an owner would use. */
const KIND_TITLES: Record<string, string> = {
  REFUND: 'Refund',
  DISCOUNT: 'Discount',
  STOCK_ADJUSTMENT: 'Stock adjustment',
  PURCHASE_ORDER: 'Purchase order',
  STOCK_TRANSFER: 'Stock transfer',
  PRICE_OVERRIDE: 'Price override',
}

export interface ApprovalsInboxCount {
  /** Requests waiting for someone's decision, across every queue. */
  count: number
  /** The money asked for, where the request carries an amount. */
  amount: number
  byQueue: Array<{ queue: string; count: number }>
}

export interface InboxItem {
  queue: string
  /** Which queue this row belongs to, so a decision can be routed to it. */
  kind: 'APPROVAL_REQUEST' | 'OUTGOING_PAYMENT' | 'PETTY_CASH' | 'STOCK_COUNT' | 'PURCHASE'
  id: string
  /** WHAT is being asked for. */
  title: string
  /** WHY — the requester's own words, where the queue captures them. */
  reason: string | null
  /** AMOUNT, in minor units; null where the request is not about money. */
  amount: number | null
  /** BRANCH. Null means it concerns the whole restaurant. */
  branchId: string | null
  branchName: string | null
  /** REQUESTED BY, and by whose id — so self-approval can be greyed out. */
  requestedByName: string
  requestedById: string | null
  requestedAt: Date
  /** RELATED RECORD — the document this decision is about. */
  reference: string | null
  /** What approving actually does — stated honestly, never oversold. */
  consequence: string
  /**
   * Whether this row can be decided from the list at all. Some cannot be
   * judged from a summary — a stock count is lines of counted shelves, and
   * approving it unseen is not a decision, it is a rubber stamp.
   */
  decidable: boolean
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
        entity: true, entityId: true, branchId: true,
        branch: { select: { name: true } },
        requestedById: true,
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
        branchId: true, branch: { select: { name: true } }, submittedById: true,
      },
      orderBy: { createdAt: 'asc' },
      take: 100,
    }),
    prisma.pettyCashRequest.findMany({
      where: { restaurantId, status: 'PENDING', ...atBranch },
      select: {
        id: true, amount: true, description: true, requestedAt: true,
        branchId: true, branch: { select: { name: true } }, requestedById: true,
        requestedBy: { select: { name: true } },
      },
      orderBy: { requestedAt: 'asc' },
      take: 100,
    }),
    prisma.stockCount.findMany({
      where: { restaurantId, status: 'AWAITING_APPROVAL', ...atBranch },
      select: {
        id: true, reference: true, createdAt: true, branchId: true,
        branch: { select: { name: true } }, countedById: true,
        countedBy: { select: { name: true } },
      },
      orderBy: { createdAt: 'asc' },
      take: 100,
    }),
    prisma.purchase.findMany({
      where: { restaurantId, status: 'PENDING_APPROVAL', ...atBranch },
      select: {
        id: true, number: true, total: true, createdAt: true,
        branchId: true, branch: { select: { name: true } }, createdById: true,
        supplier: { select: { name: true } },
      },
      orderBy: { createdAt: 'asc' },
      take: 100,
    }),
  ])

  const items: InboxItem[] = [
    ...outgoing.map((row) => ({
      queue: 'Payment out',
      kind: 'OUTGOING_PAYMENT' as const,
      id: row.id,
      title: row.description,
      reason: null,
      amount: row.amount,
      branchId: row.branchId,
      branchName: row.branch?.name ?? null,
      requestedByName: row.createdByName,
      requestedById: row.submittedById,
      requestedAt: row.submittedAt ?? row.createdAt,
      reference: row.number,
      consequence: 'Approving releases it for payment. The person who submitted it cannot approve it.',
      decidable: true,
      href: '/dashboard/accounting/approvals',
    })),
    ...generic.map((row) => ({
      queue: row.kind === 'STOCK_TRANSFER' ? 'Stock transfer' : row.kind === 'REFUND' ? 'Refund' : 'Discount / override',
      id: row.id,
      kind: 'APPROVAL_REQUEST' as const,
      title: KIND_TITLES[row.kind] ?? 'Approval',
      reason: row.reason,
      amount: row.amount,
      branchId: row.branchId,
      branchName: row.branch?.name ?? null,
      requestedByName: row.requestedBy?.name ?? 'Someone',
      requestedById: row.requestedById,
      requestedAt: row.createdAt,
      reference: row.entityId ? `${row.entity} ${row.entityId.slice(0, 8)}` : row.entity,
      consequence:
        row.kind === 'STOCK_TRANSFER'
          ? 'Approving dispatches the transfer.'
          : 'Records the decision — the person who asked still has to carry it out.',
      decidable: true,
      href: '/dashboard/approvals',
    })),
    ...petty.map((row) => ({
      queue: 'Petty cash',
      id: row.id,
      kind: 'PETTY_CASH' as const,
      title: row.description,
      reason: null,
      amount: row.amount,
      branchId: row.branchId,
      branchName: row.branch?.name ?? null,
      requestedByName: row.requestedBy?.name ?? 'Someone',
      requestedById: row.requestedById,
      requestedAt: row.requestedAt,
      reference: null,
      consequence: 'Approving allows the cash to be paid out of the tin.',
      decidable: true,
      href: '/dashboard/petty-cash',
    })),
    ...purchases.map((row) => ({
      queue: 'Purchase order',
      id: row.id,
      kind: 'PURCHASE' as const,
      title: `Order from ${row.supplier?.name ?? 'a supplier'}`,
      reason: null,
      amount: row.total,
      branchId: row.branchId,
      branchName: row.branch?.name ?? null,
      requestedByName: 'Purchasing',
      requestedById: row.createdById,
      requestedAt: row.createdAt,
      reference: row.number,
      consequence: 'Approving lets the order be placed and the goods received.',
      // The lines matter — what was ordered, at what price — so this one is
      // read on its own page rather than waved through from a summary.
      decidable: false,
      href: `/dashboard/purchases/${row.id}`,
    })),
    ...counts.map((row) => ({
      queue: 'Stock count',
      id: row.id,
      kind: 'STOCK_COUNT' as const,
      title: `Stock count ${row.reference}`,
      reason: null,
      amount: null,
      branchId: row.branchId,
      branchName: row.branch?.name ?? null,
      requestedByName: row.countedBy?.name ?? 'Someone',
      requestedById: row.countedById,
      requestedAt: row.createdAt,
      reference: row.reference,
      consequence: 'Approving posts stock adjustments — review the counted lines first.',
      // A count is shelves of numbers. Approving it unseen is a rubber stamp,
      // so this row sends you to read it.
      decidable: false,
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
