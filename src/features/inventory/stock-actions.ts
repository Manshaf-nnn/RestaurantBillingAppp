'use server'

import { revalidatePath } from 'next/cache'

import type { UserRole } from '@prisma/client'

import { runAction, type ActionResult } from '@/lib/action'
import { minorUnitFactor } from '@/lib/money'
import { PERMISSIONS } from '@/lib/rbac'
import { AUDIT_ACTIONS, audit } from '@/server/audit'
import { assertBranchAccess, assertRecordBranch, requirePermission } from '@/server/auth/guard'
import { prisma } from '@/server/db/prisma'
import { requireRestaurant } from '@/server/db/tenant'
import { actingBranchId } from '@/features/dashboard/selected-branch'
import {
  adjustStock, receiveStock, setOpeningBalance,
} from './operations'
import {
  approveStockCount, cancelStockCount, openStockCount, recordCountLines, submitStockCount,
} from './stock-count'
import {
  adjustStockSchema, approveCountSchema, countLinesSchema, openingBalanceSchema,
  receiveStockSchema,
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
      branchId: await actingBranchId(user),
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
      restaurantId: user.restaurantId, branchId: await actingBranchId(user),
      itemId: data.itemId, quantity: data.quantity,
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

/*
 * `transferStockAction` was here and has been removed.
 *
 * It moved stock from one InventoryItem row to another and named no branch on
 * either leg, so `applyLocationDelta` skipped both and no location's balance
 * ever changed — while the restaurant-wide quantity did. It was a live server
 * action, reachable by anyone holding INVENTORY_TRANSFER, and no component in
 * the app ever called it. The real path is `/dashboard/transfers`, which moves
 * one item between two locations with a request, an approval, a dispatch and a
 * receipt.
 */


export async function setOpeningBalanceAction(input: unknown): Promise<ActionResult<{ balance: number }>> {
  return runAction(openingBalanceSchema, input, async (data) => {
    const user = await requirePermission(PERMISSIONS.INVENTORY_ADJUST)
    const posted = await setOpeningBalance({
      restaurantId: user.restaurantId, branchId: await actingBranchId(user),
      itemId: data.itemId, quantity: data.quantity,
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
 *
 * With nothing passed it falls to `actingBranchId` — the branch on screen —
 * like every other stock action in this file. It used to fall to the default
 * branch instead, so an owner looking at Branch 02 got a count filed against
 * Main: the sheet snapshotted Main's balances while somebody walked Branch 02's
 * shelves, and approval posted the difference between two unrelated places into
 * Main. The visible symptom was milder and much more confusing — the count
 * vanished from a list that filters by the branch you are standing in.
 */
export async function openStockCountAction(
  branchId?: string | null,
): Promise<ActionResult<{ id: string; reference: string }>> {
  const user = await requirePermission(PERMISSIONS.INVENTORY_COUNT)
  await assertBranchAccess(user, branchId ?? null)
  const count = await openStockCount({
    restaurantId: user.restaurantId, userId: user.id,
    branchId: branchId || (await actingBranchId(user)),
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
    await assertRecordBranch(
      user,
      await countBranch(user.restaurantId, data.stockCountId),
      'stock count',
    )
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

/** Roles with nobody above them to countersign. See `approveStockCountAction`. */
const SELF_APPROVERS = new Set<UserRole>(['OWNER', 'ADMIN', 'SUPER_ADMIN'])

/**
 * The branch a stock count belongs to.
 *
 * Approving a count posts variance adjustments straight into that branch's
 * ledger — it is one of the few actions in this app that MOVES stock on
 * somebody else's shelves — and it took an id and checked nothing.
 */
async function countBranch(restaurantId: string, stockCountId: string) {
  return prisma.stockCount.findFirst({
    where: { id: stockCountId, restaurantId },
    select: { branchId: true },
  })
}

/**
 * Abandon a count.
 *
 * `cancelStockCount` existed with no caller, so a draft started by mistake — or
 * one whose counter went home — could never be closed, and the list filled with
 * counts nobody would ever finish. Nothing has moved at this point, so this
 * only ends the draft.
 */
export async function cancelStockCountAction(
  stockCountId: string,
): Promise<ActionResult<{ id: string }>> {
  const user = await requirePermission(PERMISSIONS.INVENTORY_COUNT)
  await assertRecordBranch(user, await countBranch(user.restaurantId, stockCountId), 'stock count')
  const count = await cancelStockCount(user.restaurantId, stockCountId)
  await audit({
    restaurantId: user.restaurantId, userId: user.id, actorName: user.name,
    action: AUDIT_ACTIONS.STOCK_COUNT_CANCELLED, entity: 'StockCount', entityId: count.id,
    after: { reference: count.reference },
  })
  revalidatePath('/dashboard/inventory/counts')
  revalidatePath(`/dashboard/inventory/counts/${stockCountId}`)
  return { ok: true, data: { id: count.id } }
}

export async function submitStockCountAction(stockCountId: string): Promise<ActionResult<{ id: string }>> {
  const user = await requirePermission(PERMISSIONS.INVENTORY_COUNT)
  await assertRecordBranch(user, await countBranch(user.restaurantId, stockCountId), 'stock count')
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
): Promise<ActionResult<{ adjusted: number; unchanged: number; valueDelta: number }>> {
  return runAction(approveCountSchema, input, async (data) => {
    const user = await requirePermission(PERMISSIONS.INVENTORY_COUNT_APPROVE)
    await assertRecordBranch(
      user,
      await countBranch(user.restaurantId, data.stockCountId),
      'stock count',
    )
    const result = await approveStockCount({
      restaurantId: user.restaurantId, stockCountId: data.stockCountId,
      userId: user.id, notes: data.notes || null,
      /*
       * Maker-checker, with the one exemption that keeps it usable.
       *
       * A storeman must not sign off the count that writes off what they
       * carried out — that is the entire reason approval is a separate step.
       * But most restaurants running this are one person, and for them there is
       * no second signatory to find; refusing would leave them unable to count
       * at all. An owner or admin has nobody above them to ask, so they may
       * approve their own. Everybody else needs a second pair of eyes.
       */
      selfApprovalAllowed: SELF_APPROVERS.has(user.role),
    })
    await audit({
      restaurantId: user.restaurantId, userId: user.id, actorName: user.name,
      action: AUDIT_ACTIONS.STOCK_COUNT_APPROVED, entity: 'StockCount', entityId: data.stockCountId,
      after: {
        reference: result.count.reference,
        adjusted: result.adjusted,
        unchanged: result.unchanged,
        // What the signature costs, signed minor units — the audit trail
        // should read like the ledger it authorised.
        valueDelta: result.valueDelta,
      },
    })
    revalidatePath('/dashboard/inventory')
    revalidatePath(`/dashboard/inventory/counts/${data.stockCountId}`)
    return { adjusted: result.adjusted, unchanged: result.unchanged, valueDelta: result.valueDelta }
  }, 'Count approved and stock updated.')
}
