import 'server-only'

import type { ProductionOrder, ProductionStatus, ProductionVarianceReason } from '@prisma/client'

import { AppError, NotFoundError } from '@/lib/errors'
import { prisma, type TxClient } from '@/server/db/prisma'
import { postMovement } from '@/features/inventory/ledger'
import { assertSufficient } from '@/features/inventory/location-stock'
import { upsertBatch } from '@/features/inventory/batches'
import { toBaseUnits } from '@/features/inventory/units'

/**
 * Production: turning stock into different stock.
 *
 * A production house consumes raw materials and produces finished goods, both
 * through the same ledger the rest of the system uses. That is what keeps the
 * chain honest end to end:
 *
 *   raw material → production spec → finished product → menu recipe → sale
 *
 * ── Nothing moves until completion ──────────────────────────────────────────
 *
 * Planning and approving a run change no stock. Ingredients leave and finished
 * goods appear at the moment the run is completed, in one transaction — a run
 * that consumed its chicken but failed before creating the patties would
 * destroy stock outright.
 *
 * ── Variance is compulsory ──────────────────────────────────────────────────
 *
 * Planning 500 and making 480 is normal; leaving the 20 unexplained is not. A
 * shortfall demands a reason, because "where did the other 20 go" is precisely
 * what a production house exists to answer.
 */

const ALLOWED: Record<ProductionStatus, ProductionStatus[]> = {
  DRAFT: ['PLANNED', 'APPROVED', 'CANCELLED'],
  PLANNED: ['APPROVED', 'DRAFT', 'CANCELLED'],
  APPROVED: ['IN_PROGRESS', 'CANCELLED'],
  IN_PROGRESS: ['COMPLETED', 'PARTIALLY_COMPLETED', 'CANCELLED'],
  COMPLETED: [],
  PARTIALLY_COMPLETED: [],
  CANCELLED: [],
}

export function canTransitionProduction(from: ProductionStatus, to: ProductionStatus): boolean {
  return ALLOWED[from]?.includes(to) ?? false
}

/** Only a production house may run production. */
async function requireProductionHouse(restaurantId: string, branchId: string) {
  const branch = await prisma.branch.findFirst({
    where: { id: branchId, restaurantId, deletedAt: null },
    select: { id: true, name: true, type: true },
  })
  if (!branch) throw new NotFoundError('Location')
  if (branch.type !== 'PRODUCTION_HOUSE') {
    throw new AppError(
      `${branch.name} is not a production house`,
      400,
      'NOT_PRODUCTION_HOUSE',
    )
  }
  return branch
}

export async function createProductionOrder(params: {
  restaurantId: string
  branchId: string
  specId: string
  /** Batches to make. */
  plannedQty: number
  productionDate?: Date | null
  notes?: string | null
  userId?: string | null
}): Promise<ProductionOrder> {
  if (!(params.plannedQty > 0)) {
    throw new AppError('Plan a quantity above zero', 400, 'PRODUCTION_BAD_QTY')
  }
  await requireProductionHouse(params.restaurantId, params.branchId)

  const spec = await prisma.productionSpec.findFirst({
    where: { id: params.specId, restaurantId: params.restaurantId, isActive: true },
    include: { outputItem: { select: { id: true, unit: true } } },
  })
  if (!spec) throw new NotFoundError('Production recipe')

  return prisma.$transaction(async (tx) => {
    const count = await tx.productionOrder.count({ where: { restaurantId: params.restaurantId } })
    const number = `PRD-${String(count + 1).padStart(6, '0')}`

    return tx.productionOrder.create({
      data: {
        restaurantId: params.restaurantId,
        branchId: params.branchId,
        specId: spec.id,
        number,
        status: 'DRAFT',
        plannedQty: params.plannedQty,
        unit: spec.outputItem.unit,
        productionDate: params.productionDate ?? null,
        notes: params.notes?.trim() || null,
        requestedById: params.userId ?? null,
      },
    })
  })
}

