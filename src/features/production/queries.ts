import 'server-only'

import type { Prisma, StockUnit } from '@prisma/client'

import { prisma } from '@/server/db/prisma'
import { acceptableUnits, toBaseUnits } from '@/features/inventory/units'
import { nextUnitCost } from '@/features/inventory/fifo-walk'
import { roundQty } from '@/lib/quantity'
import { visibleBranchIds } from '@/lib/rbac'
import { fifoCostFor } from './costing'
import type {
  OpenBatch, PrepRecipe, PrepRecipeLine, PreparedItemPageData, PreparedItemRow, ProductionHistoryRow,
  ProductionWorkspaceData, WorkspaceItem,
} from './types'

const FINISHED = ['COMPLETED', 'PARTIALLY_COMPLETED'] as const
/**
 * Every state a run can be in and still belong in Production History
 * (aO.md §5). A batch in progress and a cancelled batch are part of the
 * story — history that showed only what finished would hide the pot that
 * was started and never made.
 */
const HISTORY = ['IN_PROGRESS', 'COMPLETED', 'PARTIALLY_COMPLETED', 'CANCELLED'] as const

const historyInclude = {
  outputItem: { select: { name: true, unit: true } },
  outputs: { select: { quantity: true, unit: true }, take: 1 },
  requestedBy: { select: { name: true } },
  branch: { select: { name: true } },
  consumption: {
    select: { itemId: true, quantity: true, unit: true, item: { select: { name: true } } },
    orderBy: { lineCost: 'desc' },
  },
  _count: { select: { wastage: true } },
} satisfies Prisma.ProductionOrderInclude

type HistoryRun = Prisma.ProductionOrderGetPayload<{ include: typeof historyInclude }>

/**
 * One run as a history row. Consumption rows are what actually left stock;
 * a batch still in progress has none, so its plan says what it will take,
 * named from `names` (an item retired since is named as such).
 */
function toHistoryRow(run: HistoryRun, names: Map<string, string>): ProductionHistoryRow {
  const plan = run.plan as { ingredients?: PrepRecipeLine[] } | null
  const consumed =
    run.status === 'CANCELLED'
      ? []
      : run.consumption.length > 0
        ? run.consumption.map((line) => ({
            itemId: line.itemId, name: line.item.name, quantity: line.quantity, unit: line.unit as string,
          }))
        : (plan?.ingredients ?? []).map((line) => ({
            itemId: line.itemId, name: names.get(line.itemId) ?? 'Retired item', quantity: line.quantity, unit: line.unit as string,
          }))
  return {
    id: run.id,
    number: run.number,
    itemId: run.outputItemId,
    // A run from the recipe era has no output item on the row; it kept the name.
    itemName: run.outputItem?.name ?? run.recipeName ?? 'Production run',
    quantity: run.outputs[0]?.quantity ?? run.actualQty ?? run.plannedQty,
    unit: (run.outputs[0]?.unit ?? run.unit ?? run.outputItem?.unit) as string | null,
    totalCost: run.totalCost,
    unitCost: run.unitCost,
    status: run.status,
    createdAt: (run.productionDate ?? run.createdAt).toISOString(),
    completedAt: run.completedAt?.toISOString() ?? null,
    madeBy: run.requestedBy?.name ?? null,
    branchName: run.branch.name,
    wasteCount: run._count.wastage,
    plannedQty: run.plannedQty,
    actualQty: run.outputs[0]?.quantity ?? run.actualQty ?? null,
    wastageQty: run.wastageQty,
    batchNumber: run.batchNumber,
    consumed,
  }
}

type BatchRun = Prisma.ProductionOrderGetPayload<{ include: { branch: { select: { name: true } } } }>

