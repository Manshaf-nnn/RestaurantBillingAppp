'use server'

import { revalidatePath } from 'next/cache'

import type { UserRole } from '@prisma/client'

import { runAction, type ActionResult } from '@/lib/action'
import { NotFoundError } from '@/lib/errors'
import { minorUnitFactor } from '@/lib/money'
import { can, PERMISSIONS } from '@/lib/rbac'
import { AUDIT_ACTIONS, audit } from '@/server/audit'
import { assertBranchAccess, assertRecordBranch, requirePermission } from '@/server/auth/guard'
import { prisma } from '@/server/db/prisma'
import { currentUnitCost } from './fifo'
import { nextCounterValue } from '@/server/db/counters'
import { requestApproval } from '@/features/approvals/service'
import { toBaseUnits } from './units'
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
    const branchId = await actingBranchId(user)
    const posted = await receiveStock({
      restaurantId: user.restaurantId,
      branchId,
      itemId: data.itemId,
      quantity: data.quantity,
      unit: data.unit,
      unitCost: await costToMinor(user.restaurantId, data.unitCost),
      batchNo: data.batchNo || null,
      notes: data.notes || null,
      userId: user.id,
    })
    await audit({
      restaurantId: user.restaurantId, branchId, userId: user.id, actorName: user.name,
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

/**
 * A correction to a counted balance — applied, or asked for (stockMa.md §).
 *
 * One action, two outcomes, decided by what the caller may do rather than by
 * which button they pressed:
 *
 *   holds `inventory.adjust`   → the movement is posted here and now
 *   holds only the request one → an approval request, and nothing moves
 *
 * ── Why the value threshold is not consulted on the request path ───────────
 *
 * `needsApproval` exists to spare a manager the paperwork on a small
 * correction. It was never a licence for somebody who may not correct a
 * balance at all to correct a small one, so a storeman's adjustment goes to
 * the desk whatever it is worth — including when approvals are switched off
 * altogether. The consequence, worth knowing: a restaurant that has disabled
 * approvals still accumulates these, and somebody holding
 * `inventory.countApprove` has to work the queue.
 */
export async function adjustStockAction(
  input: unknown,
): Promise<ActionResult<{ status: 'APPLIED' | 'PENDING'; reference: string; balance: number | null }>> {
  return runAction(adjustStockSchema, input, async (data) => {
    const user = await requirePermission(PERMISSIONS.INVENTORY_ADJUST_REQUEST)
    await assertBranchAccess(user, data.branchId || null)
    const branchId = data.branchId || (await actingBranchId(user))

    const item = await prisma.inventoryItem.findFirst({
      where: { id: data.itemId, restaurantId: user.restaurantId, isActive: true },
      select: { id: true, name: true, unit: true, purchaseUnit: true, consumptionUnit: true,
        unitsPerPurchaseUnit: true, quantity: true, costPerUnit: true },
    })
    if (!item) throw new NotFoundError('Item')

    /*
     * Its own document number. Adjustments were the last stock document with
     * none — transfers have TRF-, production PRD-, counts SC-, receipts GRN- —
     * so a ledger row could not be traced back to what authorised it.
     *
     * It also makes the approval's dedupe key unique. `requestApproval`
     * collapses a second PENDING request for the same (entity, entityId,
     * kind); keyed on the item, a storeman's second correction would silently
     * return the first and appear to have been recorded when it had not.
     */
    const seq = await prisma.$transaction((tx) => nextCounterValue(tx, user.restaurantId, 'stockAdjustment'))
    const reference = `ADJ-${String(seq).padStart(4, '0')}`
    const unit = data.unit ?? item.unit
    /*
     * What the correction is worth, for the desk's amount column — at what the
     * next unit costs (FIFO.md), not the blended average. The ledger decides
     * the real figure when the movement posts; this is what the approver sees
     * before it does, so the two should agree as closely as they can.
     */
    const rate = await currentUnitCost(prisma, {
      restaurantId: user.restaurantId,
      itemId: item.id,
      branchId,
    })
    const amount = Math.round(
      Math.abs(toBaseUnits(data.quantity, unit, item)) * (rate || item.costPerUnit),
    )

    if (!can(user, PERMISSIONS.INVENTORY_ADJUST)) {
      const request = await requestApproval({
        restaurantId: user.restaurantId,
        branchId,
        kind: 'STOCK_ADJUSTMENT',
        entity: 'StockAdjustment',
        entityId: reference,
        amount,
        reason: data.reason,
        userId: user.id,
        payload: {
          reference,
          itemId: item.id,
          itemName: item.name,
          quantity: data.quantity,
          unit,
          direction: data.direction,
          branchId,
          balanceBefore: item.quantity,
        },
      })
      // `requestApproval` writes the APPROVAL_REQUESTED audit row for every
      // kind, so there is nothing to record a second time here.
      revalidatePath('/dashboard/inventory/adjustments')
      return { status: 'PENDING' as const, reference, balance: null }
    }

    const posted = await adjustStock({
      restaurantId: user.restaurantId, branchId,
      itemId: data.itemId, quantity: data.quantity,
      unit: data.unit, direction: data.direction, reason: data.reason,
      reference, userId: user.id,
    })
    await audit({
      restaurantId: user.restaurantId, branchId, userId: user.id, actorName: user.name,
      action: AUDIT_ACTIONS.STOCK_ADJUSTED, entity: 'InventoryItem', entityId: data.itemId,
      before: { balance: posted.balanceBefore },
      after: {
        balance: posted.balanceAfter, reference, direction: data.direction,
        quantity: data.quantity, unit, reason: data.reason,
      },
    })
    revalidateInventory(data.itemId)
    revalidatePath('/dashboard/inventory/adjustments')
    return { status: 'APPLIED' as const, reference, balance: posted.balanceAfter }
  }, 'Saved.')
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
    const branchId = await actingBranchId(user)
    const posted = await setOpeningBalance({
      restaurantId: user.restaurantId, branchId,
      itemId: data.itemId, quantity: data.quantity,
      unit: data.unit, unitCost: await costToMinor(user.restaurantId, data.unitCost), userId: user.id,
    })
    await audit({
      restaurantId: user.restaurantId, branchId, userId: user.id, actorName: user.name,
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
  const countAt = branchId || (await actingBranchId(user))
  const count = await openStockCount({
    restaurantId: user.restaurantId, userId: user.id, branchId: countAt,
  })
  await audit({
    restaurantId: user.restaurantId, branchId: countAt, userId: user.id, actorName: user.name,
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
  const countAt = await countBranch(user.restaurantId, stockCountId)
  await assertRecordBranch(user, countAt, 'stock count')
  const count = await cancelStockCount(user.restaurantId, stockCountId)
  await audit({
    restaurantId: user.restaurantId, branchId: countAt?.branchId ?? null,
    userId: user.id, actorName: user.name,
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
    const countAt = await countBranch(user.restaurantId, data.stockCountId)
    await assertRecordBranch(user, countAt, 'stock count')
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
      restaurantId: user.restaurantId, branchId: countAt?.branchId ?? null,
      userId: user.id, actorName: user.name,
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
