import 'server-only'

import type { StockMovementType } from '@prisma/client'

import { NotFoundError } from '@/lib/errors'
import { prisma } from '@/server/db/prisma'
import { roundQty } from '@/lib/quantity'

/**
 * Where stock came from, and where it went.
 *
 * The ledger already records enough to answer both questions — every movement
 * carries a type, a location, a batch and a reference to whatever caused it.
 * This module reads that back as a story rather than a table, which is the
 * form an owner actually asks the question in: "we made 500 patties on Tuesday,
 * where are they now?"
 *
 * Both directions are derived from the same rows. Nothing here writes.
 */

export interface TraceStep {
  id: string
  type: StockMovementType
  /** Signed, in base units. */
  quantity: number
  at: string
  locationName: string | null
  actorName: string | null
  reason: string | null
  /** What caused it, and where to look. */
  sourceLabel: string | null
  sourceHref: string | null
}

export interface BatchTrace {
  batchId: string
  batchNo: string
  itemId: string
  itemName: string
  unit: string
  expiryDate: string | null
  /** Where the batch was created — production run or delivery. */
  origin: {
    kind: 'PRODUCTION' | 'PURCHASE' | 'UNKNOWN'
    label: string | null
    href: string | null
    locationName: string | null
    at: string | null
  }
  receivedQty: number
  remainingQty: number
  /** Every movement of this batch, oldest first. */
  steps: TraceStep[]
  /** What happened to it, summarised. */
  outcome: {
    transferredOut: number
    sold: number
    wasted: number
    returned: number
    remaining: number
  }
  /** Where the batch ended up, by location. */
  destinations: Array<{ locationName: string; quantity: number }>
}

const SOLD: StockMovementType[] = ['SALE', 'CONSUMPTION', 'PRODUCTION_CONSUMPTION']
const WASTED: StockMovementType[] = ['WASTAGE', 'WASTE', 'EXPIRY']
const RETURNED: StockMovementType[] = ['RETURN_TO_SUPPLIER', 'CUSTOMER_RETURN', 'RETURN']

/** Follow one batch from creation to wherever it ended up. */
export async function traceBatch(params: {
  restaurantId: string
  batchId: string
}): Promise<BatchTrace> {
  const batch = await prisma.stockBatch.findFirst({
    where: { id: params.batchId, restaurantId: params.restaurantId },
    include: {
      item: { select: { id: true, name: true, unit: true } },
      branch: { select: { name: true } },
    },
  })
  if (!batch) throw new NotFoundError('Batch')

  const movements = await prisma.stockMovement.findMany({
    where: { batchId: batch.id, restaurantId: params.restaurantId },
    orderBy: { createdAt: 'asc' },
    include: {
      user: { select: { name: true } },
      branch: { select: { name: true } },
      order: { select: { id: true, orderNumber: true } },
      purchase: { select: { id: true, number: true } },
    },
  })

  const steps: TraceStep[] = movements.map((m) => {
    let sourceLabel: string | null = null
    let sourceHref: string | null = null

    if (m.order) {
      sourceLabel = m.order.orderNumber
      sourceHref = `/dashboard/orders/${m.order.id}`
    } else if (m.purchase) {
      sourceLabel = m.purchase.number
      sourceHref = `/dashboard/purchases/${m.purchase.id}`
    } else if (m.referenceType === 'ProductionOrder' && m.referenceId) {
      sourceLabel = 'Production run'
      sourceHref = `/dashboard/production/${m.referenceId}`
    } else if (m.referenceType === 'StockTransfer' && m.referenceId) {
      sourceLabel = 'Transfer'
      sourceHref = `/dashboard/transfers/${m.referenceId}`
    }

    return {
      id: m.id,
      type: m.type,
      quantity: m.quantity,
      at: m.createdAt.toISOString(),
      locationName: m.branch?.name ?? null,
      actorName: m.user?.name ?? null,
      reason: m.reason,
      sourceLabel,
      sourceHref,
    }
  })

  // The first inbound movement is where the batch came from.
  const first = movements.find((m) => m.quantity > 0)
  const origin: BatchTrace['origin'] =
    first?.type === 'PRODUCTION_OUTPUT'
      ? {
          kind: 'PRODUCTION',
          label: first.reason ?? 'Production run',
          href: first.referenceId ? `/dashboard/production/${first.referenceId}` : null,
          locationName: first.branch?.name ?? null,
          at: first.createdAt.toISOString(),
        }
      : first?.type === 'PURCHASE'
        ? {
            kind: 'PURCHASE',
            label: first.purchase?.number ?? 'Delivery',
            href: first.purchase ? `/dashboard/purchases/${first.purchase.id}` : null,
            locationName: first.branch?.name ?? null,
            at: first.createdAt.toISOString(),
          }
        : { kind: 'UNKNOWN', label: null, href: null, locationName: batch.branch?.name ?? null, at: null }

  let transferredOut = 0
  let sold = 0
  let wasted = 0
  let returned = 0
  const byLocation = new Map<string, number>()

  for (const m of movements) {
    if (m.type === 'TRANSFER_OUT') transferredOut += Math.abs(m.quantity)
    else if (SOLD.includes(m.type)) sold += Math.abs(m.quantity)
    else if (WASTED.includes(m.type)) wasted += Math.abs(m.quantity)
    else if (RETURNED.includes(m.type)) returned += Math.abs(m.quantity)

    // Net position per location: in minus out.
    const name = m.branch?.name ?? 'Unassigned'
    byLocation.set(name, roundQty((byLocation.get(name) ?? 0) + m.quantity))
  }

  return {
    batchId: batch.id,
    batchNo: batch.batchNo,
    itemId: batch.item.id,
    itemName: batch.item.name,
    unit: batch.item.unit as string,
    expiryDate: batch.expiryDate?.toISOString() ?? null,
    origin,
    receivedQty: batch.receivedQty,
    remainingQty: batch.remainingQty,
    steps,
    outcome: {
      transferredOut: roundQty(transferredOut),
      sold: roundQty(sold),
      wasted: roundQty(wasted),
      returned: roundQty(returned),
      remaining: roundQty(batch.remainingQty),
    },
    destinations: [...byLocation.entries()]
      .filter(([, q]) => Math.abs(q) > 1e-6)
      .map(([locationName, quantity]) => ({ locationName, quantity }))
      .sort((a, b) => b.quantity - a.quantity),
  }
}

