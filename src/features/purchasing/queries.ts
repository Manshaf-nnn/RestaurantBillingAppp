import 'server-only'

import type { PurchaseStatus } from '@prisma/client'

import { NotFoundError } from '@/lib/errors'
import { prisma } from '@/server/db/prisma'
import { roundQty } from '@/lib/quantity'

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
  /** Matched against the order number, the supplier, and the items on it. */
  search?: string
  status?: string
}): Promise<PurchaseSummary[]> {
  const term = params.search?.trim()

  const orders = await prisma.purchase.findMany({
    where: {
      restaurantId: params.restaurantId,
      ...(params.branchId ? { branchId: params.branchId } : {}),
      ...(params.status && params.status !== 'ALL'
        ? { status: params.status as PurchaseStatus }
        : {}),
      /*
       * Searched on the server, not filtered on the client. This list is
       * capped, so a client filter would search the fifty rows that happened to
       * be fetched and confidently report "no results" for the order sitting at
       * fifty-one.
       */
      ...(term
        ? {
            OR: [
              { number: { contains: term, mode: 'insensitive' } },
              { notes: { contains: term, mode: 'insensitive' } },
              { supplier: { name: { contains: term, mode: 'insensitive' } } },
              { items: { some: { item: { name: { contains: term, mode: 'insensitive' } } } } },
              { items: { some: { item: { sku: { contains: term, mode: 'insensitive' } } } } },
              { receipts: { some: { number: { contains: term, mode: 'insensitive' } } } },
              { receipts: { some: { supplierRef: { contains: term, mode: 'insensitive' } } } },
            ],
          }
        : {}),
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
  createdAt: string
  /*
   * Where the goods are going. The columns have always existed and the detail
   * page never selected them, so the one screen that reads back an order could
   * not say which of your locations it was for.
   */
  branchId: string | null
  branchName: string | null
  locationId: string | null
  locationName: string | null
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
    branchName: string | null
    lines: Array<{ name: string; acceptedQty: number; rejectedQty: number; unit: string | null }>
  }>
  /** Every item on this order, with what it last cost — shown while receiving. */
  lastPurchaseByItem: Record<
    string,
    { unitCost: number; unit: string | null; at: string; supplierName: string | null }
  >
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
      branch: { select: { id: true, name: true } },
      location: { select: { id: true, name: true } },
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
          branch: { select: { name: true } },
          lines: { include: { item: { select: { name: true } } } },
        },
      },
    },
  })
  if (!po) throw new NotFoundError('Purchase order')

  /*
   * What each of these items last cost, for the receiving form.
   *
   * A delivery note rarely matches the order exactly — suppliers change prices
   * between the order and the van — and the person entering it had nothing to
   * compare against. Scoped to the items on this order rather than all of them.
   */
  const itemIds = po.items.map((l) => l.itemId)
  const lastPrices = itemIds.length
    ? await prisma.$queryRaw<
        Array<{
          itemId: string
          unitCost: number
          unit: string | null
          recordedAt: Date
          supplierName: string | null
        }>
      >`
        SELECT DISTINCT ON (h."itemId")
               h."itemId"     AS "itemId",
               h."unitCost"   AS "unitCost",
               h."unit"::text AS "unit",
               h."recordedAt" AS "recordedAt",
               s."name"       AS "supplierName"
        FROM purchase_price_history h
        LEFT JOIN suppliers s ON s.id = h."supplierId"
        WHERE h."restaurantId" = ${params.restaurantId}
          AND h."itemId" = ANY(${itemIds}::text[])
        ORDER BY h."itemId", h."recordedAt" DESC
      `
    : []

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
    createdAt: po.createdAt.toISOString(),
    branchId: po.branchId,
    branchName: po.branch?.name ?? null,
    locationId: po.locationId,
    locationName: po.location?.name ?? null,
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
      outstanding: Math.max(0, roundQty(l.quantity - l.receivedQty - l.rejectedQty)),
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
      branchName: r.branch?.name ?? null,
      lines: r.lines.map((l) => ({
        name: l.item.name,
        acceptedQty: l.acceptedQty,
        rejectedQty: l.rejectedQty,
        unit: l.unit as string | null,
      })),
    })),
    lastPurchaseByItem: Object.fromEntries(
      lastPrices.map((row) => [
        row.itemId,
        {
          unitCost: Number(row.unitCost),
          unit: row.unit,
          at: row.recordedAt.toISOString(),
          supplierName: row.supplierName,
        },
      ]),
    ),
  }
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
    /*
     * What this item last actually cost, as opposed to what a price list says.
     *
     * The data has always been captured — `PurchasePriceHistory` gets a row per
     * accepted delivery line — and nothing anywhere in the purchasing UI ever
     * showed it. The price prefilled on a new order came from the supplier's
     * standing quote, or failing that the weighted average, so the one number a
     * buyer actually wants at the moment of ordering ("what did we pay last
     * time, and to whom") was the one number missing.
     */
    lastPurchase: {
      unitCost: number
      unit: string | null
      at: string
      supplierName: string | null
    } | null
  }>
  currency: string
}

