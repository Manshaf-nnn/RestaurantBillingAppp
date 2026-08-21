import 'server-only'

import type { PurchaseStatus } from '@prisma/client'

import { NotFoundError } from '@/lib/errors'
import { prisma } from '@/server/db/prisma'

export interface PurchaseSummary {
  id: string
  number: string
  status: PurchaseStatus
  supplierName: string | null
  total: number
  expectedAt: string | null
  createdAt: string
  lineCount: number
  /** 0–100; how much of the order has arrived. */
  receivedPercent: number
}

export async function listPurchaseOrders(params: {
  restaurantId: string
  limit?: number
  /** Only orders being delivered to this location. Null means every location. */
  branchId?: string | null
}): Promise<PurchaseSummary[]> {
  const orders = await prisma.purchase.findMany({
    where: {
      restaurantId: params.restaurantId,
      ...(params.branchId ? { branchId: params.branchId } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: params.limit ?? 50,
    include: {
      supplier: { select: { name: true } },
      items: { select: { quantity: true, receivedQty: true, rejectedQty: true } },
    },
  })

  return orders.map((po) => {
    const ordered = po.items.reduce((sum, l) => sum + l.quantity, 0)
    const handled = po.items.reduce((sum, l) => sum + l.receivedQty + l.rejectedQty, 0)
    return {
      id: po.id,
      number: po.number,
      status: po.status,
      supplierName: po.supplier?.name ?? null,
      total: po.total,
      expectedAt: po.expectedAt?.toISOString() ?? null,
      createdAt: po.createdAt.toISOString(),
      lineCount: po.items.length,
      receivedPercent: ordered > 0 ? Math.min(100, Math.round((handled / ordered) * 100)) : 0,
    }
  })
}

export interface PurchaseDetail {
  id: string
  number: string
  status: PurchaseStatus
  supplierName: string | null
  supplierId: string | null
  subtotal: number
  discount: number
  taxTotal: number
  total: number
  notes: string | null
  expectedAt: string | null
  createdByName: string | null
  approvedByName: string | null
  approvedAt: string | null
  currency: string
  lines: Array<{
    id: string
    itemId: string
    name: string
    unit: string
    baseUnit: string
    quantity: number
    receivedQty: number
    rejectedQty: number
    /** Still to arrive. */
    outstanding: number
    unitCost: number
    lineTotal: number
    /** Batch-tracked items must carry a lot number and expiry on receipt. */
    trackBatches: boolean
    trackExpiry: boolean
  }>
  receipts: Array<{
    id: string
    number: string
    supplierRef: string | null
    receivedAt: string
    receivedByName: string | null
    lines: Array<{ name: string; acceptedQty: number; rejectedQty: number; unit: string | null }>
  }>
}

export async function getPurchaseDetail(params: {
  restaurantId: string
  purchaseId: string
  currency: string
}): Promise<PurchaseDetail> {
  const po = await prisma.purchase.findFirst({
    where: { id: params.purchaseId, restaurantId: params.restaurantId },
    include: {
      supplier: { select: { id: true, name: true } },
      createdBy: { select: { name: true } },
      approvedBy: { select: { name: true } },
      items: {
        include: {
          item: {
            select: { id: true, name: true, unit: true, trackBatches: true, trackExpiry: true },
          },
        },
      },
      receipts: {
        orderBy: { receivedAt: 'desc' },
        include: {
          receivedBy: { select: { name: true } },
          lines: { include: { item: { select: { name: true } } } },
        },
      },
    },
  })
  if (!po) throw new NotFoundError('Purchase order')

  return {
    id: po.id,
    number: po.number,
    status: po.status,
    supplierName: po.supplier?.name ?? null,
    supplierId: po.supplier?.id ?? null,
    subtotal: po.subtotal,
    discount: po.discount,
    taxTotal: po.taxTotal,
    total: po.total,
    notes: po.notes,
    expectedAt: po.expectedAt?.toISOString() ?? null,
    createdByName: po.createdBy?.name ?? null,
    approvedByName: po.approvedBy?.name ?? null,
    approvedAt: po.approvedAt?.toISOString() ?? null,
    currency: params.currency,
    lines: po.items.map((l) => ({
      id: l.id,
      itemId: l.itemId,
      name: l.item.name,
      unit: (l.unit ?? l.item.unit) as string,
      baseUnit: l.item.unit as string,
      quantity: l.quantity,
      receivedQty: l.receivedQty,
      rejectedQty: l.rejectedQty,
      outstanding: Math.max(0, round(l.quantity - l.receivedQty - l.rejectedQty)),
      unitCost: l.unitCost,
      lineTotal: l.lineTotal,
      trackBatches: l.item.trackBatches,
      trackExpiry: l.item.trackExpiry,
    })),
    receipts: po.receipts.map((r) => ({
      id: r.id,
      number: r.number,
      supplierRef: r.supplierRef,
      receivedAt: r.receivedAt.toISOString(),
      receivedByName: r.receivedBy?.name ?? null,
      lines: r.lines.map((l) => ({
        name: l.item.name,
        acceptedQty: l.acceptedQty,
        rejectedQty: l.rejectedQty,
        unit: l.unit as string | null,
      })),
    })),
  }
}

function round(v: number) {
  return Math.round(v * 1e6) / 1e6
}


export interface PoBuilderData {
  suppliers: Array<{ id: string; name: string; paymentTerms: string }>
  /** Where the delivery can land. */
  locations: Array<{ id: string; name: string; type: string; isDefault: boolean }>
  items: Array<{
    id: string
    name: string
    unit: string
    quantity: number
    /** Supplier-specific pricing, best/preferred first. */
    sources: Array<{
      supplierId: string
      supplierName: string
      price: number
      purchaseUnit: string | null
      leadTimeDays: number | null
      minOrderQty: number | null
      isPreferred: boolean
    }>
    /** Falls back to the item's own average cost when no supplier price exists. */
    fallbackCost: number
  }>
  currency: string
}

/** Everything the "new purchase order" form needs in one read. */
export async function getPoBuilderData(params: {
  restaurantId: string
  currency: string
}): Promise<PoBuilderData> {
  const [suppliers, items, locations] = await Promise.all([
    prisma.supplier.findMany({
      where: { restaurantId: params.restaurantId, isActive: true },
      select: { id: true, name: true, paymentTerms: true },
      orderBy: { name: 'asc' },
    }),
    prisma.inventoryItem.findMany({
      where: { restaurantId: params.restaurantId, isActive: true },
      orderBy: { name: 'asc' },
      select: {
        id: true, name: true, unit: true, quantity: true, costPerUnit: true,
        supplierItems: {
          where: { isActive: true },
          orderBy: [{ isPreferred: 'desc' }, { price: 'asc' }],
          select: {
            price: true, purchaseUnit: true, leadTimeDays: true,
            minOrderQty: true, isPreferred: true,
            supplier: { select: { id: true, name: true } },
          },
        },
      },
    }),
    // Where the delivery lands. Without this the purchase carried no location,
    // so receiving it credited no shelf and the goods were invisible everywhere
    // except the restaurant-wide total.
    prisma.branch.findMany({
      where: { restaurantId: params.restaurantId, deletedAt: null, isActive: true },
      select: { id: true, name: true, type: true, isDefault: true },
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
    }),
  ])

  return {
    currency: params.currency,
    suppliers: suppliers.map((s) => ({ id: s.id, name: s.name, paymentTerms: s.paymentTerms })),
    locations,
    items: items.map((i) => ({
      id: i.id,
      name: i.name,
      unit: i.unit,
      quantity: i.quantity,
      fallbackCost: i.costPerUnit,
      sources: i.supplierItems.map((si) => ({
        supplierId: si.supplier.id,
        supplierName: si.supplier.name,
        price: si.price,
        purchaseUnit: si.purchaseUnit,
        leadTimeDays: si.leadTimeDays,
        minOrderQty: si.minOrderQty,
        isPreferred: si.isPreferred,
      })),
    })),
  }
}


export interface SupplierPricingData {
  supplier: {
    id: string
    name: string
    company: string | null
    contactName: string | null
    phone: string | null
    email: string | null
    paymentTerms: string
    taxNumber: string | null
  }
  /** Items this supplier already quotes for. */
  priced: Array<{
    itemId: string
    name: string
    baseUnit: string
    supplierSku: string | null
    purchaseUnit: string | null
    unitsPerPurchaseUnit: number | null
    price: number
    leadTimeDays: number | null
    minOrderQty: number | null
    isPreferred: boolean
    /** How many other suppliers also quote for it. */
    alternativeCount: number
    /** The cheapest price anyone quotes, for comparison. */
    bestPrice: number | null
  }>
  /** Everything else, for adding a new line. */
  available: Array<{ id: string; name: string; unit: string }>
  currency: string
}

/**
 * One supplier's price list.
 *
 * Each row carries how many other suppliers quote the same item and the best
 * price among them, because the question worth answering on this screen is not
 * "what does this supplier charge?" but "should I still be buying it here?".
 */
export async function getSupplierPricing(params: {
  restaurantId: string
  supplierId: string
  currency: string
}): Promise<SupplierPricingData> {
  const supplier = await prisma.supplier.findFirst({
    where: { id: params.supplierId, restaurantId: params.restaurantId },
    select: {
      id: true, name: true, company: true, contactName: true,
      phone: true, email: true, paymentTerms: true, taxNumber: true,
    },
  })
  if (!supplier) throw new NotFoundError('Supplier')

  const [links, allItems] = await Promise.all([
    prisma.supplierItem.findMany({
      where: { supplierId: supplier.id, restaurantId: params.restaurantId },
      include: { item: { select: { id: true, name: true, unit: true } } },
      orderBy: { item: { name: 'asc' } },
    }),
    prisma.inventoryItem.findMany({
      where: { restaurantId: params.restaurantId, isActive: true },
      select: { id: true, name: true, unit: true },
      orderBy: { name: 'asc' },
    }),
  ])

  const itemIds = links.map((l) => l.itemId)
  const competing = itemIds.length
    ? await prisma.supplierItem.findMany({
        where: { itemId: { in: itemIds }, restaurantId: params.restaurantId, isActive: true },
        select: { itemId: true, supplierId: true, price: true },
      })
    : []

  const byItem = new Map<string, Array<{ supplierId: string; price: number }>>()
  for (const row of competing) {
    const list = byItem.get(row.itemId) ?? []
    list.push({ supplierId: row.supplierId, price: row.price })
    byItem.set(row.itemId, list)
  }

  const pricedIds = new Set(itemIds)

  return {
    supplier,
    currency: params.currency,
    priced: links.map((l) => {
      const others = (byItem.get(l.itemId) ?? []).filter((o) => o.supplierId !== supplier.id)
      const prices = (byItem.get(l.itemId) ?? []).map((o) => o.price).filter((p) => p > 0)
      return {
        itemId: l.itemId,
        name: l.item.name,
        baseUnit: l.item.unit as string,
        supplierSku: l.supplierSku,
        purchaseUnit: l.purchaseUnit as string | null,
        unitsPerPurchaseUnit: l.unitsPerPurchaseUnit,
        price: l.price,
        leadTimeDays: l.leadTimeDays,
        minOrderQty: l.minOrderQty,
        isPreferred: l.isPreferred,
        alternativeCount: others.length,
        bestPrice: prices.length ? Math.min(...prices) : null,
      }
    }),
    available: allItems.filter((i) => !pricedIds.has(i.id)),
  }
}

/** Suppliers with a count of what they quote for, for the list page. */
export async function listSuppliersWithCounts(restaurantId: string) {
  const suppliers = await prisma.supplier.findMany({
    where: { restaurantId },
    orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
    include: { _count: { select: { suppliedItems: true, purchases: true } } },
  })
  return suppliers.map((s) => ({
    id: s.id,
    name: s.name,
    company: s.company,
    phone: s.phone,
    paymentTerms: s.paymentTerms as string,
    isActive: s.isActive,
    itemCount: s._count.suppliedItems,
    orderCount: s._count.purchases,
  }))
}
