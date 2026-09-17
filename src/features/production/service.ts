import 'server-only'

import type { InventoryItem, Prisma, StockUnit } from '@prisma/client'
import type { ProductionVarianceReason } from '@prisma/client'

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
import { saveRecipe } from '@/features/recipes/service'
import type { ProduceItemResult, StartBatchResult } from './types'

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
  /**
   * Finish a batch that was started earlier (correctionA.md §10).
   *
   * When set, this run fills in that IN_PROGRESS order instead of creating a
   * new one — same transaction, same ledger writes, same reference number.
   * The alternative was a second order for one batch, which would mean two
   * job numbers for one pot of mayonnaise and a report that counts it twice.
   *
   * `output.quantity` is then the ACTUAL yield, and the planned figure stays
   * on the row beside it so the variance is the difference between the two.
   */
  batchId?: string | null
  /** Why the yield differed. Only meaningful when finishing a batch. */
  varianceReason?: ProductionVarianceReason | null
  varianceNote?: string | null
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
       * A number is drawn only for a run created here. A batch already has
       * one — issued when it was started — and the first cut drew a second
       * regardless and used it in every ledger reason and in the batch number,
       * so the order read PRD-000041 while its movements said "Made mayonnaise
       * (PRD-000042)", and 42 was skipped for ever (recorrection.md §3).
       */
      const number = params.batchId ? null : await drawJobNumber(tx, params.restaurantId)
      const now = new Date()

      /*
       * The record exists before anything moves, so every movement can point
       * at it.
       *
       * One step: created COMPLETED, planned and actual the same, no variance
       * — there is no other state a run made in one go can be in.
       *
       * Finishing a batch (correctionA.md §10): the IN_PROGRESS row started
       * earlier is filled in rather than a second one created, so one pot of
       * mayonnaise keeps one job number. Its `plannedQty` is left exactly as
       * it was and the variance is measured against it; overwriting the plan
       * with the actual would make every batch look like it yielded precisely
       * what was intended, which is the one thing this flow exists to notice.
       */
      const order = params.batchId
        ? await (async () => {
            const claimed = await tx.productionOrder.updateMany({
              // `updateMany` with the status in the WHERE, not `update`: two
              // cooks pressing Mark Done on the same batch would otherwise
              // both pass and both deduct the ingredients.
              where: {
                id: params.batchId!,
                restaurantId: params.restaurantId,
                status: 'IN_PROGRESS',
              },
              data: {
                status: 'COMPLETED',
                clientRequestId: params.clientRequestId,
                outputItemId: resolved.item.id,
                recipeName: resolved.item.name,
                unit: resolved.item.unit,
                actualQty: producedBase,
                varianceReason: params.varianceReason ?? null,
                varianceNote: params.varianceNote?.trim() || null,
                notes: params.notes?.trim() || null,
                productionDate: now,
                completedAt: now,
              },
            })
            if (claimed.count === 0) {
              throw new AppError(
                'That batch was finished a moment ago',
                409,
                'PRODUCTION_ALREADY_DONE',
              )
            }
            const row = await tx.productionOrder.findUniqueOrThrow({
              where: { id: params.batchId! },
            })
            // Measured against what was planned when the batch was started.
            await tx.productionOrder.update({
              where: { id: row.id },
              data: { variance: producedBase - row.plannedQty },
            })
            return { ...row, variance: producedBase - row.plannedQty }
          })()
        : await tx.productionOrder.create({
            data: {
              restaurantId: params.restaurantId,
              branchId: params.branchId,
              // Non-null on this path: it is only skipped when finishing a batch.
              number: number!,
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

      // The batch's own number when finishing one; the fresh one otherwise.
      const jobNumber = order.number
      const reason = `Made ${resolved.item.name} (${jobNumber})`
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
          notes: `Production ${jobNumber} — ${resolved.item.name}`,
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
        ? `${jobNumber}-${now.toISOString().slice(0, 10).replace(/-/g, '')}`
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
        number: jobNumber,
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
  params: Pick<ProduceItemParams, 'restaurantId' | 'branchId'> & {
    output: Pick<ProduceItemParams['output'], 'itemId' | 'name' | 'unit'>
  },
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
async function drawJobNumber(tx: TxClient, restaurantId: string): Promise<string> {
  /*
   * Job numbers are derived from the highest issued, so two runs created in
   * the same instant would draw the same one. A per-restaurant advisory lock
   * serialises that without locking any row, and is released with the
   * transaction — safe behind a transaction-mode pooler.
   */
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${restaurantId}))`
  return nextJobNumber(tx, restaurantId)
}

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

// ── batches: plan now, finish when the yield is known (correctionA.md §10) ──

/**
 * The plan a batch is started with.
 *
 * Stored as JSON on the order, not as consumption rows: those mean stock has
 * left the shelf, and a kitchen whose ingredients read as spent before anybody
 * opened a bag would take every report down with it.
 */
export interface BatchPlan {
  name: string
  quantity: number
  unit: StockUnit
  itemId?: string | null
  ingredients: Array<{ itemId: string; quantity: number; unit: StockUnit }>
  waste?: Array<{ itemId: string; quantity: number; unit: StockUnit; note?: string | null }>
}

/**
 * Create a prepared item — start its batch (recorrection.md §3).
 *
 * ── One flow ────────────────────────────────────────────────────────────────
 *
 * There used to be two buttons: "Make it now", which deducted the ingredients
 * and stocked the output in one go, and "Start a batch", which wrote a plan
 * and moved nothing. Both were defensible and together they were confusing —
 * the same form, two verbs, and a cook asked to predict the yield of a pot
 * that had not reduced yet. Now there is one: Create. It moves nothing. The
 * stock moves on Mark Done, with the quantity that actually came out, which
 * may be entered a moment later or hours later. The one-step transaction is
 * still `produceItem`, and Mark Done runs it against this batch's own row.
 *
 * ── What Create actually creates ───────────────────────────────────────────
 *
 * Two things, before the batch itself, and both outlive it:
 *
 *   - the prepared ITEM, as an ordinary `InventoryItem` with `isPrepared` —
 *     found by id, found by name, or created empty. The first cut created it
 *     only on Mark Done, so a batch for a new item was a row with a name and
 *     no item behind it, and the Prepared Items tab could not show it;
 *   - the prepared item's RECIPE (`Recipe.producesItemId`), holding the
 *     ingredients and the yield — how this thing is made. It is what "Make
 *     more" pre-fills from. Written through `saveRecipe`, the recipes domain's
 *     own writer, so its versioning rule applies: edited in place until a
 *     completed run has costed against it, superseded after. Left alone when
 *     the plan is identical to the recipe on file, so making the same thing
 *     the same way every day does not manufacture versions.
 *
 * The three writes are not one transaction, deliberately: the item and the
 * recipe are worth keeping if the batch row fails to be created, and the next
 * attempt finds and reuses both. Nothing in any of them touches stock.
 */
export async function startBatch(params: {
  restaurantId: string
  branchId: string
  userId: string | null
  clientRequestId: string
  plan: BatchPlan
  notes?: string | null
}): Promise<StartBatchResult> {
  if (!params.plan.name.trim()) throw new AppError('Name what is being made', 400, 'PRODUCTION_NO_NAME')
  if (!(params.plan.quantity > 0)) {
    throw new AppError('How much are you making?', 400, 'PRODUCTION_NO_QUANTITY')
  }
  if (params.plan.ingredients.length === 0) {
    throw new AppError('Add at least one ingredient', 400, 'PRODUCTION_NO_INGREDIENTS')
  }

  await requireBranch(params.restaurantId, params.branchId)

  const resolved = await resolvePreparedItem({
    restaurantId: params.restaurantId,
    branchId: params.branchId,
    output: { itemId: params.plan.itemId ?? null, name: params.plan.name, unit: params.plan.unit },
  })
  // A yield in a unit the item cannot be measured in is refused now, at the
  // form, not at Mark Done with the pot on the counter.
  convertOrRefuse(params.plan.quantity, params.plan.unit, resolved.item, 'produced')

  const recipe = await rememberRecipe({
    restaurantId: params.restaurantId,
    userId: params.userId,
    item: resolved.item,
    plan: params.plan,
  })

  const plan: BatchPlan = { ...params.plan, itemId: resolved.item.id, name: resolved.item.name }

  return prisma.$transaction(async (tx) => {
    await guardLocks(tx)

    // Same replay guard as `produceItem`: a double tap starts one batch.
    const already = await tx.productionOrder.findFirst({
      where: { restaurantId: params.restaurantId, clientRequestId: params.clientRequestId },
      select: { id: true, number: true, plannedQty: true, unit: true },
    })
    if (already) {
      return {
        replayed: true,
        id: already.id,
        number: already.number,
        plannedQty: already.plannedQty,
        unit: already.unit ?? params.plan.unit,
        item: { id: resolved.item.id, name: resolved.item.name, unit: resolved.item.unit, isNew: false },
      }
    }

    const number = await drawJobNumber(tx, params.restaurantId)

    const order = await tx.productionOrder.create({
      data: {
        restaurantId: params.restaurantId,
        branchId: params.branchId,
        number,
        status: 'IN_PROGRESS',
        clientRequestId: params.clientRequestId,
        recipeId: recipe?.id ?? null,
        recipeName: resolved.item.name,
        outputItemId: resolved.item.id,
        unit: params.plan.unit,
        plannedQty: params.plan.quantity,
        notes: params.notes?.trim() || null,
        requestedById: params.userId,
        productionDate: new Date(),
        plan: plan as unknown as Prisma.InputJsonValue,
      },
      select: { id: true, number: true },
    })
    return {
      replayed: false,
      id: order.id,
      number: order.number,
      plannedQty: params.plan.quantity,
      unit: params.plan.unit,
      item: {
        id: resolved.item.id,
        name: resolved.item.name,
        unit: resolved.item.unit,
        isNew: resolved.created,
      },
    }
  })
}

/**
 * The prepared item's recipe is how it was last made.
 *
 * Skipped when the plan matches the recipe on file line for line; written
 * through `saveRecipe` otherwise, so the recipes domain's versioning rule
 * holds here too. A unit the recipe writer refuses is reported in this
 * feature's own vocabulary.
 */
async function rememberRecipe(params: {
  restaurantId: string
  userId: string | null
  item: InventoryItem
  plan: BatchPlan
}): Promise<{ id: string } | null> {
  const current = await prisma.recipe.findFirst({
    where: {
      restaurantId: params.restaurantId,
      producesItemId: params.item.id,
      isActive: true,
      archivedAt: null,
    },
    orderBy: { version: 'desc' },
    include: { ingredients: { select: { inventoryItemId: true, quantity: true, unit: true } } },
  })

  const same =
    current !== null &&
    current.yieldQty === params.plan.quantity &&
    current.yieldUnit === params.plan.unit &&
    current.ingredients.length === params.plan.ingredients.length &&
    params.plan.ingredients.every((line) =>
      current.ingredients.some(
        (row) => row.inventoryItemId === line.itemId && row.quantity === line.quantity && row.unit === line.unit,
      ),
    )
  if (same) return { id: current.id }

  try {
    const saved = await saveRecipe({
      restaurantId: params.restaurantId,
      userId: params.userId,
      producesItemId: params.item.id,
      name: params.item.name,
      yieldQty: params.plan.quantity,
      yieldUnit: params.plan.unit,
      ingredients: params.plan.ingredients.map((line) => ({
        inventoryItemId: line.itemId,
        quantity: line.quantity,
        unit: line.unit,
      })),
    })
    return { id: saved.id }
  } catch (error) {
    if (error instanceof UnitConversionError) {
      throw new AppError(error.message, 400, 'PRODUCTION_UNIT_MISMATCH')
    }
    throw error
  }
}

/**
 * Mark a batch done, with what it actually produced.
 *
 * Runs the ordinary production transaction — the one `prepared-items-test`
 * pins — against the batch's own row, so the ingredients are deducted, the
 * prepared item is stocked at its real cost, and the reference number is the
 * one the batch has carried since it was started.
 *
 * ── The ingredients are what was planned, and that is not a shortcut ───────
 *
 * A yield variance is not an ingredient variance. Five eggs went into the
 * mayonnaise whether it made 1kg or 950g, and pretending less went in because
 * less came out would silently write the loss off the books — which is the
 * opposite of what measuring yield is for. The value of the missing 50g stays
 * in the prepared item's cost per gram, exactly where an owner can see it.
 *
 * A cook who genuinely used different amounts can say so: `overrides` replaces
 * the planned lines.
 */
export async function completeBatch(params: {
  restaurantId: string
  batchId: string
  userId: string | null
  clientRequestId: string
  actualQuantity: number
  /**
   * The unit the yield was measured in (aO.md §5): "2 KG" when the batch was
   * planned in grams. Converted by `produceItem` against the item's own
   * ledger unit, and refused there if it cannot be. Defaults to the plan's
   * unit, which is what every caller before this meant.
   */
  actualUnit?: StockUnit | null
  varianceReason?: ProductionVarianceReason | null
  varianceNote?: string | null
  overrides?: BatchPlan['ingredients']
  notes?: string | null
}): Promise<ProduceItemResult> {
  const batch = await prisma.productionOrder.findFirst({
    where: { id: params.batchId, restaurantId: params.restaurantId },
  })
  if (!batch) throw new NotFoundError('Batch')
  if (batch.status !== 'IN_PROGRESS') {
    throw new AppError('That batch is not in progress', 409, 'PRODUCTION_NOT_IN_PROGRESS')
  }

  const plan = batch.plan as unknown as BatchPlan | null
  if (!plan) throw new AppError('That batch has no plan to finish', 409, 'PRODUCTION_NO_PLAN')

  return produceItem({
    restaurantId: params.restaurantId,
    branchId: batch.branchId,
    userId: params.userId,
    clientRequestId: params.clientRequestId,
    batchId: batch.id,
    output: {
      itemId: plan.itemId ?? batch.outputItemId,
      name: plan.name,
      quantity: params.actualQuantity,
      unit: params.actualUnit ?? plan.unit,
    },
    ingredients: params.overrides ?? plan.ingredients,
    waste: plan.waste,
    varianceReason: params.varianceReason ?? null,
    varianceNote: params.varianceNote ?? null,
    notes: params.notes ?? batch.notes,
  })
}

/**
 * Make more of something already made (aO.md §5).
 *
 * The prepared item's page asks one question — how much are you making? —
 * and this answers it from the recipe the item already has: the ingredients
 * are scaled by the ratio of what is being made to what the recipe yields,
 * and the ordinary production transaction runs. One step, because there is
 * nothing left to decide: the item exists, the recipe says how it is made,
 * and the cook is standing in front of the finished pot.
 *
 * ── Scaling, and why the ratio is taken in base units ──────────────────────
 *
 * A recipe that yields 900 GRAM being asked for 2 KG is the same question as
 * 2000 g ÷ 900 g, and only the ledger's base unit makes those comparable.
 * Both sides go through `toBaseUnits` against the item itself, so a yield in
 * kilos and a request in grams scale correctly, and a unit the item cannot be
 * measured in is refused here rather than producing a nonsense multiplier.
 *
 * Each ingredient line keeps its OWN unit and is multiplied by that ratio:
 * `produceItem` converts and costs it exactly as it would a typed line, so
 * there is no second costing path and no new prepared item — this is the
 * same item, gaining stock.
 */
export async function makeMore(params: {
  restaurantId: string
  branchId: string
  userId: string | null
  clientRequestId: string
  itemId: string
  quantity: number
  unit: StockUnit
  notes?: string | null
}): Promise<ProduceItemResult> {
  if (!(params.quantity > 0)) {
    throw new AppError('How much are you making?', 400, 'PRODUCTION_NO_QUANTITY')
  }

  const item = await prisma.inventoryItem.findFirst({
    where: { id: params.itemId, restaurantId: params.restaurantId, isActive: true },
  })
  if (!item) throw new NotFoundError('Prepared item')
  refuseRawName(item)

  const recipe = await prisma.recipe.findFirst({
    where: {
      restaurantId: params.restaurantId,
      producesItemId: item.id,
      isActive: true,
      archivedAt: null,
    },
    orderBy: { version: 'desc' },
    include: { ingredients: { select: { inventoryItemId: true, quantity: true, unit: true } } },
  })
  const lines = (recipe?.ingredients ?? []).filter((line) => line.inventoryItemId)
  if (!recipe || lines.length === 0) {
    throw new AppError(
      `There is no recipe on file for ${item.name} yet — make it once on Make an Item, listing what goes in, and Make More can repeat it.`,
      409,
      'PRODUCTION_NO_RECIPE',
    )
  }

  const wanted = convertOrRefuse(params.quantity, params.unit, item, 'produced')
  const yieldBase = convertOrRefuse(recipe.yieldQty, recipe.yieldUnit ?? item.unit, item, 'produced')
  if (!(yieldBase > 0)) {
    throw new AppError(
      `${item.name}'s recipe does not say how much it makes — make it once on Make an Item to record the yield.`,
      409,
      'PRODUCTION_NO_YIELD',
    )
  }
  const ratio = wanted / yieldBase

  return produceItem({
    restaurantId: params.restaurantId,
    branchId: params.branchId,
    userId: params.userId,
    clientRequestId: params.clientRequestId,
    output: { itemId: item.id, name: item.name, quantity: params.quantity, unit: params.unit },
    ingredients: lines.map((line) => ({
      itemId: line.inventoryItemId!,
      quantity: roundQty(line.quantity * ratio),
      unit: line.unit,
    })),
    notes: params.notes?.trim() || null,
  })
}

/** Batches started and not yet finished, for the Prepared Items tab. */
export async function listOpenBatches(params: {
  restaurantId: string
  branchId?: string | null
}) {
  return prisma.productionOrder.findMany({
    where: {
      restaurantId: params.restaurantId,
      status: 'IN_PROGRESS',
      ...(params.branchId ? { branchId: params.branchId } : {}),
    },
    orderBy: { productionDate: 'desc' },
    take: 50,
    include: { branch: { select: { name: true } } },
  })
}

/** Abandon a batch that was never made. Nothing to reverse: nothing moved. */
export async function cancelBatch(params: {
  restaurantId: string
  batchId: string
}): Promise<void> {
  const cancelled = await prisma.productionOrder.updateMany({
    where: { id: params.batchId, restaurantId: params.restaurantId, status: 'IN_PROGRESS' },
    data: { status: 'CANCELLED' },
  })
  if (cancelled.count === 0) {
    throw new AppError('That batch is not in progress', 409, 'PRODUCTION_NOT_IN_PROGRESS')
  }
}
