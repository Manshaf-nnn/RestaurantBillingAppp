'use server'

import { revalidatePath } from 'next/cache'

import { runAction, type ActionResult } from '@/lib/action'
import { minorUnitFactor } from '@/lib/money'
import { PERMISSIONS } from '@/lib/rbac'
import { resolveStockLocation } from '@/features/branches/service'
import { AUDIT_ACTIONS, audit } from '@/server/audit'
import { assertBranchAccess, requirePermission } from '@/server/auth/guard'
import { requireRestaurant } from '@/server/db/tenant'
import {
  adjustStock, receiveStock, setOpeningBalance, transferStock,
} from './operations'
import {
  approveStockCount, openStockCount, recordCountLines, submitStockCount,
} from './stock-count'
import {
  adjustStockSchema, approveCountSchema, countLinesSchema, openingBalanceSchema,
  receiveStockSchema, transferStockSchema,
} from './stock-schema'

/**
 * Server actions for stock movement.
 *
 * Each one is gated on the narrowest permission that fits. Recording wastage is
 * a kitchen job; correcting a balance and approving a count are not, because
 * those are the two operations that can hide a discrepancy. Every action writes
 * an audit row alongside the ledger row, so the movement and the authority for
 * it are both recorded.
 */

function revalidateInventory(itemId?: string) {
  revalidatePath('/dashboard/inventory')
  if (itemId) revalidatePath(`/dashboard/inventory/${itemId}`)
}

/** Cost is typed in major units; the ledger stores minor. */
async function costToMinor(restaurantId: string, value?: number): Promise<number | undefined> {
  if (value === undefined) return undefined
  const restaurant = await requireRestaurant(restaurantId)
  return Math.round(value * minorUnitFactor(restaurant.currency))
}

export async function receiveStockAction(input: unknown): Promise<ActionResult<{ balance: number }>> {
  return runAction(receiveStockSchema, input, async (data) => {
    const user = await requirePermission(PERMISSIONS.INVENTORY_MANAGE)
    const posted = await receiveStock({
      restaurantId: user.restaurantId,
      itemId: data.itemId,
      quantity: data.quantity,
      unit: data.unit,
      unitCost: await costToMinor(user.restaurantId, data.unitCost),
      batchNo: data.batchNo || null,
      notes: data.notes || null,
      userId: user.id,
    })
    await audit({
      restaurantId: user.restaurantId, userId: user.id, actorName: user.name,
      action: AUDIT_ACTIONS.STOCK_RECEIVED, entity: 'InventoryItem', entityId: data.itemId,
      before: { balance: posted.balanceBefore },
      after: { balance: posted.balanceAfter, quantity: data.quantity, unit: data.unit },
    })
    revalidateInventory(data.itemId)
    return { balance: posted.balanceAfter }
  }, 'Stock received.')
}

/*
 * recordWastageAction lives in wastage-actions.ts, not here.
 *
 * There were two, and they behaved differently: this one wrote only a stock
 * movement, so wastage logged through it never reached the wastage report.
 * One event should have one way in.
 */

export async function adjustStockAction(input: unknown): Promise<ActionResult<{ balance: number }>> {
  return runAction(adjustStockSchema, input, async (data) => {
    const user = await requirePermission(PERMISSIONS.INVENTORY_ADJUST)
    const posted = await adjustStock({
      restaurantId: user.restaurantId, itemId: data.itemId, quantity: data.quantity,
      unit: data.unit, direction: data.direction, reason: data.reason, userId: user.id,
    })
    await audit({
      restaurantId: user.restaurantId, userId: user.id, actorName: user.name,
      action: AUDIT_ACTIONS.STOCK_ADJUSTED, entity: 'InventoryItem', entityId: data.itemId,
      before: { balance: posted.balanceBefore },
      after: { balance: posted.balanceAfter, direction: data.direction, reason: data.reason },
    })
    revalidateInventory(data.itemId)
    return { balance: posted.balanceAfter }
  }, 'Stock adjusted.')
}

export async function transferStockAction(
  input: unknown,
): Promise<ActionResult<{ from: number; to: number }>> {
  return runAction(transferStockSchema, input, async (data) => {
    const user = await requirePermission(PERMISSIONS.INVENTORY_TRANSFER)
    const moved = await transferStock({
      restaurantId: user.restaurantId, fromItemId: data.fromItemId, toItemId: data.toItemId,
      quantity: data.quantity, unit: data.unit, reason: data.reason || null, userId: user.id,
    })
    await audit({
      restaurantId: user.restaurantId, userId: user.id, actorName: user.name,
      action: AUDIT_ACTIONS.STOCK_TRANSFER, entity: 'InventoryItem', entityId: data.fromItemId,
      after: {
        to: data.toItemId, quantity: data.quantity,
        fromBalance: moved.out.balanceAfter, toBalance: moved.in.balanceAfter,
      },
    })
    revalidateInventory(data.fromItemId)
    revalidateInventory(data.toItemId)
    return { from: moved.out.balanceAfter, to: moved.in.balanceAfter }
  }, 'Stock transferred.')
}

