import 'server-only'

import { AppError } from '@/lib/errors'
import { prisma, type TxClient } from '@/server/db/prisma'

/**
 * Per-location stock.
 *
 * `InventoryItem.quantity` remains the restaurant-wide available total so every
 * existing query keeps working; this module maintains the breakdown underneath
 * it. Both are written inside the same transaction as the ledger row that
 * justifies them, so they cannot drift apart.
 *
 * ── Why three numbers, never one ────────────────────────────────────────────
 *
 *   available — on the shelf here, sellable now
 *   reserved  — committed to an approved transfer that has not left yet
 *   inTransit — dispatched from elsewhere, not yet arrived here
 *
 * Collapsing these is the classic multi-location bug: stock sitting in a van
 * gets counted as available at both ends, and the branch about to run out looks
 * fine right up until service.
 */

export interface LocationBalance {
  available: number
  reserved: number
  inTransit: number
  /** available − reserved: what can actually be committed to something new. */
  free: number
}

/** Move a location's figures, creating the row on first use. */
export async function applyLocationDelta(
  tx: TxClient,
  params: {
    restaurantId: string
    itemId: string
    branchId: string | null
    storageLocationId?: string | null
    available?: number
    reserved?: number
    inTransit?: number
  },
): Promise<void> {
  // Movements with no location still move the restaurant-wide total; they
  // simply cannot be attributed to a shelf. Refusing them would break every
  // single-location restaurant that has never thought about branches.
  if (!params.branchId) return

  await tx.inventoryStock.upsert({
    where: { itemId_branchId: { itemId: params.itemId, branchId: params.branchId } },
    create: {
      restaurantId: params.restaurantId,
      itemId: params.itemId,
      branchId: params.branchId,
      storageLocationId: params.storageLocationId ?? null,
      available: params.available ?? 0,
      reserved: params.reserved ?? 0,
      inTransit: params.inTransit ?? 0,
    },
    update: {
      ...(params.available ? { available: { increment: params.available } } : {}),
      ...(params.reserved ? { reserved: { increment: params.reserved } } : {}),
      ...(params.inTransit ? { inTransit: { increment: params.inTransit } } : {}),
      ...(params.storageLocationId ? { storageLocationId: params.storageLocationId } : {}),
    },
  })
}

export async function getLocationBalance(params: {
  restaurantId: string
  itemId: string
  branchId: string
}): Promise<LocationBalance> {
  const row = await prisma.inventoryStock.findFirst({
    where: { itemId: params.itemId, branchId: params.branchId, restaurantId: params.restaurantId },
  })
  const available = row?.available ?? 0
  const reserved = row?.reserved ?? 0
  return {
    available,
    reserved,
    inTransit: row?.inTransit ?? 0,
    free: round(available - reserved),
  }
}

/**
 * Refuse a withdrawal a location cannot cover.
 *
 * Negative stock is rejected here rather than allowed and flagged. A transfer
 * is a deliberate act with a person and a form behind it, unlike a sale, where
 * blocking would mean refusing to serve a guest over a bookkeeping gap.
 * Reserved stock is excluded — it is already promised elsewhere.
 */
export async function assertSufficient(
  tx: TxClient,
  params: {
    restaurantId: string
    itemId: string
    branchId: string
    quantity: number
    itemName?: string
  },
): Promise<void> {
  const row = await tx.inventoryStock.findFirst({
    where: { itemId: params.itemId, branchId: params.branchId, restaurantId: params.restaurantId },
  })
  const free = round((row?.available ?? 0) - (row?.reserved ?? 0))

  if (free + 1e-6 < params.quantity) {
    throw new AppError(
      `Insufficient stock${params.itemName ? ` for ${params.itemName}` : ''} — ${free} available, ${params.quantity} needed`,
      409,
      'INSUFFICIENT_STOCK',
    )
  }
}

/** Everything a location holds, for its dashboard. */
export async function listLocationStock(params: { restaurantId: string; branchId: string }) {
  return prisma.inventoryStock.findMany({
    where: { restaurantId: params.restaurantId, branchId: params.branchId },
    include: {
      item: {
        select: {
          id: true, name: true, unit: true, reorderLevel: true,
          minStock: true, maxStock: true, costPerUnit: true,
        },
      },
      storageLocation: { select: { name: true } },
    },
    orderBy: { item: { name: 'asc' } },
  })
}

/** The same item across every location — the "where is it?" view. */
export async function getItemAcrossLocations(params: { restaurantId: string; itemId: string }) {
  return prisma.inventoryStock.findMany({
    where: { restaurantId: params.restaurantId, itemId: params.itemId },
    include: { branch: { select: { id: true, name: true, type: true } } },
    orderBy: { branch: { name: 'asc' } },
  })
}

function round(v: number): number {
  return Math.round(v * 1e6) / 1e6
}
