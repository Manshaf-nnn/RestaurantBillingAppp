import 'server-only'

import type { StockUnit } from '@prisma/client'

import { AppError, NotFoundError } from '@/lib/errors'
import { prisma } from '@/server/db/prisma'
import { postMovement, type PostedMovement } from './ledger'
import { recordWastage as recordWastageDetailed } from './wastage'

/**
 * Named stock operations.
 *
 * Each one is a thin, well-labelled wrapper over `postMovement`. They exist so
 * that callers say what happened — "this was wasted", "this was returned to the
 * supplier" — rather than choosing a movement type and a sign themselves. The
 * ledger then carries the restaurant's actual vocabulary, which is what makes
 * the history readable months later.
 */

interface Actor {
  restaurantId: string
  userId?: string | null
}

interface Simple extends Actor {
  itemId: string
  quantity: number
  unit?: StockUnit | null
  reason?: string | null
  notes?: string | null
  /**
   * Which location. Required since the ledger made it required — a movement
   * that names no place updates the restaurant's total and no location's
   * balance, which is how the two drift apart.
   */
  branchId: string
  locationId?: string | null
}

/** Stock received from a supplier. Carries the cost, so it moves the average. */
export async function receiveStock(
  params: Simple & {
    unitCost?: number
    purchaseId?: string | null
    batchNo?: string | null
    expiryDate?: Date | null
  },
): Promise<PostedMovement> {
  return prisma.$transaction((tx) =>
    postMovement(tx, {
      ...params,
      type: 'PURCHASE',
      enteredUnit: params.unit,
      referenceType: params.purchaseId ? 'Purchase' : null,
      referenceId: params.purchaseId ?? null,
    }),
  )
}

/**
 * Stock thrown away.
 *
 * Delegates to the wastage module rather than posting a bare movement. Both
 * used to exist: this one moved stock and wrote nothing else, so anything
 * recorded through it left the balance correct while never appearing in the
 * wastage report, in "by reason", or in the cost of waste. Two ways to record
 * the same event, one of which quietly lost half the record.
 *
 * A free-text reason maps to OTHER with the text kept as the note, since the
 * report groups by the enum.
 */
export async function recordWastage(
  params: Simple & { reason: string },
): Promise<{ id: string; quantity: number }> {
  // Checked here rather than left to the enum mapping below, which would turn a
  // blank into OTHER and then complain about a missing note — technically a
  // refusal, but for the wrong reason and with the wrong message.
  if (params.reason.trim().length < 2) {
    throw new AppError('Give a reason for the wastage', 400, 'WASTAGE_NO_REASON')
  }

  const KNOWN = [
    'EXPIRED', 'SPOILED', 'BURNT', 'DAMAGED', 'DROPPED',
    'PREPARATION', 'CUSTOMER_RETURN', 'OTHER',
  ] as const
  const raw = params.reason.trim().toUpperCase().replace(/ /g, '_')
  const matched = (KNOWN as readonly string[]).includes(raw)
    ? (raw as (typeof KNOWN)[number])
    : 'OTHER'

  const record = await recordWastageDetailed({
    restaurantId: params.restaurantId,
    itemId: params.itemId,
    quantity: params.quantity,
    unit: params.unit,
    reason: matched,
    reasonNote: matched === 'OTHER' ? params.reason.trim() : null,
    notes: params.notes ?? null,
    branchId: params.branchId,
    locationId: params.locationId,
    userId: params.userId,
  })
  return { id: record.id, quantity: record.quantity }
}

/** Stock sent back to the supplier — damaged delivery, wrong item. */
export async function returnToSupplier(params: Simple & { reason: string }): Promise<PostedMovement> {
  return prisma.$transaction((tx) =>
    postMovement(tx, { ...params, type: 'RETURN_TO_SUPPLIER', enteredUnit: params.unit }),
  )
}

/** Stock coming back from a customer. */
export async function customerReturn(params: Simple & { orderId?: string | null }): Promise<PostedMovement> {
  return prisma.$transaction((tx) =>
    postMovement(tx, {
      ...params,
      type: 'CUSTOMER_RETURN',
      enteredUnit: params.unit,
      referenceType: params.orderId ? 'Order' : null,
      referenceId: params.orderId ?? null,
      orderId: params.orderId ?? null,
    }),
  )
}

/** Something made in-house from other stock, e.g. a batch of sauce. */
export async function recordProduction(params: Simple): Promise<PostedMovement> {
  return prisma.$transaction((tx) =>
    postMovement(tx, { ...params, type: 'PRODUCTION', enteredUnit: params.unit }),
  )
}

/**
 * The starting balance for an item.
 *
 * Posted as a movement rather than written straight onto the item, so even the
 * very first number in an item's life has a date and a name against it.
 */
export async function setOpeningBalance(
  params: Simple & { unitCost?: number },
): Promise<PostedMovement> {
  /*
   * One opening balance per item PER LOCATION, not per restaurant.
   *
   * This counted restaurant-wide, so opening a second warehouse with stock the
   * first branch already carried was refused — "this item already has an opening
   * balance" — even though that location had never held any. Every location gets
   * its own starting figure; that is the whole point of tracking stock by place.
   */
  const existing = await prisma.stockMovement.count({
    where: {
      itemId: params.itemId,
      restaurantId: params.restaurantId,
      type: 'OPENING_BALANCE',
      ...(params.branchId ? { branchId: params.branchId } : {}),
    },
  })
  if (existing > 0) {
    throw new AppError(
      'This item already has an opening balance at that location — use a stock count to correct it',
      409,
      'OPENING_BALANCE_EXISTS',
    )
  }
  return prisma.$transaction((tx) =>
    postMovement(tx, { ...params, type: 'OPENING_BALANCE', enteredUnit: params.unit }),
  )
}

/** A manual correction in either direction. Always needs a reason. */
export async function adjustStock(
  params: Simple & { direction: 'IN' | 'OUT'; reason: string },
): Promise<PostedMovement> {
  if (params.reason.trim().length < 2) {
    throw new AppError('Give a reason for the adjustment', 400, 'ADJUSTMENT_NO_REASON')
  }
  return prisma.$transaction((tx) =>
    postMovement(tx, {
      ...params,
      type: params.direction === 'IN' ? 'ADJUSTMENT_IN' : 'ADJUSTMENT_OUT',
      enteredUnit: params.unit,
      reason: params.reason.trim(),
    }),
  )
}