export async function setOpeningBalanceAction(input: unknown): Promise<ActionResult<{ balance: number }>> {
  return runAction(openingBalanceSchema, input, async (data) => {
    const user = await requirePermission(PERMISSIONS.INVENTORY_ADJUST)
    const posted = await setOpeningBalance({
      restaurantId: user.restaurantId, itemId: data.itemId, quantity: data.quantity,
      unit: data.unit, unitCost: await costToMinor(user.restaurantId, data.unitCost), userId: user.id,
    })
    await audit({
      restaurantId: user.restaurantId, userId: user.id, actorName: user.name,
      action: AUDIT_ACTIONS.STOCK_OPENING, entity: 'InventoryItem', entityId: data.itemId,
      after: { balance: posted.balanceAfter },
    })
    revalidateInventory(data.itemId)
    return { balance: posted.balanceAfter }
  }, 'Opening balance set.')
}

// ── stock counts ─────────────────────────────────────────────────────────────

/**
 * Start a stock count.
 *
 * Takes the location being counted. It used to take nothing and record
 * `user.branchId ?? null`, which is null for an owner — so every count was
 * against "no location" and its adjustments credited no shelf.
 */
export async function openStockCountAction(
  branchId?: string | null,
): Promise<ActionResult<{ id: string; reference: string }>> {
  const user = await requirePermission(PERMISSIONS.INVENTORY_COUNT)
  await assertBranchAccess(user, branchId ?? null)
  const count = await openStockCount({
    restaurantId: user.restaurantId, userId: user.id,
    branchId: await resolveStockLocation({
      restaurantId: user.restaurantId,
      requestedBranchId: branchId,
      userBranchId: user.branchId,
    }),
  })
  await audit({
    restaurantId: user.restaurantId, userId: user.id, actorName: user.name,
    action: AUDIT_ACTIONS.STOCK_COUNT_OPENED, entity: 'StockCount', entityId: count.id,
    after: { reference: count.reference },
  })
  revalidatePath('/dashboard/inventory/counts')
  return { ok: true, data: { id: count.id, reference: count.reference } }
}

export async function recordCountLinesAction(input: unknown): Promise<ActionResult<{ recorded: number }>> {
  return runAction(countLinesSchema, input, async (data) => {
    const user = await requirePermission(PERMISSIONS.INVENTORY_COUNT)
    const result = await recordCountLines({
      restaurantId: user.restaurantId,
      stockCountId: data.stockCountId,
      lines: data.lines.map((l) => ({
        itemId: l.itemId, countedQty: l.countedQty, unit: l.unit, notes: l.notes || null,
      })),
    })
    revalidatePath(`/dashboard/inventory/counts/${data.stockCountId}`)
    return result
  }, 'Count saved. Nothing has moved yet.')
}

export async function submitStockCountAction(stockCountId: string): Promise<ActionResult<{ id: string }>> {
  const user = await requirePermission(PERMISSIONS.INVENTORY_COUNT)
  const count = await submitStockCount(user.restaurantId, stockCountId)
  revalidatePath(`/dashboard/inventory/counts/${stockCountId}`)
  return { ok: true, data: { id: count.id } }
}

/**
 * The only route by which a count changes stock, and the reason the whole
 * two-step flow exists. Gated separately from counting so the person who walked
 * the shelves is not necessarily the person who signs off the variance.
 */
export async function approveStockCountAction(
  input: unknown,
): Promise<ActionResult<{ adjusted: number; unchanged: number }>> {
  return runAction(approveCountSchema, input, async (data) => {
    const user = await requirePermission(PERMISSIONS.INVENTORY_COUNT_APPROVE)
    const result = await approveStockCount({
      restaurantId: user.restaurantId, stockCountId: data.stockCountId,
      userId: user.id, notes: data.notes || null,
    })
    await audit({
      restaurantId: user.restaurantId, userId: user.id, actorName: user.name,
      action: AUDIT_ACTIONS.STOCK_COUNT_APPROVED, entity: 'StockCount', entityId: data.stockCountId,
      after: { reference: result.count.reference, adjusted: result.adjusted, unchanged: result.unchanged },
    })
    revalidatePath('/dashboard/inventory')
    revalidatePath(`/dashboard/inventory/counts/${data.stockCountId}`)
    return { adjusted: result.adjusted, unchanged: result.unchanged }
  }, 'Count approved and stock updated.')
}
