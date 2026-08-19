import 'server-only'

import type { Purchase, PurchaseStatus, StockUnit } from '@prisma/client'

import { AppError, NotFoundError } from '@/lib/errors'
import { prisma, type TxClient } from '@/server/db/prisma'

/**
 * Purchase orders.
 *
 * A purchase order is a promise, not stock. Nothing here touches an inventory
 * balance — creating, approving and sending an order all leave the ledger
 * untouched, and stock only moves when goods are actually received. That
 * separation is the point of the module: it is what stops a restaurant's stock
 * figures reflecting what was ordered rather than what arrived.
 *
 * ── Status ──────────────────────────────────────────────────────────────────
 *
 *   DRAFT → PENDING_APPROVAL → APPROVED → ORDERED → PARTIALLY_RECEIVED
 *                                                 → RECEIVED
 *
 * Transitions are validated rather than assumed, because "approved" is a real
 * authority claim: an order that reached ORDERED without passing through
 * APPROVED would mean someone committed the restaurant's money unreviewed.
 * The receiving statuses are set by the receiving module, never by hand.
 */

const ALLOWED: Record<PurchaseStatus, PurchaseStatus[]> = {
  DRAFT: ['PENDING_APPROVAL', 'APPROVED', 'CANCELLED'],
  // Approving straight from draft is allowed for an owner buying vegetables;
  // requiring a two-person dance in a five-person restaurant is theatre.
  PENDING_APPROVAL: ['APPROVED', 'DRAFT', 'CANCELLED'],
  APPROVED: ['ORDERED', 'CANCELLED'],
  ORDERED: ['PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED'],
  PARTIALLY_RECEIVED: ['RECEIVED', 'CANCELLED'],
  RECEIVED: [],
  CANCELLED: [],
}

export function canTransitionPurchase(from: PurchaseStatus, to: PurchaseStatus): boolean {
  return ALLOWED[from]?.includes(to) ?? false
}

export interface PurchaseLineInput {
  itemId: string
  quantity: number
  unit?: StockUnit | null
  unitCost: number
}

/** Next PO number for the restaurant, e.g. PO-000042. */
async function nextNumber(tx: TxClient, restaurantId: string, prefix: string, table: 'purchase' | 'receipt' | 'return'): Promise<string> {
  const count =
    table === 'purchase'
      ? await tx.purchase.count({ where: { restaurantId } })
      : table === 'receipt'
        ? await tx.goodsReceipt.count({ where: { restaurantId } })
        : await tx.purchaseReturn.count({ where: { restaurantId } })
  return `${prefix}-${String(count + 1).padStart(6, '0')}`
}

function totalsFor(lines: PurchaseLineInput[], discount: number, taxTotal: number) {
  const subtotal = lines.reduce((sum, l) => sum + Math.round(l.quantity * l.unitCost), 0)
  const capped = Math.min(Math.max(0, discount), subtotal)
  return { subtotal, discount: capped, taxTotal: Math.max(0, taxTotal), total: subtotal - capped + Math.max(0, taxTotal) }
}

export async function createPurchaseOrder(params: {
  restaurantId: string
  supplierId?: string | null
  branchId?: string | null
  locationId?: string | null
  lines: PurchaseLineInput[]
  discount?: number
  taxTotal?: number
  expectedAt?: Date | null
  notes?: string | null
  userId?: string | null
}): Promise<Purchase> {
  if (params.lines.length === 0) {
    throw new AppError('Add at least one item to the order', 400, 'PO_EMPTY')
  }
  for (const line of params.lines) {
    if (!(line.quantity > 0)) throw new AppError('Every line needs a quantity above zero', 400, 'PO_BAD_QTY')
    if (line.unitCost < 0) throw new AppError('A cost cannot be negative', 400, 'PO_BAD_COST')
  }

  const owned = await prisma.inventoryItem.count({
    where: { id: { in: params.lines.map((l) => l.itemId) }, restaurantId: params.restaurantId },
  })
  if (owned !== new Set(params.lines.map((l) => l.itemId)).size) {
    throw new NotFoundError('Inventory item')
  }

  const money = totalsFor(params.lines, params.discount ?? 0, params.taxTotal ?? 0)

  return prisma.$transaction(async (tx) => {
    const number = await nextNumber(tx, params.restaurantId, 'PO', 'purchase')
    return tx.purchase.create({
      data: {
        restaurantId: params.restaurantId,
        supplierId: params.supplierId ?? null,
        branchId: params.branchId ?? null,
        locationId: params.locationId ?? null,
        number,
        status: 'DRAFT',
        ...money,
        expectedAt: params.expectedAt ?? null,
        notes: params.notes?.trim() || null,
        createdById: params.userId ?? null,
        items: {
          create: params.lines.map((l) => ({
            itemId: l.itemId,
            quantity: l.quantity,
            unit: l.unit ?? null,
            unitCost: l.unitCost,
            lineTotal: Math.round(l.quantity * l.unitCost),
          })),
        },
      },
    })
  })
}