function toOpenBatch(b: BatchRun, names: Map<string, string>): OpenBatch {
  return {
    id: b.id,
    number: b.number,
    itemId: b.outputItemId,
    name: b.recipeName ?? 'Unnamed batch',
    plannedQty: b.plannedQty,
    unit: b.unit,
    branchName: b.branch?.name ?? null,
    startedAt: (b.productionDate ?? b.createdAt).toISOString(),
    notes: b.notes,
    ingredients: ((b.plan as { ingredients?: PrepRecipeLine[] } | null)?.ingredients ?? []).map((line) => ({
      itemId: line.itemId, quantity: line.quantity, unit: line.unit, name: names.get(line.itemId),
    })),
    issued: b.startedAt !== null,
  }
}

/**
 * Everything the Kitchen Production screen shows, for one branch.
 *
 * Three tabs, one read: the stock items the Make Item form can draw on (with
 * what each costs and what this branch holds), the prepared items and their
 * value, and the runs that made them. Dates go out as ISO strings so the page
 * can hand the whole thing to a client component.
 *
 * `branchId` scopes the QUANTITIES, never the item list — `InventoryStock`
 * says where stock sits; an item belongs to the restaurant.
 */
export async function getProductionWorkspace(params: {
  restaurantId: string
  branchId: string | null
  timeZone?: string
}): Promise<ProductionWorkspaceData> {
  const { restaurantId, branchId } = params
  const dayStart = startOfToday(params.timeZone ?? 'UTC')
  const branchWhere = branchId ? { branchId } : {}

  const [items, onHand, runsByItem, recent, today, openBatches, prepRecipes, lots] = await Promise.all([
    prisma.inventoryItem.findMany({
      where: { restaurantId, isActive: true },
      orderBy: { name: 'asc' },
    }),
    prisma.inventoryStock.groupBy({
      by: ['itemId'],
      where: { restaurantId, ...branchWhere },
      _sum: { available: true },
    }),
    prisma.productionOrder.groupBy({
      by: ['outputItemId'],
      where: { restaurantId, status: { in: [...FINISHED] }, outputItemId: { not: null } },
      _max: { completedAt: true },
      _count: { _all: true },
    }),
    // Every run, whatever state it is in (aO.md §5), newest first.
    prisma.productionOrder.findMany({
      where: { restaurantId, status: { in: [...HISTORY] }, ...branchWhere },
      orderBy: [{ createdAt: 'desc' }],
      take: 100,
      include: historyInclude,
    }),
    prisma.productionOrder.aggregate({
      where: {
        restaurantId, status: { in: [...FINISHED] }, ...branchWhere,
        completedAt: { gte: dayStart },
      },
      _count: { _all: true },
      _sum: { totalCost: true },
    }),
    // correctionA.md §10 — batches started and not finished. Nothing in them
    // has moved yet, so they are deliberately NOT part of `history`.
    prisma.productionOrder.findMany({
      where: { restaurantId, status: 'IN_PROGRESS', ...branchWhere },
      orderBy: { productionDate: 'desc' },
      take: 50,
      include: { branch: { select: { name: true } } },
    }),
    // recorrection.md §3 — how each prepared item was last made. The active
    // prep recipe per item; "Make more" pre-fills from it.
    prisma.recipe.findMany({
      where: { restaurantId, producesItemId: { not: null }, isActive: true, archivedAt: null },
      select: {
        id: true, version: true, producesItemId: true, yieldQty: true, yieldUnit: true, prepNotes: true,
        ingredients: {
          select: { inventoryItemId: true, quantity: true, unit: true },
          orderBy: { sortOrder: 'asc' },
        },
      },
    }),
    /*
     * Every lot on this branch's shelf, oldest receipt first (pro.b.md §5).
     * One read for the whole screen; the form walks them per ingredient. No
     * branch chosen means no lots — a preview cannot be honest about a shelf
     * it has not been told about.
     */
    branchId
      ? prisma.stockBatch.findMany({
          where: { restaurantId, branchId, remainingQty: { gt: 0 } },
          select: {
            id: true, itemId: true, batchNo: true,
            remainingQty: true, remainingValue: true, unitCost: true,
          },
          orderBy: [{ receivedAt: 'asc' }, { createdAt: 'asc' }],
        })
      : Promise.resolve([]),
  ])

  const lotsByItem = new Map<string, WorkspaceItem['lots']>()
  for (const lot of lots) {
    const list = lotsByItem.get(lot.itemId) ?? []
    list.push({
      batchId: lot.id,
      batchNo: lot.batchNo,
      remaining: lot.remainingQty,
      remainingValue: lot.remainingValue,
      unitCost: lot.unitCost,
    })
    lotsByItem.set(lot.itemId, list)
  }

  const available = new Map<string, number>()
  for (const row of onHand) available.set(row.itemId, roundQty(row._sum.available ?? 0))
  const produced = new Map<string, { last: Date | null; runs: number }>()
  for (const row of runsByItem) {
    if (row.outputItemId) produced.set(row.outputItemId, { last: row._max.completedAt, runs: row._count._all })
  }

  const workspaceItems: WorkspaceItem[] = items.map((item) => ({
    id: item.id,
    name: item.name,
    unit: item.unit,
    purchaseUnit: item.purchaseUnit,
    consumptionUnit: item.consumptionUnit,
    unitsPerPurchaseUnit: item.unitsPerPurchaseUnit,
    units: acceptableUnits(item),
    // The exact average while there is stock to average over; the cache otherwise.
    unitCost: item.quantity > 0 ? Number(item.stockValue) / item.quantity : item.costPerUnit,
    available: available.get(item.id) ?? 0,
    isPrepared: item.isPrepared,
    category: item.category,
    lots: lotsByItem.get(item.id) ?? [],
    // The next layer's own rate. No average fallback: after the opening-layer
    // migration an item with stock has a layer, and an item without has no
    // cost to report rather than an invented one (FIFO.md).
    nextUnitCost: nextUnitCost(lotsByItem.get(item.id) ?? []),
  }))

  const prepared: PreparedItemRow[] = items
    .filter((item) => item.isPrepared)
    .map((item) => {
      const here = available.get(item.id) ?? 0
      const runs = produced.get(item.id)
      const mine = lotsByItem.get(item.id) ?? []
      return {
        id: item.id,
        name: item.name,
        unit: item.unit,
        available: here,
        costPerUnit: item.costPerUnit,
        // The layers' own sum (FIFO.md), not quantity × a blended rate.
        stockValue: mine.reduce((sum, lot) => sum + lot.remainingValue, 0),
        lastProducedAt: runs?.last?.toISOString() ?? null,
        runs: runs?.runs ?? 0,
      }
    })
    .sort((a, b) => (b.lastProducedAt ?? '').localeCompare(a.lastProducedAt ?? '') || a.name.localeCompare(b.name))

  const names = new Map(items.map((item) => [item.id, item.name]))
  const history: ProductionHistoryRow[] = recent.map((run) => toHistoryRow(run, names))

  return {
    items: workspaceItems,
    prepared,
    history,
    openBatches: openBatches.map((b) => toOpenBatch(b, names)),
    recipes: Object.fromEntries(
      prepRecipes
        .filter((r) => r.producesItemId)
        .map((r): [string, PrepRecipe] => [
          r.producesItemId!,
          {
            recipeId: r.id,
            version: r.version,
            yieldQty: r.yieldQty,
            yieldUnit: r.yieldUnit,
            ingredients: r.ingredients
              .filter((line) => line.inventoryItemId)
              .map((line) => ({ itemId: line.inventoryItemId!, quantity: line.quantity, unit: line.unit })),
            instructions: r.prepNotes,
          },
        ]),
    ),
    stats: {
      runsToday: today._count._all,
      valueToday: today._sum.totalCost ?? 0,
      preparedCount: prepared.length,
    },
  }
}

