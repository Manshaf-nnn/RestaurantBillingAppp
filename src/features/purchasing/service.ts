import 'server-only'

import type { Purchase, PurchaseStatus, StockUnit } from '@prisma/client'

import { AppError, NotFoundError } from '@/lib/errors'
import { prisma, type TxClient } from '@/server/db/prisma'
import { nextCounterValue } from '@/server/db/counters'
import { toBaseUnits } from '@/features/inventory/units'

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
/**
 * Next document number for a restaurant.
 *
 * Derived from the highest number already issued rather than a row count: a
 * count goes wrong the moment anything is deleted, and two concurrent callers
 * both read the same count and both propose the same number. The unique
 * constraint catches the collision, but the caller sees a database error rather
 * than a clean retry, so the maximum is read under a lock on the restaurant row
 * to serialise issuance.
 */
/**
 * Purchase-order numbers come from the named counter, six digits.
 *
 * There were TWO generators for a while: this file's max-scan and the quick
 * purchase's counter, padding to six and five digits respectively — and a
 * lexicographic `orderBy number desc` over mixed widths reads 'PO-00099' as
 * later than 'PO-000100', so each generator corrupted the other's idea of
 * "last". One counter now, one width, both entry points. The counter is
 * seeded/reseeded by migration at GREATEST(row count, highest issued number)
 * so it can never re-issue an existing number.
 */
export async function nextPurchaseNumber(tx: TxClient, restaurantId: string): Promise<string> {
  const sequence = await nextCounterValue(tx, restaurantId, 'purchase')
  return `PO-${String(sequence).padStart(6, '0')}`
}

async function nextNumber(
  tx: TxClient,
  restaurantId: string,
  prefix: string,
  table: 'receipt' | 'return',
): Promise<string> {
  // Serialise number issuance per restaurant. Cheap: held only for the moment
  // between reading the last number and writing the new document.
  /*
   * Serialise numbering per tenant with an advisory lock, not a row lock.
   *
   * This used to be `SELECT id FROM restaurants ... FOR UPDATE`, which looked
   * like a cheap per-tenant mutex and was in fact a site-wide outage waiting to
   * happen. `restaurants` is the parent of thirty-odd foreign keys, and every
   * INSERT into any child table makes Postgres take `FOR KEY SHARE` on the
   * parent row to check referential integrity. `FOR KEY SHARE` conflicts with
   * exactly one mode — `FOR UPDATE`. So for as long as one purchase order or
   * transfer was being numbered, every insert belonging to that restaurant
   * blocked: branches, orders, order items, stock movements, audit rows,
   * everything. With no lock_timeout those waits never ended.
   *
   * An advisory lock takes no row lock at all, so no referential-integrity
   * check ever contends with it. `pg_advisory_xact_lock` is transaction-scoped
   * and released on commit or rollback, which also makes it safe behind a
   * transaction-mode pooler — unlike the session-scoped variety.
   */
  // $executeRaw, not $queryRaw: the function returns void and Prisma cannot
  // deserialise a void column into a row.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${restaurantId}))`

  const rows =
    table === 'receipt'
      ? await tx.goodsReceipt.findMany({
          where: { restaurantId, number: { startsWith: `${prefix}-` } },
          orderBy: { number: 'desc' }, take: 1, select: { number: true },
        })
      : await tx.purchaseReturn.findMany({
          where: { restaurantId, number: { startsWith: `${prefix}-` } },
          orderBy: { number: 'desc' }, take: 1, select: { number: true },
        })

  const last = Number(rows[0]?.number?.split('-')[1] ?? 0)
  return `${prefix}-${String((Number.isFinite(last) ? last : 0) + 1).padStart(6, '0')}`
}

function totalsFor(lines: PurchaseLineInput[], discount: number, taxTotal: number) {
  const subtotal = lines.reduce((sum, l) => sum + Math.round(l.quantity * l.unitCost), 0)
  const capped = Math.min(Math.max(0, discount), subtotal)
  return { subtotal, discount: capped, taxTotal: Math.max(0, taxTotal), total: subtotal - capped + Math.max(0, taxTotal) }
}

