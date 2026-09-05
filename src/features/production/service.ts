import 'server-only'

import type { ProductionOrder, ProductionStatus, ProductionVarianceReason } from '@prisma/client'

import { AppError, NotFoundError } from '@/lib/errors'
import { guardLocks, prisma } from '@/server/db/prisma'
import { postMovement } from '@/features/inventory/ledger'
import { assertSufficient } from '@/features/inventory/location-stock'
import { upsertBatch } from '@/features/inventory/batches'
import { resolveRecipe } from '@/features/inventory/recipe-resolver'
import { setRecipeActive } from '@/features/recipes/service'
import { roundQty } from '@/lib/quantity'

/**
 * Kitchen jobs: making something ahead, so it is on the shelf when you need it.
 *
 * A production house consumes raw materials and produces a finished stock item,
 * both through the same ledger the rest of the system uses. That is what keeps
 * the chain honest end to end:
 *
 *   raw material → make-ahead recipe → finished item → dish recipe → sale
 *
 * ── One recipe, not two ─────────────────────────────────────────────────────
 *
 * A job points at a `Recipe` with `producesItemId` set — the same model a dish
 * recipe uses. There used to be a second table, `ProductionSpec`, holding the
 * same idea without versioning or nesting, which meant one product could be
 * described two ways and costed two ways.
 *
 * ── How many, not how many batches ──────────────────────────────────────────
 *
 * A job says how many of the finished item to make, in the item's own unit.
 * It used to count BATCHES against a recipe that made ten of something, so
 * "10" meant a hundred loaves and nothing on screen said so.
 *
 * ── Nothing moves until the job is finished ─────────────────────────────────
 *
 * Creating and starting a job change no stock. Ingredients leave and finished
 * goods appear at the moment the job is completed, in one transaction — a job
 * that consumed its chicken but failed before creating the patties would
 * destroy stock outright.
 *
 * ── Three states, and why approval left ─────────────────────────────────────
 *
 * The flow was create → approve → complete, and the approval step was the part
 * everyone found confusing. It was also protecting the wrong thing: approving
 * moved no stock and required `production.approve`, while completing moved all
 * of it and required only `production.manage`. The gate stood in front of the
 * one action that changed nothing.
 *
 * It was never the maker-checker mechanism either — `ApprovalKind` has no
 * production value, so there was no threshold, no second pair of eyes and no
 * self-approval refusal. It was a status field with a permission attached.
 *
 * So a job now reads: **ready to make → in progress → completed**, using
 * `IN_PROGRESS` and `startedAt`, both of which already existed in the schema
 * and were written by nothing.
 *
 * `APPROVED` is kept in both tables below and is deliberately still
 * completable. No new job enters it, but jobs approved before this change are
 * sitting in real databases and must still be finishable — dropping it would
 * strand them.
 */

const ALLOWED: Record<ProductionStatus, ProductionStatus[]> = {
  DRAFT: ['IN_PROGRESS', 'COMPLETED', 'PARTIALLY_COMPLETED', 'CANCELLED'],
  IN_PROGRESS: ['COMPLETED', 'PARTIALLY_COMPLETED', 'CANCELLED'],
  COMPLETED: [],
  PARTIALLY_COMPLETED: [],
  CANCELLED: [],
  // Legacy, both of them: reachable only on rows written before the flow was
  // shortened. Kept so jobs already in these states can still be finished.
  APPROVED: ['IN_PROGRESS', 'COMPLETED', 'PARTIALLY_COMPLETED', 'CANCELLED'],
  PLANNED: ['IN_PROGRESS', 'DRAFT', 'CANCELLED'],
}

/**
 * Statuses a job may still be completed from.
 *
 * `DRAFT` is here now, and that is the substance of dropping approval: a job
 * can be made without anyone first declaring that it may be. `APPROVED` stays
 * for the jobs that were approved under the old flow.
 */
const COMPLETABLE: ProductionStatus[] = ['DRAFT', 'APPROVED', 'IN_PROGRESS']

export function canTransitionProduction(from: ProductionStatus, to: ProductionStatus): boolean {
  return ALLOWED[from]?.includes(to) ?? false
}

