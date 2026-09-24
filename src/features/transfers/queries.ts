import 'server-only'

import type { LocationType, Prisma } from '@prisma/client'

import { NotFoundError } from '@/lib/errors'
import { parseOpeningHours } from '@/lib/opening-hours'
import { prisma } from '@/server/db/prisma'
import { levelFor } from '@/features/inventory/alerts'
import { roundQty } from '@/lib/quantity'

export interface LocationSummary {
  id: string
  name: string
  code: string
  type: LocationType
  isActive: boolean
  isDefault: boolean
  itemsHeld: number
  stockValue: number
  lowStock: number
  outOfStock: number
  inTransitLines: number
  /*
   * Who runs it and how many people work there.
   *
   * `isDefault` was already fetched and never rendered, and the manager — a
   * cheap join on one indexed column — was not fetched at all, so the card told
   * you what a location HELD and nothing about who was answerable for it.
   */
  managerId: string | null
  managerName: string | null
  staffCount: number
  address: string | null
  phone: string | null
}

/**
 * Every location with the figures its card needs.
 *
 * Stock value ignores negative balances — a negative quantity is a bookkeeping
 * problem, not a negative asset, and letting it subtract would understate what
 * the restaurant actually holds.
 */
/**
 * Every location, for the locations screen.
 *
 * `branchIds` narrows it to what the viewer may see. It had no such parameter,
 * and `BRANCH_VIEW` is held by cashiers, warehouse staff and site-confined
 * managers — so anyone could read every branch's name, stock value, staff count
 * and low-stock position from `/dashboard/locations`. The detail page one click
 * away was guarded; the list was not.
 */
export async function listLocations(
  restaurantId: string,
  branchIds?: string[] | null,
): Promise<LocationSummary[]> {
  const branches = await prisma.branch.findMany({
    where: {
      restaurantId,
      deletedAt: null,
      ...(branchIds ? { id: { in: branchIds } } : {}),
    },
    orderBy: [{ type: 'asc' }, { name: 'asc' }],
    include: {
      manager: { select: { id: true, name: true } },
      _count: { select: { users: { where: { deletedAt: null, isActive: true } } } },
      stock: {
        include: {
          item: {
            select: {
              costPerUnit: true, reorderLevel: true, minStock: true, maxStock: true,
            },
          },
        },
      },
    },
  })

  /*
   * What each location's stock is worth: the sum of its layers (FIFO.md).
   *
   * It was `available × item.costPerUnit` — a per-branch quantity multiplied
   * by a RESTAURANT-WIDE rate, so two branches holding the same item bought at
   * genuinely different prices were both reported at the blend of the two.
   * Layers carry their own branch, so this is exact per location and it is an
   * integer sum with no multiplication in it.
   */
  const layerValue = await prisma.stockBatch.groupBy({
    by: ['branchId'],
    where: { restaurantId, remainingQty: { gt: 0 }, ...(branchIds ? { branchId: { in: branchIds } } : {}) },
    _sum: { remainingValue: true },
  })
  const valueAt = new Map(layerValue.map((row) => [row.branchId, row._sum.remainingValue ?? 0]))

  return branches.map((b) => {
    const stockValue = valueAt.get(b.id) ?? 0
    let lowStock = 0
    let outOfStock = 0
    let inTransitLines = 0

    for (const row of b.stock) {
      if (row.inTransit > 0) inTransitLines += 1
      const level = levelFor({
        quantity: row.available,
        reorderLevel: row.item.reorderLevel,
        minStock: row.item.minStock,
        maxStock: row.item.maxStock,
      })
      if (level === 'OUT_OF_STOCK') outOfStock += 1
      else if (level === 'LOW_STOCK') lowStock += 1
    }

    return {
      id: b.id,
      name: b.name,
      code: b.code,
      type: b.type,
      isActive: b.isActive,
      isDefault: b.isDefault,
      itemsHeld: b.stock.filter((s) => s.available !== 0).length,
      stockValue: Math.round(stockValue),
      lowStock,
      outOfStock,
      inTransitLines,
      managerId: b.manager?.id ?? null,
      managerName: b.manager?.name ?? null,
      staffCount: b._count.users,
      address: b.address,
      phone: b.phone,
    }
  })
}

