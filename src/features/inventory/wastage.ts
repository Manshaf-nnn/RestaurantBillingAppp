import 'server-only'

import type { StockUnit, WastageReason, WastageRecord } from '@prisma/client'

import { AppError, NotFoundError } from '@/lib/errors'
import { prisma } from '@/server/db/prisma'
import { postMovement } from './ledger'
import { toBaseUnits } from './units'
import { allocateFefo, consumeBatches } from './batches'

/**
 * Wastage.
 *
 * Recorded as a WASTAGE movement, never as a sale. That distinction is the
 * whole point: food that went in the bin and food a guest paid for both leave
 * stock, but only one of them earned anything, and a system that conflates them
 * reports a healthy day while the kitchen quietly loses money.
 *
 * ── Why stock moves before approval ─────────────────────────────────────────
 *
 * The movement is posted when the record is created, not when a manager
 * approves it. The food is already in the bin; refusing to write it down until
 * someone signs off would leave the system claiming stock that visibly does not
 * exist, and the person who dropped the tray is rarely the person who can
 * approve it. Approval is a review of a fact, not permission for it — which is
 * also what makes the approval queue useful, since it lists what happened
 * rather than what is waiting to happen.
 */

export const WASTAGE_REASON_LABELS: Record<WastageReason, string> = {
  EXPIRED: 'Expired',
  SPOILED: 'Spoiled',
  BURNT: 'Burnt',
  DAMAGED: 'Damaged',
  DROPPED: 'Dropped',
  PREPARATION: 'Preparation waste',
  CUSTOMER_RETURN: 'Customer return',
  OTHER: 'Other',
}

export async function recordWastage(params: {
  restaurantId: string
  itemId: string
  quantity: number
  unit?: StockUnit | null
  reason: WastageReason
  reasonNote?: string | null
  notes?: string | null
  photoUrl?: string | null
  branchId?: string | null
  locationId?: string | null
  batchId?: string | null
  userId?: string | null
}): Promise<WastageRecord> {
  if (!(params.quantity > 0)) {
    throw new AppError('Quantity must be more than zero', 400, 'WASTAGE_BAD_QTY')
  }
  // "Other" without an explanation is the same as no reason at all.
  if (params.reason === 'OTHER' && !params.reasonNote?.trim()) {
    throw new AppError('Say what happened when the reason is Other', 400, 'WASTAGE_NO_NOTE')
  }

  const item = await prisma.inventoryItem.findFirst({
    where: { id: params.itemId, restaurantId: params.restaurantId },
  })
  if (!item) throw new NotFoundError('Inventory item')

  const enteredUnit = params.unit ?? item.unit
  const base = toBaseUnits(params.quantity, enteredUnit, item)

  return prisma.$transaction(async (tx) => {
    const posted = await postMovement(tx, {
      restaurantId: params.restaurantId,
      itemId: item.id,
      type: 'WASTAGE',
      quantity: params.quantity,
      enteredUnit,
      reason: WASTAGE_REASON_LABELS[params.reason],
      notes: params.reasonNote?.trim() || params.notes?.trim() || null,
      referenceType: 'Wastage',
      branchId: params.branchId,
      locationId: params.locationId,
      batchId: params.batchId ?? null,
      userId: params.userId,
    })

    // Batches are drawn down by postMovement above, for every outward movement
    // rather than only this one. Repeating it here would consume each lot twice.

    const record = await tx.wastageRecord.create({
      data: {
        restaurantId: params.restaurantId,
        itemId: item.id,
        quantity: base,
        quantityEntered: params.quantity,
        enteredUnit,
        // Snapshotted: what was wasted cost that day's price, not today's.
        costValue: Math.round(base * item.costPerUnit),
        reason: params.reason,
        reasonNote: params.reasonNote?.trim() || null,
        notes: params.notes?.trim() || null,
        photoUrl: params.photoUrl?.trim() || null,
        branchId: params.branchId ?? null,
        locationId: params.locationId ?? null,
        batchId: params.batchId ?? null,
        createdById: params.userId ?? null,
        movementId: posted.movement.id,
        status: 'RECORDED',
      },
    })

    await tx.stockMovement.update({
      where: { id: posted.movement.id },
      data: { referenceId: record.id },
    })

    return record
  })
}

