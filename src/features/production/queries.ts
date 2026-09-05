import 'server-only'

import { prisma } from '@/server/db/prisma'
import { listLocationStock } from '@/features/inventory/location-stock'
import { resolveRecipe } from '@/features/inventory/recipe-resolver'
import { roundQty } from '@/lib/quantity'

/**
 * The production house dashboard.
 *
 * Answers the four questions a production manager has each morning: what did we
 * make, what did it cost, what is still to do, and what is about to go off.
 */
export interface ProductionDashboard {
  house: { id: string; name: string } | null
  today: { runs: number; produced: number; cost: number }
  week: { runs: number; produced: number; cost: number }
  pending: Array<{
    id: string
    number: string
    status: string
    recipeName: string | null
    plannedQty: number
    requestedByName: string | null
  }>
  recent: Array<{
    id: string
    number: string
    status: string
    recipeName: string | null
    plannedQty: number
    actualQty: number | null
    variance: number | null
    varianceReason: string | null
    unitCost: number
    totalCost: number
    batchNumber: string | null
    completedAt: string | null
  }>
  expiringBatches: Array<{
    batchNo: string
    itemName: string
    remainingQty: number
    unit: string
    expiryDate: string | null
    daysLeft: number | null
  }>
}

export async function getProductionDashboard(params: {
  restaurantId: string
  branchId?: string | null
}): Promise<ProductionDashboard> {
  const defaultHouse = () =>
    prisma.branch.findFirst({
      where: { restaurantId: params.restaurantId, type: 'PRODUCTION_HOUSE', deletedAt: null },
      select: { id: true, name: true },
      orderBy: { createdAt: 'asc' },
    })

  /*
   * A requested location that is not a production house falls back to the
   * default house rather than to nothing. The top-bar switcher can name any
   * location, and "you have selected Kandy, therefore production does not
   * exist" is not an answer anyone wants.
   */
  const house = params.branchId
    ? (await prisma.branch.findFirst({
        where: {
          id: params.branchId,
          restaurantId: params.restaurantId,
          type: 'PRODUCTION_HOUSE',
          deletedAt: null,
        },
        select: { id: true, name: true },
      })) ?? (await defaultHouse())
    : await defaultHouse()

  if (!house) {
    return {
      house: null,
      today: { runs: 0, produced: 0, cost: 0 },
      week: { runs: 0, produced: 0, cost: 0 },
      pending: [], recent: [], expiringBatches: [],
    }
  }

  const now = new Date()
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000)

  const [orders, batches] = await Promise.all([
    prisma.productionOrder.findMany({
      where: { restaurantId: params.restaurantId, branchId: house.id },
      orderBy: { createdAt: 'desc' },
      take: 60,
      include: {
        requestedBy: { select: { name: true } },
        outputs: { select: { quantity: true } },
      },
    }),
    prisma.stockBatch.findMany({
      where: {
        restaurantId: params.restaurantId,
        branchId: house.id,
        remainingQty: { gt: 0 },
        expiryDate: { not: null, lte: new Date(now.getTime() + 7 * 86_400_000) },
      },
      orderBy: { expiryDate: 'asc' },
      include: { item: { select: { name: true, unit: true } } },
      take: 20,
    }),
  ])

  const completed = orders.filter((o) => o.completedAt !== null)
  const sum = (from: Date) => {
    const inWindow = completed.filter((o) => o.completedAt! >= from)
    return {
      runs: inWindow.length,
      produced: inWindow.reduce((s, o) => s + o.outputs.reduce((x, out) => x + out.quantity, 0), 0),
      cost: inWindow.reduce((s, o) => s + o.totalCost, 0),
    }
  }

  return {
    house,
    today: sum(startOfDay),
    week: sum(weekAgo),
    pending: orders
      .filter((o) => ['DRAFT', 'PLANNED', 'APPROVED', 'IN_PROGRESS'].includes(o.status))
      .map((o) => ({
        id: o.id,
        number: o.number,
        status: o.status,
        recipeName: o.recipeName,
        plannedQty: o.plannedQty,
        requestedByName: o.requestedBy?.name ?? null,
      })),
    recent: completed.slice(0, 20).map((o) => ({
      id: o.id,
      number: o.number,
      status: o.status,
      recipeName: o.recipeName,
      plannedQty: o.plannedQty,
      actualQty: o.actualQty,
      variance: o.variance,
      varianceReason: (o.varianceReason as string | null) ?? null,
      unitCost: o.unitCost,
      totalCost: o.totalCost,
      batchNumber: o.batchNumber,
      completedAt: o.completedAt?.toISOString() ?? null,
    })),
    expiringBatches: batches.map((b) => ({
      batchNo: b.batchNo,
      itemName: b.item.name,
      remainingQty: b.remainingQty,
      unit: b.item.unit as string,
      expiryDate: b.expiryDate?.toISOString() ?? null,
      daysLeft: b.expiryDate
        ? Math.round((new Date(b.expiryDate.getFullYear(), b.expiryDate.getMonth(), b.expiryDate.getDate()).getTime()
            - startOfDay.getTime()) / 86_400_000)
        : null,
    })),
  }
}


