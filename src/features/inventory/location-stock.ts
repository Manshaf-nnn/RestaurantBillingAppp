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

/**
 * Move one shelf's figures, creating the row on first use.
 *
 * The shelf is part of the identity of a balance, not a label on it. This used
 * to upsert on (item, branch) alone and then overwrite `storageLocationId` with
 * whatever the latest posting carried — so two shelves in one branch shared a
 * single row whose label flip-flopped, and neither figure meant anything.
 *
 * Stock with no shelf assigned is a real position, not a missing one: it is the
 * whole of a restaurant that has never defined a storage area, so `null` is a
 * key value in its own right rather than a wildcard.
 *
 * Read-then-write rather than upsert, because uniqueness is enforced by partial
 * indexes (Postgres treats NULLs as distinct, so a plain three-column unique
 * would let unassigned stock accumulate duplicate rows) and Prisma cannot upsert
 * against a partial index. The item row is locked first so the read and the
 * write cannot interleave with another posting for the same item.
 */
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

  const storageLocationId = params.storageLocationId ?? null

  // Serialise against other postings for this item. postMovement already holds
  // this lock; taking it again in the same transaction is free, and the
  // transfer paths that reach here without it are covered by it too.
  await tx.$queryRaw`
    SELECT id FROM inventory_items
    WHERE id = ${params.itemId} AND "restaurantId" = ${params.restaurantId}
    FOR UPDATE
  `

  const existing = await tx.inventoryStock.findFirst({
    where: {
      itemId: params.itemId,
      branchId: params.branchId,
      restaurantId: params.restaurantId,
      storageLocationId,
    },
    select: { id: true },
  })

  if (existing) {
    await tx.inventoryStock.update({
      where: { id: existing.id },
      data: {
        ...(params.available ? { available: { increment: params.available } } : {}),
        ...(params.reserved ? { reserved: { increment: params.reserved } } : {}),
        ...(params.inTransit ? { inTransit: { increment: params.inTransit } } : {}),
      },
    })
    return
  }

  await tx.inventoryStock.create({
    data: {
      restaurantId: params.restaurantId,
      itemId: params.itemId,
      branchId: params.branchId,
      storageLocationId,
      available: params.available ?? 0,
      reserved: params.reserved ?? 0,
      inTransit: params.inTransit ?? 0,
    },
  })
}

/**
 * What a location holds.
 *
 * Without `storageLocationId` this is the branch total — the sum of its shelves,
 * derived on read rather than stored, so there is never a branch figure that can
 * disagree with the shelves under it. With one, it is that shelf alone.
 *
 * Pass `storageLocationId: null` explicitly to mean the unassigned position
 * specifically, which is different from "the whole branch".
 */
export async function getLocationBalance(params: {
  restaurantId: string
  itemId: string
  branchId: string
  storageLocationId?: string | null
}): Promise<LocationBalance> {
  const scoped = params.storageLocationId !== undefined

  const rows = await prisma.inventoryStock.findMany({
    where: {
      itemId: params.itemId,
      branchId: params.branchId,
      restaurantId: params.restaurantId,
      ...(scoped ? { storageLocationId: params.storageLocationId } : {}),
    },
    select: { available: true, reserved: true, inTransit: true },
  })

  const available = round(rows.reduce((sum, r) => sum + r.available, 0))
  const reserved = round(rows.reduce((sum, r) => sum + r.reserved, 0))

  return {
    available,
    reserved,
    inTransit: round(rows.reduce((sum, r) => sum + r.inTransit, 0)),
    free: round(available - reserved),
  }
}

/** Every shelf holding this item at a location, for a per-store view. */
export async function getShelfBalances(params: {
  restaurantId: string
  itemId: string
  branchId: string
}) {
  const rows = await prisma.inventoryStock.findMany({
    where: {
      itemId: params.itemId,
      branchId: params.branchId,
      restaurantId: params.restaurantId,
    },
    include: { storageLocation: { select: { id: true, name: true } } },
  })

  return rows.map((r) => ({
    storageLocationId: r.storageLocationId,
    // A row with no shelf is stock the restaurant has never filed anywhere,
    // which is worth naming rather than showing as a blank.
    name: r.storageLocation?.name ?? 'Unassigned',
    available: r.available,
    reserved: r.reserved,
    inTransit: r.inTransit,
    free: round(r.available - r.reserved),
  }))
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
    /** Check one shelf; omitted means anywhere in the branch. */
    storageLocationId?: string | null
  },
): Promise<void> {
  const scoped = params.storageLocationId !== undefined

  const rows = await tx.inventoryStock.findMany({
    where: {
      itemId: params.itemId,
      branchId: params.branchId,
      restaurantId: params.restaurantId,
      ...(scoped ? { storageLocationId: params.storageLocationId } : {}),
    },
    select: { available: true, reserved: true },
  })

  // Summed across shelves when unscoped: a branch that holds 6 on one shelf and
  // 5 on another can cover 10, and refusing that would be wrong.
  const free = round(rows.reduce((sum, r) => sum + r.available - r.reserved, 0))

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