/** Replace the lines on an order that has not been approved yet. */
export async function updatePurchaseOrder(params: {
  restaurantId: string
  purchaseId: string
  lines: PurchaseLineInput[]
  discount?: number
  taxTotal?: number
  expectedAt?: Date | null
  notes?: string | null
}): Promise<Purchase> {
  const po = await requirePurchase(params.restaurantId, params.purchaseId)
  if (po.status !== 'DRAFT' && po.status !== 'PENDING_APPROVAL') {
    throw new AppError('Only a draft order can be edited', 409, 'PO_NOT_EDITABLE')
  }
  const money = totalsFor(params.lines, params.discount ?? 0, params.taxTotal ?? 0)

  return prisma.$transaction(async (tx) => {
    await tx.purchaseItem.deleteMany({ where: { purchaseId: po.id } })
    return tx.purchase.update({
      where: { id: po.id },
      data: {
        ...money,
        expectedAt: params.expectedAt ?? null,
        notes: params.notes?.trim() || null,
        items: {
          create: params.lines.map((l) => ({
            itemId: l.itemId,
            quantity: l.quantity,
            unit: l.unit ?? null,
            unitCost: l.unitCost,
            lineTotal: Math.round(l.quantity * l.unitCost),
          })),
        },
      },
    })
  })
}

export async function setPurchaseStatus(params: {
  restaurantId: string
  purchaseId: string
  status: PurchaseStatus
  userId?: string | null
  reason?: string | null
}): Promise<Purchase> {
  const po = await requirePurchase(params.restaurantId, params.purchaseId)

  if (!canTransitionPurchase(po.status, params.status)) {
    throw new AppError(
      `A ${po.status.replace(/_/g, ' ').toLowerCase()} order cannot become ${params.status
        .replace(/_/g, ' ')
        .toLowerCase()}`,
      409,
      'PO_BAD_TRANSITION',
    )
  }

  return prisma.purchase.update({
    where: { id: po.id },
    data: {
      status: params.status,
      ...(params.status === 'APPROVED'
        ? { approvedById: params.userId ?? null, approvedAt: new Date() }
        : {}),
      ...(params.status === 'ORDERED' ? { orderedAt: new Date() } : {}),
      ...(params.status === 'CANCELLED' ? { cancelReason: params.reason?.trim() || null } : {}),
    },
  })
}

export async function requirePurchase(restaurantId: string, purchaseId: string): Promise<Purchase> {
  const po = await prisma.purchase.findFirst({ where: { id: purchaseId, restaurantId } })
  if (!po) throw new NotFoundError('Purchase order')
  return po
}

// ── suppliers ────────────────────────────────────────────────────────────────

export async function upsertSupplierItem(params: {
  restaurantId: string
  supplierId: string
  itemId: string
  supplierSku?: string | null
  purchaseUnit?: StockUnit | null
  unitsPerPurchaseUnit?: number | null
  price?: number
  leadTimeDays?: number | null
  minOrderQty?: number | null
  isPreferred?: boolean
}) {
  const [supplier, item] = await Promise.all([
    prisma.supplier.findFirst({ where: { id: params.supplierId, restaurantId: params.restaurantId } }),
    prisma.inventoryItem.findFirst({ where: { id: params.itemId, restaurantId: params.restaurantId } }),
  ])
  if (!supplier || !item) throw new NotFoundError('Supplier or item')

  const data = {
    supplierSku: params.supplierSku?.trim() || null,
    purchaseUnit: params.purchaseUnit ?? null,
    unitsPerPurchaseUnit: params.unitsPerPurchaseUnit ?? null,
    price: params.price ?? 0,
    leadTimeDays: params.leadTimeDays ?? null,
    minOrderQty: params.minOrderQty ?? null,
    isPreferred: params.isPreferred ?? false,
  }

  return prisma.$transaction(async (tx) => {
    // Only one preferred supplier per item, or "preferred" means nothing.
    if (data.isPreferred) {
      await tx.supplierItem.updateMany({
        where: { itemId: params.itemId, restaurantId: params.restaurantId },
        data: { isPreferred: false },
      })
    }
    return tx.supplierItem.upsert({
      where: { supplierId_itemId: { supplierId: params.supplierId, itemId: params.itemId } },
      create: { restaurantId: params.restaurantId, supplierId: params.supplierId, itemId: params.itemId, ...data },
      update: data,
    })
  })
}

export { nextNumber }
