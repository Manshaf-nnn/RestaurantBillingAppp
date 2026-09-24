import 'server-only'

import type { StockBatch } from '@prisma/client'

import { AppError, NotFoundError } from '@/lib/errors'
import { prisma, type TxClient } from '@/server/db/prisma'
import { walkFifo } from './fifo-walk'

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
  /** The layer's rate at the moment of the draw, for reading. */
  unitCost: number
  /**
   * What this slice is worth, minor units — the figure of record.
   *
   * Taken from the walk, never rebuilt as quantity × unitCost: an integer rate
   * cannot express a cost below one minor unit, so the multiplication drifts
   * and the trace stops agreeing with the ledger it belongs to.
   */
  lineValue: number
}

/**
 * A layer, for a test fixture or a caller building a shelf directly.
 *
 * ── Ordinary receipts do NOT come through here any more ─────────────────────
 *
 * `postMovement` creates the layer for every inbound movement, so a caller
 * that posts a receipt and then calls this would make two layers for one
 * delivery. The three callers that used to do both no longer do.
 *
 * ── It no longer merges ─────────────────────────────────────────────────────
 *
 * A second delivery under the same supplier lot number used to top up the
 * first layer and overwrite its price. That collapsed two deliveries bought at
 * two prices into one layer at the newer price — destroying exactly the
 * information FIFO exists to keep, and doing it silently. A repeat number is
 * suffixed instead; the label is a delivery's name, not its identity.
 */
export async function upsertBatch(
  tx: TxClient,
  params: {
    restaurantId: string
    itemId: string
    batchNo: string
    quantity: number
    /** Exactly what was paid, minor units. Preferred over `unitCost`. */
    value?: number
    unitCost?: number
    expiryDate?: Date | null
    locationId?: string | null
    branchId: string
    receivedAt?: Date | null
  },
): Promise<StockBatch> {
  /*
   * The exact total where the caller has one, else the per-unit price times
   * the quantity. A per-unit price cannot carry an exact total — 650 over
   * 1,000 g rounds to 1 a gram and books the delivery at 1,000 — which is why
   * `value` wins wherever it is known.
   */
  const value =
    params.value !== undefined && params.value >= 0
      ? Math.round(params.value)
      : Math.round(params.quantity * (params.unitCost ?? 0))

  let batchNo = params.batchNo
  for (let attempt = 1; attempt <= 50; attempt += 1) {
    const clash = await tx.stockBatch.findFirst({
      where: {
        restaurantId: params.restaurantId,
        branchId: params.branchId,
        itemId: params.itemId,
        batchNo,
      },
      select: { id: true },
    })
    if (!clash) break
    batchNo = `${params.batchNo}#${attempt + 1}`
  }

  return tx.stockBatch.create({
    data: {
      restaurantId: params.restaurantId,
      itemId: params.itemId,
      batchNo,
      receivedQty: params.quantity,
      remainingQty: params.quantity,
      receivedValue: value,
      remainingValue: value,
      // Derived from the value, for display and for recall.
      unitCost: params.quantity > 0 ? Math.round(value / params.quantity) : 0,
      expiryDate: params.expiryDate ?? null,
      locationId: params.locationId ?? null,
      branchId: params.branchId,
      ...(params.receivedAt ? { receivedAt: params.receivedAt } : {}),
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

  /*
   * The same walk the FIFO draw uses, on a differently ordered list.
   *
   * It had its own loop, which is how the two came to disagree: this one
   * computed no value at all, so anything costed through it was left to the
   * running average. One walk means one arithmetic — including the rule that
   * a draw emptying a layer takes exactly what is left in it.
   */
  const draw = walkFifo({
    lots: ordered.map((batch) => ({
      batchId: batch.id,
      batchNo: batch.batchNo,
      remaining: batch.remainingQty,
      remainingValue: batch.remainingValue,
      unitCost: batch.unitCost,
    })),
    quantity: params.quantity,
  })

  const byId = new Map(ordered.map((batch) => [batch.id, batch]))
  const allocations: BatchAllocation[] = draw.lots.map((lot) => ({
    batchId: lot.batchId!,
    batchNo: lot.batchNo!,
    expiryDate: byId.get(lot.batchId!)?.expiryDate ?? null,
    quantity: lot.quantity,
    unitCost: lot.unitCost,
    lineValue: lot.lineValue,
  }))

  return { allocations, shortfall: draw.shortfall }
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


/**
 * What one outbound draw of `quantity` WOULD come to, oldest receipt first.
 *
 * ── A preview. The allocator is elsewhere ───────────────────────────────────
 *
 * This reads layers and costs a draw without touching anything, for the
 * screens that show what an issue is about to cost. The draw that actually
 * moves stock is `allocateAndConsume` in `./fifo`, called from `postMovement`
 * and nowhere else — this function used to be called just before that, which
 * is precisely how two production runs could allocate the same layer twice:
 * the read happened before the lock was taken.
 *
 * Both walk the same layers with the same `walkFifo`, so the preview and the
 * draw agree by construction.
 *
 * ── What is gone ────────────────────────────────────────────────────────────
 *
 * The "unlotted" remainder — stock no layer accounted for, priced at the
 * item's running average and drawn after every real layer. The opening-layer
 * migration gave that stock a real layer, so the average has no part in this
 * any more. A shortfall is still reported and still has no price (FIFO.md).
 */
export interface FifoAllocation {
  /** Layers, oldest receipt first, each at its own rate. */
  lots: BatchAllocation[]
  /** Base units no layer covers. Never priced. */
  shortfall: number
  /** The exact value of everything allocated, minor units. An integer. */
  totalValue: number
}

export async function allocateFifo(
  db: TxClient | typeof prisma,
  params: { restaurantId: string; itemId: string; quantity: number; branchId: string },
): Promise<FifoAllocation> {
  if (!(params.quantity > 0)) {
    throw new AppError('Quantity must be above zero', 400, 'STOCK_BAD_QUANTITY')
  }

  const batches = await db.stockBatch.findMany({
    where: {
      restaurantId: params.restaurantId,
      itemId: params.itemId,
      branchId: params.branchId,
      remainingQty: { gt: 0 },
    },
    // Receipt order, then creation order for two receipts in the same instant.
    orderBy: [{ receivedAt: 'asc' }, { createdAt: 'asc' }],
  })

  const draw = walkFifo({
    lots: batches.map((batch) => ({
      batchId: batch.id,
      batchNo: batch.batchNo,
      remaining: batch.remainingQty,
      remainingValue: batch.remainingValue,
      unitCost: batch.unitCost,
    })),
    quantity: params.quantity,
  })

  const byId = new Map(batches.map((batch) => [batch.id, batch]))
  return {
    lots: draw.lots.map((lot) => ({
      batchId: lot.batchId!,
      batchNo: lot.batchNo!,
      expiryDate: byId.get(lot.batchId!)?.expiryDate ?? null,
      quantity: lot.quantity,
      unitCost: lot.unitCost,
      lineValue: lot.lineValue,
    })),
    shortfall: draw.shortfall,
    totalValue: draw.totalValue,
  }
}
