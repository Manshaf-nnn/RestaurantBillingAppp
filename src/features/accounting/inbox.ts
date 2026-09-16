import 'server-only'

import type { Prisma } from '@prisma/client'

import { prisma } from '@/server/db/prisma'

/**
 * The one place that knows every queue a decision can be waiting in
 * (acCal.md §14). Six queues, six owners — this module only counts and
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

/**
 * The sections of the desk, in the order recorrection.md §1 lists them.
 *
 * A category is how the desk is READ; `kind` below is how a decision is
 * ROUTED. They are not the same axis — money out and petty cash are two
 * queues with two actions and one meaning to the person clearing them.
 */
export const INBOX_CATEGORIES = [
  'Stock transfers',
  'Money out',
  'Refunds',
  'Discounts',
  'Stock adjustments',
  'Stock write-offs',
  'Other',
] as const
export type InboxCategory = (typeof INBOX_CATEGORIES)[number]

export type InboxKind =
  | 'APPROVAL_REQUEST'
  | 'OUTGOING_PAYMENT'
  | 'PETTY_CASH'
  | 'STOCK_COUNT'
  | 'PURCHASE'
  | 'WASTAGE'

export interface ApprovalsInboxCount {
  /** Requests waiting for someone's decision, across every queue. */
  count: number
  /** The money asked for, where the request carries an amount. */
  amount: number
  byQueue: Array<{ queue: string; count: number }>
}

export interface InboxItem {
  category: InboxCategory
  queue: string
  /** Which queue this row belongs to, so a decision can be routed to it. */
  kind: InboxKind
  /** For the generic queue, WHICH kind — each kind has its own deciding permission. */
  approvalKind: string | null
  id: string
  /** WHAT is being asked for. */
  title: string
  /** WHY — the requester's own words, where the queue captures them. */
  reason: string | null
  /** AMOUNT, in minor units; null where the request is not about money. */
  amount: number | null
  /** BRANCH. Null means it concerns the whole restaurant. For a transfer, the SOURCE. */
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
  /**
   * A transfer's own facts (recorrection.md §1): FROM, TO, and the lines. The
   * request row carries a reason string and a line COUNT; what somebody rules
   * on is which items, how many, from where to where.
   */
  transfer: {
    number: string
    fromBranchName: string
    toBranchId: string
    toBranchName: string
    lines: Array<{ name: string; unit: string; quantity: number }>
  } | null
}

/**
 * How the desk is narrowed (recorrection.md §1). The same shape the decided
 * list takes, so one set of controls governs both.
 */
export interface InboxFilters {
  /** Anything other than PENDING (or unset) empties the pending desk by definition. */
  status?: string
  /** An `ApprovalKind`, or `STOCK_WRITEOFF` for the wastage queue. */
  kind?: string
  requestedById?: string
  fromBranchId?: string
  toBranchId?: string
}

const categoryFor = (kind: string): InboxCategory =>
  kind === 'STOCK_TRANSFER'
    ? 'Stock transfers'
    : kind === 'REFUND'
      ? 'Refunds'
      : kind === 'DISCOUNT' || kind === 'PRICE_OVERRIDE'
        ? 'Discounts'
        : kind === 'STOCK_ADJUSTMENT'
          ? 'Stock adjustments'
          : 'Other'

/**
 * Everything waiting on a decision, in one list (acCal.md §14).
 *
 * The inbox itself writes nothing: each row links to the screen whose own
 * guarded action owns that decision. That keeps every permission check and
 * every side effect where it already lives — and it is why the consequence
 * line can be honest about the queues where approving only records a
 * decision rather than doing anything.
 *
 * ── Who sees a transfer (recorrection.md §1) ────────────────────────────────
 *
 * `ApprovalRequest.branchId` is the SOURCE, because the source approves. But
 * the spec gives the destination a responsibility too — "view request status"
 * — and scoping on `branchId` alone meant the manager who RAISED the request
 * could never see it waiting. So a transfer is visible from either end: the
 * source to decide it, the destination to watch it. The destination's row is
 * not decidable; `assertTransferSide` refuses them at the action anyway.
 */