export interface TransferSummary {
  id: string
  number: string
  status: string
  /**
   * Both ends by id as well as name (recorrection.md §1). The list has to say
   * "waiting on YOU to dispatch" versus "waiting on THEM", and that is a
   * question about which end the viewer stands at — unanswerable from names.
   */
  fromBranchId: string
  toBranchId: string
  fromName: string
  toName: string
  lineCount: number
  /** Σ requested across the lines — the "Total Qty" column. */
  totalQty: number
  requestedAt: string
  requestedByName: string | null
  hasVariance: boolean
}

export async function listTransfers(params: {
  restaurantId: string
  branchId?: string | null
  limit?: number
  /** Transfer number, either location, or an item being moved. */
  search?: string
}): Promise<TransferSummary[]> {
  const term = params.search?.trim()

  const transfers = await prisma.stockTransfer.findMany({
    where: {
      restaurantId: params.restaurantId,
      /*
       * Both conditions are OR groups, so they go in an AND rather than
       * overwriting each other on the same key.
       */
      AND: [
        ...(params.branchId
          ? [{ OR: [{ fromBranchId: params.branchId }, { toBranchId: params.branchId }] }]
          : []),
        ...(term
          ? [
              {
                OR: [
                  { number: { contains: term, mode: 'insensitive' as const } },
                  { notes: { contains: term, mode: 'insensitive' as const } },
                  { fromBranch: { name: { contains: term, mode: 'insensitive' as const } } },
                  { toBranch: { name: { contains: term, mode: 'insensitive' as const } } },
                  { lines: { some: { item: { name: { contains: term, mode: 'insensitive' as const } } } } },
                ],
              },
            ]
          : []),
      ],
    },
    orderBy: { requestedAt: 'desc' },
    take: params.limit ?? 50,
    include: {
      fromBranch: { select: { name: true } },
      toBranch: { select: { name: true } },
      requestedBy: { select: { name: true } },
      lines: { select: { variance: true, requestedQty: true } },
    },
  })

  return transfers.map(toSummary)
}

/** One row of the list, from a transfer with its lines and both branch names. */
function toSummary(t: {
  id: string
  number: string
  status: string
  fromBranchId: string
  toBranchId: string
  fromBranch: { name: string }
  toBranch: { name: string }
  requestedAt: Date
  requestedBy: { name: string } | null
  lines: Array<{ variance: number | null; requestedQty: number }>
}): TransferSummary {
  return {
    id: t.id,
    number: t.number,
    status: t.status,
    fromBranchId: t.fromBranchId,
    toBranchId: t.toBranchId,
    fromName: t.fromBranch.name,
    toName: t.toBranch.name,
    lineCount: t.lines.length,
    totalQty: roundQty(t.lines.reduce((sum, line) => sum + line.requestedQty, 0)),
    requestedAt: t.requestedAt.toISOString(),
    requestedByName: t.requestedBy?.name ?? null,
    hasVariance: t.lines.some((l) => l.variance !== null && Math.abs(l.variance) > 1e-6),
  }
}

/* ── The Transfers screen ─────────────────────────────────────────────────── */

export interface TransferFilter {
  search?: string
  /** Branch ids. Empty means every location this person can already see. */
  fromBranchId?: string | null
  toBranchId?: string | null
  /** A `StockTransferStatus`, or one of the derived buckets below. */
  status?: string | null
  itemId?: string | null
  /** ISO dates, inclusive. */
  from?: string | null
  to?: string | null
  /**
   * The same range, already resolved to instants.
   *
   * `from`/`to` are compared by pasting `T00:00:00.000Z` onto a date, which is
   * midnight in UTC and not midnight anywhere a restaurant actually is. The
   * report is driven entirely by its date range, so it resolves the boundary
   * once in the page through the canonical `resolveRange` and passes the
   * instants here. When these are set they win; the strings stay for the board,
   * whose filters are a rough narrowing rather than an accounting boundary.
   */
  fromAt?: Date | null
  toAt?: Date | null
  page?: number
  perPage?: number
}

export interface TransferStats {
  total: number
  inTransit: number
  pending: number
  received: number
  variance: number
}

export interface TransferBoard {
  rows: TransferSummary[]
  total: number
  page: number
  perPage: number
  pages: number
  stats: TransferStats
}

/**
 * Statuses grouped the way the screen's cards count them.
 *
 * The transfer's own `status` column is untouched — these are read-only
 * groupings over it, so the workflow keeps exactly the states it always had
 * and only the counting is new.
 */