export async function setProductionStatus(params: {
  restaurantId: string
  orderId: string
  status: ProductionStatus
  userId?: string | null
}): Promise<ProductionOrder> {
  const order = await prisma.productionOrder.findFirst({
    where: { id: params.orderId, restaurantId: params.restaurantId },
  })
  if (!order) throw new NotFoundError('Production order')

  if (!canTransitionProduction(order.status, params.status)) {
    throw new AppError(
      `A ${order.status.replace(/_/g, ' ').toLowerCase()} run cannot become ${params.status
        .replace(/_/g, ' ')
        .toLowerCase()}`,
      409,
      'PRODUCTION_BAD_TRANSITION',
    )
  }

  return prisma.productionOrder.update({
    where: { id: order.id },
    data: {
      status: params.status,
      ...(params.status === 'APPROVED'
        ? { approvedById: params.userId ?? null, approvedAt: new Date() }
        : {}),
      ...(params.status === 'IN_PROGRESS' ? { startedAt: new Date() } : {}),
    },
  })
}

export interface CompleteProductionResult {
  order: ProductionOrder
  consumed: Array<{ itemId: string; name: string; quantity: number; cost: number }>
  producedQty: number
  totalCost: number
  unitCost: number
  variance: number
  batchNumber: string | null
}

/**
 * Complete a run: consume the raw materials, create the finished goods.
 *
 * Everything happens in one transaction. Raw materials are checked against the
 * production house's own stock first, so a run cannot half-consume its way into
 * negative ingredients before failing.
 *
 * Cost flows from what was actually consumed, not from a price list: the
 * finished item's cost per unit is the run's total ingredient cost divided by
 * what was actually made. Making 480 instead of 500 therefore raises the cost
 * of each patty, which is the true picture.
 */
export async function completeProduction(params: {
  restaurantId: string
  orderId: string
  /** Batches actually produced. Defaults to what was planned. */
  actualQty?: number
  varianceReason?: ProductionVarianceReason | null
  varianceNote?: string | null
  batchNumber?: string | null
  userId?: string | null
}): Promise<CompleteProductionResult> {
  const order = await prisma.productionOrder.findFirst({
    where: { id: params.orderId, restaurantId: params.restaurantId },
    include: {
      spec: {
        include: {
          items: { include: { item: true } },
          outputItem: true,
        },
      },
    },
  })
  if (!order) throw new NotFoundError('Production order')
  if (!order.spec) throw new AppError('This run has no recipe', 400, 'PRODUCTION_NO_SPEC')
  if (order.status === 'COMPLETED' || order.status === 'PARTIALLY_COMPLETED') {
    throw new AppError('That run is already finished', 409, 'PRODUCTION_DONE')
  }
  if (order.status === 'CANCELLED') {
    throw new AppError('That run was cancelled', 409, 'PRODUCTION_CANCELLED')
  }
  if (order.status !== 'APPROVED' && order.status !== 'IN_PROGRESS') {
    throw new AppError('Approve the run before completing it', 409, 'PRODUCTION_NOT_APPROVED')
  }

  const batches = params.actualQty ?? order.plannedQty
  if (batches < 0) throw new AppError('Produced quantity cannot be negative', 400, 'PRODUCTION_NEGATIVE')

  const variance = round(batches - order.plannedQty)
  if (variance < 0 && !params.varianceReason) {
    throw new AppError(
      `${Math.abs(variance)} short of plan — give a reason`,
      400,
      'PRODUCTION_VARIANCE_NO_REASON',
    )
  }

  const spec = order.spec
  // Ingredients scale with what was actually made, not what was planned: a run
  // that produced 80% of target consumed roughly 80% of the ingredients.
  const scale = spec.outputQty > 0 ? batches / 1 : batches

  return prisma.$transaction(async (tx) => {
    const consumed: CompleteProductionResult['consumed'] = []
    let totalCost = 0

    for (const line of spec.items) {
      const perBatch = toBaseUnits(line.quantity, line.unit ?? line.item.unit, line.item)
      const needed = round(perBatch * scale)
      if (needed <= 0) continue

      await assertSufficient(tx, {
        restaurantId: params.restaurantId,
        itemId: line.itemId,
        branchId: order.branchId,
        quantity: needed,
        itemName: line.item.name,
      })

      const posted = await postMovement(tx, {
        restaurantId: params.restaurantId,
        itemId: line.itemId,
        type: 'PRODUCTION_CONSUMPTION',
        quantity: needed,
        reason: `Production ${order.number}`,
        referenceType: 'ProductionOrder',
        referenceId: order.id,
        branchId: order.branchId,
        userId: params.userId,
      })

      const lineCost = Math.round(needed * posted.item.costPerUnit)
      totalCost += lineCost

      await tx.productionConsumption.create({
        data: {
          orderId: order.id,
          itemId: line.itemId,
          quantity: needed,
          unit: line.item.unit,
          unitCost: posted.item.costPerUnit,
          lineCost,
        },
      })

      consumed.push({
        itemId: line.itemId,
        name: line.item.name,
        quantity: needed,
        cost: lineCost,
      })
    }

    const producedQty = round(batches * spec.outputQty)
    const unitCost = producedQty > 0 ? Math.round(totalCost / producedQty) : 0

    const batchNumber =
      params.batchNumber?.trim().toUpperCase() ||
      `${order.number}-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`

    const expiryDate = spec.shelfLifeDays
      ? new Date(Date.now() + spec.shelfLifeDays * 86_400_000)
      : null

    let batchId: string | null = null
    if (producedQty > 0) {
      const posted = await postMovement(tx, {
        restaurantId: params.restaurantId,
        itemId: spec.outputItemId,
        type: 'PRODUCTION_OUTPUT',
        quantity: producedQty,
        // The finished item is costed from what it actually took to make.
        unitCost,
        reason: `Production ${order.number}`,
        referenceType: 'ProductionOrder',
        referenceId: order.id,
        branchId: order.branchId,
        batchNo: batchNumber,
        expiryDate,
        userId: params.userId,
      })

      if (spec.outputItem.trackBatches) {
        const batch = await upsertBatch(tx, {
          restaurantId: params.restaurantId,
          itemId: spec.outputItemId,
          batchNo: batchNumber,
          quantity: producedQty,
          unitCost,
          expiryDate,
          branchId: order.branchId,
        })
        batchId = batch.id
        await tx.stockMovement.update({
          where: { id: posted.movement.id },
          data: { batchId: batch.id },
        })
      }

      await tx.productionOutput.create({
        data: {
          orderId: order.id,
          itemId: spec.outputItemId,
          quantity: producedQty,
          unit: spec.outputItem.unit,
          unitCost,
          batchId,
        },
      })
    }

    const updated = await tx.productionOrder.update({
      where: { id: order.id },
      data: {
        status: variance < 0 ? 'PARTIALLY_COMPLETED' : 'COMPLETED',
        actualQty: batches,
        variance,
        varianceReason: params.varianceReason ?? null,
        varianceNote: params.varianceNote?.trim() || null,
        totalCost,
        unitCost,
        batchNumber,
        expiryDate,
        completedAt: new Date(),
        productionDate: order.productionDate ?? new Date(),
      },
    })

    return {
      order: updated,
      consumed,
      producedQty,
      totalCost,
      unitCost,
      variance,
      batchNumber,
    }
  })
}