/** Only a production house may run kitchen jobs. */
async function requireProductionHouse(restaurantId: string, branchId: string) {
  const branch = await prisma.branch.findFirst({
    where: { id: branchId, restaurantId, deletedAt: null },
    select: { id: true, name: true, type: true },
  })
  if (!branch) throw new NotFoundError('Location')
  if (branch.type !== 'PRODUCTION_HOUSE') {
    throw new AppError(`${branch.name} is not a production house`, 400, 'NOT_PRODUCTION_HOUSE')
  }
  return branch
}

/** A make-ahead recipe, with the item it produces. */
async function requireMakeAheadRecipe(restaurantId: string, recipeId: string) {
  const recipe = await prisma.recipe.findFirst({
    where: { id: recipeId, restaurantId, archivedAt: null },
    include: { producesItem: { select: { id: true, name: true, unit: true, trackBatches: true } } },
  })
  if (!recipe || !recipe.producesItem) throw new NotFoundError('Make-ahead recipe')
  return { ...recipe, producesItem: recipe.producesItem }
}

export async function createProductionOrder(params: {
  restaurantId: string
  branchId: string
  recipeId: string
  /** How many of the finished item to make, in its own unit. */
  plannedQty: number
  productionDate?: Date | null
  notes?: string | null
  userId?: string | null
}): Promise<ProductionOrder> {
  if (!(params.plannedQty > 0)) {
    throw new AppError('Say how many to make', 400, 'PRODUCTION_BAD_QTY')
  }
  await requireProductionHouse(params.restaurantId, params.branchId)

  const recipe = await requireMakeAheadRecipe(params.restaurantId, params.recipeId)
  if (!recipe.isActive) {
    throw new AppError('That recipe has been retired', 400, 'PRODUCTION_RECIPE_RETIRED')
  }

  return prisma.$transaction(async (tx) => {
    return tx.productionOrder.create({
      data: {
        restaurantId: params.restaurantId,
        branchId: params.branchId,
        recipeId: recipe.id,
        // Snapshotted so a finished job stays readable after a rename.
        recipeName: recipe.name ?? recipe.producesItem.name,
        number: await nextJobNumber(tx, params.restaurantId),
        status: 'DRAFT',
        plannedQty: params.plannedQty,
        unit: recipe.producesItem.unit,
        productionDate: params.productionDate ?? null,
        notes: params.notes?.trim() || null,
        requestedById: params.userId ?? null,
      },
    })
  })
}

/**
 * The next job number.
 *
 * Derived from the highest number already issued rather than from a row count,
 * which collided the moment anything was cancelled and deleted, and raced two
 * jobs created in the same second into the same number. `@@unique([restaurantId,
 * number])` turned that into a failed save rather than a duplicate, so this was
 * never a data bug — but it was a job somebody could not create.
 */
async function nextJobNumber(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  restaurantId: string,
): Promise<string> {
  const last = await tx.productionOrder.findFirst({
    where: { restaurantId },
    orderBy: { number: 'desc' },
    select: { number: true },
  })
  const previous = last ? Number.parseInt(last.number.replace(/\D/g, ''), 10) : 0
  return `PRD-${String((Number.isFinite(previous) ? previous : 0) + 1).padStart(6, '0')}`
}

/**
 * Move a job along: start it, or cancel it.
 *
 * Locked and claimed with a compare-and-swap, for the same reason
 * `completeProduction` is. This used to read the row outside any transaction
 * and update it unconditionally, so two taps on Cancel both passed the
 * transition check and both wrote — harmless for cancel, but the same shape
 * that let a job be completed twice before that was fixed, and there is no
 * reason to leave the pattern lying around for the next status to copy.
 */