const IN_TRANSIT_STATUSES = ['DISPATCHED', 'IN_TRANSIT'] as const
const PENDING_STATUSES = ['REQUESTED', 'APPROVED'] as const
const DONE_STATUSES = ['RECEIVED', 'COMPLETED'] as const

/** The screen's status filter, including the three grouped ones. */
export function transferStatusWhere(status: string | null | undefined): Prisma.StockTransferWhereInput {
  switch (status) {
    case 'IN_TRANSIT_GROUP':
      return { status: { in: [...IN_TRANSIT_STATUSES] } }
    case 'PENDING_GROUP':
      return { status: { in: [...PENDING_STATUSES] } }
    case 'DONE_GROUP':
      return { status: { in: [...DONE_STATUSES] } }
    case 'VARIANCE':
      return { lines: { some: { variance: { not: null } } } }
    case undefined:
    case null:
    case '':
    case 'ALL':
      return {}
    default:
      return { status: status as Prisma.StockTransferWhereInput['status'] }
  }
}

/**
 * Everything except the status, which is applied separately.
 *
 * Extracted so the board, the report and the export cannot disagree. They used
 * to build their own predicates — which is how the export came to apply no
 * branch filter at all while the screen above its button applied one — and a
 * report whose figures differ from the screen it was launched from is worse
 * than no report.
 *
 * `branchIds` is `visibleBranchIds`: null means every location, `[]` means
 * none, which is a real answer and not a missing one. A transfer is visible
 * from either end, so the reach is an OR over both columns.
 */
export function transferBoardWhere(params: {
  restaurantId: string
  branchIds: string[] | null
  filter: TransferFilter
}): Prisma.StockTransferWhereInput {
  const { filter } = params
  const term = filter.search?.trim()

  const reach: Prisma.StockTransferWhereInput[] =
    params.branchIds === null
      ? []
      : [{ OR: [{ fromBranchId: { in: params.branchIds } }, { toBranchId: { in: params.branchIds } }] }]

  // Resolved instants win over the date strings; see `TransferFilter.fromAt`.
  const gte = filter.fromAt ?? (filter.from ? new Date(`${filter.from}T00:00:00.000Z`) : null)
  const lte = filter.toAt ?? (filter.to ? new Date(`${filter.to}T23:59:59.999Z`) : null)

  return {
    restaurantId: params.restaurantId,
    AND: [
      ...reach,
      ...(filter.fromBranchId ? [{ fromBranchId: filter.fromBranchId }] : []),
      ...(filter.toBranchId ? [{ toBranchId: filter.toBranchId }] : []),
      ...(filter.itemId ? [{ lines: { some: { itemId: filter.itemId } } }] : []),
      ...(gte || lte
        ? [
            {
              requestedAt: {
                ...(gte ? { gte } : {}),
                // Inclusive: a date picked as the end means the whole of it.
                ...(lte ? { lte } : {}),
              },
            },
          ]
        : []),
      ...(term
        ? [
            {
              OR: [
                { number: { contains: term, mode: 'insensitive' as const } },
                { notes: { contains: term, mode: 'insensitive' as const } },
                { fromBranch: { name: { contains: term, mode: 'insensitive' as const } } },
                { toBranch: { name: { contains: term, mode: 'insensitive' as const } } },
                { lines: { some: { item: { name: { contains: term, mode: 'insensitive' as const } } } } },
              ],
            },
          ]
        : []),
    ],
  }
}

/** The same predicate with the status filter folded in. */
function withStatus(
  where: Prisma.StockTransferWhereInput,
  status: string | null | undefined,
): Prisma.StockTransferWhereInput {
  return {
    ...where,
    AND: [...((where.AND as Prisma.StockTransferWhereInput[]) ?? []), transferStatusWhere(status)],
  }
}

/**
 * The Transfers screen: the rows for one page, the count behind them, and the
 * five figures across the top.
 *
 * `visibleBranchIds` is applied first and always, so every figure on the screen
 * counts the same transfers the table can show. A stat card that counted things
 * the person cannot open would be worse than no card.
 */
