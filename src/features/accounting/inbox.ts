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

/**
 * What KIND of thing is being asked for, in the four words an owner uses.
 *
 * ── Why a second axis on top of `category` ─────────────────────────────────
 *
 * `category` is a reading order inside one long list — seven headings on one
 * page. That was too fine to navigate: somebody who came to clear the money
 * had to scroll past transfers and write-offs to find it, and somebody
 * looking for what happened to a request yesterday had nowhere to look at
 * all. These four are the tabs of the desk, and every queue lands in exactly
 * one of them.
 *
 * Deliberately four and not six: "money" is one job whether it is a payment
 * out, petty cash, a refund or a discount — the question is always whether
 * the business is right to part with it — and `category` still separates
 * them within the tab.
 */
export const REQUEST_TYPES = ['TRANSFER', 'MONEY', 'PURCHASE', 'OTHER'] as const
export type RequestType = (typeof REQUEST_TYPES)[number]

export const REQUEST_TYPE_LABELS: Record<RequestType, string> = {
  TRANSFER: 'Stock transfer requests',
  MONEY: 'Money requests',
  PURCHASE: 'PO requests',
  OTHER: 'Other requests',
}

export const REQUEST_TYPE_HINTS: Record<RequestType, string> = {
  TRANSFER: 'Stock moving between locations. The source approves; approving reserves it, dispatch moves it.',
  MONEY: 'Payments out, petty cash, refunds and discounts. Whoever asked cannot approve it.',
  PURCHASE: 'Buying from a supplier. Approving turns the request into the order goods can be received against.',
  OTHER: 'Stock counts, corrections and write-offs — anything that changes what the books say is on the shelf.',
}

/** Which tab a generic `ApprovalKind` belongs to. */
export function typeForApprovalKind(kind: string): RequestType {
  if (kind === 'STOCK_TRANSFER') return 'TRANSFER'
  if (kind === 'PURCHASE_ORDER') return 'PURCHASE'
  if (kind === 'REFUND' || kind === 'DISCOUNT' || kind === 'PRICE_OVERRIDE') return 'MONEY'
  return 'OTHER'
}

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
  /** Which tab of the desk this belongs to. */
  type: RequestType
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
    lines: Array<{
      /** Needed to send an adjusted quantity back for this exact line. */
      id: string
      itemId: string
      name: string
      unit: string
      quantity: number
      /**
       * Free stock at the SOURCE right now, in base units.
       *
       * The approver's whole question is "can we actually send this", and it
       * was not on the screen — they had to open Inventory in another tab and
       * come back. Free, not total: stock already reserved for another
       * approved transfer is spoken for.
       */
      available: number
    }>
  } | null
}

/**
 * How the desk is narrowed (recorrection.md §1). The same shape the decided
 * list takes, so one set of controls governs both.
 */
export interface InboxFilters {
  /** Only this tab's queues are read. Unset reads them all. */
  type?: RequestType
  /** Anything other than PENDING (or unset) empties the pending desk by definition. */
  status?: string
  /** An `ApprovalKind`, or `STOCK_WRITEOFF` for the wastage queue. */
  kind?: string
  requestedById?: string
  fromBranchId?: string
  toBranchId?: string
  /** When it was raised — inclusive bounds, already at day start / day end. */
  from?: Date
  to?: Date
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
  /*
   * The tab narrows which queues are read at all — four of the six vanish on
   * the transfers tab, so the desk costs two queries instead of six. `inType`
   * is asked before every one of them.
   */
  const inType = (type: RequestType) => !filters.type || filters.type === type
  const wantGeneric = (!kindFilter || kindFilter !== 'STOCK_WRITEOFF')
  const wantWastage = (!kindFilter || kindFilter === 'STOCK_WRITEOFF') && inType('OTHER')
  const wantOthers = !kindFilter
  const genericKind = kindFilter && kindFilter !== 'STOCK_WRITEOFF' ? { kind: kindFilter as never } : {}

