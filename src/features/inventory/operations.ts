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
  branchId?: string | null
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
  const existing = await prisma.stockMovement.count({
    where: { itemId: params.itemId, restaurantId: params.restaurantId, type: 'OPENING_BALANCE' },
  })
  if (existing > 0) {
    throw new AppError(
      'This item already has an opening balance — use a stock count to correct it',
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

/**
 * Move stock from one item record to another — between branches, or between
 * stores within a branch.
 *
 * Both legs are written in one transaction. A transfer that debited the source
 * but failed to credit the destination would destroy stock that physically
 * still exists, so the pair is atomic and shares a reference id linking them.
 */
export async function transferStock(params: {
  restaurantId: string
  fromItemId: string
  toItemId: string
  quantity: number
  unit?: StockUnit | null
  reason?: string | null
  userId?: string | null
  toLocationId?: string | null
}): Promise<{ out: PostedMovement; in: PostedMovement }> {
  if (params.fromItemId === params.toItemId && !params.toLocationId) {
    throw new AppError(
      'Choose a different destination — a transfer to the same place moves nothing',
      400,
      'TRANSFER_SAME_ITEM',
    )
  }

  const [source, destination] = await Promise.all([
    prisma.inventoryItem.findFirst({
      where: { id: params.fromItemId, restaurantId: params.restaurantId },
      select: { id: true, name: true },
    }),
    prisma.inventoryItem.findFirst({
      where: { id: params.toItemId, restaurantId: params.restaurantId },
      select: { id: true, name: true },
    }),
  ])
  if (!source || !destination) throw new NotFoundError('Inventory item')

  // Shared so the two halves can be found together in the ledger.
  const reference = `TRF-${Date.now().toString(36).toUpperCase()}`

  return prisma.$transaction(async (tx) => {
    const out = await postMovement(tx, {
      restaurantId: params.restaurantId,
      itemId: params.fromItemId,
      type: 'TRANSFER_OUT',
      quantity: params.quantity,
      enteredUnit: params.unit,
      reason: params.reason ?? `Transfer to ${destination.name}`,
      referenceType: 'Transfer',
      referenceId: reference,
      userId: params.userId,
    })

    const credited = await postMovement(tx, {
      restaurantId: params.restaurantId,
      itemId: params.toItemId,
      type: 'TRANSFER_IN',
      quantity: params.quantity,
      enteredUnit: params.unit,
      reason: params.reason ?? `Transfer from ${source.name}`,
      referenceType: 'Transfer',
      referenceId: reference,
      locationId: params.toLocationId ?? null,
      userId: params.userId,
    })

    return { out, in: credited }
  })
}
