import 'server-only'

import type { InventoryItem, StockUnit } from '@prisma/client'

import { AppError, NotFoundError } from '@/lib/errors'
import { roundQty } from '@/lib/quantity'
import {
  guardLocks, isUniqueViolation, prisma, uniqueViolationTargets, type TxClient,
} from '@/server/db/prisma'
import { requireBranch } from '@/features/branches/service'
import { upsertBatch } from '@/features/inventory/batches'
import { postMovement } from '@/features/inventory/ledger'
import { assertSufficient } from '@/features/inventory/location-stock'
import { UNIT_LABELS, UnitConversionError, toBaseUnits } from '@/features/inventory/units'
import { recordWastageWithin } from '@/features/inventory/wastage'
import type { ProduceItemResult } from './types'

/**
 * Kitchen production: making a prepared item out of stock (redesignkitchenjob.md).
 *
 *   raw stock ──consume──▶ [ production run ] ──produce──▶ prepared item ──▶ dish ──▶ sale
 *
 * ── What a run is ───────────────────────────────────────────────────────────
 *
 * Somebody names what they made, says how much, and lists the stock items they
 * used. That is the whole input. There is no recipe to select, no job to plan,
 * start or approve: the previous flow (kitchenjobs.md) had all three and cooks
 * found it confusing, because none of those steps moved any stock — only the
 * last one did. Now there is only the last one.
 *
 * ── An inventory transformation, not cost of sales ─────────────────────────
 *
 * The ingredients leave the ledger at their running average and EXACTLY that
 * value arrives in the prepared item: raw value down, prepared value up, the
 * restaurant's stock is worth the same before and after. Nothing is expensed.
 * Cost of sales happens later, when a dish that uses the prepared item is
 * sold and `reconcileOrderDepletion` consumes it like any other ingredient —
 * which is also why there is no second costing path here. A prepared item is
 * an ordinary `InventoryItem` with `isPrepared` set, and every recipe picker,
 * report and reconciliation already treats it as one.
 *
 * Waste is the exception: trimmings thrown away while making something are
 * recorded as WASTAGE in the same transaction, and their value is expensed —
 * it must not be hidden inside the prepared item's cost.
 *
 * ── One transaction, once ───────────────────────────────────────────────────
 *
 * Everything below `produceItem`'s pre-checks happens in a single transaction:
 * a run that consumed its eggs and failed before the mayonnaise existed would
 * destroy stock outright. The form's request key is unique per restaurant, so
 * the same batch submitted twice — a retry, a double tap — is recorded once and
 * the second caller is handed the first result.
 */

export interface ProduceItemParams {
  restaurantId: string
  branchId: string
  userId: string | null
  /** Minted once by the form when the cook commits; the same value on every retry. */
  clientRequestId: string
  output: {
    /** When the form matched the typed name to an existing prepared item. */
    itemId?: string | null
    name: string
    quantity: number
    unit: StockUnit
  }
  ingredients: Array<{ itemId: string; quantity: number; unit: StockUnit }>
  waste?: Array<{ itemId: string; quantity: number; unit: StockUnit; note?: string | null }>
  notes?: string | null
}