export async function getTransferBoard(params: {
  restaurantId: string
  /** Null means every location; `[]` means none, which is a real answer. */
  branchIds: string[] | null
  filter: TransferFilter
}): Promise<TransferBoard> {
  const { filter } = params
  const page = Math.max(1, filter.page ?? 1)
  const perPage = Math.min(100, Math.max(5, filter.perPage ?? 10))

  const where = transferBoardWhere(params)

  // The status filter narrows the table but NOT the cards: the cards are what
  // you click to set it, so they have to keep counting the whole filtered set.
  const tableWhere = withStatus(where, filter.status)

  const [rows, total, counts, varianceCount] = await Promise.all([
    prisma.stockTransfer.findMany({
      where: tableWhere,
      orderBy: { requestedAt: 'desc' },
      skip: (page - 1) * perPage,
      take: perPage,
      include: {
        fromBranch: { select: { name: true } },
        toBranch: { select: { name: true } },
        requestedBy: { select: { name: true } },
        lines: { select: { variance: true, requestedQty: true } },
      },
    }),
    prisma.stockTransfer.count({ where: tableWhere }),
    prisma.stockTransfer.groupBy({ by: ['status'], where, _count: { _all: true } }),
    prisma.stockTransfer.count({ where: { ...where, lines: { some: { variance: { not: null } } } } }),
  ])

  const by = (list: readonly string[]) =>
    counts.filter((row) => list.includes(row.status)).reduce((sum, row) => sum + row._count._all, 0)

  return {
    rows: rows.map(toSummary),
    total,
    page,
    perPage,
    pages: Math.max(1, Math.ceil(total / perPage)),
    stats: {
      total: counts.reduce((sum, row) => sum + row._count._all, 0),
      inTransit: by(IN_TRANSIT_STATUSES),
      pending: by(PENDING_STATUSES),
      received: by(DONE_STATUSES),
      variance: varianceCount,
    },
  }
}

/* ── The transfer report ──────────────────────────────────────────────────── */

/**
 * One line of one transfer, with the whole transfer's context repeated on it.
 *
 * The report and the export are both about what physically moved, so the row is
 * the line and not the transfer: "who sent 6kg of chicken to Beach Road, who
 * signed for it, and were two cases short" is a question about a line. The
 * header fields are duplicated onto every line of a transfer, which is what
 * makes the file sortable and pivotable in a spreadsheet.
 */
export interface TransferLineRow {
  transferId: string
  number: string
  status: string
  fromName: string
  toName: string
  notes: string | null
  rejectReason: string | null
  requestedByName: string | null
  approvedByName: string | null
  dispatchedByName: string | null
  receivedByName: string | null
  requestedAt: string
  approvedAt: string | null
  dispatchedAt: string | null
  receivedAt: string | null
  lineId: string
  itemId: string
  itemName: string
  unit: string
  requestedQty: number
  sentQty: number | null
  receivedQty: number | null
  variance: number | null
  varianceReason: string | null
  varianceNote: string | null
  /** Cents per base unit, snapshotted at dispatch. */
  unitCost: number
  /** Cents. What actually arrived, at the cost it was sent at. */
  lineValue: number
}

export interface TransferReportTotals {
  transfers: number
  lines: number
  requestedQty: number
  sentQty: number
  receivedQty: number
  /** Cents. */
  value: number
  varianceLines: number
}

/**
 * Every line matching the filter, newest transfer first.
 *
 * Deliberately takes `branchIds` — the viewer's whole reach — and never a
 * single branch id. The export used to narrow with `scopeToOne`, which returns
 * null for someone who can reach several branches and has not picked one, and a
 * null branch applied no predicate at all: a manager confined to two of five
 * locations downloaded all five. The reach is the only correct scope here, and
 * `[]` genuinely means nothing is returned.
 */
