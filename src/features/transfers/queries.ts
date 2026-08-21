import 'server-only'

import type { LocationType } from '@prisma/client'

import { NotFoundError } from '@/lib/errors'
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
}): Promise<TransferSummary[]> {
  const transfers = await prisma.stockTransfer.findMany({
    where: {
      restaurantId: params.restaurantId,
      ...(params.branchId
        ? { OR: [{ fromBranchId: params.branchId }, { toBranchId: params.branchId }] }
        : {}),
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
      manager: { select: { name: true } },
      storageLocations: { where: { deletedAt: null }, select: { id: true, name: true } },
    },
  })
  if (!branch) throw new NotFoundError('Location')

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
      managerName: branch.manager?.name ?? null,
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
  }
}


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
  Array<{ id: string; name: string; type: LocationType }>
> {
  return prisma.branch.findMany({
    where: { restaurantId, deletedAt: null, isActive: true },
    select: { id: true, name: true, type: true },
    orderBy: [{ type: 'asc' }, { name: 'asc' }],
  })
}