/** A manager's review of wastage that has already happened. */
export async function reviewWastage(params: {
  restaurantId: string
  wastageId: string
  approve: boolean
  userId: string
  note?: string | null
}): Promise<WastageRecord> {
  const record = await prisma.wastageRecord.findFirst({
    where: { id: params.wastageId, restaurantId: params.restaurantId },
  })
  if (!record) throw new NotFoundError('Wastage record')
  if (record.status !== 'RECORDED') {
    throw new AppError('That record has already been reviewed', 409, 'WASTAGE_REVIEWED')
  }

  return prisma.wastageRecord.update({
    where: { id: record.id },
    data: {
      status: params.approve ? 'APPROVED' : 'REJECTED',
      approvedById: params.userId,
      approvedAt: new Date(),
      // Rejecting does not restore stock — the food is still gone. It flags the
      // record as disputed so it can be investigated, which is the honest
      // outcome; reversing it would invent stock that does not exist.
      notes: params.note?.trim() || record.notes,
    },
  })
}

// ── reporting ────────────────────────────────────────────────────────────────

export type WastagePeriod = 'DAY' | 'WEEK' | 'MONTH'

export interface WastageReport {
  from: string
  to: string
  totalValue: number
  totalRecords: number
  byReason: Array<{ reason: WastageReason; label: string; count: number; value: number; share: number }>
  topItems: Array<{ itemId: string; name: string; unit: string; quantity: number; value: number }>
  byBranch: Array<{ branchId: string | null; name: string; value: number; count: number }>
  byEmployee: Array<{ userId: string | null; name: string; value: number; count: number }>
}

/**
 * Wastage over a period.
 *
 * Value is the sum of the snapshotted cost on each record, not a recomputation
 * at today's prices — otherwise last month's waste would silently change every
 * time a supplier put their prices up.
 */
export async function getWastageReport(params: {
  restaurantId: string
  period: WastagePeriod
  /** Defaults to now; passed in so the report is testable. */
  now?: Date
  branchId?: string | null
  /** Employee attribution is sensitive; the caller decides whether to include it. */
  includeEmployees?: boolean
}): Promise<WastageReport> {
  const now = params.now ?? new Date()
  const from = new Date(now)
  if (params.period === 'DAY') from.setHours(0, 0, 0, 0)
  else if (params.period === 'WEEK') from.setDate(from.getDate() - 7)
  else from.setMonth(from.getMonth() - 1)

  const records = await prisma.wastageRecord.findMany({
    where: {
      restaurantId: params.restaurantId,
      createdAt: { gte: from, lte: now },
      ...(params.branchId ? { branchId: params.branchId } : {}),
    },
    include: {
      item: { select: { id: true, name: true, unit: true } },
      branch: { select: { id: true, name: true } },
      createdBy: { select: { id: true, name: true } },
    },
  })

  const totalValue = records.reduce((sum, r) => sum + r.costValue, 0)

  const reasons = new Map<WastageReason, { count: number; value: number }>()
  const itemTotals = new Map<string, { name: string; unit: string; quantity: number; value: number }>()
  const branches = new Map<string, { name: string; value: number; count: number }>()
  const employees = new Map<string, { name: string; value: number; count: number }>()

  for (const r of records) {
    const reason = reasons.get(r.reason) ?? { count: 0, value: 0 }
    reasons.set(r.reason, { count: reason.count + 1, value: reason.value + r.costValue })

    const item = itemTotals.get(r.itemId) ?? {
      name: r.item.name, unit: r.item.unit, quantity: 0, value: 0,
    }
    itemTotals.set(r.itemId, {
      ...item, quantity: item.quantity + r.quantity, value: item.value + r.costValue,
    })

    const bKey = r.branchId ?? 'none'
    const branch = branches.get(bKey) ?? { name: r.branch?.name ?? 'Unassigned', value: 0, count: 0 }
    branches.set(bKey, { ...branch, value: branch.value + r.costValue, count: branch.count + 1 })

    if (params.includeEmployees) {
      const eKey = r.createdById ?? 'none'
      const employee = employees.get(eKey) ?? { name: r.createdBy?.name ?? 'Unknown', value: 0, count: 0 }
      employees.set(eKey, { ...employee, value: employee.value + r.costValue, count: employee.count + 1 })
    }
  }

  return {
    from: from.toISOString(),
    to: now.toISOString(),
    totalValue,
    totalRecords: records.length,
    byReason: [...reasons.entries()]
      .map(([reason, v]) => ({
        reason,
        label: WASTAGE_REASON_LABELS[reason],
        count: v.count,
        value: v.value,
        share: totalValue > 0 ? Math.round((v.value / totalValue) * 10000) / 100 : 0,
      }))
      .sort((a, b) => b.value - a.value),
    topItems: [...itemTotals.entries()]
      .map(([itemId, v]) => ({ itemId, ...v }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 20),
    byBranch: [...branches.entries()]
      .map(([id, v]) => ({ branchId: id === 'none' ? null : id, ...v }))
      .sort((a, b) => b.value - a.value),
    byEmployee: [...employees.entries()]
      .map(([id, v]) => ({ userId: id === 'none' ? null : id, ...v }))
      .sort((a, b) => b.value - a.value),
  }
}
