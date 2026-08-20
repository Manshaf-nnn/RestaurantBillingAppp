import 'server-only'

import type { InventoryItem, StockMovement, StockMovementType, StockUnit } from '@prisma/client'

import { AppError, NotFoundError } from '@/lib/errors'
import { prisma, type TxClient } from '@/server/db/prisma'
import { toBaseUnits, formatQuantity } from './units'

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
 * An outward movement that would take the balance below zero is allowed and
 * flagged, not refused. Refusing would mean a guest cannot be served because
 * someone forgot to record a delivery, which is the wrong trade in a
 * restaurant. The negative balance surfaces as an alert instead.
 */

/** Movement types that add stock. Everything else removes it. */
const INBOUND: StockMovementType[] = [
  'PURCHASE',
  'ADJUSTMENT_IN',
  'TRANSFER_IN',
  'CUSTOMER_RETURN',
  'PRODUCTION',
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
]

export function directionOf(type: StockMovementType): 1 | -1 | 0 {
  if (INBOUND.includes(type)) return 1
  if (OUTBOUND.includes(type)) return -1
  return 0 // legacy ADJUSTMENT carries its own sign
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
  branchId?: string | null
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

  const movement = await tx.stockMovement.create({
    data: {
      restaurantId: params.restaurantId,
      itemId: item.id,
      type: params.type,
      quantity: signed,
      quantityEntered: Math.abs(params.quantity),
      enteredUnit,
      balanceAfter,
      unitCost: params.unitCost ?? 0,
      reason: params.reason ?? null,
      notes: params.notes ?? null,
      referenceType: params.referenceType ?? null,
      referenceId: params.referenceId ?? null,
      branchId: params.branchId ?? item.branchId ?? null,
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

  const costing = costingUpdate(item, signed, params.unitCost)

  const updated = await tx.inventoryItem.update({
    where: { id: item.id },
    data: { quantity: balanceAfter, ...costing },
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
 * Weighted average cost, recomputed on receipt.
 *
 * Only inbound movements carrying a cost move the average; a sale or a wastage
 * must not, or the cost of what is left would change every time something is
 * sold. When the previous balance was zero or negative there is nothing to
 * average against, so the new cost simply becomes the cost.
 */
function costingUpdate(
  item: InventoryItem,
  signedBase: number,
  unitCost?: number,
): { costPerUnit?: number; lastPurchaseCost?: number } {
  if (signedBase <= 0 || unitCost === undefined || unitCost <= 0) return {}

  const previousQty = Math.max(0, item.quantity)
  const blended =
    previousQty > 0
      ? Math.round((previousQty * item.costPerUnit + signedBase * unitCost) / (previousQty + signedBase))
      : unitCost

  return { costPerUnit: blended, lastPurchaseCost: unitCost }
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