export async function listTransferLines(params: {
  restaurantId: string
  branchIds: string[] | null
  filter: TransferFilter
  /** Safety rail for the export, which streams to a file. */
  limit?: number
}): Promise<{ rows: TransferLineRow[]; totals: TransferReportTotals; truncated: boolean }> {
  const where = withStatus(transferBoardWhere(params), params.filter.status)
  const limit = params.limit ?? 5_000

  const transfers = await prisma.stockTransfer.findMany({
    where,
    orderBy: [{ requestedAt: 'desc' }, { number: 'desc' }],
    // One over the limit, so "there is more" is known rather than guessed.
    take: limit + 1,
    include: {
      fromBranch: { select: { name: true } },
      toBranch: { select: { name: true } },
      requestedBy: { select: { name: true } },
      approvedBy: { select: { name: true } },
      dispatchedBy: { select: { name: true } },
      receivedBy: { select: { name: true } },
      lines: {
        orderBy: { createdAt: 'asc' },
        include: { item: { select: { id: true, name: true, unit: true } } },
      },
    },
  })

  const truncated = transfers.length > limit
  const kept = truncated ? transfers.slice(0, limit) : transfers

  const rows: TransferLineRow[] = []
  const totals: TransferReportTotals = {
    transfers: kept.length,
    lines: 0,
    requestedQty: 0,
    sentQty: 0,
    receivedQty: 0,
    value: 0,
    varianceLines: 0,
  }

  for (const t of kept) {
    for (const l of t.lines) {
      // What arrived is the honest basis for value; before it arrives, what was
      // sent; before that, what was asked for.
      const valuedQty = l.receivedQty ?? l.sentQty ?? l.requestedQty
      const lineValue = Math.round(valuedQty * l.unitCost)
      const hasVariance = l.variance !== null && Math.abs(l.variance) > 1e-6

      rows.push({
        transferId: t.id,
        number: t.number,
        status: t.status as string,
        fromName: t.fromBranch.name,
        toName: t.toBranch.name,
        notes: t.notes,
        rejectReason: t.rejectReason,
        requestedByName: t.requestedBy?.name ?? null,
        approvedByName: t.approvedBy?.name ?? null,
        dispatchedByName: t.dispatchedBy?.name ?? null,
        receivedByName: t.receivedBy?.name ?? null,
        requestedAt: t.requestedAt.toISOString(),
        approvedAt: t.approvedAt?.toISOString() ?? null,
        dispatchedAt: t.dispatchedAt?.toISOString() ?? null,
        receivedAt: t.receivedAt?.toISOString() ?? null,
        lineId: l.id,
        itemId: l.itemId,
        itemName: l.item.name,
        unit: (l.unit ?? l.item.unit) as string,
        requestedQty: l.requestedQty,
        sentQty: l.sentQty,
        receivedQty: l.receivedQty,
        variance: l.variance,
        varianceReason: (l.varianceReason as string | null) ?? null,
        varianceNote: l.varianceNote,
        unitCost: l.unitCost,
        lineValue,
      })

      totals.lines += 1
      totals.requestedQty += l.requestedQty
      totals.sentQty += l.sentQty ?? 0
      totals.receivedQty += l.receivedQty ?? 0
      totals.value += lineValue
      if (hasVariance) totals.varianceLines += 1
    }
  }

  totals.requestedQty = roundQty(totals.requestedQty)
  totals.sentQty = roundQty(totals.sentQty)
  totals.receivedQty = roundQty(totals.receivedQty)

  return { rows, totals, truncated }
}

