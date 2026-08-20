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
    },
    orderBy: { item: { name: 'asc' } },
  })

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
    stock: stock.map((s) => ({
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
    })),
  }
}