export async function setProductionStatus(params: {
  restaurantId: string
  orderId: string
  status: ProductionStatus
  userId?: string | null
}): Promise<ProductionOrder> {
  return prisma.$transaction(async (tx) => {
    await guardLocks(tx)
    await tx.$queryRaw`SELECT id FROM production_orders WHERE id = ${params.orderId} FOR UPDATE`

    const order = await tx.productionOrder.findFirst({
      where: { id: params.orderId, restaurantId: params.restaurantId },
    })
    if (!order) throw new NotFoundError('Kitchen job')

    if (order.status === params.status) return order

    if (!canTransitionProduction(order.status, params.status)) {
      throw new AppError(
        `A ${label(order.status)} job cannot become ${label(params.status)}`,
        409,
        'PRODUCTION_BAD_TRANSITION',
      )
    }

    const claimed = await tx.productionOrder.updateMany({
      where: { id: order.id, status: order.status },
      data: {
        status: params.status,
        // `startedAt` has existed since the table was created and was written by
        // nothing. Starting a job is now a real step, so it records when.
        ...(params.status === 'IN_PROGRESS' ? { startedAt: new Date() } : {}),
      },
    })
    if (claimed.count === 0) {
      throw new AppError('That job just changed — reload and try again', 409, 'PRODUCTION_RACE')
    }

    return tx.productionOrder.findFirstOrThrow({ where: { id: order.id } })
  })
}

const label = (status: ProductionStatus) => status.replace(/_/g, ' ').toLowerCase()

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
 * Finish a job: consume the ingredients, put the finished item on the shelf.
 *
 * Everything happens in one transaction, and the job's status is read INSIDE it
 * under a row lock, then claimed with a compare-and-swap. It used to be read
 * before the transaction opened with no predicate on the final update, so one
 * impatient double-click ran the whole body twice: ingredients consumed twice,
 * finished goods created twice. Same shape as `approveStockCount`.
 *
 * ── Why a short job costs more per unit ─────────────────────────────────────
 *
 * Ingredients default to the number PLANNED, because that is what was issued to
 * the line — a batch of sauce that catches and yields 480 instead of 500 still
 * used all of its cream. Output is the actual figure. So unit cost is inputs
 * divided by real output, and a poor run raises it, which is the true picture
 * and the whole reason to record what went short.
 *
 * ── `consumed`: what the kitchen actually used ──────────────────────────────
 *
 * A caller may state, per ingredient, how much really left the store. Absent,
 * the recipe's requirement for the planned quantity is used and the behaviour
 * is exactly what it has always been — which is why the suites that pin
 * "planning 100 loaves consumes 100 kg of flour even when 80 come out" keep
 * passing untouched.
 *
 * What this is NOT is a licence to scale ingredients down to match the output.
 * Producing 80 of a planned 100 does not put a fifth of the flour back on the
 * shelf; the flour was poured. The shortfall is a yield loss, recorded as
 * `variance` + `varianceReason`, and it belongs in the unit cost rather than in
 * the stock balance. `consumed` exists for the other case: the kitchen used a
 * different amount than the recipe said, and somebody knows it.
 *
 * `overheadCost` — labour, power — is added on top before dividing, since
 * materials alone understate what a finished item costs to make. It is passed
 * in here rather than written beforehand: it used to be saved outside this
 * transaction, so a job that failed to complete kept the overhead anyway.
 */