  const byRequester = filters.requestedById ? { requestedById: filters.requestedById } : {}
  // The same window on every queue, on the field that means "raised at".
  const raised = (field: string) =>
    filters.from || filters.to
      ? { [field]: { ...(filters.from ? { gte: filters.from } : {}), ...(filters.to ? { lte: filters.to } : {}) } }
      : {}
  const fromBranch = filters.fromBranchId ? { branchId: filters.fromBranchId } : {}
  // Only a transfer has a destination; a To filter excludes everything else.
  const toBranch: Prisma.ApprovalRequestWhereInput = filters.toBranchId
    ? { kind: 'STOCK_TRANSFER', payload: { path: ['toBranchId'], equals: filters.toBranchId } }
    : {}

  /** The generic queue's kinds that belong to the chosen tab. */
  const typeKinds: Record<RequestType, string[]> = {
    TRANSFER: ['STOCK_TRANSFER'],
    MONEY: ['REFUND', 'DISCOUNT', 'PRICE_OVERRIDE'],
    PURCHASE: ['PURCHASE_ORDER'],
    OTHER: ['STOCK_ADJUSTMENT'],
  }
  const genericTypeKinds = filters.type ? { kind: { in: typeKinds[filters.type] as never[] } } : {}

  const [generic, outgoing, petty, counts, purchases, wastage] = await Promise.all([
    wantGeneric
      ? prisma.approvalRequest.findMany({
          where: {
            restaurantId,
            status: 'PENDING',
            ...genericTypeKinds,
            ...genericKind,
            ...byRequester,
            ...raised('createdAt'),
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
    wantOthers && !filters.toBranchId && inType('MONEY')
      ? prisma.outgoingPayment.findMany({
          where: {
            restaurantId, status: 'SUBMITTED', ...atBranch, ...fromBranch, ...raised('createdAt'),
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
    wantOthers && !filters.toBranchId && inType('MONEY')
      ? prisma.pettyCashRequest.findMany({
          where: { restaurantId, status: 'PENDING', ...atBranch, ...fromBranch, ...byRequester, ...raised('requestedAt') },
          select: {
            id: true, amount: true, description: true, requestedAt: true,
            branchId: true, branch: { select: { name: true } }, requestedById: true,
            requestedBy: { select: { name: true } },
          },
          orderBy: { requestedAt: 'asc' },
          take: 100,
        })
      : Promise.resolve([]),
    wantOthers && !filters.toBranchId && inType('OTHER')
      ? prisma.stockCount.findMany({
          where: {
            restaurantId, status: 'AWAITING_APPROVAL', ...atBranch, ...fromBranch, ...raised('createdAt'),
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
    /*
     * Purchase orders waiting with NO approval request of their own.
     *
     * Submitting a request now raises an `ApprovalRequest` of kind
     * PURCHASE_ORDER as well as setting the order's status, so an order that
     * went through that path is already in `generic` above — and listing it
     * here too put it on the desk twice, with two sets of buttons for one
     * decision. The `none` clause keeps this query for what it is now for:
     * orders submitted before that existed, which have a status and no
     * request, and would otherwise be stranded off the desk entirely.
     */
    wantOthers && !filters.toBranchId && inType('PURCHASE')
      ? prisma.purchase.findMany({
          where: {
            restaurantId, status: 'PENDING_APPROVAL', ...atBranch, ...fromBranch, ...raised('createdAt'),
            ...(filters.requestedById ? { createdById: filters.requestedById } : {}),
            NOT: {
              id: {
                in: (
                  await prisma.approvalRequest.findMany({
                    where: { restaurantId, kind: 'PURCHASE_ORDER', status: 'PENDING', entity: 'Purchase' },
                    select: { entityId: true },
                  })
                )
                  .map((row) => row.entityId)
                  .filter((id): id is string => Boolean(id)),
              },
            },
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
            restaurantId, status: 'RECORDED', ...atBranch, ...fromBranch, ...raised('createdAt'),
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
          id: true, number: true, toBranchId: true, fromBranchId: true, fromStorageId: true,
          fromBranch: { select: { name: true } },
          toBranch: { select: { name: true } },
          lines: {
            select: {
              id: true,
              requestedQty: true,
              itemId: true,
              item: { select: { name: true, unit: true } },
            },
          },
        },
      })
    : []
  const transferById = new Map(transfers.map((t) => [t.id, t]))

  /*
   * What the source actually has, per item and location.
   *
   * One read for every line on every pending transfer, rather than one per
   * line: the desk shows a page of requests and a query inside the map would
   * be an N+1 on the screen somebody opens most often.
   */
  const stockKeys = transfers.flatMap((t) =>
    t.lines.map((line) => ({ itemId: line.itemId, branchId: t.fromBranchId })),
  )
  const stockRows = stockKeys.length
    ? await prisma.inventoryStock.findMany({
        where: {
          restaurantId,
          itemId: { in: [...new Set(stockKeys.map((k) => k.itemId))] },
          branchId: { in: [...new Set(stockKeys.map((k) => k.branchId))] },
        },
        select: { itemId: true, branchId: true, available: true, reserved: true },
      })
    : []
  const freeStock = new Map<string, number>()
  for (const row of stockRows) {
    const key = `${row.branchId}:${row.itemId}`
    // Already-reserved stock is spoken for by another approved transfer.
    freeStock.set(key, (freeStock.get(key) ?? 0) + Math.max(0, row.available - row.reserved))
  }

  const items: InboxItem[] = [
    ...outgoing.map((row) => ({
      type: 'MONEY' as const,
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
        type: typeForApprovalKind(row.kind),
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
                id: line.id,
                itemId: line.itemId,
                name: line.item.name,
                unit: line.item.unit,
                quantity: line.requestedQty,
                available: freeStock.get(`${transfer.fromBranchId}:${line.itemId}`) ?? 0,
              })),
            }
          : null,
      }
    }),
    ...petty.map((row) => ({
      type: 'MONEY' as const,
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
      type: 'OTHER' as const,
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
      type: 'PURCHASE' as const,
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
      type: 'OTHER' as const,
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

/**
 * What was already decided — the Record half of each tab.
 *
 * ── Why this exists beside `listApprovals` ─────────────────────────────────
 *
 * The desk's history used to read `ApprovalRequest` and nothing else, so it
 * answered for refunds, discounts and transfers and was silent about the four
 * queues that keep their decision on the record itself: a paid-out petty cash
 * request, an approved write-off, a posted stock count, a payment released.
 * Somebody asking "what happened to the money I asked for on Tuesday" was
 * told nothing, on a screen whose whole job is to answer that.
 *
 * So this reads the same six queues the pending desk reads, in their decided
 * states, and returns one shape. It is the counterpart of `getApprovalsInbox`
 * and deliberately has the same narrowing: the tab decides which queues are
 * touched at all.
 *
 * Read-only by construction — there is nothing to decide about a decision.
 */
export interface RecordItem {
  type: RequestType
  queue: string
  id: string
  title: string
  reason: string | null
  amount: number | null
  branchName: string | null
  requestedByName: string
  requestedAt: Date
  decidedByName: string | null
  decidedAt: Date | null
  /** APPROVED, REJECTED, RETURNED, CANCELLED or WITHDRAWN. */
  outcome: string
  decisionNote: string | null
  /** The two-person rule was overridden to decide it (correctionA.md §9). */
  forced: boolean
  reference: string | null
  href: string
}

export async function getApprovalsRecord(
  restaurantId: string,
  branchIds?: string[] | null,
  filters: InboxFilters = {},
): Promise<RecordItem[]> {
  const reach = branchIds ?? null
  const atBranch = reach ? { branchId: { in: reach } } : {}
  const atBranchOrGlobal: Prisma.ApprovalRequestWhereInput = reach
    ? { OR: [{ branchId: { in: reach } }, { branchId: null }] }
    : {}
  const inType = (type: RequestType) => !filters.type || filters.type === type
  const byRequester = filters.requestedById ? { requestedById: filters.requestedById } : {}
  const decidedIn = (field: string) =>
    filters.from || filters.to
      ? { [field]: { ...(filters.from ? { gte: filters.from } : {}), ...(filters.to ? { lte: filters.to } : {}) } }
      : {}

  const typeKinds: Record<RequestType, string[]> = {
    TRANSFER: ['STOCK_TRANSFER'],
    MONEY: ['REFUND', 'DISCOUNT', 'PRICE_OVERRIDE'],
    PURCHASE: ['PURCHASE_ORDER'],
    OTHER: ['STOCK_ADJUSTMENT'],
  }
  const genericKinds = filters.type
    ? { kind: { in: typeKinds[filters.type] as never[] } }
    : filters.kind && filters.kind !== 'STOCK_WRITEOFF'
      ? { kind: filters.kind as never }
      : {}
  // A status filter narrows the outcome; unset means every decided state.
  const outcomes = filters.status && filters.status !== 'PENDING' ? [filters.status] : ['APPROVED', 'REJECTED', 'WITHDRAWN']
  const wantGeneric = filters.kind !== 'STOCK_WRITEOFF'
  const wantOthers = !filters.kind

  /* Purchases decided through the desk already have a request row above. */
  const viaDesk = inType('PURCHASE')
    ? (
        await prisma.approvalRequest.findMany({
          where: { restaurantId, kind: 'PURCHASE_ORDER', entity: 'Purchase' },
          select: { entityId: true },
        })
      )
        .map((row) => row.entityId)
        .filter((id): id is string => Boolean(id))
    : []

  const [generic, outgoing, petty, wastage, counts, purchases] = await Promise.all([
    wantGeneric
      ? prisma.approvalRequest.findMany({
          where: {
            restaurantId,
            status: { in: outcomes as never[] },
            ...genericKinds,
            ...byRequester,
            ...decidedIn('decidedAt'),
            AND: [atBranchOrGlobal],
          },
          select: {
            id: true, kind: true, amount: true, reason: true, requestedAt: true, status: true,
            entity: true, entityId: true, decidedAt: true, decisionNote: true, forcedAt: true,
            branch: { select: { name: true } },
            requestedBy: { select: { name: true } },
            decidedBy: { select: { name: true } },
          },
          orderBy: { decidedAt: 'desc' },
          take: 60,
        })
      : Promise.resolve([]),
    wantOthers && inType('MONEY')
      ? prisma.outgoingPayment.findMany({
          where: {
            restaurantId, status: { in: ['APPROVED', 'REJECTED', 'PAID', 'REVERSED'] },
            ...atBranch, ...decidedIn('decidedAt'),
          },
          select: {
            id: true, number: true, amount: true, description: true, status: true,
            createdByName: true, submittedAt: true, createdAt: true, decidedAt: true,
            decisionNote: true, branch: { select: { name: true } },
            decidedBy: { select: { name: true } },
          },
          orderBy: { decidedAt: 'desc' },
          take: 60,
        })
      : Promise.resolve([]),
    wantOthers && inType('MONEY')
      ? prisma.pettyCashRequest.findMany({
          where: {
            restaurantId, status: { in: ['APPROVED', 'PAID', 'REJECTED'] },
            ...atBranch, ...byRequester, ...decidedIn('decidedAt'),
          },
          select: {
            id: true, amount: true, description: true, status: true, requestedAt: true,
            decidedAt: true, decisionNote: true, branch: { select: { name: true } },
            requestedBy: { select: { name: true } }, decidedBy: { select: { name: true } },
          },
          orderBy: { decidedAt: 'desc' },
          take: 60,
        })
      : Promise.resolve([]),
    wantOthers && inType('OTHER')
      ? prisma.wastageRecord.findMany({
          where: {
            restaurantId, status: { in: ['APPROVED', 'REJECTED'] },
            ...atBranch, ...decidedIn('approvedAt'),
          },
          select: {
            id: true, quantity: true, enteredUnit: true, costValue: true, status: true,
            reason: true, reasonNote: true, createdAt: true, approvedAt: true,
            branch: { select: { name: true } }, createdBy: { select: { name: true } },
            approvedBy: { select: { name: true } }, item: { select: { name: true, unit: true } },
          },
          orderBy: { approvedAt: 'desc' },
          take: 60,
        })
      : Promise.resolve([]),
    wantOthers && inType('OTHER')
      ? prisma.stockCount.findMany({
          where: {
            restaurantId, status: { in: ['APPROVED', 'CANCELLED'] },
            ...atBranch, ...decidedIn('approvedAt'),
          },
          select: {
            id: true, reference: true, status: true, createdAt: true, approvedAt: true,
            branch: { select: { name: true } }, countedBy: { select: { name: true } },
            approvedBy: { select: { name: true } },
          },
          orderBy: { approvedAt: 'desc' },
          take: 60,
        })
      : Promise.resolve([]),
    wantOthers && inType('PURCHASE')
      ? prisma.purchase.findMany({
          where: {
            restaurantId,
            status: { in: ['APPROVED', 'REJECTED', 'RETURNED', 'ORDERED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED', 'CANCELLED'] },
            ...atBranch, ...decidedIn('approvedAt'),
            ...(viaDesk.length ? { NOT: { id: { in: viaDesk } } } : {}),
          },
          select: {
            id: true, number: true, total: true, status: true, createdAt: true,
            approvedAt: true, decisionNote: true, cancelReason: true,
            branch: { select: { name: true } }, createdBy: { select: { name: true } },
            approvedBy: { select: { name: true } }, supplier: { select: { name: true } },
          },
          orderBy: { createdAt: 'desc' },
          take: 60,
        })
      : Promise.resolve([]),
  ])

  const items: RecordItem[] = [
    ...generic.map((row) => ({
      type: typeForApprovalKind(row.kind),
      queue: KIND_TITLES[row.kind] ?? 'Approval',
      id: row.id,
      title: KIND_TITLES[row.kind] ?? 'Approval',
      reason: row.reason,
      amount: row.amount,
      branchName: row.branch?.name ?? null,
      requestedByName: row.requestedBy?.name ?? 'Someone',
      requestedAt: row.requestedAt,
      decidedByName: row.decidedBy?.name ?? null,
      decidedAt: row.decidedAt,
      outcome: row.status as string,
      decisionNote: row.decisionNote,
      forced: row.forcedAt !== null,
      reference: row.entityId ? `${row.entity} ${row.entityId.slice(0, 8)}` : row.entity,
      href:
        row.kind === 'STOCK_TRANSFER' && row.entityId
          ? `/dashboard/transfers/${row.entityId}`
          : row.kind === 'PURCHASE_ORDER' && row.entityId
            ? `/dashboard/purchases/${row.entityId}`
            : '/dashboard/approvals',
    })),
    ...outgoing.map((row) => ({
      type: 'MONEY' as const,
      queue: 'Payment out',
      id: row.id,
      title: row.description,
      reason: null,
      amount: row.amount,
      branchName: row.branch?.name ?? null,
      requestedByName: row.createdByName,
      requestedAt: row.submittedAt ?? row.createdAt,
      decidedByName: row.decidedBy?.name ?? null,
      decidedAt: row.decidedAt,
      outcome: row.status as string,
      decisionNote: row.decisionNote,
      forced: false,
      reference: row.number,
      href: '/dashboard/accounting/payments',
    })),
    ...petty.map((row) => ({
      type: 'MONEY' as const,
      queue: 'Petty cash',
      id: row.id,
      title: row.description,
      reason: null,
      amount: row.amount,
      branchName: row.branch?.name ?? null,
      requestedByName: row.requestedBy?.name ?? 'Someone',
      requestedAt: row.requestedAt,
      decidedByName: row.decidedBy?.name ?? null,
      decidedAt: row.decidedAt,
      outcome: row.status as string,
      decisionNote: row.decisionNote,
      forced: false,
      reference: null,
      href: '/dashboard/petty-cash',
    })),
    ...wastage.map((row) => ({
      type: 'OTHER' as const,
      queue: 'Write-off',
      id: row.id,
      title: `${row.item.name} · ${row.quantity} ${(row.enteredUnit ?? row.item.unit).toLowerCase()}`,
      reason: row.reasonNote ?? row.reason.replace(/_/g, ' ').toLowerCase(),
      amount: row.costValue,
      branchName: row.branch?.name ?? null,
      requestedByName: row.createdBy?.name ?? 'Someone',
      requestedAt: row.createdAt,
      decidedByName: row.approvedBy?.name ?? null,
      decidedAt: row.approvedAt,
      outcome: row.status as string,
      decisionNote: null,
      forced: false,
      reference: null,
      href: '/dashboard/inventory/wastage',
    })),
    ...counts.map((row) => ({
      type: 'OTHER' as const,
      queue: 'Stock count',
      id: row.id,
      title: `Stock count ${row.reference}`,
      reason: null,
      amount: null,
      branchName: row.branch?.name ?? null,
      requestedByName: row.countedBy?.name ?? 'Someone',
      requestedAt: row.createdAt,
      decidedByName: row.approvedBy?.name ?? null,
      decidedAt: row.approvedAt,
      outcome: row.status as string,
      decisionNote: null,
      forced: false,
      reference: row.reference,
      href: `/dashboard/inventory/counts/${row.id}`,
    })),
    ...purchases.map((row) => ({
      type: 'PURCHASE' as const,
      queue: 'Purchase order',
      id: row.id,
      title: `Order from ${row.supplier?.name ?? 'a supplier'}`,
      reason: null,
      amount: row.total,
      branchName: row.branch?.name ?? null,
      requestedByName: row.createdBy?.name ?? 'Purchasing',
      requestedAt: row.createdAt,
      decidedByName: row.approvedBy?.name ?? null,
      decidedAt: row.approvedAt,
      outcome: row.status as string,
      decisionNote: row.decisionNote ?? row.cancelReason,
      forced: false,
      reference: row.number,
      href: `/dashboard/purchases/${row.id}`,
    })),
  ]

  // Newest decision first; a row with no decision stamp falls back to when it
  // was raised, so nothing sinks to the bottom for want of a timestamp.
  return items.sort(
    (a, b) =>
      (b.decidedAt ?? b.requestedAt).getTime() - (a.decidedAt ?? a.requestedAt).getTime(),
  )
}

/**
 * How many are waiting in each tab, for the badges on the tab strip.
 *
 * Counts rather than rows: the desk shows one tab's rows and four tabs'
 * numbers, and fetching four lists to display three numbers is how a screen
 * that opens on every page load gets slow. Same predicates as the inbox
 * above, so a badge and its tab can never disagree.
 */
export async function getPendingCountsByType(
  restaurantId: string,
  branchIds?: string[] | null,
): Promise<Record<RequestType, number>> {
  const reach = branchIds ?? null
  const atBranch = reach ? { branchId: { in: reach } } : {}
  const atBranchOrGlobal: Prisma.ApprovalRequestWhereInput = reach
    ? {
        OR: [
          { branchId: { in: reach } },
          { branchId: null },
          ...reach.map((id) => ({
            kind: 'STOCK_TRANSFER' as const,
            payload: { path: ['toBranchId'], equals: id },
          })),
        ],
      }
    : {}

  const generic = (kinds: string[]) =>
    prisma.approvalRequest.count({
      where: { restaurantId, status: 'PENDING', kind: { in: kinds as never[] }, AND: [atBranchOrGlobal] },
    })

  const [transfers, money, poRequests, adjustments, outgoing, petty, counts, wastage, orphanPos] =
    await Promise.all([
      generic(['STOCK_TRANSFER']),
      generic(['REFUND', 'DISCOUNT', 'PRICE_OVERRIDE']),
      generic(['PURCHASE_ORDER']),
      generic(['STOCK_ADJUSTMENT']),
      prisma.outgoingPayment.count({ where: { restaurantId, status: 'SUBMITTED', ...atBranch } }),
      prisma.pettyCashRequest.count({ where: { restaurantId, status: 'PENDING', ...atBranch } }),
      prisma.stockCount.count({ where: { restaurantId, status: 'AWAITING_APPROVAL', ...atBranch } }),
      prisma.wastageRecord.count({ where: { restaurantId, status: 'RECORDED', ...atBranch } }),
      // Orders submitted before they raised a request of their own; the same
      // exclusion the inbox applies, so nothing is counted twice.
      prisma.purchase.count({
        where: {
          restaurantId,
          status: 'PENDING_APPROVAL',
          ...atBranch,
          NOT: {
            id: {
              in: (
                await prisma.approvalRequest.findMany({
                  where: { restaurantId, kind: 'PURCHASE_ORDER', status: 'PENDING', entity: 'Purchase' },
                  select: { entityId: true },
                })
              )
                .map((row) => row.entityId)
                .filter((id): id is string => Boolean(id)),
            },
          },
        },
      }),
    ])

  return {
    TRANSFER: transfers,
    MONEY: money + outgoing + petty,
    PURCHASE: poRequests + orphanPos,
    OTHER: adjustments + counts + wastage,
  }
}