export async function getApprovalsInbox(
  restaurantId: string,
  branchIds?: string[] | null,
  filters: InboxFilters = {},
): Promise<InboxItem[]> {
  // The pending desk holds pending things. Asking it for "approved" is a
  // question for the history table, which the page answers separately.
  if (filters.status && filters.status !== 'PENDING') return []

  const reach = branchIds ?? null
  const atBranch = reach ? { branchId: { in: reach } } : {}
  const atBranchOrGlobal: Prisma.ApprovalRequestWhereInput = reach
    ? {
        OR: [
          { branchId: { in: reach } },
          { branchId: null },
          // The destination end of a transfer, held only in the payload.
          ...reach.map((id) => ({
            kind: 'STOCK_TRANSFER' as const,
            payload: { path: ['toBranchId'], equals: id },
          })),
        ],
      }
    : {}

  /*
   * Which queues a `kind` filter keeps. An ApprovalKind narrows the generic
   * queue to that kind and silences the others; STOCK_WRITEOFF keeps only the
   * wastage queue; unset keeps everything.
   */
  const kindFilter = filters.kind || null
  const wantGeneric = !kindFilter || kindFilter !== 'STOCK_WRITEOFF'
  const wantWastage = !kindFilter || kindFilter === 'STOCK_WRITEOFF'
  const wantOthers = !kindFilter
  const genericKind = kindFilter && kindFilter !== 'STOCK_WRITEOFF' ? { kind: kindFilter as never } : {}

  const byRequester = filters.requestedById ? { requestedById: filters.requestedById } : {}
  const fromBranch = filters.fromBranchId ? { branchId: filters.fromBranchId } : {}
  // Only a transfer has a destination; a To filter excludes everything else.
  const toBranch: Prisma.ApprovalRequestWhereInput = filters.toBranchId
    ? { kind: 'STOCK_TRANSFER', payload: { path: ['toBranchId'], equals: filters.toBranchId } }
    : {}

  const [generic, outgoing, petty, counts, purchases, wastage] = await Promise.all([
    wantGeneric
      ? prisma.approvalRequest.findMany({
          where: {
            restaurantId,
            status: 'PENDING',
            ...genericKind,
            ...byRequester,
            AND: [atBranchOrGlobal, fromBranch, toBranch],
          },
          select: {
            id: true, kind: true, amount: true, reason: true, createdAt: true,
            entity: true, entityId: true, branchId: true, payload: true,
            branch: { select: { name: true } },
            requestedById: true,
            requestedBy: { select: { name: true } },
          },
          orderBy: { createdAt: 'asc' },
          take: 100,
        })
      : Promise.resolve([]),
    wantOthers && !filters.toBranchId
      ? prisma.outgoingPayment.findMany({
          where: {
            restaurantId, status: 'SUBMITTED', ...atBranch, ...fromBranch,
            ...(filters.requestedById ? { submittedById: filters.requestedById } : {}),
          },
          select: {
            id: true, number: true, amount: true, description: true,
            submittedAt: true, createdAt: true, createdByName: true,
            branchId: true, branch: { select: { name: true } }, submittedById: true,
          },
          orderBy: { createdAt: 'asc' },
          take: 100,
        })
      : Promise.resolve([]),
    wantOthers && !filters.toBranchId
      ? prisma.pettyCashRequest.findMany({
          where: { restaurantId, status: 'PENDING', ...atBranch, ...fromBranch, ...byRequester },
          select: {
            id: true, amount: true, description: true, requestedAt: true,
            branchId: true, branch: { select: { name: true } }, requestedById: true,
            requestedBy: { select: { name: true } },
          },
          orderBy: { requestedAt: 'asc' },
          take: 100,
        })
      : Promise.resolve([]),
    wantOthers && !filters.toBranchId
      ? prisma.stockCount.findMany({
          where: {
            restaurantId, status: 'AWAITING_APPROVAL', ...atBranch, ...fromBranch,
            ...(filters.requestedById ? { countedById: filters.requestedById } : {}),
          },
          select: {
            id: true, reference: true, createdAt: true, branchId: true,
            branch: { select: { name: true } }, countedById: true,
            countedBy: { select: { name: true } },
          },
          orderBy: { createdAt: 'asc' },
          take: 100,
        })
      : Promise.resolve([]),
    wantOthers && !filters.toBranchId
      ? prisma.purchase.findMany({
          where: {
            restaurantId, status: 'PENDING_APPROVAL', ...atBranch, ...fromBranch,
            ...(filters.requestedById ? { createdById: filters.requestedById } : {}),
          },
          select: {
            id: true, number: true, total: true, createdAt: true,
            branchId: true, branch: { select: { name: true } }, createdById: true,
            supplier: { select: { name: true } },
          },
          orderBy: { createdAt: 'asc' },
          take: 100,
        })
      : Promise.resolve([]),
    /*
     * Write-offs (recorrection.md §1's "Stock Write-off Requests").
     *
     * Wastage has always had its own review — `WastageRecord.status`,
     * `INVENTORY_WASTAGE_APPROVE`, `/dashboard/inventory/wastage` — and was
     * invisible here, so a desk that claimed to hold every decision held all
     * but one. RECORDED is the state waiting on somebody: the stock is already
     * gone and approval is a review, not a gate, which the consequence says.
     */
    wantWastage && !filters.toBranchId
      ? prisma.wastageRecord.findMany({
          where: {
            restaurantId, status: 'RECORDED', ...atBranch, ...fromBranch,
            ...(filters.requestedById ? { createdById: filters.requestedById } : {}),
          },
          select: {
            id: true, quantity: true, enteredUnit: true, costValue: true,
            reason: true, reasonNote: true, createdAt: true,
            branchId: true, branch: { select: { name: true } },
            createdById: true, createdBy: { select: { name: true } },
            item: { select: { name: true, unit: true } },
          },
          orderBy: { createdAt: 'asc' },
          take: 100,
        })
      : Promise.resolve([]),
  ])

  /*
   * The transfers behind the transfer requests, in one query. The request
   * carries a line COUNT (`payload.lines`), and a desk that shows "3 items"
   * where the spec asks for "Chicken · 20 KG" is a desk that sends people to
   * another tab to find out what they are signing.
   */
  const transferIds = generic
    .filter((row) => row.kind === 'STOCK_TRANSFER' && row.entityId)
    .map((row) => row.entityId!)
  const transfers = transferIds.length
    ? await prisma.stockTransfer.findMany({
        where: { id: { in: transferIds }, restaurantId },
        select: {
          id: true, number: true, toBranchId: true,
          fromBranch: { select: { name: true } },
          toBranch: { select: { name: true } },
          lines: { select: { requestedQty: true, item: { select: { name: true, unit: true } } } },
        },
      })
    : []
  const transferById = new Map(transfers.map((t) => [t.id, t]))

  const items: InboxItem[] = [
    ...outgoing.map((row) => ({
      category: 'Money out' as const,
      queue: 'Payment out',
      kind: 'OUTGOING_PAYMENT' as const,
      approvalKind: null,
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
      transfer: null,
    })),
    ...generic.map((row) => {
      const transfer = row.entityId ? transferById.get(row.entityId) : undefined
      const fromName = transfer?.fromBranch.name ?? row.branch?.name ?? 'the source'
      return {
        category: categoryFor(row.kind),
        queue: KIND_TITLES[row.kind] ?? 'Approval',
        id: row.id,
        kind: 'APPROVAL_REQUEST' as const,
        approvalKind: row.kind,
        title: KIND_TITLES[row.kind] ?? 'Approval',
        reason: row.reason,
        amount: row.amount,
        branchId: row.branchId,
        branchName: row.branch?.name ?? null,
        requestedByName: row.requestedBy?.name ?? 'Someone',
        requestedById: row.requestedById,
        requestedAt: row.createdAt,
        // The document's own number where it has one, not an id slice.
        reference: transfer?.number ?? (row.entityId ? `${row.entity} ${row.entityId.slice(0, 8)}` : row.entity),
        /*
         * Said accurately. This read "Approving dispatches the transfer",
         * and it does not: approving reserves the stock at the source, and
         * the source dispatches it as a separate step, by hand, when the van
         * is there. An approver who believed the first sentence would go
         * looking for stock that had not moved.
         */
        consequence:
          row.kind === 'STOCK_TRANSFER'
            ? `Approving reserves the stock at ${fromName}; ${fromName} then dispatches it.`
            : 'Records the decision — the person who asked still has to carry it out.',
        decidable: true,
        href:
          row.kind === 'STOCK_TRANSFER' && row.entityId
            ? `/dashboard/transfers/${row.entityId}`
            : '/dashboard/approvals',
        transfer: transfer
          ? {
              number: transfer.number,
              fromBranchName: transfer.fromBranch.name,
              toBranchId: transfer.toBranchId,
              toBranchName: transfer.toBranch.name,
              lines: transfer.lines.map((line) => ({
                name: line.item.name,
                unit: line.item.unit,
                quantity: line.requestedQty,
              })),
            }
          : null,
      }
    }),
    ...petty.map((row) => ({
      category: 'Money out' as const,
      queue: 'Petty cash',
      id: row.id,
      kind: 'PETTY_CASH' as const,
      approvalKind: null,
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
      transfer: null,
    })),
    ...wastage.map((row) => ({
      category: 'Stock write-offs' as const,
      queue: 'Write-off',
      id: row.id,
      kind: 'WASTAGE' as const,
      approvalKind: null,
      title: `${row.item.name} · ${row.quantity} ${(row.enteredUnit ?? row.item.unit).toLowerCase()}`,
      reason: row.reasonNote ?? row.reason.replace(/_/g, ' ').toLowerCase(),
      amount: row.costValue,
      branchId: row.branchId,
      branchName: row.branch?.name ?? null,
      requestedByName: row.createdBy?.name ?? 'Someone',
      requestedById: row.createdById,
      requestedAt: row.createdAt,
      reference: null,
      // Honest about the order of events: the shelf is already lighter.
      consequence: 'The stock is already written off. Approving confirms the reason; rejecting flags it for a manager.',
      decidable: true,
      href: '/dashboard/inventory/wastage',
      transfer: null,
    })),
    ...purchases.map((row) => ({
      category: 'Other' as const,
      queue: 'Purchase order',
      id: row.id,
      kind: 'PURCHASE' as const,
      approvalKind: null,
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
      transfer: null,
    })),
    ...counts.map((row) => ({
      category: 'Stock adjustments' as const,
      queue: 'Stock count',
      id: row.id,
      kind: 'STOCK_COUNT' as const,
      approvalKind: null,
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
      transfer: null,
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

  const [generic, genericAmount, outgoing, petty, counts, purchases, wastage] = await Promise.all([
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
    prisma.wastageRecord.count({
      where: { restaurantId, status: 'RECORDED', ...atBranch },
    }),
  ])

  const byQueue = [
    { queue: 'Payments out', count: outgoing._count },
    { queue: 'Refunds, discounts & transfers', count: generic },
    { queue: 'Petty cash', count: petty._count },
    { queue: 'Stock counts', count: counts },
    { queue: 'Purchase orders', count: purchases },
    { queue: 'Write-offs', count: wastage },
  ].filter((row) => row.count > 0)

  return {
    count: generic + outgoing._count + petty._count + counts + purchases + wastage,
    amount:
      (genericAmount._sum.amount ?? 0) +
      (outgoing._sum.amount ?? 0) +
      (petty._sum.amount ?? 0),
    byQueue,
  }
}