/**
 * One prepared item's page (aO.md §5), at one location.
 *
 * The same reads the workspace does, scoped to one item: what is on the
 * shelf here, the active recipe costed at today's averages, the batches
 * waiting to be marked done, and every run of this item here — in progress,
 * done or cancelled. Null when the id is not this restaurant's prepared item.
 *
 * `branchId` scopes the quantities, the open batches and the history; the
 * recipe and the item belong to the restaurant.
 */
export async function getPreparedItemPage(params: {
  restaurantId: string
  branchId: string | null
  itemId: string
}): Promise<PreparedItemPageData | null> {
  const { restaurantId, branchId } = params
  const item = await prisma.inventoryItem.findFirst({
    where: { id: params.itemId, restaurantId, isPrepared: true },
  })
  if (!item) return null
  const branchWhere = branchId ? { branchId } : {}

  const [branch, onHand, runs, recipe, openBatches, recent, allItems] = await Promise.all([
    branchId
      ? prisma.branch.findFirst({ where: { id: branchId, restaurantId }, select: { id: true, name: true } })
      : Promise.resolve(null),
    prisma.inventoryStock.aggregate({
      where: { restaurantId, itemId: item.id, ...branchWhere },
      _sum: { available: true },
    }),
    prisma.productionOrder.aggregate({
      where: { restaurantId, outputItemId: item.id, status: { in: [...FINISHED] }, ...branchWhere },
      _count: { _all: true },
      _max: { completedAt: true },
    }),
    prisma.recipe.findFirst({
      where: { restaurantId, producesItemId: item.id, isActive: true, archivedAt: null },
      orderBy: { version: 'desc' },
      select: {
        id: true, version: true, yieldQty: true, yieldUnit: true,
        ingredients: {
          select: { inventoryItemId: true, quantity: true, unit: true },
          orderBy: { sortOrder: 'asc' },
        },
      },
    }),
    prisma.productionOrder.findMany({
      where: { restaurantId, outputItemId: item.id, status: 'IN_PROGRESS', ...branchWhere },
      orderBy: { productionDate: 'desc' },
      take: 50,
      include: { branch: { select: { name: true } } },
    }),
    prisma.productionOrder.findMany({
      where: { restaurantId, outputItemId: item.id, status: { in: [...HISTORY] }, ...branchWhere },
      orderBy: [{ createdAt: 'desc' }],
      take: 200,
      include: historyInclude,
    }),
    // Names for plan lines (open batches, batches in history) and the recipe.
    prisma.inventoryItem.findMany({ where: { restaurantId }, select: { id: true, name: true } }),
  ])
  const names = new Map(allItems.map((row) => [row.id, row.name]))

  /*
   * The recipe costed at today's averages — the same arithmetic the Make
   * Item preview uses, so the page and the form never disagree about what a
   * batch should cost. The run itself re-reads the ledger and is the figure
   * of record.
   */
  const lineIds = (recipe?.ingredients ?? []).map((l) => l.inventoryItemId).filter((id): id is string => Boolean(id))
  const [ingredients, ingredientStock] = lineIds.length
    ? await Promise.all([
        prisma.inventoryItem.findMany({ where: { id: { in: lineIds }, restaurantId } }),
        prisma.inventoryStock.groupBy({
          by: ['itemId'],
          where: { restaurantId, itemId: { in: lineIds }, ...branchWhere },
          _sum: { available: true },
        }),
      ])
    : [[], []]
  const ingredientById = new Map(ingredients.map((row) => [row.id, row]))
  const availableById = new Map(ingredientStock.map((row) => [row.itemId, roundQty(row._sum.available ?? 0)]))

  let costed: PreparedItemPageData['recipe'] = null
  if (recipe) {
    /*
     * Costed FIFO, per line, for the quantity the recipe needs (pro.b.md §1):
     * the same reader the issue draws through, so this is what a batch would
     * cost right now, delivery by delivery. Without a branch there is no
     * shelf to walk, and the running average stands in.
     */
    const lines = await Promise.all(
      recipe.ingredients
        .filter((line) => line.inventoryItemId)
        .map(async (line) => {
          const ingredient = ingredientById.get(line.inventoryItemId!) ?? null
          const average = ingredient
            ? ingredient.quantity > 0 ? Number(ingredient.stockValue) / ingredient.quantity : ingredient.costPerUnit
            : 0
          let base = 0
          if (ingredient) {
            try { base = roundQty(toBaseUnits(line.quantity, line.unit, ingredient)) } catch { base = 0 }
          }
          const fifo =
            ingredient && branchId && base > 0
              ? await fifoCostFor(prisma, {
                  restaurantId, itemId: ingredient.id, branchId, quantity: line.quantity, unit: line.unit,
                }).catch(() => null)
              : null
          return {
            itemId: line.inventoryItemId!,
            name: ingredient?.name ?? names.get(line.inventoryItemId!) ?? 'Retired item',
            quantity: line.quantity,
            unit: line.unit,
            itemUnit: ingredient?.unit ?? null,
            unitCost: fifo ? fifo.unitCost : average,
            lineCost: fifo ? Math.round(fifo.totalCost) : Math.round(base * average),
            available: availableById.get(line.inventoryItemId!) ?? 0,
          }
        }),
    )
    const productionCost = lines.reduce((sum, l) => sum + l.lineCost, 0)
    let yieldBase = recipe.yieldQty
    try { yieldBase = roundQty(toBaseUnits(recipe.yieldQty, recipe.yieldUnit ?? item.unit, item)) } catch { /* per recipe unit */ }
    costed = {
      recipeId: recipe.id,
      version: recipe.version,
      yieldQty: recipe.yieldQty,
      yieldUnit: recipe.yieldUnit,
      lines,
      productionCost,
      costPerUnit: yieldBase > 0 ? productionCost / yieldBase : 0,
    }
  }

  const here = roundQty(onHand._sum.available ?? 0)
  /* What this branch's layers of it are worth (FIFO.md). */
  const layerValue = await prisma.stockBatch.aggregate({
    where: {
      restaurantId: params.restaurantId,
      itemId: item.id,
      ...(params.branchId ? { branchId: params.branchId } : {}),
      remainingQty: { gt: 0 },
    },
    _sum: { remainingValue: true },
  })
  return {
    item: { id: item.id, name: item.name, unit: item.unit, units: acceptableUnits(item) },
    branch,
    stock: {
      here,
      total: roundQty(item.quantity),
      costPerUnit: item.costPerUnit,
      value: layerValue._sum?.remainingValue ?? 0,
      lastProducedAt: runs._max.completedAt?.toISOString() ?? null,
      runs: runs._count._all,
    },
    recipe: costed,
    openBatches: openBatches.map((b) => toOpenBatch(b, names)),
    history: recent.map((run) => toHistoryRow(run, names)),
  }
}

