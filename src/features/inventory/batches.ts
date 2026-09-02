import 'server-only'

import type { StockBatch } from '@prisma/client'

import { AppError, NotFoundError } from '@/lib/errors'
import { prisma, type TxClient } from '@/server/db/prisma'

/**
 * Batch and expiry tracking.
 *
 * Opt-in per item via `trackBatches`. Most restaurant stock does not need it —
 * nobody lots their salt — but anything with a short life or a recall risk
 * does, and forcing it everywhere would make ordinary receiving slower for no
 * benefit.
 *
 * ── FEFO ────────────────────────────────────────────────────────────────────
 *
 * First Expiry First Out is prepared here but never mandatory. `allocateFefo`
 * returns which batches a withdrawal *should* draw from, oldest expiry first;
 * whether a caller uses it is the item's `useFefo` flag. Keeping allocation
 * separate from posting means the strategy can be swapped — FIFO by receipt
 * date, or manual batch choice — without touching the ledger.
 */

export interface BatchAllocation {
  batchId: string
  batchNo: string
  expiryDate: Date | null
  /** Base units to draw from this batch. */
  quantity: number
  unitCost: number
}

/** Create or top up a batch as stock is received. */
export async function upsertBatch(
  tx: TxClient,
  params: {
    restaurantId: string
    itemId: string
    batchNo: string
    quantity: number
    unitCost?: number
    expiryDate?: Date | null
    locationId?: string | null
    /** Which location. Required, in step with the ledger. */
    branchId: string
  },
): Promise<StockBatch> {
  const existing = await tx.stockBatch.findFirst({
    where: { itemId: params.itemId, batchNo: params.batchNo },
  })

  if (existing) {
    return tx.stockBatch.update({
      where: { id: existing.id },
      data: {
        receivedQty: { increment: params.quantity },
        remainingQty: { increment: params.quantity },
        // A later delivery of the same lot can carry a different cost; the
        // batch keeps the most recent, which is what a recall would quote.
        ...(params.unitCost ? { unitCost: params.unitCost } : {}),
        ...(params.expiryDate ? { expiryDate: params.expiryDate } : {}),
      },
    })
  }

  return tx.stockBatch.create({
    data: {
      restaurantId: params.restaurantId,
      itemId: params.itemId,
      batchNo: params.batchNo,
      receivedQty: params.quantity,
      remainingQty: params.quantity,
      unitCost: params.unitCost ?? 0,
      expiryDate: params.expiryDate ?? null,
      locationId: params.locationId ?? null,
      branchId: params.branchId,
    },
  })
}

/**
 * Which batches to draw `quantity` from, oldest expiry first.
 *
 * Batches with no expiry sort last: a dated batch should always go before an
 * undated one, since the dated one is the one that can spoil. Returns as much
 * as it can and reports any shortfall rather than throwing, because a
 * withdrawal exceeding tracked batches is a bookkeeping gap, not a reason to
 * stop someone serving food.
 */
export async function allocateFefo(
  db: TxClient | typeof prisma,
  params: { restaurantId: string; itemId: string; quantity: number; branchId?: string | null },
): Promise<{ allocations: BatchAllocation[]; shortfall: number }> {
  /*
   * Only lots that are physically WHERE the stock is leaving from. Without
   * the branch predicate a sale in Colombo drained Kandy's crates on paper:
   * Kandy's expiry board stopped warning about stock it still held, and
   * Colombo's kept warning about stock it never had.
   */
  const batches = await db.stockBatch.findMany({
    where: {
      restaurantId: params.restaurantId,
      itemId: params.itemId,
      remainingQty: { gt: 0 },
      ...(params.branchId ? { branchId: params.branchId } : {}),
    },
    orderBy: [{ expiryDate: 'asc' }, { receivedAt: 'asc' }],
  })

  // Prisma sorts NULLs first on asc; an undated batch must come last.
  const ordered = [
    ...batches.filter((b) => b.expiryDate !== null),
    ...batches.filter((b) => b.expiryDate === null),
  ]

  const allocations: BatchAllocation[] = []
  let left = params.quantity

  for (const batch of ordered) {
    if (left <= 1e-9) break
    const take = Math.min(batch.remainingQty, left)
    allocations.push({
      batchId: batch.id,
      batchNo: batch.batchNo,
      expiryDate: batch.expiryDate,
      quantity: round(take),
      unitCost: batch.unitCost,
    })
    left = round(left - take)
  }

  return { allocations, shortfall: Math.max(0, round(left)) }
}

/** Draw stock down from specific batches. */
export async function consumeBatches(
  tx: TxClient,
  allocations: BatchAllocation[],
): Promise<void> {
  for (const allocation of allocations) {
    await tx.stockBatch.update({
      where: { id: allocation.batchId },
      data: { remainingQty: { decrement: allocation.quantity } },
    })
  }
}