/** Everything the "new purchase order" form needs in one read. */
export async function getPoBuilderData(params: {
  restaurantId: string
  currency: string
}): Promise<PoBuilderData> {
  const [suppliers, items, locations, lastPrices] = await Promise.all([
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
    /*
     * The most recent recorded price for every item, in one query.
     *
     * `DISTINCT ON` is Postgres-specific and deliberate: the alternative is a
     * correlated subquery per item, and this list is read on every visit to the
     * order form. The index on (restaurantId, itemId, recordedAt) makes it a
     * single ordered scan.
     */
    prisma.$queryRaw<
      Array<{
        itemId: string
        unitCost: number
        unit: string | null
        recordedAt: Date
        supplierName: string | null
      }>
    >`
      SELECT DISTINCT ON (h."itemId")
             h."itemId"      AS "itemId",
             h."unitCost"    AS "unitCost",
             h."unit"::text  AS "unit",
             h."recordedAt"  AS "recordedAt",
             s."name"        AS "supplierName"
      FROM purchase_price_history h
      LEFT JOIN suppliers s ON s.id = h."supplierId"
      WHERE h."restaurantId" = ${params.restaurantId}
      ORDER BY h."itemId", h."recordedAt" DESC
    `,
  ])

  const lastByItem = new Map(
    lastPrices.map((row) => [
      row.itemId,
      {
        unitCost: Number(row.unitCost),
        unit: row.unit,
        at: row.recordedAt.toISOString(),
        supplierName: row.supplierName,
      },
    ]),
  )

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
      lastPurchase: lastByItem.get(i.id) ?? null,
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

/**
 * What is waiting to be unloaded.
 *
 * Receiving has always worked, and the only way to reach it was to know a PO
 * number, open that order and scroll to the bottom. A storekeeper standing at a
 * bay with a delivery note had no screen that answered "what are we expecting".
 * That is why it was reported as "no option to create a GRN from an approved
 * order" — the option existed, in a place nobody would look for it.
 *
 * Only orders that can actually be received are listed, so nothing here is a
 * dead end: an approved order that has been ordered or partly received, with
 * something still outstanding.
 */
export interface AwaitingDelivery {
  id: string
  number: string
  status: PurchaseStatus
  supplierId: string | null
  supplierName: string | null
  branchName: string | null
  expectedAt: string | null
  createdAt: string
  lineCount: number
  orderedQty: number
  receivedQty: number
  outstandingQty: number
  total: number
}

export async function listAwaitingDelivery(params: {
  restaurantId: string
  branchId?: string | null
  search?: string
}): Promise<AwaitingDelivery[]> {
  const term = params.search?.trim()

  const orders = await prisma.purchase.findMany({
    where: {
      restaurantId: params.restaurantId,
      status: { in: ['APPROVED', 'ORDERED', 'PARTIALLY_RECEIVED'] },
      ...(params.branchId ? { branchId: params.branchId } : {}),
      ...(term
        ? {
            OR: [
              { number: { contains: term, mode: 'insensitive' } },
              { supplier: { name: { contains: term, mode: 'insensitive' } } },
              { items: { some: { item: { name: { contains: term, mode: 'insensitive' } } } } },
            ],
          }
        : {}),
    },
    orderBy: [{ expectedAt: 'asc' }, { createdAt: 'asc' }],
    include: {
      supplier: { select: { id: true, name: true } },
      branch: { select: { name: true } },
      items: { select: { quantity: true, receivedQty: true, rejectedQty: true } },
    },
  })

  return orders
    .map((po) => {
      const orderedQty = po.items.reduce((sum, l) => sum + l.quantity, 0)
      const receivedQty = po.items.reduce((sum, l) => sum + l.receivedQty, 0)
      const handled = po.items.reduce((sum, l) => sum + l.receivedQty + l.rejectedQty, 0)

      return {
        id: po.id,
        number: po.number,
        status: po.status,
        supplierId: po.supplier?.id ?? null,
        supplierName: po.supplier?.name ?? null,
        branchName: po.branch?.name ?? null,
        expectedAt: po.expectedAt?.toISOString() ?? null,
        createdAt: po.createdAt.toISOString(),
        lineCount: po.items.length,
        orderedQty: roundQty(orderedQty),
        receivedQty: roundQty(receivedQty),
        outstandingQty: roundQty(Math.max(0, orderedQty - handled)),
        total: po.total,
      }
    })
    // An order whose every line is settled is not awaiting anything, whatever
    // its status says — status is derived after each receipt and a rejected-only
    // delivery can close a line without the order reading RECEIVED.
    .filter((po) => po.outstandingQty > 1e-6)
}

/** Deliveries already taken in, newest first — the other half of the screen. */
export async function listRecentReceipts(params: {
  restaurantId: string
  branchId?: string | null
  limit?: number
}) {
  const receipts = await prisma.goodsReceipt.findMany({
    where: {
      restaurantId: params.restaurantId,
      // Where the delivery actually landed. A receipt can be diverted to a
      // location its order never named, so this is the receipt's own branch
      // rather than the order's.
      ...(params.branchId ? { branchId: params.branchId } : {}),
    },
    orderBy: { receivedAt: 'desc' },
    take: params.limit ?? 20,
    include: {
      branch: { select: { name: true } },
      receivedBy: { select: { name: true } },
      purchase: {
        select: {
          id: true,
          number: true,
          branch: { select: { name: true } },
          supplier: { select: { name: true } },
        },
      },
      lines: { select: { acceptedQty: true, unitCost: true } },
    },
  })

  return receipts.map((r) => ({
    id: r.id,
    number: r.number,
    purchaseId: r.purchase.id,
    purchaseNumber: r.purchase.number,
    supplierName: r.purchase.supplier?.name ?? null,
    branchName: r.branch?.name ?? r.purchase.branch?.name ?? null,
    supplierRef: r.supplierRef,
    receivedAt: r.receivedAt.toISOString(),
    receivedByName: r.receivedBy?.name ?? null,
    lineCount: r.lines.length,
    value: r.lines.reduce((sum, l) => sum + Math.round(l.acceptedQty * l.unitCost), 0),
  }))
}

/**
 * One delivery, in full — the GRN preview.
 *
 * GRNs existed only as a cramped nested list inside the purchase order page:
 * item names and quantities, no costs, no total, no destination, nothing to
 * print and nothing to link to. A delivery is the document a supplier's invoice
 * is checked against, so it needs to stand on its own.
 */
export async function getReceiptDetail(params: {
  restaurantId: string
  receiptId: string
  currency: string
}) {
  const receipt = await prisma.goodsReceipt.findFirst({
    where: { id: params.receiptId, restaurantId: params.restaurantId },
    include: {
      branch: { select: { id: true, name: true } },
      location: { select: { id: true, name: true } },
      receivedBy: { select: { name: true } },
      purchase: {
        select: {
          id: true,
          number: true,
          status: true,
          branchId: true,
          branch: { select: { id: true, name: true } },
          supplier: { select: { id: true, name: true } },
        },
      },
      lines: {
        include: {
          item: { select: { id: true, name: true, sku: true, unit: true } },
          purchaseItem: { select: { quantity: true, unitCost: true } },
        },
      },
    },
  })
  if (!receipt) return null

  const lines = receipt.lines.map((l) => ({
    id: l.id,
    itemId: l.itemId,
    name: l.item.name,
    sku: l.item.sku,
    unit: (l.unit ?? l.item.unit) as string,
    /** What the order asked for, so the two can be compared side by side. */
    orderedQty: l.purchaseItem?.quantity ?? 0,
    acceptedQty: l.acceptedQty,
    rejectedQty: l.rejectedQty,
    unitCost: l.unitCost,
    /** What the order expected to pay, when it differs from what was charged. */
    orderedUnitCost: l.purchaseItem?.unitCost ?? l.unitCost,
    lineTotal: Math.round(l.acceptedQty * l.unitCost),
    rejectReason: l.rejectReason,
    batchNo: l.batchNo,
    expiryDate: l.expiryDate?.toISOString() ?? null,
  }))

  return {
    id: receipt.id,
    number: receipt.number,
    supplierRef: receipt.supplierRef,
    notes: receipt.notes,
    receivedAt: receipt.receivedAt.toISOString(),
    receivedByName: receipt.receivedBy?.name ?? null,
    // Falls back to the order's branch, which is where pre-existing receipts —
    // recorded before a delivery could be diverted — actually landed.
    branchId: receipt.branch?.id ?? receipt.purchase.branch?.id ?? null,
    branchName: receipt.branch?.name ?? receipt.purchase.branch?.name ?? null,
    locationName: receipt.location?.name ?? null,
    purchaseId: receipt.purchase.id,
    purchaseNumber: receipt.purchase.number,
    purchaseStatus: receipt.purchase.status as string,
    supplierId: receipt.purchase.supplier?.id ?? null,
    supplierName: receipt.purchase.supplier?.name ?? null,
    currency: params.currency,
    lines,
    acceptedTotal: lines.reduce((sum, l) => sum + l.lineTotal, 0),
    rejectedCount: lines.filter((l) => l.rejectedQty > 0).length,
  }
}

export type ReceiptDetail = NonNullable<Awaited<ReturnType<typeof getReceiptDetail>>>