export interface ItemTrace {
  itemId: string
  name: string
  unit: string
  /** Recent movements across every location, newest first. */
  steps: TraceStep[]
  /** Current holding per location. */
  byLocation: Array<{
    branchId: string
    locationName: string
    type: string
    available: number
    reserved: number
    inTransit: number
  }>
  batches: Array<{
    batchId: string
    batchNo: string
    remainingQty: number
    expiryDate: string | null
    locationName: string | null
  }>
}

/** The same question for an item that is not batch-tracked. */
export async function traceItem(params: {
  restaurantId: string
  itemId: string
  limit?: number
}): Promise<ItemTrace> {
  const item = await prisma.inventoryItem.findFirst({
    where: { id: params.itemId, restaurantId: params.restaurantId },
    select: { id: true, name: true, unit: true },
  })
  if (!item) throw new NotFoundError('Inventory item')

  const [movements, stock, batches] = await Promise.all([
    prisma.stockMovement.findMany({
      where: { itemId: item.id, restaurantId: params.restaurantId },
      orderBy: { createdAt: 'desc' },
      take: params.limit ?? 100,
      include: {
        user: { select: { name: true } },
        branch: { select: { name: true } },
        order: { select: { id: true, orderNumber: true } },
        purchase: { select: { id: true, number: true } },
      },
    }),
    prisma.inventoryStock.findMany({
      where: { itemId: item.id, restaurantId: params.restaurantId },
      include: { branch: { select: { id: true, name: true, type: true } } },
    }),
    prisma.stockBatch.findMany({
      where: { itemId: item.id, restaurantId: params.restaurantId, remainingQty: { gt: 0 } },
      orderBy: { expiryDate: 'asc' },
      include: { branch: { select: { name: true } } },
    }),
  ])

  return {
    itemId: item.id,
    name: item.name,
    unit: item.unit as string,
    steps: movements.map((m) => ({
      id: m.id,
      type: m.type,
      quantity: m.quantity,
      at: m.createdAt.toISOString(),
      locationName: m.branch?.name ?? null,
      actorName: m.user?.name ?? null,
      reason: m.reason,
      sourceLabel: m.order?.orderNumber ?? m.purchase?.number ?? null,
      sourceHref: m.order
        ? `/dashboard/orders/${m.order.id}`
        : m.purchase
          ? `/dashboard/purchases/${m.purchase.id}`
          : null,
    })),
    byLocation: stock.map((s) => ({
      branchId: s.branch.id,
      locationName: s.branch.name,
      type: s.branch.type as string,
      available: s.available,
      reserved: s.reserved,
      inTransit: s.inTransit,
    })),
    batches: batches.map((b) => ({
      batchId: b.id,
      batchNo: b.batchNo,
      remainingQty: b.remainingQty,
      expiryDate: b.expiryDate?.toISOString() ?? null,
      locationName: b.branch?.name ?? null,
    })),
  }
}

