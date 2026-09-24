import 'server-only'

import type { Prisma } from '@prisma/client'

import { AppError } from '@/lib/errors'
import { roundQty, sameQty } from '@/lib/quantity'
import { walkFifo, type FifoLot } from './fifo-walk'

/**
 * The one place stock is allocated out of layers and into them (FIFO.md).
 *
 * ── Why there is only one ───────────────────────────────────────────────────
 *
 * There were several. `allocateFifo` walked by receipt date and was used by
 * production alone; `allocateFefo` walked by expiry date, computed no cost at
 * all, and was what the ledger reached for on everything else — and only when
 * the item happened to have batch tracking switched on, which is off by
 * default. Two orderings mutated the same column, most items never drained
 * their layers, and of twenty callers that moved stock, two costed it from the
 * layers they drew.
 *
 * So allocation lives here and `postMovement` is the only caller. Every
 * movement in the system goes through `postMovement`, so every movement is
 * costed the same way by construction rather than by twenty callers each
 * remembering to.
 *
 * ── Why here and not in each caller ─────────────────────────────────────────
 *
 * `postMovement` already takes `SELECT … FOR UPDATE` on the item row and holds
 * it for the rest of the transaction. Allocation done anywhere else races
 * against it: production read its layers BEFORE that lock, so a second run
 * could compute a draw against layers the first had already taken, and both
 * would commit. Allocating inside the lock is not a tidiness argument, it is
 * the fix.
 *
 * ── Ordering ────────────────────────────────────────────────────────────────
 *
 * Oldest receipt first, always, for every draw. Expiry order is a PICKING
 * instruction — which carton to reach for — and a layer is one object with
 * both a quantity and a price, so drawing down one layer while charging
 * another is incoherent. The expiry board still advises; it no longer costs.
 */

type TxClient = Prisma.TransactionClient

/** One layer's share of a movement. */
export interface LayerDraw {
  batchId: string | null
  batchNo: string | null
  /** Base units, always positive; the movement's own sign says the direction. */
  quantity: number
  unitCost: number
  /** Minor units, always positive. These sum to the movement's value. */
  lineValue: number
  /** No layer covered this slice; the value is zero, never a guess. */
  uncosted: boolean
}

export interface Allocation {
  draws: LayerDraw[]
  /** The exact value drawn, minor units. An integer. */
  totalValue: number
  /** Base units no layer could cover. */
  uncoveredQty: number
}

/**
 * Read this branch's open layers for one item, oldest receipt first, and lock
 * them for the rest of the transaction.
 *
 * `FOR UPDATE` is belt to the item lock's braces. The item row is already
 * locked by the time this runs, so in practice this never waits — but a future
 * path that reaches layers another way will, and that is the point of it.
 */
async function lockedLayers(
  tx: TxClient,
  params: { restaurantId: string; itemId: string; branchId: string },
): Promise<Array<FifoLot & { id: string }>> {
  const rows = await tx.$queryRaw<
    Array<{ id: string; batchNo: string; remainingQty: number; remainingValue: number; unitCost: number }>
  >`
    SELECT id, "batchNo", "remainingQty", "remainingValue", "unitCost"
      FROM stock_batches
     WHERE "restaurantId" = ${params.restaurantId}
       AND "itemId" = ${params.itemId}
       AND "branchId" = ${params.branchId}
       AND "remainingQty" > 0
     ORDER BY "receivedAt" ASC, "createdAt" ASC, id ASC
       FOR UPDATE
  `
  return rows.map((row) => ({
    id: row.id,
    batchId: row.id,
    batchNo: row.batchNo,
    remaining: row.remainingQty,
    remainingValue: row.remainingValue,
    unitCost: row.unitCost,
  }))
}

/**
 * Named layers to the front, everything else left in FIFO order behind them.
 *
 * ── The one case where oldest-first is the wrong answer ─────────────────────
 *
 * A return to supplier is not an issue of stock, it is the undoing of a
 * receipt. The goods physically going back on the lorry are the ones that came
 * off it, so they leave at what that delivery charged — which is the price the
 * supplier is about to credit. Draw oldest-first instead and the two figures
 * disagree: return 5 kg from a 100/kg delivery while the oldest layer sits at
 * 80/kg and inventory falls 400 against a 500 credit, booking a 100 profit on
 * having sent goods back. Repeat that on every return and a restaurant can
 * show a margin on its own paperwork.
 *
 * So a caller that knows which layers the stock came from says so, and the
 * rest of the queue stays exactly as it was behind them — a return for more
 * than that delivery held still falls through to normal FIFO rather than
 * failing or inventing a layer.
 */