/** One location's stock, with the three quantities kept apart. */
export async function getLocationDetail(params: {
  restaurantId: string
  branchId: string
}) {
  const branch = await prisma.branch.findFirst({
    where: { id: params.branchId, restaurantId: params.restaurantId, deletedAt: null },
    include: {
      manager: {
        select: { id: true, name: true, email: true, phone: true, staffCode: true, signInCode: true },
      },
      storageLocations: {
        where: { deletedAt: null },
        select: { id: true, name: true, code: true, isDefault: true },
        orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
      },
    },
  })
  if (!branch) throw new NotFoundError('Location')

  /*
   * Everything else that happens here, in one batch.
   *
   * A location page that shows only what is on the shelves answers one question
   * out of five. The other four — who works here, what is coming in, what it
   * sold, where it keeps things — were all one query away and none was asked.
   */
  const since = new Date()
  since.setDate(since.getDate() - 30)

  const [team, incoming, receipts, sales, unpaid] = await Promise.all([
    prisma.user.findMany({
      where: { restaurantId: params.restaurantId, branchId: branch.id, deletedAt: null },
      select: {
        id: true, name: true, email: true, role: true, staffCode: true,
        isActive: true, lastLoginAt: true,
      },
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
    }),
    // Ordered here and not yet fully delivered.
    prisma.purchase.findMany({
      where: {
        restaurantId: params.restaurantId,
        branchId: branch.id,
        status: { in: ['APPROVED', 'ORDERED', 'PARTIALLY_RECEIVED'] },
      },
      select: {
        id: true, number: true, status: true, total: true, expectedAt: true,
        supplier: { select: { id: true, name: true } },
      },
      orderBy: [{ expectedAt: 'asc' }, { createdAt: 'asc' }],
      take: 10,
    }),
    // Delivered here — including anything diverted here from another order,
    // which is why this reads the receipt's branch and not the purchase's.
    prisma.goodsReceipt.findMany({
      where: { restaurantId: params.restaurantId, branchId: branch.id },
      select: {
        id: true, number: true, receivedAt: true, supplierRef: true,
        purchase: { select: { id: true, number: true, supplier: { select: { name: true } } } },
        lines: { select: { acceptedQty: true, unitCost: true } },
      },
      orderBy: { receivedAt: 'desc' },
      take: 10,
    }),
    prisma.order.aggregate({
      where: {
        restaurantId: params.restaurantId,
        branchId: branch.id,
        status: { not: 'CANCELLED' },
        placedAt: { gte: since },
      },
      _sum: { grandTotal: true },
      _count: true,
    }),
    prisma.order.aggregate({
      where: {
        restaurantId: params.restaurantId,
        branchId: branch.id,
        status: { not: 'CANCELLED' },
        paymentStatus: { in: ['UNPAID', 'PARTIAL'] },
      },
      _sum: { grandTotal: true, paidTotal: true },
    }),
  ])

  const stock = await prisma.inventoryStock.findMany({
    where: { branchId: branch.id, restaurantId: params.restaurantId },
    include: {
      item: {
        select: {
          id: true, name: true, unit: true, costPerUnit: true,
          reorderLevel: true, minStock: true, maxStock: true,
        },
      },
      storageLocation: { select: { id: true, name: true } },
    },
    orderBy: { item: { name: 'asc' } },
  })

  /*
   * One row per shelf now, so an item stored in two places appears twice. The
   * table needs the item's position at this location, not one line per shelf,
   * so the shelves are folded together here and listed underneath.
   *
   * Alert level is judged on the branch total. A kitchen store holding two of
   * something is not "low" when the cold room next door holds forty.
   */
  const byItem = new Map<string, {
    item: (typeof stock)[number]['item']
    available: number
    reserved: number
    inTransit: number
    shelves: Array<{ name: string; available: number }>
  }>()

  for (const row of stock) {
    const entry = byItem.get(row.item.id) ?? {
      item: row.item, available: 0, reserved: 0, inTransit: 0, shelves: [],
    }
    entry.available += row.available
    entry.reserved += row.reserved
    entry.inTransit += row.inTransit
    if (row.available !== 0 || row.storageLocation) {
      entry.shelves.push({
        name: row.storageLocation?.name ?? 'Unassigned',
        available: row.available,
      })
    }
    byItem.set(row.item.id, entry)
  }

  const merged = [...byItem.values()]

  /*
   * Each item's value AT THIS LOCATION, from its layers (FIFO.md).
   *
   * It was `available × item.costPerUnit`, and `costPerUnit` is a
   * restaurant-wide figure — so an item held at two branches that bought it at
   * different prices was reported at the blend of both, at both.
   */
  const itemValue = await prisma.stockBatch.groupBy({
    by: ['itemId'],
    where: { restaurantId: params.restaurantId, branchId: params.branchId, remainingQty: { gt: 0 } },
    _sum: { remainingValue: true },
  })
  const valueOf = new Map(itemValue.map((row) => [row.itemId, row._sum.remainingValue ?? 0]))

  return {
    branch: {
      id: branch.id,
      name: branch.name,
      code: branch.code,
      type: branch.type,
      address: branch.address,
      phone: branch.phone,
      isActive: branch.isActive,
      isDefault: branch.isDefault,
      managerId: branch.managerId,
      managerName: branch.manager?.name ?? null,
      manager: branch.manager
        ? {
            id: branch.manager.id,
            name: branch.manager.name,
            email: branch.manager.email,
            phone: branch.manager.phone,
            staffCode: branch.manager.staffCode,
            // Plaintext by design — the owner must be able to reprint a lost
            // card. Same trade-off documented on staff codes; the page that
            // renders it is permission-gated.
            signInCode: branch.manager.signInCode,
          }
        : null,
      /*
       * Null is a real answer, not a missing one: it means this location keeps
       * the restaurant's own hours. `parseOpeningHours` would substitute
       * DEFAULT_HOURS for an empty column and the edit form would then show
       * invented times as though someone had chosen them.
       */
      openingHours: branch.openingHours ? parseOpeningHours(branch.openingHours) : null,
      storageLocations: branch.storageLocations,
    },
    stock: merged.map((s) => ({
      itemId: s.item.id,
      name: s.item.name,
      unit: s.item.unit as string,
      available: s.available,
      reserved: s.reserved,
      inTransit: s.inTransit,
      free: roundQty(s.available - s.reserved),
      value: valueOf.get(s.item.id) ?? 0,
      level: levelFor({
        quantity: s.available,
        reorderLevel: s.item.reorderLevel,
        minStock: s.item.minStock,
        maxStock: s.item.maxStock,
      }),
      // Only worth showing when it is actually split across more than one.
      shelves: s.shelves.length > 1 ? s.shelves : [],
    })),
    team: team.map((t) => ({
      id: t.id,
      name: t.name,
      email: t.email,
      role: t.role as string,
      staffCode: t.staffCode,
      isActive: t.isActive,
      lastLoginAt: t.lastLoginAt?.toISOString() ?? null,
    })),
    incoming: incoming.map((po) => ({
      id: po.id,
      number: po.number,
      status: po.status as string,
      total: po.total,
      expectedAt: po.expectedAt?.toISOString() ?? null,
      supplierId: po.supplier?.id ?? null,
      supplierName: po.supplier?.name ?? null,
    })),
    receipts: receipts.map((r) => ({
      id: r.id,
      number: r.number,
      purchaseId: r.purchase.id,
      purchaseNumber: r.purchase.number,
      supplierName: r.purchase.supplier?.name ?? null,
      supplierRef: r.supplierRef,
      receivedAt: r.receivedAt.toISOString(),
      value: r.lines.reduce((sum, l) => sum + Math.round(l.acceptedQty * l.unitCost), 0),
    })),
    sales: {
      days: 30,
      orders: sales._count,
      revenue: sales._sum.grandTotal ?? 0,
      /*
       * Owed on orders taken here, all time — not just the window. A debt does
       * not stop existing because it is a month old, and showing a 30-day
       * figure beside a lifetime one under the same heading would be worse
       * than showing neither.
       */
      unpaid: Math.max(0, (unpaid._sum.grandTotal ?? 0) - (unpaid._sum.paidTotal ?? 0)),
    },
  }
}