/** Create a production recipe. */
export async function createProductionSpec(params: {
  restaurantId: string
  name: string
  outputItemId: string
  outputQty: number
  shelfLifeDays?: number | null
  items: Array<{ itemId: string; quantity: number; unit?: string | null }>
  notes?: string | null
}) {
  if (params.items.length === 0) {
    throw new AppError('A production recipe needs ingredients', 400, 'SPEC_EMPTY')
  }
  if (!(params.outputQty > 0)) {
    throw new AppError('Say how much one batch produces', 400, 'SPEC_BAD_OUTPUT')
  }
  if (params.items.some((i) => i.itemId === params.outputItemId)) {
    throw new AppError(
      'A recipe cannot consume the thing it produces',
      400,
      'SPEC_SELF_REFERENCE',
    )
  }

  const ids = [params.outputItemId, ...params.items.map((i) => i.itemId)]
  const owned = await prisma.inventoryItem.count({
    where: { id: { in: ids }, restaurantId: params.restaurantId },
  })
  if (owned !== new Set(ids).size) throw new NotFoundError('Inventory item')

  return prisma.productionSpec.create({
    data: {
      restaurantId: params.restaurantId,
      name: params.name.trim(),
      outputItemId: params.outputItemId,
      outputQty: params.outputQty,
      shelfLifeDays: params.shelfLifeDays ?? null,
      notes: params.notes?.trim() || null,
      items: {
        create: params.items.map((i) => ({
          itemId: i.itemId,
          quantity: i.quantity,
          unit: (i.unit ?? null) as never,
        })),
      },
    },
  })
}

function round(v: number): number {
  return Math.round(v * 1e6) / 1e6
}
