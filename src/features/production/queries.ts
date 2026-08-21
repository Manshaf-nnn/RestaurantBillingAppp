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
    prisma.productionSpec.findMany({
      where: { restaurantId: params.restaurantId, isActive: true },
      include: { outputItem: { select: { name: true } } }, orderBy: { name: 'asc' },
    }),
    prisma.productionOrder.findMany({
      where: {
        restaurantId: params.restaurantId,
        status: { in: ['DRAFT', 'PLANNED', 'APPROVED', 'IN_PROGRESS'] },
      },
      include: { spec: { select: { name: true } } }, orderBy: { createdAt: 'desc' },
    }),
  ])

  return {
    currency: params.currency,
    houses,
    items: items.map((i) => ({ ...i, unit: i.unit as string })),
    specs: specs.map((s) => ({
      id: s.id, name: s.name, outputName: s.outputItem.name, outputQty: s.outputQty,
    })),
    pending: pending.map((p) => ({
      id: p.id, number: p.number, status: p.status,
      specName: p.spec?.name ?? null, plannedQty: p.plannedQty,
    })),
  }
}