function orderPreferred(
  layers: Array<FifoLot & { id: string }>,
  prefer: string[] | null | undefined,
): Array<FifoLot & { id: string }> {
  if (!prefer || prefer.length === 0) return layers

  const rank = new Map(prefer.map((id, index) => [id, index]))
  const front: Array<FifoLot & { id: string }> = []
  const rest: Array<FifoLot & { id: string }> = []
  for (const layer of layers) {
    if (rank.has(layer.id)) front.push(layer)
    else rest.push(layer)
  }
  front.sort((a, b) => rank.get(a.id)! - rank.get(b.id)!)
  return [...front, ...rest]
}

/**
 * Draw `quantity` out of this branch's layers, oldest first, and write them
 * down. Returns what was drawn and what it was worth.
 *
 * The caller has already decided whether running out is allowed — that is the
 * restaurant's `allowNegativeStock` policy, checked in `postMovement`. What is
 * NOT negotiable is the price of stock that is not there: it has none. An
 * uncovered draw is recorded with a zero value and an `uncosted` flag so the
 * gap is visible and correctable, rather than filled in from an average.
 */
export async function allocateAndConsume(
  tx: TxClient,
  params: {
    restaurantId: string
    itemId: string
    branchId: string
    quantity: number
    /**
     * Take from these layers first, in this order, before falling back to
     * oldest-first — see `orderPreferred`.
     */
    preferLayers?: string[] | null
  },
): Promise<Allocation> {
  if (!(params.quantity > 0)) return { draws: [], totalValue: 0, uncoveredQty: 0 }

  const layers = orderPreferred(await lockedLayers(tx, params), params.preferLayers)
  const draw = walkFifo({ lots: layers, quantity: params.quantity })
  const byId = new Map(layers.map((layer) => [layer.id, layer]))

  for (const line of draw.lots) {
    const layer = byId.get(line.batchId!)
    if (!layer) continue

    /*
     * The draw that empties a layer zeroes it outright rather than subtracting
     * to something like 1e-16. A layer left nominally open with no value in it
     * would be offered to the next walk and draw for free.
     */
    const clears = sameQty(line.quantity, layer.remaining)
    const nextQty = clears ? 0 : roundQty(layer.remaining - line.quantity)
    const nextValue = clears ? 0 : layer.remainingValue - line.lineValue

    /*
     * Compare-and-set, not a bare decrement.
     *
     * The layers are locked above, so this cannot fail today. It is here so
     * that if anything ever reaches a layer without taking the lock, the
     * result is a loud 409 rather than a quiet double-spend — which is what
     * the bare `decrement` this replaces would have produced.
     */
    const written = await tx.stockBatch.updateMany({
      where: { id: layer.id, remainingQty: layer.remaining, remainingValue: layer.remainingValue },
      data: { remainingQty: nextQty, remainingValue: nextValue },
    })
    if (written.count !== 1) {
      throw new AppError(
        'That stock moved while it was being costed. Try again.',
        409,
        'FIFO_LAYER_RACE',
      )
    }
  }

  const draws: LayerDraw[] = draw.lots.map((line) => ({
    batchId: line.batchId,
    batchNo: line.batchNo,
    quantity: line.quantity,
    unitCost: line.unitCost,
    lineValue: line.lineValue,
    uncosted: false,
  }))

  // What no layer could cover, recorded rather than priced.
  if (draw.shortfall > 1e-9) {
    draws.push({
      batchId: null,
      batchNo: null,
      quantity: roundQty(draw.shortfall),
      unitCost: 0,
      lineValue: 0,
      uncosted: true,
    })
  }

  return { draws, totalValue: draw.totalValue, uncoveredQty: roundQty(Math.max(0, draw.shortfall)) }
}

/**
 * Put stock into a new layer.
 *
 * Every inbound movement makes one — a delivery, a production run, a transfer
 * arriving, stock coming back off a cancelled order. It used to be three
 * callers, so everything else arrived with no layer at all and had to be
 * costed at the running average for ever afterwards.
 *
 * A second delivery of the same supplier lot number is a SECOND layer, never a
 * top-up of the first. `upsertBatch` merged them and overwrote the price,
 * which collapsed two layers bought at two prices into one — the exact
 * information FIFO exists to keep.
 */