export async function completeProduction(params: {
  restaurantId: string
  orderId: string
  /** How many actually came out. Defaults to what was planned. */
  actualQty?: number
  /**
   * What actually left the store, per ingredient, in the item's BASE unit.
   *
   * Omit it and every ingredient falls back to the recipe's requirement. Name
   * only some and the rest fall back individually. `0` is a real answer — it
   * means the ingredient was not used — and is not the same as omitting it.
   */
  consumed?: Array<{ itemId: string; quantity: number }>
  /** Labour, power and the rest, in minor units. */
  overheadCost?: number
  varianceReason?: ProductionVarianceReason | null
  varianceNote?: string | null
  batchNumber?: string | null
  userId?: string | null
}): Promise<CompleteProductionResult> {
  return prisma.$transaction(async (tx) => {
    /*
     * Lock the job, then read it. Everything below decides what to consume from
     * what this read returns, so reading it outside the lock is what allowed the
     * same job to be completed twice.
     */
    await guardLocks(tx)
    await tx.$queryRaw`SELECT id FROM production_orders WHERE id = ${params.orderId} FOR UPDATE`

    const order = await tx.productionOrder.findFirst({
      where: { id: params.orderId, restaurantId: params.restaurantId },
      include: {
        recipe: {
          include: { producesItem: true },
        },
      },
    })
    if (!order) throw new NotFoundError('Kitchen job')
    if (order.status === 'COMPLETED' || order.status === 'PARTIALLY_COMPLETED') {
      throw new AppError('That job is already finished', 409, 'PRODUCTION_DONE')
    }
    if (order.status === 'CANCELLED') {
      throw new AppError('That job was cancelled', 409, 'PRODUCTION_CANCELLED')
    }
    if (!COMPLETABLE.includes(order.status)) {
      throw new AppError(
        `A ${label(order.status)} job cannot be completed`,
        409,
        'PRODUCTION_NOT_COMPLETABLE',
      )
    }
    if (!order.recipe || !order.recipe.producesItem) {
      throw new AppError('This job has no recipe', 400, 'PRODUCTION_NO_SPEC')
    }

    const recipe = order.recipe
    const producesItem = recipe.producesItem!

    const producedQty = roundQty(params.actualQty ?? order.plannedQty)
    /*
     * Zero is refused, not treated as "all of it".
     *
     * A blank input arrives as `Number('')`, which is 0 and passes every
     * `Number.isFinite` / `< 0` check. That consumed every planned ingredient,
     * produced nothing, and wrote a unit cost of zero without a word. A job that
     * produced nothing is a cancellation, and `setProductionStatus` records it.
     */
    if (!(producedQty > 0)) {
      throw new AppError(
        'Say how many came out. If none did, cancel the job instead.',
        400,
        'PRODUCTION_NO_OUTPUT',
      )
    }

    const variance = roundQty(producedQty - order.plannedQty)
    if (variance < 0 && !params.varianceReason) {
      throw new AppError(
        `${Math.abs(variance)} short of plan — give a reason`,
        400,
        'PRODUCTION_VARIANCE_NO_REASON',
      )
    }

    /*
     * `portions` is how many of the finished item are wanted; `resolveRecipe`
     * divides by the recipe's own yield itself, so a recipe making 10 loaves
     * asked for 100 runs ten times over. New make-ahead recipes are created
     * with a yield of 1, so for everything made from now on this is just the
     * quantity and the division is a no-op.
     *
     * PLANNED, not actual — this is the yield-variance rule from the docstring.
     */
    const resolved = await resolveRecipe(tx, {
      restaurantId: params.restaurantId,
      recipeId: recipe.id,
      portions: order.plannedQty,
    })
    if (resolved.problems.length) {
      throw new AppError(resolved.problems[0], 400, 'PRODUCTION_RECIPE_PROBLEM')
    }

    /*
     * What the kitchen says it actually used, keyed by item.
     *
     * Only ingredients the recipe resolved to are accepted. An unknown item is
     * refused rather than posted: this is a completion screen, not a stock
     * adjustment screen, and quietly deducting something the recipe never
     * mentioned would be a way to move stock with no adjustment record and no
     * approval behind it. `recordWastage` and the adjustment path exist for
     * that, with their own guards.
     */
    const stated = new Map<string, number>()
    if (params.consumed?.length) {
      const known = new Set(resolved.ingredients.map((ingredient) => ingredient.itemId))
      for (const line of params.consumed) {
        if (!known.has(line.itemId)) {
          throw new AppError(
            'That ingredient is not in this recipe',
            400,
            'PRODUCTION_UNKNOWN_INGREDIENT',
          )
        }
        if (!Number.isFinite(line.quantity) || line.quantity < 0) {
          throw new AppError(
            'An ingredient amount cannot be negative',
            400,
            'PRODUCTION_BAD_CONSUMPTION',
          )
        }
        stated.set(line.itemId, roundQty(line.quantity))
      }
    }

    const consumed: CompleteProductionResult['consumed'] = []
    let totalCost = 0

    for (const ingredient of resolved.ingredients) {
      // Stated wins where given — including a stated zero, which is why this
      // reads the map rather than testing the value for truthiness.
      const needed = stated.has(ingredient.itemId)
        ? stated.get(ingredient.itemId)!
        : roundQty(ingredient.quantity)
      if (needed <= 0) continue

      await assertSufficient(tx, {
        restaurantId: params.restaurantId,
        itemId: ingredient.itemId,
        branchId: order.branchId,
        quantity: needed,
        itemName: ingredient.name,
      })

      const posted = await postMovement(tx, {
        restaurantId: params.restaurantId,
        itemId: ingredient.itemId,
        type: 'PRODUCTION_CONSUMPTION',
        quantity: needed,
        reason: `Kitchen job ${order.number}`,
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
          itemId: ingredient.itemId,
          quantity: needed,
          unit: ingredient.unit,
          unitCost: posted.item.costPerUnit,
          lineCost,
        },
      })

      consumed.push({
        itemId: ingredient.itemId,
        name: ingredient.name,
        quantity: needed,
        cost: lineCost,
      })
    }

    // Overhead is part of what the job cost, so it belongs in the numerator
    // rather than being reported separately and forgotten.
    const overheadCost = Math.max(0, Math.round(params.overheadCost ?? order.overheadCost ?? 0))
    const runCost = totalCost + overheadCost
    const unitCost = Math.round(runCost / producedQty)

    const batchNumber =
      params.batchNumber?.trim().toUpperCase() ||
      `${order.number}-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`

    const expiryDate = recipe.shelfLifeDays
      ? new Date(Date.now() + recipe.shelfLifeDays * 86_400_000)
      : null

    const posted = await postMovement(tx, {
      restaurantId: params.restaurantId,
      itemId: producesItem.id,
      type: 'PRODUCTION_OUTPUT',
      quantity: producedQty,
      // The finished item is costed from what it actually took to make.
      unitCost,
      reason: `Kitchen job ${order.number}`,
      referenceType: 'ProductionOrder',
      referenceId: order.id,
      branchId: order.branchId,
      batchNo: batchNumber,
      expiryDate,
      userId: params.userId,
    })

    let batchId: string | null = null
    if (producesItem.trackBatches) {
      const batch = await upsertBatch(tx, {
        restaurantId: params.restaurantId,
        itemId: producesItem.id,
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
        itemId: producesItem.id,
        quantity: producedQty,
        unit: producesItem.unit,
        unitCost,
        batchId,
      },
    })

    /*
     * Claim the job. The `status` predicate is what makes the second of two
     * concurrent completions lose instead of both committing.
     */
    const claimed = await tx.productionOrder.updateMany({
      where: { id: order.id, status: order.status },
      data: {
        status: variance < 0 ? 'PARTIALLY_COMPLETED' : 'COMPLETED',
        actualQty: producedQty,
        variance,
        varianceReason: params.varianceReason ?? null,
        varianceNote: params.varianceNote?.trim() || null,
        overheadCost,
        totalCost: runCost,
        unitCost,
        batchNumber,
        expiryDate,
        completedAt: new Date(),
        productionDate: order.productionDate ?? new Date(),
      },
    })
    if (claimed.count === 0) {
      throw new AppError('That job was finished while you were finishing it', 409, 'PRODUCTION_RACE')
    }

    const updated = await tx.productionOrder.findUniqueOrThrow({ where: { id: order.id } })

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

/**
 * Retire a make-ahead recipe, or bring it back.
 *
 * Retiring is refused while jobs still depend on it: a job whose recipe has been
 * retired cannot be finished, and the person retiring it has no way of knowing
 * they have done that. Nothing is ever deleted — finished jobs point at the exact
 * version they were made against.
 *
 * The guard lives here rather than in the action so it holds however this is
 * reached, and so it is covered by the service tests.
 */
export async function setMakeAheadRecipeActive(params: {
  restaurantId: string
  recipeId: string
  isActive: boolean
}) {
  const recipe = await prisma.recipe.findFirst({
    where: { id: params.recipeId, restaurantId: params.restaurantId },
    select: { id: true },
  })
  if (!recipe) throw new NotFoundError('Make-ahead recipe')

  if (!params.isActive) {
    const open = await prisma.productionOrder.count({
      where: {
        restaurantId: params.restaurantId,
        recipeId: params.recipeId,
        status: { in: ['DRAFT', 'PLANNED', 'APPROVED', 'IN_PROGRESS'] },
      },
    })
    if (open > 0) {
      throw new AppError(
        `${open} job${open === 1 ? ' is' : 's are'} still using this recipe — finish or cancel ${open === 1 ? 'it' : 'them'} first`,
        409,
        'RECIPE_IN_USE',
      )
    }
  }

  return setRecipeActive(params)
}