/** Everything the production console needs to define recipes and start runs. */
export async function getProductionConsoleData(params: {
  restaurantId: string
  currency: string
  /** Restrict the houses offered to the one chosen in the top bar. */
  branchId?: string | null
}) {
  const [houses, items, recipes, pending] = await Promise.all([
    prisma.branch.findMany({
      where: { restaurantId: params.restaurantId, type: 'PRODUCTION_HOUSE', deletedAt: null, isActive: true },
      select: { id: true, name: true }, orderBy: { name: 'asc' },
    }),
    prisma.inventoryItem.findMany({
      where: { restaurantId: params.restaurantId, isActive: true },
      select: { id: true, name: true, unit: true, quantity: true }, orderBy: { name: 'asc' },
    }),
    /*
     * Retired recipes come back too, so they can be un-retired. They are told
     * apart by `isActive`, and only the active ones are offered for a new run —
     * a list that silently omits the thing you are looking for reads as a bug.
     */
    prisma.recipe.findMany({
      where: {
        restaurantId: params.restaurantId,
        producesItemId: { not: null },
        archivedAt: null,
      },
      include: {
        producesItem: { select: { id: true, name: true, unit: true } },
        ingredients: {
          orderBy: { sortOrder: 'asc' },
          include: { inventoryItem: { select: { id: true, name: true, unit: true } } },
        },
      },
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
    }),
    prisma.productionOrder.findMany({
      where: {
        restaurantId: params.restaurantId,
        status: { in: ['DRAFT', 'PLANNED', 'APPROVED', 'IN_PROGRESS'] },
        ...(params.branchId ? { branchId: params.branchId } : {}),
      },
      include: {
        recipe: { select: { producesItem: { select: { name: true, unit: true } } } },
      },
      orderBy: { createdAt: 'desc' },
    }),
  ])

  return {
    currency: params.currency,
    houses,
    items: items.map((i) => ({ ...i, unit: i.unit as string })),
    recipes: recipes
      .filter((r) => r.producesItem !== null)
      .map((r) => ({
        id: r.id,
        name: r.name ?? r.producesItem!.name,
        isActive: r.isActive,
        producesItemId: r.producesItemId!,
        outputName: r.producesItem!.name,
        outputUnit: r.producesItem!.unit as string,
        /** How much one run of the recipe makes. New recipes are created at 1. */
        yieldQty: r.yieldQty,
        shelfLifeDays: r.shelfLifeDays,
        notes: r.prepNotes,
        items: r.ingredients
          .filter((line) => line.inventoryItem !== null)
          .map((line) => ({
            itemId: line.inventoryItemId!,
            name: line.inventoryItem!.name,
            quantity: line.quantity,
            unit: line.unit as string,
          })),
      })),
    pending: pending.map((p) => ({
      id: p.id,
      number: p.number,
      status: p.status,
      // The board needs both so it can ask for a required-vs-available preview
      // of this exact job without a second round trip to work out which recipe
      // and which house it belongs to.
      recipeId: p.recipeId,
      branchId: p.branchId,
      startedAt: p.startedAt?.toISOString() ?? null,
      recipeName: p.recipeName,
      plannedQty: p.plannedQty,
      outputName: p.recipe?.producesItem?.name ?? null,
      outputUnit: (p.recipe?.producesItem?.unit ?? null) as string | null,
    })),
  }
}