export async function createLayer(
  tx: TxClient,
  params: {
    restaurantId: string
    itemId: string
    branchId: string
    locationId?: string | null
    quantity: number
    /** Exactly what was paid, minor units. Not a per-unit price. */
    value: number
    batchNo?: string | null
    expiryDate?: Date | null
    /** Transfers carry the source layer's date, so FIFO order survives the trip. */
    receivedAt?: Date | null
  },
): Promise<{ id: string; batchNo: string } | null> {
  const quantity = roundQty(params.quantity)
  if (!(quantity > 0)) return null

  const value = Math.max(0, Math.round(params.value))
  const batchNo = params.batchNo?.trim() || `L-${Date.now().toString(36).toUpperCase()}`

  /*
   * A lot number is unique within a branch, so a repeat of the same number is
   * suffixed rather than merged. The label is a delivery's name, not its
   * identity — two deliveries under one name are still two deliveries.
   */
  let candidate = batchNo
  for (let attempt = 1; attempt <= 50; attempt += 1) {
    const clash = await tx.stockBatch.findFirst({
      where: {
        restaurantId: params.restaurantId,
        branchId: params.branchId,
        itemId: params.itemId,
        batchNo: candidate,
      },
      select: { id: true },
    })
    if (!clash) break
    candidate = `${batchNo}#${attempt + 1}`
  }

  const created = await tx.stockBatch.create({
    data: {
      restaurantId: params.restaurantId,
      itemId: params.itemId,
      branchId: params.branchId,
      locationId: params.locationId ?? null,
      batchNo: candidate,
      receivedQty: quantity,
      remainingQty: quantity,
      receivedValue: value,
      remainingValue: value,
      // Derived, for display and for recall. The value above is the figure.
      unitCost: quantity > 0 ? Math.round(value / quantity) : 0,
      expiryDate: params.expiryDate ?? null,
      ...(params.receivedAt ? { receivedAt: params.receivedAt } : {}),
    },
    select: { id: true, batchNo: true },
  })
  return created
}

/**
 * Put stock back on the layers it came off.
 *
 * A cancelled order, a voided line, a recalled transfer. Without this a
 * reversal returns the quantity at whatever the average happens to be that
 * day, so cancelling an order creates or destroys value whenever prices have
 * moved since the sale — which is how a cancellation can change last month's
 * margin.
 *
 * Newest first: "deduct 3, deduct 2, return 2" must put back the second
 * deduction, not a slice of each. Netted against what has already been
 * restored for the same reference, so running it twice restores nothing the
 * second time.
 */
export async function restoreToLayers(
  tx: TxClient,
  params: {
    restaurantId: string
    itemId: string
    branchId: string
    referenceType: string
    referenceId: string
    quantity: number
  },
): Promise<Allocation> {
  const want = roundQty(params.quantity)
  if (!(want > 0)) return { draws: [], totalValue: 0, uncoveredQty: 0 }

  /*
   * What this reference took out of each layer, and what it has already had
   * put back. A restore row carries a positive quantity, a consumption a
   * negative one, so the net is what is still out.
   */
  const rows = await tx.stockMovementLot.findMany({
    where: {
      restaurantId: params.restaurantId,
      movement: {
        itemId: params.itemId,
        branchId: params.branchId,
        referenceType: params.referenceType,
        referenceId: params.referenceId,
      },
    },
    select: {
      batchId: true,
      batchNo: true,
      quantity: true,
      lineValue: true,
      uncosted: true,
      movement: { select: { id: true, quantity: true, createdAt: true } },
    },
    orderBy: { createdAt: 'desc' },
  })

  const outstanding = new Map<string, { batchId: string | null; batchNo: string | null; qty: number; value: number }>()
  for (const row of rows) {
    const key = row.batchId ?? `__uncosted__${row.uncosted}`
    const held = outstanding.get(key) ?? {
      batchId: row.batchId,
      batchNo: row.batchNo,
      qty: 0,
      value: 0,
    }
    // An outbound movement is negative; its lot rows describe what it took.
    const sign = row.movement.quantity < 0 ? 1 : -1
    held.qty = roundQty(held.qty + sign * row.quantity)
    held.value += sign * row.lineValue
    outstanding.set(key, held)
  }

  const draws: LayerDraw[] = []
  let left = want
  let totalValue = 0

  for (const held of outstanding.values()) {
    if (left <= 1e-9) break
    if (held.qty <= 1e-9) continue

    const take = roundQty(Math.min(held.qty, left))
    /*
     * The same clearing rule the draw uses, so a full reversal returns exactly
     * the value the sale removed — to the minor unit, whatever the partial
     * restores rounded along the way.
     */
    const clears = sameQty(take, held.qty)
    const value = clears
      ? Math.max(0, held.value)
      : Math.min(Math.max(0, Math.round((held.value * take) / held.qty)), Math.max(0, held.value))

    if (held.batchId) {
      const restored = await tx.stockBatch.updateMany({
        where: { id: held.batchId, restaurantId: params.restaurantId },
        data: { remainingQty: { increment: take }, remainingValue: { increment: value } },
      })
      // The layer is gone — cleaned up, or its branch retired. The quantity
      // still has to come back, so it comes back as its own layer.
      if (restored.count !== 1) {
        await createLayer(tx, {
          restaurantId: params.restaurantId,
          itemId: params.itemId,
          branchId: params.branchId,
          quantity: take,
          value,
          batchNo: held.batchNo,
        })
      }
    }

    draws.push({
      batchId: held.batchId,
      batchNo: held.batchNo,
      quantity: take,
      unitCost: take > 0 ? Math.round(value / take) : 0,
      lineValue: value,
      uncosted: held.batchId === null,
    })
    totalValue += value
    left = roundQty(left - take)
  }

  /*
   * More is coming back than this reference ever took — a correction, or stock
   * returned against the wrong document. It goes back as a new layer with no
   * value, because there is no record of it having had any.
   */
  if (left > 1e-9) {
    draws.push({ batchId: null, batchNo: null, quantity: left, unitCost: 0, lineValue: 0, uncosted: true })
  }

  return { draws, totalValue, uncoveredQty: left > 1e-9 ? left : 0 }
}

