import 'server-only'

import type { InventoryItem, StockMovement, StockMovementType, StockUnit } from '@prisma/client'

import { AppError, NotFoundError } from '@/lib/errors'
import { assertPeriodOpen } from '@/features/accounting/service'
import { roundQty, sameQty } from '@/lib/quantity'
import { emitOutbox } from '@/server/realtime/outbox'
import { EVENTS } from '@/lib/realtime/events'
import { prisma, type TxClient, guardLocks} from '@/server/db/prisma'
import { toBaseUnits, formatQuantity } from './units'
import { applyLocationDelta } from './location-stock'
import { type BatchAllocation } from './batches'
import { allocateAndConsume, createLayer, restoreToLayers } from './fifo'

/**
 * The stock ledger.
 *
 * `postMovement` is the only function in the codebase that may change an
 * inventory balance. Everything else — receiving a purchase, deducting a sale,
 * recording wastage, approving a stock count — goes through it, so there is no
 * path by which stock moves without a dated, attributed, reasoned row.
 *
 * ── Source of truth ─────────────────────────────────────────────────────────
 *
 * The ledger is authoritative. `InventoryItem.quantity` is a cache kept for
 * fast reads and is written only here, inside the same transaction as the row
 * that justifies it, so the two cannot drift. `recomputeBalance` replays the
 * ledger and is used by the tests to prove that.
 *
 * ── Direction ───────────────────────────────────────────────────────────────
 *
 * Callers pass a positive magnitude and the movement type decides the sign.
 * Letting callers pass negative numbers invites a sign error that reads as a
 * plausible balance, so the direction is derived from the type instead.
 *
 * ── Negative stock ──────────────────────────────────────────────────────────
 *
 * An outward movement that would take the balance below zero is refused, unless
 * the restaurant has set `allowNegativeStock`. Allowing it unconditionally is
 * defensible — a guest should not be turned away because a delivery was not
 * keyed in — but it is the owner's trade to make, and left on by default it
 * quietly produced balances no report could be trusted against.
 *
 * Corrections are always allowed through, whatever the setting: an adjustment,
 * an opening balance or a stock count must be able to record the truth,
 * including an uncomfortable one.
 *
 * ── Batches ─────────────────────────────────────────────────────────────────
 *
 * Outgoing stock is drawn from real lots, earliest expiry first, for any item
 * with `trackBatches`. Done here rather than in each caller so a sale, a
 * production run and a wastage entry cannot disagree about it.
 */

/** Movement types that add stock. Everything else removes it. */
const INBOUND: StockMovementType[] = [
  'PURCHASE',
  'ADJUSTMENT_IN',
  'TRANSFER_IN',
  'CUSTOMER_RETURN',
  'PRODUCTION',
  'PRODUCTION_OUTPUT',
  // Puts stock back when an order shrinks or is cancelled.
  'SALE_REVERSAL',
  'OPENING_BALANCE',
  'RETURN',
]

const OUTBOUND: StockMovementType[] = [
  'SALE',
  'WASTAGE',
  'ADJUSTMENT_OUT',
  'TRANSFER_OUT',
  'RETURN_TO_SUPPLIER',
  'EXPIRY',
  'CONSUMPTION',
  'WASTE',
  'PRODUCTION_CONSUMPTION',
]

/**
 * Which way a movement type moves stock.
 *
 * Only the legacy `ADJUSTMENT` type carries its own sign; everything else must
 * be listed explicitly. An unlisted type throws rather than defaulting to
 * signed, because a new type silently falling through to "add stock" is exactly
 * the bug this guard exists to prevent — it reads as a plausible balance and is
 * invisible until a stock take.
 */
export function directionOf(type: StockMovementType): 1 | -1 | 0 {
  if (INBOUND.includes(type)) return 1
  if (OUTBOUND.includes(type)) return -1
  if (type === 'ADJUSTMENT') return 0
  throw new AppError(
    `Movement type ${type} has no direction defined`,
    500,
    'STOCK_UNKNOWN_DIRECTION',
  )
}