export async function createPurchaseOrder(params: {
  restaurantId: string
  supplierId?: string | null
  /** Which location is buying. Required — the spend belongs to a site. */
  branchId: string
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

  await validateLines(params.restaurantId, params.lines)

  const money = totalsFor(params.lines, params.discount ?? 0, params.taxTotal ?? 0)

  return prisma.$transaction(async (tx) => {
    const number = await nextPurchaseNumber(tx, params.restaurantId)
    return tx.purchase.create({
      data: {
        restaurantId: params.restaurantId,
        supplierId: params.supplierId ?? null,
        branchId: params.branchId,
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

/**
 * Everything the lines on an order must satisfy before it is saved.
 *
 * The unit check is the one that matters, and it is the second cause of the
 * reported "the item is on the order but the GRN won't take it".
 *
 * The line's unit was accepted unchecked — the builder offers all nine — and
 * `toBaseUnits` only ran at goods receipt, deep inside the transaction that
 * moves the stock. So an order written in BOX against an item that has never
 * declared how many kilos are in a box saved perfectly, sat in the system for a
 * week, and then failed at the exact moment someone was standing beside a
 * pallet with a delivery note. Checking here means the person who wrote the
 * mistake is the person told about it, while they still have the form open.
 *
 * Duplicates are rejected for a plainer reason: two lines for one item silently
 * double what is ordered, and the old check compared a count against a Set's
 * size, which cannot detect it.
 */
async function validateLines(restaurantId: string, lines: PurchaseLineInput[]) {
  const seen = new Set<string>()
  for (const line of lines) {
    if (seen.has(line.itemId)) {
      throw new AppError(
        'The same item is on the order twice — combine the lines',
        400,
        'PO_DUPLICATE_ITEM',
      )
    }
    seen.add(line.itemId)
  }

  const items = await prisma.inventoryItem.findMany({
    where: { id: { in: [...seen] }, restaurantId },
    select: {
      id: true, name: true, unit: true, purchaseUnit: true, unitsPerPurchaseUnit: true,
    },
  })
  if (items.length !== seen.size) throw new NotFoundError('Inventory item')

  const byId = new Map(items.map((i) => [i.id, i]))
  for (const line of lines) {
    const item = byId.get(line.itemId)
    if (!item || !line.unit || line.unit === item.unit) continue
    // Throws UnitConversionError, whose message names the item and the fix.
    toBaseUnits(line.quantity, line.unit, item)
  }
}

/** Replace the lines on an order that has not been approved yet. */
export async function updatePurchaseOrder(params: {
  restaurantId: string
  purchaseId: string
  supplierId?: string | null
  branchId?: string | null
  locationId?: string | null
  lines: PurchaseLineInput[]
  discount?: number
  taxTotal?: number
  expectedAt?: Date | null
  notes?: string | null
}): Promise<Purchase> {
  const po = await requirePurchase(params.restaurantId, params.purchaseId)

  /*
   * A draft is a proposal and may be changed freely. Once approved it is a
   * commitment somebody signed, and once anything has been received it is also
   * a stock history — editing either would rewrite a decision or a fact.
   */
  if (po.status !== 'DRAFT' && po.status !== 'PENDING_APPROVAL') {
    throw new AppError(
      `A ${po.status.replace(/_/g, ' ').toLowerCase()} order cannot be edited — cancel it and raise a new one`,
      409,
      'PO_NOT_EDITABLE',
    )
  }

  if (params.lines.length === 0) {
    throw new AppError('Add at least one item to the order', 400, 'PO_EMPTY')
  }
  for (const line of params.lines) {
    if (!(line.quantity > 0)) throw new AppError('Every line needs a quantity above zero', 400, 'PO_BAD_QTY')
    if (line.unitCost < 0) throw new AppError('A cost cannot be negative', 400, 'PO_BAD_COST')
  }
  await validateLines(params.restaurantId, params.lines)

  const money = totalsFor(params.lines, params.discount ?? 0, params.taxTotal ?? 0)

  return prisma.$transaction(async (tx) => {
    await tx.purchaseItem.deleteMany({ where: { purchaseId: po.id } })
    return tx.purchase.update({
      where: { id: po.id },
      data: {
        ...money,
        ...(params.supplierId !== undefined ? { supplierId: params.supplierId || null } : {}),
        ...(params.branchId ? { branchId: params.branchId } : {}),
        ...(params.locationId !== undefined ? { locationId: params.locationId || null } : {}),
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
    /*
     * Teach the ITEM its pack size from the supplier's, when it has none.
     *
     * `toBaseUnits` refuses rather than guesses, and `assertConvertible` calls
     * it when a purchase order is RAISED — so an item bought by the box with no
     * pack size on the item row blocks the order, with an error naming a field
     * the owner had to hunt for. The same question is answered right here, on
     * the supplier price list, and the answer was going nowhere near the item.
     *
     * One direction only, and never an overwrite: two suppliers can pack the
     * same thing differently, and the item's own columns are the restaurant's
     * convention for counting it. Copying the second supplier's case size over
     * the first would silently rewrite every conversion the item has ever done.
     */
    if (data.purchaseUnit && data.unitsPerPurchaseUnit && data.unitsPerPurchaseUnit > 0) {
      await tx.inventoryItem.updateMany({
        where: {
          id: params.itemId,
          restaurantId: params.restaurantId,
          OR: [{ purchaseUnit: null }, { unitsPerPurchaseUnit: null }, { unitsPerPurchaseUnit: 0 }],
        },
        data: {
          purchaseUnit: data.purchaseUnit,
          unitsPerPurchaseUnit: data.unitsPerPurchaseUnit,
        },
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