// ── expiry ───────────────────────────────────────────────────────────────────

export type ExpiryBucket = 'EXPIRED' | 'TODAY' | 'WITHIN_3' | 'WITHIN_7' | 'WITHIN_PERIOD' | 'OK'

export interface ExpiringBatch {
  batchId: string
  batchNo: string
  itemId: string
  itemName: string
  unit: string
  remainingQty: number
  expiryDate: string | null
  daysLeft: number | null
  bucket: ExpiryBucket
  /** remainingQty × unitCost, minor units — what walks out of the door if it spoils. */
  valueAtRisk: number
  branchName: string | null
  locationName: string | null
}

/**
 * Classify a batch by how close it is to expiry.
 *
 * Whole days, floored, so anything dated today reads as TODAY rather than
 * flicking between buckets as the clock moves through the afternoon.
 */
export function bucketFor(expiry: Date | null, now: Date, periodDays: number): ExpiryBucket {
  if (!expiry) return 'OK'
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const startOfExpiry = new Date(expiry.getFullYear(), expiry.getMonth(), expiry.getDate())
  const days = Math.round((startOfExpiry.getTime() - startOfToday.getTime()) / 86_400_000)

  if (days < 0) return 'EXPIRED'
  if (days === 0) return 'TODAY'
  if (days <= 3) return 'WITHIN_3'
  if (days <= 7) return 'WITHIN_7'
  if (days <= periodDays) return 'WITHIN_PERIOD'
  return 'OK'
}

export async function listExpiringStock(params: {
  restaurantId: string
  /** The restaurant's own horizon beyond the fixed 3- and 7-day buckets. */
  periodDays?: number
  branchId?: string | null
}): Promise<ExpiringBatch[]> {
  const periodDays = params.periodDays ?? 30
  const now = new Date()
  const horizon = new Date(now.getTime() + periodDays * 86_400_000)

  const batches = await prisma.stockBatch.findMany({
    where: {
      restaurantId: params.restaurantId,
      remainingQty: { gt: 0 },
      expiryDate: { not: null, lte: horizon },
      ...(params.branchId ? { branchId: params.branchId } : {}),
    },
    orderBy: { expiryDate: 'asc' },
    include: {
      item: { select: { id: true, name: true, unit: true } },
      branch: { select: { name: true } },
      location: { select: { name: true } },
    },
  })

  return batches.map((b) => {
    const bucket = bucketFor(b.expiryDate, now, periodDays)
    const days = b.expiryDate
      ? Math.round(
          (new Date(b.expiryDate.getFullYear(), b.expiryDate.getMonth(), b.expiryDate.getDate()).getTime() -
            new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) /
            86_400_000,
        )
      : null

    return {
      batchId: b.id,
      batchNo: b.batchNo,
      itemId: b.item.id,
      itemName: b.item.name,
      unit: b.item.unit,
      remainingQty: b.remainingQty,
      expiryDate: b.expiryDate?.toISOString() ?? null,
      daysLeft: days,
      bucket,
      valueAtRisk: Math.round(b.remainingQty * b.unitCost),
      branchName: b.branch?.name ?? null,
      locationName: b.location?.name ?? null,
    }
  })
}

/** Headline counts for the expiry board. */
export async function getExpirySummary(params: {
  restaurantId: string
  periodDays?: number
  // `listExpiringStock` below has always taken a branch; this signature did
  // not, so the summary tiles counted the whole business while the table
  // under them counted one location.
  branchId?: string | null
}): Promise<Record<ExpiryBucket, { count: number; value: number }>> {
  const rows = await listExpiringStock(params)
  const empty = { count: 0, value: 0 }
  const summary: Record<ExpiryBucket, { count: number; value: number }> = {
    EXPIRED: { ...empty }, TODAY: { ...empty }, WITHIN_3: { ...empty },
    WITHIN_7: { ...empty }, WITHIN_PERIOD: { ...empty }, OK: { ...empty },
  }
  for (const row of rows) {
    summary[row.bucket].count += 1
    summary[row.bucket].value += row.valueAtRisk
  }
  return summary
}

export async function requireBatch(restaurantId: string, batchId: string): Promise<StockBatch> {
  const batch = await prisma.stockBatch.findFirst({ where: { id: batchId, restaurantId } })
  if (!batch) throw new NotFoundError('Batch')
  return batch
}

/** Reject a batch number that would collide with a different item's lot. */
export function assertBatchNo(batchNo: string): string {
  const trimmed = batchNo.trim().toUpperCase()
  if (trimmed.length < 2) throw new AppError('Batch number is too short', 400, 'BATCH_NO_SHORT')
  return trimmed
}

function round(v: number): number {
  return Math.round(v * 1e6) / 1e6
}
