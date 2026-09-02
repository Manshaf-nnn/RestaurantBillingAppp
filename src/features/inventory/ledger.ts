import 'server-only'

import type { InventoryItem, StockMovement, StockMovementType, StockUnit } from '@prisma/client'

import { AppError, NotFoundError } from '@/lib/errors'
import { prisma, type TxClient, guardLocks} from '@/server/db/prisma'
import { toBaseUnits, formatQuantity } from './units'
import { applyLocationDelta } from './location-stock'
import { allocateFefo, consumeBatches } from './batches'

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
  const balanceAfter = round(balanceBefore + signed)

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
    const branchAfter = round(atBranch + signed)
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
   * What this stock was worth when it moved.
   *
   * Inbound movements bring their own price and it must not be invented — the
   * weighted average is computed from it below. Outbound movements had no cost
   * at all, so every SALE, WASTAGE and TRANSFER_OUT row recorded zero, and the
   * ledger could not answer "what did we consume, in money" — which is exactly
   * what COGS is. Stamping the average in force at the moment of the movement
   * makes the ledger the source of truth for cost as well as quantity, and it is
   * a snapshot: later price changes cannot rewrite what last month cost.
   */
  const valuation = valueUpdate(item, signed, params.unitCost)
  const unitCost = valuation.movementUnitCost

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
   * Draw outgoing stock out of real lots, earliest expiry first.
   *
   * Only wastage did this, so anything sold or used in production left batch
   * quantities untouched: `remainingQty` stayed at what was received, FEFO kept
   * offering lots that were long gone, and the expiry board warned about stock
   * that had already been eaten. Doing it here rather than in each caller means
   * every outward movement is covered by construction — the same reason
   * `postMovement` owns the balance itself.
   *
   * A caller naming a specific batch has already decided; anything else is
   * allocated. A shortfall is not an error: batches can legitimately lag behind
   * the balance for stock received before batch tracking was turned on, and
   * refusing the movement would block a sale over a bookkeeping detail.
   */
  if (item.trackBatches && signed < 0) {
    if (params.batchId) {
      await tx.stockBatch.update({
        where: { id: params.batchId },
        data: { remainingQty: { decrement: magnitude } },
      })
    } else {
      const { allocations } = await allocateFefo(tx, {
        restaurantId: params.restaurantId,
        itemId: item.id,
        quantity: magnitude,
        branchId: params.branchId,
      })
      await consumeBatches(tx, allocations)
    }
  }

  const updated = await tx.inventoryItem.update({
    where: { id: item.id },
    data: { quantity: balanceAfter, ...valuation.item },
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

  return {
    movement,
    item: updated,
    balanceBefore,
    balanceAfter,
    wentNegative: balanceBefore >= 0 && balanceAfter < 0,
  }
}

/**
 * Value-carrying weighted average cost.
 *
 * The average used to live only as a rounded Int per base unit, recomputed on
 * receipt — and for an item counted in grams, a real cost of 0.4 cents per
 * gram rounded to 0, so entire deliveries were worth nothing on the books.
 * The VALUE on hand is now the tracked figure, exact: receipts add at their
 * own price, everything leaving subtracts at the running average, and
 * `costPerUnit` becomes a rounded cache of value ÷ quantity.
 *
 * Rules the numbers follow:
 *   • Outbound never moves the average — selling stock cannot change what the
 *     rest of it cost.
 *   • Inbound WITHOUT a price (a sale reversal, a transfer in) comes back at
 *     the running average, so returned stock carries the value it left with —
 *     these rows used to be stamped zero and the value ladder could not close.
 *   • When the balance empties or goes negative the value is written to zero:
 *     negative stock is a quantity problem, and pretending it holds negative
 *     value would poison the next receipt's average.
 */
function valueUpdate(
  item: InventoryItem,
  signedBase: number,
  explicitUnitCost?: number,
): {
  item: { stockValue: number; costPerUnit?: number; lastPurchaseCost?: number }
  movementUnitCost: number
} {
  const prevQty = Math.max(0, item.quantity)
  const prevValue = Math.max(0, Number(item.stockValue))
  const average = prevQty > 0 ? prevValue / prevQty : item.costPerUnit

  if (signedBase > 0) {
    const priced = explicitUnitCost !== undefined && explicitUnitCost > 0
    const unitCost = priced ? explicitUnitCost! : average
    const nextQty = prevQty + signedBase
    const nextValue = prevValue + signedBase * unitCost
    return {
      item: {
        stockValue: round6(nextValue),
        costPerUnit: nextQty > 0 ? Math.round(nextValue / nextQty) : item.costPerUnit,
        ...(priced ? { lastPurchaseCost: explicitUnitCost } : {}),
      },
      movementUnitCost: Math.round(unitCost),
    }
  }

  const out = Math.min(-signedBase, prevQty)
  const outValue = prevQty > 0 ? (prevValue * out) / prevQty : 0
  const nextQty = prevQty + signedBase
  const nextValue = nextQty <= 0 ? 0 : Math.max(0, prevValue - outValue)
  return {
    // The average itself is deliberately not recomputed on the way out.
    item: { stockValue: round6(nextValue) },
    movementUnitCost: explicitUnitCost ?? Math.round(average),
  }
}

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6
}

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
  const ledger = round(sum._sum?.quantity ?? 0)
  const cached = round(item.quantity)

  return { cached, ledger, matches: Math.abs(cached - ledger) < 1e-6 }
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

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6
}