export type LocationDetail = Awaited<ReturnType<typeof getLocationDetail>>


/** One transfer with everything the detail screen shows. */
export async function getTransferDetail(params: {
  restaurantId: string
  transferId: string
}) {
  const t = await prisma.stockTransfer.findFirst({
    where: { id: params.transferId, restaurantId: params.restaurantId },
    include: {
      fromBranch: { select: { name: true } },
      toBranch: { select: { name: true } },
      requestedBy: { select: { name: true } },
      approvedBy: { select: { name: true } },
      dispatchedBy: { select: { name: true } },
      receivedBy: { select: { name: true } },
      lines: {
        orderBy: { createdAt: 'asc' },
        include: { item: { select: { id: true, name: true, unit: true } } },
      },
    },
  })
  if (!t) throw new NotFoundError('Transfer')

  return {
    id: t.id,
    number: t.number,
    status: t.status as string,
    fromBranchId: t.fromBranchId,
    toBranchId: t.toBranchId,
    fromName: t.fromBranch.name,
    toName: t.toBranch.name,
    notes: t.notes,
    /*
     * Why it was refused. It was already stored and never read back, so a
     * rejected transfer told you it was rejected and not why — the one thing
     * anybody opening a rejected transfer wants to know.
     */
    rejectReason: t.rejectReason,
    requestedByName: t.requestedBy?.name ?? null,
    approvedByName: t.approvedBy?.name ?? null,
    dispatchedByName: t.dispatchedBy?.name ?? null,
    receivedByName: t.receivedBy?.name ?? null,
    requestedAt: t.requestedAt.toISOString(),
    approvedAt: t.approvedAt?.toISOString() ?? null,
    dispatchedAt: t.dispatchedAt?.toISOString() ?? null,
    receivedAt: t.receivedAt?.toISOString() ?? null,
    lines: t.lines.map((l) => ({
      id: l.id,
      itemId: l.itemId,
      name: l.item.name,
      unit: (l.unit ?? l.item.unit) as string,
      requestedQty: l.requestedQty,
      sentQty: l.sentQty,
      receivedQty: l.receivedQty,
      variance: l.variance,
      varianceReason: (l.varianceReason as string | null) ?? null,
      /** The free-text half of a variance — what the receiver actually wrote. */
      varianceNote: l.varianceNote,
      /** Cents per base unit, snapshotted at dispatch. */
      unitCost: l.unitCost,
      /** Cents, on the same "what arrived" basis the report uses. */
      lineValue: Math.round((l.receivedQty ?? l.sentQty ?? l.requestedQty) * l.unitCost),
    })),
  }
}