export interface PostMovementParams {
  restaurantId: string
  itemId: string
  type: StockMovementType
  /** Positive magnitude in `enteredUnit`; the type decides the direction. */
  quantity: number
  /** Defaults to the item's own base unit. */
  enteredUnit?: StockUnit | null
  /** Cost per base unit in minor units — only meaningful on inbound receipts. */
  unitCost?: number
  /**
   * The EXACT value of this inbound movement, in minor units, unrounded.
   *
   * A per-unit cost cannot carry an exact total: 650.00 spread over 1,000 g is
   * 65 minor units a gram, but 6.50 over 1,000 g is 0.65 — which `unitCost`,
   * an integer, cannot say, and rounding it to 1 would book a run at 54% more
   * than it consumed. Production passes what its ingredients were actually
   * worth and this wins over `unitCost` when both are given.
   *
   * DELIBERATE behaviour change 2026-09 (pro.b.md §5): honoured on OUTBOUND
   * movements too, when a caller supplies it. It used to be ignored there and
   * every issue left at the running average. Production now values what it
   * consumes at the lots it actually drew — oldest first, each at its own
   * price — and hands that exact figure here. Every other caller passes
   * nothing and gets the average, exactly as before. Capped at the value on
   * hand, so no caller can remove more worth than the shelf holds.
   */
  totalValue?: number
  /**
   * Which lots this outbound movement draws from, already decided
   * (pro.b.md §4, §5).
   *
   * When given, exactly these lots are drawn down and the FEFO pass below is
   * skipped, so a lot is never decremented twice. Production allocates by
   * receipt date and records the split on its own trace rows; this is how
   * the split reaches the lots. Ignored on inbound movements.
   */
  allocations?: BatchAllocation[]
  reason?: string | null
  notes?: string | null
  referenceType?: string | null
  referenceId?: string | null
  /**
   * Where this happened. Required, and deliberately.
   *
   * It was optional, falling back to `item.branchId` and then to null — and
   * `applyLocationDelta` returns early on a null branch, so a movement with no
   * location moved the restaurant-wide quantity while no location's balance
   * changed. That is the drift the reconciliation report was built to find,
   * and the ledger was manufacturing it. Two callers were relying on the
   * fallback; both turned out to be posting at a location they knew.
   */
  branchId: string
  locationId?: string | null
  userId?: string | null
  /**
   * When this stock was received, for the layer it creates.
   *
   * A transfer passes the SOURCE layer's date so the stock keeps its place in
   * the FIFO queue at the far end. Everything else leaves it unset and the
   * layer is dated now.
   */
  receivedAt?: Date | null
  /**
   * Put this stock back on the layers a previous movement took it off.
   *
   * Named by what caused the original — the order, the transfer — because a
   * reversal is usually a net correction across several movements rather than
   * the undoing of one. `SALE_REVERSAL` does this automatically from its own
   * reference; anything else asks.
   */
  restoreFrom?: { referenceType: string; referenceId: string } | null
  /**
   * Create exactly these layers instead of one (FIFO.md).
   *
   * A transfer arriving is not one delivery at a blended price — it is the
   * source's layers, moved. One destination layer per source layer, each
   * carrying the value and the ORIGINAL receipt date, so six-month-old stock
   * does not arrive looking fresh and stop being drawn first. Inbound only.
   */
  intoLayers?: Array<{
    quantity: number
    /** Minor units, exact. */
    value: number
    batchNo?: string | null
    receivedAt?: Date | null
    expiryDate?: Date | null
  }> | null
  /**
   * Draw from these layers first, then normal FIFO for anything left.
   *
   * For an outbound movement that is undoing a specific receipt rather than
   * issuing stock — a return to supplier being the one that matters. The goods
   * leave at what that delivery charged, which is what the supplier credits,
   * so the return nets to zero instead of booking a profit on the difference
   * between that price and the oldest layer's.
   */
  preferLayers?: string[] | null
  batchNo?: string | null
  /** Ties the movement to a specific lot when the item is batch-tracked. */
  batchId?: string | null
  expiryDate?: Date | null
  stockCountId?: string | null
  orderId?: string | null
  purchaseId?: string | null
}