export async function produceItem(params: ProduceItemParams): Promise<ProduceItemResult> {
  validateShape(params)

  // Tenant check on the branch; `assertBranchAccess` in the action only checks
  // the caller's reach, not that the branch is this restaurant's.
  await requireBranch(params.restaurantId, params.branchId)

  const resolved = await resolvePreparedItem(params)
  const producedBase = convertOrRefuse(params.output.quantity, params.output.unit, resolved.item, 'produced')

  try {
    return await prisma.$transaction(async (tx) => {
      await guardLocks(tx)

      /*
       * Replay before anything else. Two requests with one key can both pass
       * this read; the unique index on (restaurantId, clientRequestId) decides
       * between them when the order row is created below, and the loser is
       * handed the winner's result in the catch at the bottom.
       */
      const already = await tx.productionOrder.findFirst({
        where: { restaurantId: params.restaurantId, clientRequestId: params.clientRequestId },
        select: { id: true },
      })
      if (already) return loadResult(tx, params.restaurantId, already.id, true)

      /*
       * The ingredients, tenant-scoped. An id from another restaurant — or a
       * retired item — is simply not found, which is the right answer.
       */
      const ids = params.ingredients.map((line) => line.itemId)
      const rows = await tx.inventoryItem.findMany({
        where: { id: { in: ids }, restaurantId: params.restaurantId, isActive: true },
      })
      const byId = new Map(rows.map((row) => [row.id, row]))
      for (const id of ids) if (!byId.has(id)) throw new NotFoundError('Ingredient')

      /*
       * Job numbers are derived from the highest issued, so two runs created in
       * the same instant would draw the same one. A per-restaurant advisory lock
       * serialises that without locking any row, and is released with the
       * transaction — safe behind a transaction-mode pooler.
       */
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${params.restaurantId}))`
      const number = await nextJobNumber(tx, params.restaurantId)
      const now = new Date()

      /*
       * The record exists before anything moves, so every movement can point
       * at it. Created COMPLETED: there is no other state a run can be in.
       * Totals are filled in once the ledger has said what they are.
       */
      const order = await tx.productionOrder.create({
        data: {
          restaurantId: params.restaurantId,
          branchId: params.branchId,
          number,
          status: 'COMPLETED',
          clientRequestId: params.clientRequestId,
          outputItemId: resolved.item.id,
          recipeName: resolved.item.name,
          unit: resolved.item.unit,
          plannedQty: producedBase,
          actualQty: producedBase,
          variance: 0,
          notes: params.notes?.trim() || null,
          requestedById: params.userId,
          productionDate: now,
          completedAt: now,
        },
      })

      const reason = `Made ${resolved.item.name} (${number})`
      const reference = { referenceType: 'ProductionOrder', referenceId: order.id }

      /*
       * Ingredients leave, in a fixed order. `postMovement` locks each item row;
       * two runs touching the same items in different orders would deadlock,
       * and the lock timeout would turn a busy kitchen into a flaky one.
       */
      const consumed: ProduceItemResult['consumed'] = []
      let totalValue = 0
      const lines = [...params.ingredients].sort((a, b) => a.itemId.localeCompare(b.itemId))
      for (const line of lines) {
        const ingredient = byId.get(line.itemId)!
        const base = convertOrRefuse(line.quantity, line.unit, ingredient, 'used')

        // Production never draws a shelf below zero, whatever the negative-stock
        // setting says: a run is planned against what is actually there.
        await assertSufficient(tx, {
          restaurantId: params.restaurantId,
          itemId: ingredient.id,
          branchId: params.branchId,
          quantity: base,
          itemName: ingredient.name,
        })

        const posted = await postMovement(tx, {
          restaurantId: params.restaurantId,
          itemId: ingredient.id,
          type: 'PRODUCTION_CONSUMPTION',
          quantity: line.quantity,
          enteredUnit: line.unit,
          reason,
          ...reference,
          branchId: params.branchId,
          userId: params.userId,
        })

        // The EXACT value the ledger removed — not quantity × a rounded cache.
        totalValue += posted.valueMoved

        await tx.productionConsumption.create({
          data: {
            orderId: order.id,
            itemId: ingredient.id,
            quantity: base,
            unit: ingredient.unit,
            unitCost: posted.movement.unitCost,
            lineCost: Math.round(posted.valueMoved),
          },
        })
        consumed.push({
          itemId: ingredient.id,
          name: ingredient.name,
          quantity: base,
          unit: ingredient.unit,
          value: Math.round(posted.valueMoved),
        })
      }

      // Waste: thrown away, expensed, never part of the item's value.
      const wasted: ProduceItemResult['wasted'] = []
      for (const line of params.waste ?? []) {
        const ingredient = byId.get(line.itemId)!
        const record = await recordWastageWithin(tx, {
          restaurantId: params.restaurantId,
          itemId: ingredient.id,
          quantity: line.quantity,
          unit: line.unit,
          reason: 'PREPARATION',
          reasonNote: line.note?.trim() || null,
          notes: `Production ${number} — ${resolved.item.name}`,
          branchId: params.branchId,
          userId: params.userId,
          productionOrderId: order.id,
        })
        wasted.push({
          itemId: ingredient.id,
          name: ingredient.name,
          quantity: record.quantity,
          unit: ingredient.unit,
          value: record.costValue,
        })
      }

      /*
       * The prepared item arrives carrying exactly what left. `totalValue` is
       * the value channel; the per-unit figure on the movement is derived from
       * it, not the other way round.
       */
      const batchNumber = resolved.item.trackBatches
        ? `${number}-${now.toISOString().slice(0, 10).replace(/-/g, '')}`
        : null
      const produced = await postMovement(tx, {
        restaurantId: params.restaurantId,
        itemId: resolved.item.id,
        type: 'PRODUCTION_OUTPUT',
        quantity: params.output.quantity,
        enteredUnit: params.output.unit,
        totalValue,
        reason,
        ...reference,
        branchId: params.branchId,
        batchNo: batchNumber,
        userId: params.userId,
      })
      const unitCost = produced.movement.unitCost

      let batchId: string | null = null
      if (resolved.item.trackBatches && batchNumber) {
        const batch = await upsertBatch(tx, {
          restaurantId: params.restaurantId,
          itemId: resolved.item.id,
          batchNo: batchNumber,
          quantity: producedBase,
          unitCost,
          branchId: params.branchId,
        })
        batchId = batch.id
        await tx.stockMovement.update({
          where: { id: produced.movement.id },
          data: { batchId: batch.id },
        })
      }

      await tx.productionOutput.create({
        data: {
          orderId: order.id,
          itemId: resolved.item.id,
          quantity: producedBase,
          unit: resolved.item.unit,
          unitCost,
          batchId,
        },
      })

      if (!resolved.item.isPrepared) {
        await tx.inventoryItem.update({
          where: { id: resolved.item.id },
          data: { isPrepared: true },
        })
      }

      await tx.productionOrder.update({
        where: { id: order.id },
        data: { totalCost: Math.round(totalValue), unitCost, batchNumber },
      })

      return {
        replayed: false,
        orderId: order.id,
        number,
        item: {
          id: resolved.item.id,
          name: resolved.item.name,
          unit: resolved.item.unit,
          isNew: resolved.created,
          costPerUnit: produced.item.costPerUnit,
          quantity: produced.item.quantity,
        },
        producedQty: producedBase,
        consumed,
        wasted,
        totalValue: Math.round(totalValue),
        unitCost,
        completedAt: now.toISOString(),
      }
    })
  } catch (error) {
    /*
     * Two requests with the same key raced and this one lost. It must not
     * retry — that would make the batch twice — so it returns the winner's
     * record, and both callers see the same result.
     */
    if (isUniqueViolation(error) && uniqueViolationTargets(error).includes('clientRequestId')) {
      const winner = await prisma.productionOrder.findFirst({
        where: { restaurantId: params.restaurantId, clientRequestId: params.clientRequestId },
        select: { id: true },
      })
      if (winner) {
        return prisma.$transaction((tx) => loadResult(tx, params.restaurantId, winner.id, true))
      }
    }
    throw error
  }
}

/* ── Pieces ───────────────────────────────────────────────────────────────── */

function validateShape(params: ProduceItemParams) {
  if (!(params.output.quantity > 0)) {
    throw new AppError('Say how much came out', 400, 'PRODUCTION_NO_OUTPUT')
  }
  if (params.ingredients.length === 0) {
    throw new AppError('Add at least one ingredient', 400, 'PRODUCTION_NO_INGREDIENTS')
  }
  const seen = new Set<string>()
  for (const line of params.ingredients) {
    if (!(line.quantity > 0)) {
      throw new AppError('Every ingredient needs a quantity above zero', 400, 'PRODUCTION_BAD_QUANTITY')
    }
    if (seen.has(line.itemId)) {
      throw new AppError('An ingredient is listed twice — combine the lines', 400, 'PRODUCTION_DUPLICATE_LINE')
    }
    seen.add(line.itemId)
  }
  if (params.output.itemId && seen.has(params.output.itemId)) {
    throw new AppError('Something cannot be made out of itself', 400, 'PRODUCTION_SELF_REFERENCE')
  }
  for (const line of params.waste ?? []) {
    if (!(line.quantity > 0)) {
      throw new AppError('Waste needs a quantity above zero', 400, 'PRODUCTION_BAD_QUANTITY')
    }
    if (!seen.has(line.itemId)) {
      throw new AppError('Waste can only be recorded for an ingredient this run used', 400, 'PRODUCTION_WASTE_NOT_INGREDIENT')
    }
  }
}

/** Unit conversion with the item's name in the refusal, so the cook knows which row. */
function convertOrRefuse(
  quantity: number,
  unit: StockUnit,
  item: InventoryItem,
  what: 'produced' | 'used',
): number {
  try {
    return roundQty(toBaseUnits(quantity, unit, item))
  } catch (error) {
    if (error instanceof UnitConversionError) {
      throw new AppError(
        `${item.name} is stocked in ${UNIT_LABELS[item.unit]} — enter the ${what} quantity in a matching unit`,
        400,
        'PRODUCTION_UNIT_MISMATCH',
      )
    }
    throw error
  }
}

/**
 * The item being made: found by id, found by name, or created.
 *
 * Done in its own short transaction, deliberately. A unique-key collision on
 * a create aborts a Postgres transaction and nothing after it can run, so the
 * create cannot sit inside the run's transaction and recover. Creating first
 * means a run that then fails leaves at worst an empty prepared item — which
 * the next attempt finds by name and uses. Two first runs of the same new item
 * at the same moment: one creates, the other's create collides and re-reads.
 *
 * A name that already belongs to a RAW stock item is refused. Adding
 * production output to "Chicken" would blend prepared value into raw stock and
 * make both wrong; the form says so and suggests a different name.
 */
async function resolvePreparedItem(
  params: ProduceItemParams,
): Promise<{ item: InventoryItem; created: boolean }> {
  const name = params.output.name.trim().replace(/\s+/g, ' ')

  if (params.output.itemId) {
    const item = await prisma.inventoryItem.findFirst({
      where: { id: params.output.itemId, restaurantId: params.restaurantId, isActive: true },
    })
    if (!item) throw new NotFoundError('Prepared item')
    refuseRawName(item)
    return { item, created: false }
  }

  const existing = await prisma.inventoryItem.findFirst({
    where: { restaurantId: params.restaurantId, name: { equals: name, mode: 'insensitive' } },
  })
  if (existing) {
    if (!existing.isActive) {
      throw new AppError(`${existing.name} was retired — restore it in Inventory first`, 409, 'PRODUCTION_ITEM_RETIRED')
    }
    refuseRawName(existing)
    return { item: existing, created: false }
  }

  try {
    const item = await prisma.inventoryItem.create({
      data: {
        restaurantId: params.restaurantId,
        name,
        unit: params.output.unit,
        category: 'Prepared',
        isPrepared: true,
        branchId: params.branchId,
        quantity: 0,
        costPerUnit: 0,
      },
    })
    return { item, created: true }
  } catch (error) {
    if (!isUniqueViolation(error)) throw error
    const raced = await prisma.inventoryItem.findFirst({
      where: { restaurantId: params.restaurantId, name: { equals: name, mode: 'insensitive' } },
    })
    if (!raced) throw error
    refuseRawName(raced)
    return { item: raced, created: false }
  }
}

function refuseRawName(item: InventoryItem) {
  if (item.isPrepared) return
  // Legacy: anything a recipe produces or a run has produced was flagged by the
  // migration, so a real raw item is the only thing that reaches here.
  throw new AppError(
    `"${item.name}" is a raw stock item. Give the prepared item its own name — "Prepared ${item.name.toLowerCase()}", say.`,
    409,
    'PRODUCTION_NAME_IS_RAW_STOCK',
  )
}

/**
 * The next job number.
 *
 * Derived from the highest number already issued rather than from a row count,
 * which collided the moment anything was cancelled and deleted. Kept as an
 * internal reference — it appears on ledger rows and the run's page, not as
 * the way anyone is expected to find a run.
 */
async function nextJobNumber(tx: TxClient, restaurantId: string): Promise<string> {
  const last = await tx.productionOrder.findFirst({
    where: { restaurantId },
    orderBy: { number: 'desc' },
    select: { number: true },
  })
  const previous = last ? Number.parseInt(last.number.replace(/\D/g, ''), 10) : 0
  return `PRD-${String((Number.isFinite(previous) ? previous : 0) + 1).padStart(6, '0')}`
}

/** A finished run, in the shape `produceItem` returns — for replays. */
async function loadResult(
  tx: TxClient,
  restaurantId: string,
  orderId: string,
  replayed: boolean,
): Promise<ProduceItemResult> {
  const order = await tx.productionOrder.findFirstOrThrow({
    where: { id: orderId, restaurantId },
    include: {
      outputItem: true,
      consumption: { include: { item: { select: { name: true, unit: true } } } },
      outputs: { take: 1 },
      wastage: { include: { item: { select: { name: true, unit: true } } } },
    },
  })
  const item = order.outputItem
  if (!item) throw new NotFoundError('Prepared item')
  return {
    replayed,
    orderId: order.id,
    number: order.number,
    item: {
      id: item.id,
      name: item.name,
      unit: item.unit,
      isNew: false,
      costPerUnit: item.costPerUnit,
      quantity: item.quantity,
    },
    producedQty: order.outputs[0]?.quantity ?? order.actualQty ?? 0,
    consumed: order.consumption.map((line) => ({
      itemId: line.itemId,
      name: line.item.name,
      quantity: line.quantity,
      unit: line.item.unit,
      value: line.lineCost,
    })),
    wasted: order.wastage.map((record) => ({
      itemId: record.itemId,
      name: record.item.name,
      quantity: record.quantity,
      unit: record.item.unit,
      value: record.costValue,
    })),
    totalValue: order.totalCost,
    unitCost: order.unitCost,
    completedAt: (order.completedAt ?? order.createdAt).toISOString(),
  }
}