/**
 * One run, in full.
 *
 * Written because `/dashboard/production/[orderId]` did not exist and the
 * traceability panel linked to it anyway: every "where did this stock come
 * from" trail that ended at a production run ended at a 404. The link was
 * right; the page was missing.
 *
 * Shows what a run actually is — what went in, what came out, what the gap
 * cost — rather than the summary line the dashboard already carries.
 */
export async function getProductionRun(params: { restaurantId: string; orderId: string }) {
  const order = await prisma.productionOrder.findFirst({
    where: { id: params.orderId, restaurantId: params.restaurantId },
    include: {
      branch: { select: { id: true, name: true } },
      recipe: {
        select: {
          id: true,
          name: true,
          yieldQty: true,
          shelfLifeDays: true,
          producesItem: { select: { id: true, name: true, unit: true } },
        },
      },
      requestedBy: { select: { name: true } },
      approvedBy: { select: { name: true } },
      consumption: {
        include: { item: { select: { id: true, name: true, unit: true } } },
        orderBy: { lineCost: 'desc' },
      },
      outputs: {
        include: { item: { select: { id: true, name: true, unit: true } } },
      },
    },
  })
  if (!order) return null

  const materialCost = order.consumption.reduce((sum, line) => sum + line.lineCost, 0)

  return {
    id: order.id,
    number: order.number,
    status: order.status as string,
    branchId: order.branchId,
    branchName: order.branch.name,
    recipeId: order.recipeId,
    /* The name as it was when the job ran, so a rename cannot rewrite history. */
    recipeName: order.recipeName ?? order.recipe?.name ?? null,
    outputName: order.recipe?.producesItem?.name ?? null,
    outputUnit: (order.recipe?.producesItem?.unit ?? null) as string | null,
    shelfLifeDays: order.recipe?.shelfLifeDays ?? null,
    plannedQty: order.plannedQty,
    actualQty: order.actualQty,
    variance: order.variance,
    varianceReason: order.varianceReason as string | null,
    varianceNote: order.varianceNote,
    batchNumber: order.batchNumber,
    notes: order.notes,
    /*
     * Three costs, kept apart on purpose. Materials is what the ledger posted;
     * overhead is what someone typed; unitCost is (materials + overhead) over
     * what actually came out. Showing only the last one is how a run that
     * burned a fifth of its flour reads as merely "a bit expensive".
     */
    materialCost,
    overheadCost: order.overheadCost,
    totalCost: order.totalCost,
    unitCost: order.unitCost,
    requestedByName: order.requestedBy?.name ?? null,
    approvedByName: order.approvedBy?.name ?? null,
    approvedAt: order.approvedAt?.toISOString() ?? null,
    startedAt: order.startedAt?.toISOString() ?? null,
    completedAt: order.completedAt?.toISOString() ?? null,
    productionDate: order.productionDate?.toISOString() ?? null,
    expiryDate: order.expiryDate?.toISOString() ?? null,
    createdAt: order.createdAt.toISOString(),
    consumption: order.consumption.map((line) => ({
      id: line.id,
      itemId: line.itemId,
      name: line.item.name,
      quantity: line.quantity,
      unit: line.unit as string,
      unitCost: line.unitCost,
      lineCost: line.lineCost,
    })),
    outputs: order.outputs.map((out) => ({
      id: out.id,
      itemId: out.itemId,
      name: out.item.name,
      quantity: out.quantity,
      unit: out.unit as string,
    })),
  }
}