export interface PostedMovement {
  movement: StockMovement
  item: InventoryItem
  balanceBefore: number
  balanceAfter: number
  /** True when this movement drove the balance below zero. */
  wentNegative: boolean
  /**
   * The exact value that moved, minor units, unrounded: what an inbound
   * movement added to `stockValue`, or what an outbound one removed at the
   * running average. `movement.unitCost` is the rounded per-unit snapshot; a
   * caller that needs to hand value on exactly — production turning raw stock
   * into a prepared item — reads this instead of multiplying that back out.
   * On an outbound movement that drives stock negative it is capped at the
   * value that was actually on hand.
   */
  valueMoved: number
}

/**
 * Write one movement and move the balance with it.
 *
 * Must be called inside a transaction. The item row is locked first so two
 * concurrent movements cannot both read the same starting balance and write
 * `balanceAfter` values that disagree with the ledger.
 */
export async function postMovement(
  tx: TxClient,
  params: PostMovementParams,
): Promise<PostedMovement> {
  if (!Number.isFinite(params.quantity) || params.quantity === 0) {
    throw new AppError('Quantity must be a number other than zero', 400, 'STOCK_BAD_QUANTITY')
  }

  /*
   * Sealed books refuse deliberate stock operations (§59, production.md §2).
   *
   * Every movement is dated `now()` — nothing here accepts a caller-supplied
   * date, which is what already makes the ledger's history immutable. So the
   * only way stock can land in a signed-off range is if the period covering
   * TODAY has been closed, and this is where that gets refused. Guarding here
   * rather than at the six calling features is deliberate: `postMovement` is
   * the sole balance writer, so a future caller cannot forget the check.
   *
   * The order-driven types are exempt, and that is a considered trade rather
   * than an oversight. A SALE deduction refused mid-transaction rolls back the
   * order that caused it, so sealing the current period would stop the kitchen
   * serving food — a far worse failure than a movement landing in a sealed
   * range, and one an owner would experience as the system breaking. Trading
   * keeps working; what stops is anyone reaching back to revalue the range by
   * receiving, wasting, adjusting, transferring or approving a count into it.
   */
  const TRADING: StockMovementType[] = ['SALE', 'SALE_REVERSAL', 'CONSUMPTION']
  if (!TRADING.includes(params.type)) {
    await assertPeriodOpen(tx, params.restaurantId, new Date(), 'This stock movement')
  }

  const direction = directionOf(params.type)
  if (direction !== 0 && params.quantity < 0) {
    throw new AppError(
      'Pass a positive quantity — the movement type decides whether stock goes in or out',
      400,
      'STOCK_SIGNED_QUANTITY',
    )
  }

  // Lock the row for the rest of the transaction. Postgres releases it on
  // commit or rollback, so a crash cannot leave an item locked.
  await guardLocks(tx)
  const locked = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM inventory_items
    WHERE id = ${params.itemId} AND "restaurantId" = ${params.restaurantId}
    FOR UPDATE
  `
  if (locked.length === 0) throw new NotFoundError('Inventory item')

  const item = await tx.inventoryItem.findFirstOrThrow({
    where: { id: params.itemId, restaurantId: params.restaurantId },
  })

  const enteredUnit = params.enteredUnit ?? item.unit
  const magnitude = toBaseUnits(Math.abs(params.quantity), enteredUnit, item)
  const signed = direction === 0 ? toBaseUnits(params.quantity, enteredUnit, item) : magnitude * direction

  const balanceBefore = item.quantity
  const balanceAfter = roundQty(balanceBefore + signed)

  /*
   * Refuse to go negative unless this restaurant has said otherwise.
   *
   * Previously allowed unconditionally: `wentNegative` was computed here and
   * read by nothing, so a sale could always drive stock below zero and the only
   * trace was a negative number on a report. That is defensible for a busy
   * kitchen — refusing to serve a guest because a delivery was not keyed in is
   * usually the worse outcome — but it is the owner's call, not a constant.
   *
   * Corrections are always allowed through: a stock count, an adjustment or a
   * transfer reversal must be able to set the truth, including a negative one,
   * or an owner could not fix the very problem this refusal creates.
   */
  const CORRECTIONS: StockMovementType[] = ['ADJUSTMENT', 'ADJUSTMENT_OUT', 'OPENING_BALANCE']
  if (balanceAfter < 0 && !CORRECTIONS.includes(params.type)) {
    const restaurant = await tx.restaurant.findUnique({
      where: { id: params.restaurantId },
      select: { allowNegativeStock: true },
    })
    if (!restaurant?.allowNegativeStock) {
      throw new AppError(
        `Not enough ${item.name}: ${formatQuantity(balanceBefore, item.unit)} left, ` +
          `${formatQuantity(magnitude, item.unit)} needed. ` +
          'Record the delivery first, or allow negative stock in settings.',
        409,
        'STOCK_INSUFFICIENT',
      )
    }
  }

  /*
   * The same refusal PER BRANCH. The check above reads the restaurant-wide
   * total, so a branch holding nothing could keep selling for as long as some
   * OTHER branch had stock — its own balance sank below zero while the total
   * stayed healthy, and the reconciliation report found the hole weeks later.
   * Same policy switch, same correction escape hatch.
   */
  if (signed < 0 && !CORRECTIONS.includes(params.type)) {
    // Summed across shelves: what the BRANCH holds, wherever it sits.
    const here = await tx.inventoryStock.aggregate({
      where: { itemId: item.id, branchId: params.branchId, restaurantId: params.restaurantId },
      _sum: { available: true },
    })
    const atBranch = here._sum.available ?? 0
    const branchAfter = roundQty(atBranch + signed)
    if (branchAfter < 0) {
      const restaurant = await tx.restaurant.findUnique({
        where: { id: params.restaurantId },
        select: { allowNegativeStock: true },
      })
      if (!restaurant?.allowNegativeStock) {
        throw new AppError(
          `Not enough ${item.name} at this location: ${formatQuantity(atBranch, item.unit)} here, ` +
            `${formatQuantity(magnitude, item.unit)} needed. ` +
            'Transfer stock in or record the delivery first.',
          409,
          'STOCK_INSUFFICIENT_BRANCH',
        )
      }
    }
  }

  /*
   * ── What this stock was worth when it moved (FIFO.md) ─────────────────────
   *
   * This is the change the whole FIFO rebuild turns on.
   *
   * It used to be `valueUpdate`: a weighted-average pool on the item, with an
   * inbound movement recomputing `costPerUnit = value / quantity` and an
   * outbound one removing a pro-rata slice of it. The FIFO layers sat beside
   * that pool as a side record, drained only when the item happened to have
   * batch tracking switched on, and consulted for costing by exactly one
   * caller out of twenty. Two systems, two answers, and the average won.
   *
   * Now the layers ARE the valuation. Outbound draws them oldest first and is
   * worth exactly what it drew; inbound creates one and is worth exactly what
   * was paid. `stockValue` and `costPerUnit` on the item become caches of the
   * layers, recomputed below, rather than the thing being maintained.
   *
   * Allocation happens HERE, inside the item lock taken above, and not in the
   * caller. That is not tidiness: production used to allocate just before
   * calling this, so a second run could compute its draw against layers the
   * first had already taken and both would commit. Inside the lock, it cannot.
   */
  /*
   * A reversal puts stock back where it came from.
   *
   * `SALE_REVERSAL` names the order it is unwinding, so the trace rows that
   * order's consumption wrote say which layers to credit and by how much. Any
   * caller can ask for the same by naming a reference explicitly.
   */
  const restoreRef =
    params.restoreFrom ??
    (signed > 0 && params.type === 'SALE_REVERSAL' && params.referenceType && params.referenceId
      ? { referenceType: params.referenceType, referenceId: params.referenceId }
      : null)

  const restoring = restoreRef
    ? await restoreToLayers(tx, {
        restaurantId: params.restaurantId,
        itemId: item.id,
        branchId: params.branchId,
        referenceType: restoreRef.referenceType,
        referenceId: restoreRef.referenceId,
        quantity: magnitude,
      })
    : null

  const drawn = signed < 0
    ? await allocateAndConsume(tx, {
        restaurantId: params.restaurantId,
        itemId: item.id,
        branchId: params.branchId,
        quantity: magnitude,
        preferLayers: params.preferLayers ?? null,
      })
    : null

  /*
   * What an inbound movement is worth, in order of authority:
   *
   *   1. the caller's exact total — a delivery knows its invoice, a production
   *      run knows what its ingredients cost, a transfer knows what the source
   *      layer held;
   *   2. the per-unit price it quoted;
   *   3. the item's own recorded cost.
   *
   * (3) is a fallback, not an average: `costPerUnit` is a figure somebody
   * recorded for this item, and a receipt keyed without a price is a gap in
   * the paperwork rather than a free delivery. Valuing it at nothing would
   * write stock onto the shelf worth zero and quietly understate the books.
   *
   * What is NOT here is the old rule: value an unpriced receipt at the running
   * weighted average of everything on hand. That is how a transfer used to
   * arrive valued at the destination's blend rather than at what the source
   * actually paid for it.
   */
  const inboundValue = signed > 0
    ? params.intoLayers && params.intoLayers.length > 0
      // The layers say what it is worth; nothing else can contradict them.
      ? params.intoLayers.reduce((sum, spec) => sum + Math.round(spec.value), 0)
      : params.totalValue !== undefined && params.totalValue >= 0
        ? Math.round(params.totalValue)
        : params.unitCost !== undefined && params.unitCost > 0
          ? Math.round(magnitude * params.unitCost)
          : Math.round(magnitude * item.costPerUnit)
    : 0

  const valueMoved = signed < 0 ? (drawn?.totalValue ?? 0) : (restoring?.totalValue ?? inboundValue)
  const unitCost = magnitude > 0 ? Math.round(valueMoved / magnitude) : 0

  const movement = await tx.stockMovement.create({
    data: {
      restaurantId: params.restaurantId,
      itemId: item.id,
      type: params.type,
      quantity: signed,
      quantityEntered: Math.abs(params.quantity),
      enteredUnit,
      balanceAfter,
      unitCost,
      // The exact figure. `unitCost` above is it rounded per unit, which cannot
      // be multiplied back out to reproduce this.
      valueMoved,
      reason: params.reason ?? null,
      notes: params.notes ?? null,
      referenceType: params.referenceType ?? null,
      referenceId: params.referenceId ?? null,
      branchId: params.branchId,
      locationId: params.locationId ?? item.locationId ?? null,
      userId: params.userId ?? null,
      batchNo: params.batchNo ?? null,
      batchId: params.batchId ?? null,
      expiryDate: params.expiryDate ?? null,
      stockCountId: params.stockCountId ?? null,
      orderId: params.orderId ?? null,
      purchaseId: params.purchaseId ?? null,
    },
  })

  /*
   * ── The layers this movement touched ──────────────────────────────────────
   *
   * Outbound was already drawn down by `allocateAndConsume` above, inside the
   * item lock. Inbound makes a layer here.
   *
   * It used to be neither, for most movements: layers were only consumed when
   * `item.trackBatches` was true — off by default — and only created by three
   * of twenty callers. So on an ordinary item layers grew with every delivery
   * and never came down, while transfers, returns, reversals and count gains
   * added stock that belonged to no layer at all and had to be costed at the
   * running average for ever after. Both halves are unconditional now.
   */
  if (signed > 0 && restoring) {
    /*
     * Stock coming back goes onto the layers it came off, at their values.
     *
     * Without this a reversal returns the quantity at whatever the item
     * happens to be worth today, so cancelling an order creates or destroys
     * value whenever prices have moved since the sale — which is how
     * cancelling last week's order can change last week's margin. The trace
     * rows written by the original movement are what make it possible.
     */
    for (const draw of restoring.draws) {
      await tx.stockMovementLot.create({
        data: {
          restaurantId: params.restaurantId,
          movementId: movement.id,
          batchId: draw.batchId,
          batchNo: draw.batchNo,
          quantity: draw.quantity,
          unitCost: draw.unitCost,
          lineValue: draw.lineValue,
          uncosted: draw.uncosted,
        },
      })
    }
  } else if (signed > 0 && params.intoLayers && params.intoLayers.length > 0) {
    // The source's layers, recreated here — see `intoLayers`.
    for (const spec of params.intoLayers) {
      const layer = await createLayer(tx, {
        restaurantId: params.restaurantId,
        itemId: item.id,
        branchId: params.branchId,
        locationId: params.locationId ?? item.locationId ?? null,
        quantity: spec.quantity,
        value: spec.value,
        batchNo: spec.batchNo ?? null,
        expiryDate: spec.expiryDate ?? params.expiryDate ?? null,
        receivedAt: spec.receivedAt ?? null,
      })
      if (layer) {
        await tx.stockMovementLot.create({
          data: {
            restaurantId: params.restaurantId,
            movementId: movement.id,
            batchId: layer.id,
            batchNo: layer.batchNo,
            quantity: spec.quantity,
            unitCost: spec.quantity > 0 ? Math.round(spec.value / spec.quantity) : 0,
            lineValue: spec.value,
          },
        })
      }
    }
  } else if (signed > 0) {
    const layer = await createLayer(tx, {
      restaurantId: params.restaurantId,
      itemId: item.id,
      branchId: params.branchId,
      locationId: params.locationId ?? item.locationId ?? null,
      quantity: magnitude,
      value: inboundValue,
      batchNo: params.batchNo ?? null,
      expiryDate: params.expiryDate ?? null,
      /*
       * A transfer hands on the source layer's date so the stock keeps its
       * place in the FIFO queue. Copy today's date instead and six-month-old
       * stock arrives looking fresh and stops being drawn first — FIFO order
       * would break silently on every transfer.
       */
      receivedAt: params.receivedAt ?? null,
    })
    if (layer) {
      await tx.stockMovementLot.create({
        data: {
          restaurantId: params.restaurantId,
          movementId: movement.id,
          batchId: layer.id,
          batchNo: layer.batchNo,
          quantity: magnitude,
          unitCost,
          lineValue: inboundValue,
        },
      })
    }
  } else if (drawn) {
    /*
     * One row per layer drawn. This is what makes a reversal able to put stock
     * back where it came from, and what makes the ledger replayable at cost —
     * neither was possible when a movement recorded only a rounded per-unit
     * figure and at most one batch id.
     */
    for (const draw of drawn.draws) {
      await tx.stockMovementLot.create({
        data: {
          restaurantId: params.restaurantId,
          movementId: movement.id,
          batchId: draw.batchId,
          batchNo: draw.batchNo,
          quantity: draw.quantity,
          unitCost: draw.unitCost,
          lineValue: draw.lineValue,
          uncosted: draw.uncosted,
        },
      })
    }
  }

  /*
   * The item's cached value, recomputed from its layers.
   *
   * `stockValue` and `costPerUnit` were the weighted-average pool the ledger
   * maintained; they are derived figures now, in exactly the relationship
   * `quantity` has always had with the movements. Every screen that reads them
   * keeps working and starts showing a number that agrees with the layers.
   */
  const layerValue = await tx.stockBatch.aggregate({
    where: { restaurantId: params.restaurantId, itemId: item.id, remainingQty: { gt: 0 } },
    _sum: { remainingValue: true },
  })
  const stockValue = Math.max(0, layerValue._sum.remainingValue ?? 0)

  const updated = await tx.inventoryItem.update({
    where: { id: item.id },
    data: {
      quantity: balanceAfter,
      stockValue,
      // The blended rate of what is on hand. Display only — never a costing
      // basis. `currentUnitCost` in ./fifo is what the next unit costs.
      costPerUnit: balanceAfter > 0 ? Math.round(stockValue / balanceAfter) : item.costPerUnit,
      // A purchase still records what it paid; the LAST costing method and the
      // reorder screen read it, and neither is a costing basis any more.
      ...(signed > 0 && params.unitCost !== undefined && params.unitCost > 0
        ? { lastPurchaseCost: params.unitCost }
        : {}),
    },
  })

  // Mirror the change onto the location that owns it. The item total above is
  // the restaurant-wide figure every existing query relies on; this records
  // where the stock actually sits, in the same transaction so the two cannot
  // disagree.
  await applyLocationDelta(tx, {
    restaurantId: params.restaurantId,
    itemId: item.id,
    branchId: params.branchId ?? item.branchId ?? null,
    storageLocationId: params.locationId ?? item.locationId ?? null,
    available: signed,
  })

  /*
   * The movement and the news of it commit together (production.md §5).
   *
   * Emitted here rather than at the six calling features for the same reason
   * the period guard is here: this is the sole balance writer, so every stock
   * change is covered by construction and a new caller cannot forget.
   *
   * The payload deliberately carries the resulting balance. That is what a
   * stock screen actually needs in order to react, and including it means a
   * screen can update without a round trip back for the item.
   */
  await emitOutbox(tx, {
    restaurantId: params.restaurantId,
    branchId: params.branchId,
    type: EVENTS.LOW_STOCK,
    entity: 'StockMovement',
    entityId: movement.id,
    payload: {
      itemId: item.id,
      itemName: item.name,
      type: params.type,
      quantity: signed,
      balanceAfter,
      belowReorder: item.reorderLevel != null && balanceAfter <= item.reorderLevel,
    },
  })

  return {
    movement,
    item: updated,
    balanceBefore,
    balanceAfter,
    wentNegative: balanceBefore >= 0 && balanceAfter < 0,
    valueMoved,
  }
}

/*
 * ── The weighted-average engine that used to live here ──────────────────────
 *
 * `valueUpdate` maintained `InventoryItem.stockValue` as a value pool: an
 * inbound movement added its cost and recomputed `costPerUnit = value ÷
 * quantity`; an outbound one removed `(value × out) ÷ quantity`, a pro-rata
 * slice of the blend. It was careful, value-carrying and internally
 * consistent — and it was a second costing system running beside the FIFO
 * layers, which is what FIFO.md exists to end.
 *
 * It had one clause worth remembering, because its removal is deliberate: an
 * outbound movement's value was capped at `Math.min(explicitTotalValue,
 * prevValue)`, so a caller could never remove more worth than the pool held.
 * Under FIFO that cap cannot fire honestly — a draw takes value out of layers
 * that hold it, so it is bounded by construction — and if it ever did fire it
 * would be silently swallowing a disagreement between the layers and the
 * cache, which is exactly the drift the new invariants exist to expose.
 *
 * The value of a movement is now whatever its layers were worth. See the
 * allocation above.
 */

/**
 * Replay the ledger for one item.
 *
 * The cached balance should always equal this. Used by the tests as the proof
 * that the cache is derived rather than independently maintained, and available
 * as a repair tool if a balance is ever doubted.
 */
export async function recomputeBalance(
  restaurantId: string,
  itemId: string,
): Promise<{ cached: number; ledger: number; matches: boolean }> {
  const item = await prisma.inventoryItem.findFirst({
    where: { id: itemId, restaurantId },
    select: { quantity: true },
  })
  if (!item) throw new NotFoundError('Inventory item')

  const sum = await prisma.stockMovement.aggregate({
    where: { itemId, restaurantId },
    _sum: { quantity: true },
  })
  const ledger = roundQty(sum._sum?.quantity ?? 0)
  const cached = roundQty(item.quantity)

  // The tolerance is roundQty's own precision — see `sameQty` for why the two
  // have to be the same number, or the replay reports drift that is not there.
  return { cached, ledger, matches: sameQty(cached, ledger) }
}

/** Convenience wrapper for callers that are not already in a transaction. */
export async function postMovementStandalone(
  params: PostMovementParams,
): Promise<PostedMovement> {
  return prisma.$transaction((tx) => postMovement(tx, params))
}

/** Human-readable one-liner for a ledger row, used in history and audit. */
export function describeMovement(
  movement: Pick<StockMovement, 'type' | 'quantity' | 'quantityEntered' | 'enteredUnit'>,
  baseUnit: StockUnit,
): string {
  const unit = movement.enteredUnit ?? baseUnit
  const magnitude = movement.quantityEntered ?? Math.abs(movement.quantity)
  const sign = movement.quantity >= 0 ? '+' : '−'
  return `${sign}${formatQuantity(magnitude, unit)} ${movement.type.replace(/_/g, ' ').toLowerCase()}`
}
