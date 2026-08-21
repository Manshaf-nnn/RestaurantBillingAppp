import 'server-only'

import type { LocationType } from '@prisma/client'

import { NotFoundError } from '@/lib/errors'
import { parseOpeningHours } from '@/lib/opening-hours'
import { prisma } from '@/server/db/prisma'
import { levelFor } from '@/features/inventory/alerts'

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
export async function listLocations(restaurantId: string): Promise<LocationSummary[]> {
  const branches = await prisma.branch.findMany({
    where: { restaurantId, deletedAt: null },
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

  return branches.map((b) => {
    let stockValue = 0
    let lowStock = 0
    let outOfStock = 0
    let inTransitLines = 0

    for (const row of b.stock) {
      if (row.available > 0) stockValue += row.available * row.item.costPerUnit
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
  fromName: string
  toName: string
  lineCount: number
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
      lines: { select: { variance: true } },
    },
  })

  return transfers.map((t) => ({
    id: t.id,
    number: t.number,
    status: t.status,
    fromName: t.fromBranch.name,
    toName: t.toBranch.name,
    lineCount: t.lines.length,
    requestedAt: t.requestedAt.toISOString(),
    requestedByName: t.requestedBy?.name ?? null,
    hasVariance: t.lines.some((l) => l.variance !== null && Math.abs(l.variance) > 1e-6),
  }))
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
      storageLocations: { where: { deletedAt: null }, select: { id: true, name: true } },
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
    // Delivered here — including anything diverted here from another order.
    prisma.goodsReceipt.findMany({
      where: {
        restaurantId: params.restaurantId,
        OR: [
          { branchId: branch.id },
          { branchId: null, purchase: { branchId: branch.id } },
        ],
      },
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
      free: Math.round((s.available - s.reserved) * 1e6) / 1e6,
      value: Math.round(Math.max(0, s.available) * s.item.costPerUnit),
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
      lines: { include: { item: { select: { name: true, unit: true } } } },
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
      name: l.item.name,
      unit: (l.unit ?? l.item.unit) as string,
      requestedQty: l.requestedQty,
      sentQty: l.sentQty,
      receivedQty: l.receivedQty,
      variance: l.variance,
      varianceReason: (l.varianceReason as string | null) ?? null,
    })),
  }
}

/** Locations and items for the "new transfer" form. */
export async function getTransferBuilderData(restaurantId: string) {
  const [locations, items, storage] = await Promise.all([
    prisma.branch.findMany({
      where: { restaurantId, deletedAt: null, isActive: true },
      select: { id: true, name: true, type: true },
      orderBy: { name: 'asc' },
    }),
    prisma.inventoryStock.findMany({
      where: { restaurantId, available: { gt: 0 } },
      include: { item: { select: { id: true, name: true, unit: true } } },
    }),
    // Shelves, so a move within one location — Main Store to Cold Room — can be
    // expressed. The service always supported it; the form had no way to say it.
    prisma.storageLocation.findMany({
      where: { restaurantId, deletedAt: null },
      select: { id: true, name: true, branchId: true },
      orderBy: { name: 'asc' },
    }),
  ])

  return {
    locations,
    storageByBranch: locations.map((l) => ({
      branchId: l.id,
      shelves: storage.filter((s) => s.branchId === l.id).map((s) => ({ id: s.id, name: s.name })),
    })),
    // Only what a location actually holds can be sent from it.
    stockByBranch: locations.map((l) => ({
      branchId: l.id,
      items: items
        .filter((s) => s.branchId === l.id)
        .map((s) => ({
          itemId: s.item.id,
          name: s.item.name,
          unit: s.item.unit as string,
          free: Math.round((s.available - s.reserved) * 1e6) / 1e6,
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
export async function listSwitchableLocations(restaurantId: string): Promise<
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
    where: { restaurantId, deletedAt: null, isActive: true },
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