export type ProductionRun = NonNullable<Awaited<ReturnType<typeof getProductionRun>>>

// ── Before the job exists: what it needs, and what is on the shelf ───────────

export interface ProductionPreviewLine {
  itemId: string
  name: string
  unit: string
  /** Base units the recipe needs for the planned quantity. */
  required: number
  /** Base units the production house is holding right now. */
  available: number
  /** How much is missing, or 0. */
  short: number
}

export interface ProductionPreview {
  recipeId: string
  recipeName: string
  producesName: string
  producesUnit: string
  plannedQty: number
  ingredients: ProductionPreviewLine[]
  /** What the ingredients are worth, minor units. */
  totalCost: number
  /** Anything the resolver could not work out — a missing item, a bad unit. */
  problems: string[]
  /** True when every ingredient is covered by stock at this house. */
  canMake: boolean
}

/**
 * "Show required ingredients + available stock", before anything is created.
 *
 * ── Read-only, and deliberately forgiving ───────────────────────────────────
 *
 * This never posts and never throws on a shortage. A missing ingredient is
 * something the screen shows in red so the kitchen can decide — order more,
 * make less, make it anyway — and turning that into an error would put the
 * refusal before the information. The hard refusal still exists where it
 * belongs: `assertSufficient` inside `completeProduction`, at the moment stock
 * would actually move.
 *
 * Availability is summed per item across the house's shelves from
 * `InventoryStock`, which is the same figure every other branch-scoped screen
 * reads — not `InventoryItem.quantity`, which is the restaurant-wide total and
 * would happily promise flour that is sitting at another site.
 */
export async function previewProduction(params: {
  restaurantId: string
  branchId: string
  recipeId: string
  plannedQty: number
}): Promise<ProductionPreview | null> {
  const recipe = await prisma.recipe.findFirst({
    where: { id: params.recipeId, restaurantId: params.restaurantId, archivedAt: null },
    include: { producesItem: { select: { id: true, name: true, unit: true } } },
  })
  if (!recipe?.producesItem) return null

  const planned = params.plannedQty > 0 ? params.plannedQty : 0

  const [resolved, onHand] = await Promise.all([
    planned > 0
      ? resolveRecipe(prisma, {
          restaurantId: params.restaurantId,
          recipeId: recipe.id,
          portions: planned,
        }).catch((error: unknown) => ({
          // A cycle or an impossible unit is a problem to report, not a crash:
          // the screen still has to render, with the reason on it.
          recipeId: recipe.id,
          ingredients: [],
          totalCost: 0,
          problems: [error instanceof Error ? error.message : 'This recipe could not be worked out'],
        }))
      : Promise.resolve({ recipeId: recipe.id, ingredients: [], totalCost: 0, problems: [] }),
    listLocationStock({ restaurantId: params.restaurantId, branchId: params.branchId }),
  ])

  // One item can sit on several shelves; the job draws from the house as a whole.
  const availableByItem = new Map<string, number>()
  for (const row of onHand) {
    availableByItem.set(row.itemId, (availableByItem.get(row.itemId) ?? 0) + row.available)
  }

  const ingredients: ProductionPreviewLine[] = resolved.ingredients.map((ingredient) => {
    const required = roundQty(ingredient.quantity)
    const available = roundQty(availableByItem.get(ingredient.itemId) ?? 0)
    return {
      itemId: ingredient.itemId,
      name: ingredient.name,
      unit: ingredient.unit,
      required,
      available,
      short: roundQty(Math.max(0, required - available)),
    }
  })

  return {
    recipeId: recipe.id,
    recipeName: recipe.name ?? recipe.producesItem.name,
    producesName: recipe.producesItem.name,
    producesUnit: recipe.producesItem.unit,
    plannedQty: planned,
    ingredients,
    totalCost: Math.round(resolved.totalCost),
    problems: resolved.problems,
    canMake: ingredients.length > 0 && ingredients.every((line) => line.short === 0),
  }
}
