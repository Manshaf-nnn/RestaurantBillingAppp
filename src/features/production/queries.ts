import 'server-only'

import { prisma } from '@/server/db/prisma'
import { acceptableUnits } from '@/features/inventory/units'
import { roundQty } from '@/lib/quantity'
import { visibleBranchIds } from '@/lib/rbac'
import type {
  PreparedItemRow, ProductionHistoryRow, ProductionWorkspaceData, WorkspaceItem,
} from './types'

const FINISHED = ['COMPLETED', 'PARTIALLY_COMPLETED'] as const

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

  const [items, onHand, runsByItem, recent, today] = await Promise.all([
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
    prisma.productionOrder.findMany({
      where: { restaurantId, status: { in: [...FINISHED] }, ...branchWhere },
      orderBy: [{ completedAt: 'desc' }, { createdAt: 'desc' }],
      take: 100,
      include: {
        outputItem: { select: { name: true, unit: true } },
        outputs: { select: { quantity: true, unit: true }, take: 1 },
        requestedBy: { select: { name: true } },
        branch: { select: { name: true } },
        _count: { select: { wastage: true } },
      },
    }),
    prisma.productionOrder.aggregate({
      where: {
        restaurantId, status: { in: [...FINISHED] }, ...branchWhere,
        completedAt: { gte: dayStart },
      },
      _count: { _all: true },
      _sum: { totalCost: true },
    }),
  ])

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
  }))

  const prepared: PreparedItemRow[] = items
    .filter((item) => item.isPrepared)
    .map((item) => {
      const here = available.get(item.id) ?? 0
      const runs = produced.get(item.id)
      return {
        id: item.id,
        name: item.name,
        unit: item.unit,
        available: here,
        costPerUnit: item.costPerUnit,
        stockValue: Math.round(here * item.costPerUnit),
        lastProducedAt: runs?.last?.toISOString() ?? null,
        runs: runs?.runs ?? 0,
      }
    })
    .sort((a, b) => (b.lastProducedAt ?? '').localeCompare(a.lastProducedAt ?? '') || a.name.localeCompare(b.name))

  const history: ProductionHistoryRow[] = recent.map((run) => ({
    id: run.id,
    number: run.number,
    itemId: run.outputItemId,
    // A run from the recipe era has no output item on the row; it kept the name.
    itemName: run.outputItem?.name ?? run.recipeName ?? 'Production run',
    quantity: run.outputs[0]?.quantity ?? run.actualQty ?? run.plannedQty,
    unit: (run.outputItem?.unit ?? run.outputs[0]?.unit ?? run.unit) as string | null,
    totalCost: run.totalCost,
    unitCost: run.unitCost,
    completedAt: run.completedAt?.toISOString() ?? null,
    madeBy: run.requestedBy?.name ?? null,
    branchName: run.branch.name,
    wasteCount: run._count.wastage,
  }))

  return {
    items: workspaceItems,
    prepared,
    history,
    stats: {
      runsToday: today._count._all,
      valueToday: today._sum.totalCost ?? 0,
      preparedCount: prepared.length,
    },
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
  const reach = visibleBranchIds({ role: user.role, branchId: user.branchId })
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
        include: { item: { select: { id: true, name: true, unit: true } } },
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
