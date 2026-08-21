import 'server-only'

import { prisma } from '@/server/db/prisma'

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
    specName: string | null
    plannedQty: number
    requestedByName: string | null
  }>
  recent: Array<{
    id: string
    number: string
    status: string
    specName: string | null
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
        spec: { select: { name: true, outputQty: true } },
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
        specName: o.spec?.name ?? null,
        plannedQty: o.plannedQty,
        requestedByName: o.requestedBy?.name ?? null,
      })),
    recent: completed.slice(0, 20).map((o) => ({
      id: o.id,
      number: o.number,
      status: o.status,
      specName: o.spec?.name ?? null,
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
  const [houses, items, specs, pending] = await Promise.all([
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
    prisma.productionSpec.findMany({
      where: { restaurantId: params.restaurantId },
      include: {
        outputItem: { select: { id: true, name: true, unit: true } },
        items: { include: { item: { select: { id: true, name: true, unit: true } } } },
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
        spec: {
          select: { name: true, outputQty: true, outputItem: { select: { name: true, unit: true } } },
        },
      },
      orderBy: { createdAt: 'desc' },
    }),
  ])

  return {
    currency: params.currency,
    houses,
    items: items.map((i) => ({ ...i, unit: i.unit as string })),
    specs: specs.map((s) => ({
      id: s.id,
      name: s.name,
      isActive: s.isActive,
      outputItemId: s.outputItemId,
      outputName: s.outputItem.name,
      outputUnit: s.outputItem.unit as string,
      outputQty: s.outputQty,
      shelfLifeDays: s.shelfLifeDays,
      notes: s.notes,
      items: s.items.map((line) => ({
        itemId: line.itemId,
        name: line.item.name,
        quantity: line.quantity,
        unit: (line.unit ?? line.item.unit) as string,
      })),
    })),
    pending: pending.map((p) => ({
      id: p.id,
      number: p.number,
      status: p.status,
      specName: p.spec?.name ?? null,
      plannedQty: p.plannedQty,
      // So the screen can say "10 batches = 100 loaves" rather than making
      // someone do the multiplication in their head at the mixer.
      outputQtyPerBatch: p.spec?.outputQty ?? null,
      outputName: p.spec?.outputItem.name ?? null,
      outputUnit: (p.spec?.outputItem.unit ?? null) as string | null,
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
      spec: {
        select: {
          id: true,
          name: true,
          outputQty: true,
          shelfLifeDays: true,
          outputItem: { select: { id: true, name: true, unit: true } },
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
    specId: order.specId,
    specName: order.spec?.name ?? null,
    outputName: order.spec?.outputItem.name ?? null,
    outputUnit: (order.spec?.outputItem.unit ?? null) as string | null,
    /** One batch's yield — what turns "10 batches" into "100 loaves". */
    outputQtyPerBatch: order.spec?.outputQty ?? null,
    shelfLifeDays: order.spec?.shelfLifeDays ?? null,
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
