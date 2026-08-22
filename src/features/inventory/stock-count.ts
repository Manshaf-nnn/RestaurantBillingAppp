import 'server-only'

import type { StockCount, StockUnit } from '@prisma/client'

import { AppError, NotFoundError } from '@/lib/errors'
import { prisma } from '@/server/db/prisma'
import { postMovement } from './ledger'
import { toBaseUnits } from './units'

/**
 * Physical stock counts.
 *
 * Counting is two steps on purpose, and the separation is the whole point of
 * this module:
 *
 *   1. Someone walks the store and records what is on the shelf. This writes
 *      count lines and moves nothing. A mistyped 5 instead of 50 is a wrong
 *      line on a draft, not a corrupted balance.
 *
 *   2. Someone with authority approves it. Only then is the variance posted to
 *      the ledger, as ordinary ADJUSTMENT_IN / ADJUSTMENT_OUT movements that
 *      reference the count.
 *
 * The system stock on each line is snapshotted when the line is entered, so a
 * sale that happens while the count is in progress does not silently change
 * what the counter was comparing against. That snapshot is also what the
 * approver sees, which means they are approving the variance that was actually
 * observed rather than one recomputed later.
 */

export interface CountLineInput {
  itemId: string
  countedQty: number
  unit?: StockUnit | null
  notes?: string | null
}

/** Start a count. Empty until lines are added. */
export async function openStockCount(params: {
  restaurantId: string
  /** Which location. Required, in step with the ledger. */
  branchId: string
  locationId?: string | null
  userId: string
  notes?: string | null
}): Promise<StockCount> {
  const reference = `SC-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Date.now()
    .toString(36)
    .slice(-4)
    .toUpperCase()}`

  return prisma.stockCount.create({
    data: {
      restaurantId: params.restaurantId,
      branchId: params.branchId,
      locationId: params.locationId ?? null,
      reference,
      countedById: params.userId,
      notes: params.notes?.trim() || null,
      status: 'DRAFT',
    },
  })
}

/**
 * Record what was on the shelf. Writes lines only — no stock moves here.
 *
 * Re-counting an item overwrites its line rather than adding a second one, so
 * a counter who miskeys can simply count again.
 */
export async function recordCountLines(params: {
  restaurantId: string
  stockCountId: string
  lines: CountLineInput[]
}): Promise<{ recorded: number }> {
  const count = await requireDraft(params.restaurantId, params.stockCountId)
  if (params.lines.length === 0) {
    throw new AppError('Add at least one item to the count', 400, 'COUNT_EMPTY')
  }

  const items = await prisma.inventoryItem.findMany({
    where: {
      id: { in: params.lines.map((l) => l.itemId) },
      restaurantId: params.restaurantId,
    },
  })
  const byId = new Map(items.map((i) => [i.id, i]))

  await prisma.$transaction(async (tx) => {
    for (const line of params.lines) {
      const item = byId.get(line.itemId)
      if (!item) throw new NotFoundError('Inventory item')
      if (line.countedQty < 0) {
        throw new AppError(`${item.name}: a count cannot be negative`, 400, 'COUNT_NEGATIVE')
      }

      const countedBase = toBaseUnits(line.countedQty, line.unit ?? item.unit, item)
      const systemQty = item.quantity

      await tx.stockCountLine.upsert({
        where: { stockCountId_itemId: { stockCountId: count.id, itemId: item.id } },
        create: {
          stockCountId: count.id,
          itemId: item.id,
          systemQty,
          countedQty: countedBase,
          variance: round(countedBase - systemQty),
          enteredUnit: line.unit ?? item.unit,
          notes: line.notes?.trim() || null,
        },
        update: {
          systemQty,
          countedQty: countedBase,
          variance: round(countedBase - systemQty),
          enteredUnit: line.unit ?? item.unit,
          notes: line.notes?.trim() || null,
        },
      })
    }
  })

  return { recorded: params.lines.length }
}