/**
 * What the next unit out of this shelf costs.
 *
 * FIFO.md: "Current Unit Cost" means the cost of the NEXT stock to be
 * consumed, not an average and not the latest purchase price. That is the
 * first open layer's own rate.
 */
export async function currentUnitCost(
  db: TxClient | { stockBatch: TxClient['stockBatch'] },
  params: { restaurantId: string; itemId: string; branchId: string },
): Promise<number> {
  const layer = await db.stockBatch.findFirst({
    where: {
      restaurantId: params.restaurantId,
      itemId: params.itemId,
      branchId: params.branchId,
      remainingQty: { gt: 0 },
    },
    orderBy: [{ receivedAt: 'asc' }, { createdAt: 'asc' }],
    select: { remainingQty: true, remainingValue: true, unitCost: true },
  })
  if (!layer) return 0
  return layer.remainingQty > 0 ? Math.round(layer.remainingValue / layer.remainingQty) : layer.unitCost
}

/**
 * The same, for a screenful of items at once.
 *
 * The inventory list renders hundreds of rows and asking per row would be
 * hundreds of queries. One query, then the first layer per item wins.
 */
export async function currentUnitCostMany(
  db: TxClient | { stockBatch: TxClient['stockBatch'] },
  params: { restaurantId: string; branchId: string | null; itemIds: string[] },
): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (params.itemIds.length === 0) return out

  const layers = await db.stockBatch.findMany({
    where: {
      restaurantId: params.restaurantId,
      itemId: { in: params.itemIds },
      ...(params.branchId ? { branchId: params.branchId } : {}),
      remainingQty: { gt: 0 },
    },
    orderBy: [{ receivedAt: 'asc' }, { createdAt: 'asc' }],
    select: { itemId: true, remainingQty: true, remainingValue: true, unitCost: true },
  })

  for (const layer of layers) {
    if (out.has(layer.itemId)) continue
    out.set(
      layer.itemId,
      layer.remainingQty > 0 ? Math.round(layer.remainingValue / layer.remainingQty) : layer.unitCost,
    )
  }
  return out
}

/** What a branch's shelf is worth: an integer sum of layer values. */
export async function stockValueAt(
  db: TxClient | { stockBatch: TxClient['stockBatch'] },
  params: { restaurantId: string; itemId?: string; branchId?: string | null },
): Promise<number> {
  const sum = await db.stockBatch.aggregate({
    where: {
      restaurantId: params.restaurantId,
      ...(params.itemId ? { itemId: params.itemId } : {}),
      ...(params.branchId ? { branchId: params.branchId } : {}),
      remainingQty: { gt: 0 },
    },
    _sum: { remainingValue: true },
  })
  return sum._sum.remainingValue ?? 0
}