/**
 * Where production can happen: every active location this person can see.
 *
 * Not `listStationBranches` — that one is for tills and keeps to `BRANCH`
 * locations, which would hide a production house from the one screen that
 * exists to use it. Any branch may make prepared items (settled 2026-09-05).
 */
export async function listProductionBranches(user: {
  role: Parameters<typeof visibleBranchIds>[0]['role']
  branchId: string | null
  restaurantId: string
}): Promise<Array<{ id: string; name: string }>> {
  const reach = visibleBranchIds(user)
  return prisma.branch.findMany({
    where: {
      restaurantId: user.restaurantId,
      deletedAt: null,
      isActive: true,
      ...(reach ? { id: { in: reach } } : {}),
    },
    select: { id: true, name: true },
    orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
  })
}

/**
 * One run, in full.
 *
 * `/dashboard/production/[orderId]` is where the traceability panel sends a
 * "where did this stock come from" trail that ends at a production run, so the
 * route stays whatever the flow above it looks like. Shows what went in, what
 * was thrown away, and what came out — and reads legacy recipe-era runs too.
 */
export async function getProductionRun(params: { restaurantId: string; orderId: string }) {
  const order = await prisma.productionOrder.findFirst({
    where: { id: params.orderId, restaurantId: params.restaurantId },
    include: {
      branch: { select: { id: true, name: true } },
      outputItem: { select: { id: true, name: true, unit: true } },
      recipe: { select: { producesItem: { select: { id: true, name: true, unit: true } } } },
      requestedBy: { select: { name: true } },
      consumption: {
        include: {
          item: { select: { id: true, name: true, unit: true } },
          lots: { orderBy: { createdAt: 'asc' } },
        },
        orderBy: { lineCost: 'desc' },
      },
      outputs: {
        include: { item: { select: { id: true, name: true, unit: true } } },
      },
      wastage: {
        include: { item: { select: { id: true, name: true, unit: true } } },
        orderBy: { createdAt: 'asc' },
      },
    },
  })
  if (!order) return null

  const output = order.outputItem ?? order.outputs[0]?.item ?? order.recipe?.producesItem ?? null
  const materialCost = order.consumption.reduce((sum, line) => sum + line.lineCost, 0)
  const wasteCost = order.wastage.reduce((sum, record) => sum + record.costValue, 0)

  /*
   * The plan, costed FIFO for what it will take (pro.b.md §4) — the Ingredients
   * table before anything is issued: Required, Issue qty, FIFO cost, Total.
   * Once issued, the consumption rows are the record and this is empty.
   */
  const planLines = (order.plan as { ingredients?: Array<{ itemId: string; quantity: number; unit: string }> } | null)
    ?.ingredients ?? []
  const planIds = planLines.map((line) => line.itemId)
  const [planItems, planStock] = planIds.length
    ? await Promise.all([
        prisma.inventoryItem.findMany({
          where: { id: { in: planIds }, restaurantId: params.restaurantId },
          select: { id: true, name: true, unit: true, purchaseUnit: true, unitsPerPurchaseUnit: true, costPerUnit: true },
        }),
        prisma.inventoryStock.groupBy({
          by: ['itemId'],
          where: { restaurantId: params.restaurantId, itemId: { in: planIds }, branchId: order.branchId },
          _sum: { available: true },
        }),
      ])
    : [[], []]
  const planItemById = new Map(planItems.map((row) => [row.id, row]))
  const planAvailable = new Map(planStock.map((row) => [row.itemId, roundQty(row._sum.available ?? 0)]))
  const plan =
    order.status === 'IN_PROGRESS' && order.consumption.length === 0
      ? await Promise.all(
          planLines.map(async (line) => {
            const item = planItemById.get(line.itemId) ?? null
            const fifo = item
              ? await fifoCostFor(prisma, {
                  restaurantId: params.restaurantId,
                  itemId: item.id,
                  branchId: order.branchId,
                  quantity: line.quantity,
                  unit: line.unit as StockUnit,
                }).catch(() => null)
              : null
            return {
              itemId: line.itemId,
              name: item?.name ?? 'Retired item',
              quantity: line.quantity,
              unit: line.unit,
              itemUnit: (item?.unit ?? null) as string | null,
              base: fifo?.quantity ?? 0,
              available: planAvailable.get(line.itemId) ?? 0,
              unitCost: fifo?.unitCost ?? item?.costPerUnit ?? 0,
              lineCost: fifo ? Math.round(fifo.totalCost) : 0,
              shortfall: fifo?.allocation.shortfall ?? 0,
            }
          }),
        )
      : []

  /*
   * Where things stand now (pro.b.md §8, the sixth screen): what this branch
   * holds of the finished item, and of each ingredient the run drew on.
   */
  const afterIds = [...new Set([...(output ? [output.id] : []), ...order.consumption.map((line) => line.itemId)])]
  const afterStock = afterIds.length
    ? await prisma.inventoryStock.groupBy({
        by: ['itemId'],
        where: { restaurantId: params.restaurantId, itemId: { in: afterIds }, branchId: order.branchId },
        _sum: { available: true },
      })
    : []
  const afterById = new Map(afterStock.map((row) => [row.itemId, roundQty(row._sum.available ?? 0)]))

  return {
    id: order.id,
    number: order.number,
    status: order.status as string,
    branchId: order.branchId,
    branchName: order.branch.name,
    itemId: output?.id ?? null,
    /* The name as it was when the run happened, so a rename cannot rewrite history. */
    itemName: order.recipeName ?? output?.name ?? 'Production run',
    unit: (output?.unit ?? order.unit ?? null) as string | null,
    producedQty: order.outputs[0]?.quantity ?? order.actualQty ?? null,
    plannedQty: order.plannedQty,
    variance: order.variance,
    varianceReason: order.varianceReason as string | null,
    varianceNote: order.varianceNote,
    batchNumber: order.batchNumber,
    notes: order.notes,
    materialCost,
    /* Legacy runs could carry overhead; new ones never do, and it shows only when non-zero. */
    overheadCost: order.overheadCost,
    totalCost: order.totalCost,
    unitCost: order.unitCost,
    wasteCost,
    madeBy: order.requestedBy?.name ?? null,
    completedAt: order.completedAt?.toISOString() ?? null,
    createdAt: order.createdAt.toISOString(),
    /* pro.b.md §3–§6: the order's own fields, and where it is in the flow. */
    productionType: order.productionType as string,
    requiredDate: order.requiredDate?.toISOString() ?? null,
    startedAt: order.startedAt?.toISOString() ?? null,
    wastageQty: order.wastageQty,
    issued: order.consumption.length > 0,
    plan,
    /** Balances at this branch now — the finished item and each ingredient. */
    stockNow: Object.fromEntries(afterById),
    consumption: order.consumption.map((line) => ({
      id: line.id,
      itemId: line.itemId,
      name: line.item.name,
      quantity: line.quantity,
      unit: line.unit as string,
      unitCost: line.unitCost,
      lineCost: line.lineCost,
      lots: line.lots.map((lot) => ({
        id: lot.id,
        batchNo: lot.batchNo,
        quantity: lot.quantity,
        unitCost: lot.unitCost,
        lineCost: lot.lineCost,
      })),
    })),
    outputs: order.outputs.map((out) => ({
      id: out.id,
      itemId: out.itemId,
      name: out.item.name,
      quantity: out.quantity,
      unit: out.unit as string,
      unitCost: out.unitCost,
    })),
    wastage: order.wastage.map((record) => ({
      id: record.id,
      itemId: record.itemId,
      name: record.item.name,
      quantity: record.quantity,
      unit: record.item.unit as string,
      costValue: record.costValue,
      note: record.reasonNote,
    })),
  }
}

export type ProductionRun = NonNullable<Awaited<ReturnType<typeof getProductionRun>>>

/**
 * Midnight today in the restaurant's own time zone.
 *
 * Server time is UTC (see timestamps-are-naive-utc); a Colombo kitchen's "today"
 * starts five and a half hours before the server's. Computed from the wall
 * clock in the zone rather than a fixed offset, so daylight-saving zones stay
 * right too.
 */
function startOfToday(timeZone: string): Date {
  const now = new Date()
  let parts: Intl.DateTimeFormatPart[]
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone, hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(now)
  } catch {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(now)
  }
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0)
  const sinceMidnight = ((get('hour') % 24) * 3600 + get('minute') * 60 + get('second')) * 1000
  return new Date(now.getTime() - sinceMidnight - now.getMilliseconds())
}