/** Hand the count to a manager. Still moves no stock. */
export async function submitStockCount(
  restaurantId: string,
  stockCountId: string,
): Promise<StockCount> {
  const count = await requireDraft(restaurantId, stockCountId)
  const lines = await prisma.stockCountLine.count({ where: { stockCountId: count.id } })
  if (lines === 0) {
    throw new AppError('Count nothing, approve nothing — add lines first', 400, 'COUNT_EMPTY')
  }
  return prisma.stockCount.update({
    where: { id: count.id },
    data: { status: 'AWAITING_APPROVAL' },
  })
}

/**
 * Approve a count and post its variances.
 *
 * This is the only place a count changes stock. Each non-zero variance becomes
 * an adjustment movement referencing the count, so the ledger explains where
 * the correction came from and who authorised it. Zero-variance lines post
 * nothing — an item that counted correctly should not clutter its own history.
 */
export async function approveStockCount(params: {
  restaurantId: string
  stockCountId: string
  userId: string
  notes?: string | null
}): Promise<{ count: StockCount; adjusted: number; unchanged: number }> {
  const count = await prisma.stockCount.findFirst({
    where: { id: params.stockCountId, restaurantId: params.restaurantId },
    include: { lines: { include: { item: true } } },
  })
  if (!count) throw new NotFoundError('Stock count')
  if (count.status === 'APPROVED') {
    throw new AppError('That count was already approved', 409, 'COUNT_APPROVED')
  }
  if (count.status === 'CANCELLED') {
    throw new AppError('That count was cancelled', 409, 'COUNT_CANCELLED')
  }
  if (count.lines.length === 0) {
    throw new AppError('Nothing to approve', 400, 'COUNT_EMPTY')
  }

  let adjusted = 0
  let unchanged = 0

  const updated = await prisma.$transaction(async (tx) => {
    for (const line of count.lines) {
      if (Math.abs(line.variance) < 1e-6) {
        unchanged += 1
        continue
      }

      // Re-derive against the balance as it stands now, so stock that moved
      // legitimately during the count is not wiped out by a stale snapshot.
      // The line still records what was observed at count time.
      await postMovement(tx, {
        restaurantId: params.restaurantId,
        itemId: line.itemId,
        type: line.variance > 0 ? 'ADJUSTMENT_IN' : 'ADJUSTMENT_OUT',
        quantity: Math.abs(line.variance),
        enteredUnit: line.item.unit,
        reason: `Stock count ${count.reference}`,
        notes: line.notes,
        referenceType: 'StockCount',
        referenceId: count.id,
        stockCountId: count.id,
        branchId: count.branchId,
        locationId: count.locationId,
        userId: params.userId,
      })
      adjusted += 1
    }

    return tx.stockCount.update({
      where: { id: count.id },
      data: {
        status: 'APPROVED',
        approvedById: params.userId,
        approvedAt: new Date(),
        notes: params.notes?.trim() || count.notes,
      },
    })
  })

  return { count: updated, adjusted, unchanged }
}

export async function cancelStockCount(
  restaurantId: string,
  stockCountId: string,
): Promise<StockCount> {
  const count = await prisma.stockCount.findFirst({
    where: { id: stockCountId, restaurantId },
  })
  if (!count) throw new NotFoundError('Stock count')
  if (count.status === 'APPROVED') {
    throw new AppError('An approved count cannot be cancelled', 409, 'COUNT_APPROVED')
  }
  return prisma.stockCount.update({ where: { id: count.id }, data: { status: 'CANCELLED' } })
}

async function requireDraft(restaurantId: string, stockCountId: string): Promise<StockCount> {
  const count = await prisma.stockCount.findFirst({
    where: { id: stockCountId, restaurantId },
  })
  if (!count) throw new NotFoundError('Stock count')
  if (count.status !== 'DRAFT') {
    throw new AppError('This count is no longer open for editing', 409, 'COUNT_NOT_DRAFT')
  }
  return count
}

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6
}