export type TransferDetail = Awaited<ReturnType<typeof getTransferDetail>>

/**
 * Locations and items for the "new transfer" form.
 *
 * `reach` is which branches the requester may act FOR (`visibleBranchIds`):
 * null means every one. recorrection.md §1 makes the destination the
 * requester, so the form locks TO to that reach and offers every location as
 * FROM — a branch requests stock from somewhere it cannot see.
 */
export async function getTransferBuilderData(restaurantId: string, reach: string[] | null = null) {
  /*
   * Shelves are no longer fetched here (correctionA.md §7). The form used to
   * offer "From storage area" and "To storage area", which let a transfer mean
   * a shelf-to-shelf move inside one location; a transfer now always moves
   * stock between two locations. The service still accepts the storage ids and
   * the columns are still on the row — historical transfers reference them —
   * so nothing below the form changed.
   */
  const [locations, items] = await Promise.all([
    prisma.branch.findMany({
      where: { restaurantId, deletedAt: null, isActive: true },
      select: { id: true, name: true, type: true },
      orderBy: { name: 'asc' },
    }),
    prisma.inventoryStock.findMany({
      where: { restaurantId, available: { gt: 0 } },
      include: { item: { select: { id: true, name: true, unit: true } } },
    }),
  ])

  return {
    locations,
    /** Branches the requester may be the destination of. Null = any. */
    actableBranchIds: reach,
    // Only what a location actually holds can be sent from it.
    stockByBranch: locations.map((l) => ({
      branchId: l.id,
      items: items
        .filter((s) => s.branchId === l.id)
        .map((s) => ({
          itemId: s.item.id,
          name: s.item.name,
          unit: s.item.unit as string,
          free: roundQty(s.available - s.reserved),
        }))
        .filter((i) => i.free > 0)
        .sort((a, b) => a.name.localeCompare(b.name)),
    })),
  }
}


/**
 * Just enough to render the location switcher.
 *
 * Deliberately separate from listLocations, which joins every stock row and
 * every item to compute values and alert counts. That is right for the
 * locations page and badly wrong for the dashboard layout, where it would run
 * on every single page load to populate a dropdown that needs three fields.
 */
export async function listSwitchableLocations(
  restaurantId: string,
  /**
   * Which locations this person may see. `null` is unrestricted; `[]` is
   * confined with nowhere to look and correctly returns nothing.
   *
   * Optional only so the existing callers keep compiling — but every one of
   * them was already doing `.filter(...)` on the result, in four separate
   * places, with nothing but habit keeping them in step. `listLocations` two
   * hundred lines up has taken this parameter since the leak that put it
   * there; this is the same fix on the cheap query.
   */
  branchIds?: string[] | null,
): Promise<
  Array<{
    id: string
    name: string
    type: LocationType
    /** Shown under the name, so the menu is worth opening. */
    managerName: string | null
    staffCount: number
  }>
> {
  /*
   * The manager is a `SET NULL` join on one indexed column and the staff count
   * is a `_count` on an indexed relation, so this is still the cheap query the
   * note above insists on — no stock rows, no items.
   */
  const branches = await prisma.branch.findMany({
    where: {
      restaurantId,
      deletedAt: null,
      isActive: true,
      ...(branchIds ? { id: { in: branchIds } } : {}),
    },
    select: {
      id: true,
      name: true,
      type: true,
      manager: { select: { name: true } },
      _count: { select: { users: { where: { deletedAt: null, isActive: true } } } },
    },
    orderBy: [{ type: 'asc' }, { name: 'asc' }],
  })

  return branches.map((b) => ({
    id: b.id,
    name: b.name,
    type: b.type,
    managerName: b.manager?.name ?? null,
    staffCount: b._count.users,
  }))
}
