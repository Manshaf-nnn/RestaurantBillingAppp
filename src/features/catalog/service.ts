import 'server-only'

import type { StockUnit } from '@prisma/client'

import { AppError, NotFoundError } from '@/lib/errors'
import { prisma } from '@/server/db/prisma'

/**
 * The two lists everything else picks from: units and stock categories.
 *
 * ── Units ───────────────────────────────────────────────────────────────────
 *
 * `StockUnit` remains a Prisma enum and remains the column type on items,
 * purchase lines, recipes and every ledger row. That is deliberate. The
 * conversion engine in `features/inventory/units.ts` encodes facts — a kilo is
 * a thousand grams, a dozen is twelve — and every balance in the system is
 * stored in an item's base unit on the strength of them. Making those editable
 * would put the correctness of the stock ledger inside a form field.
 *
 * What an owner actually wants is smaller and is what this provides: call it
 * what we call it, print the symbol we print, list them in the order we use
 * them, and stop showing us the six we never touch. The nine are seeded per
 * restaurant on first read, so the screen is never blank.
 *
 * ── Categories ──────────────────────────────────────────────────────────────
 *
 * `InventoryItem.category` was free text, so "Dairy" and "dairy" became two
 * silent buckets and no screen could offer the list back. Items now carry a
 * `categoryId`, and the string is kept in step with it — every existing reader
 * (the count sheet, the search filter, the reports) keeps working untouched,
 * and retiring a category can never orphan an item.
 */

/** The nine, with the labels this app has always used. */
const DEFAULT_UNITS: Array<{ code: StockUnit; name: string; symbol: string; sortOrder: number }> = [
  { code: 'KG', name: 'Kilogram', symbol: 'kg', sortOrder: 10 },
  { code: 'GRAM', name: 'Gram', symbol: 'g', sortOrder: 20 },
  { code: 'LITRE', name: 'Litre', symbol: 'L', sortOrder: 30 },
  { code: 'ML', name: 'Millilitre', symbol: 'ml', sortOrder: 40 },
  { code: 'PIECE', name: 'Piece', symbol: 'pc', sortOrder: 50 },
  { code: 'DOZEN', name: 'Dozen', symbol: 'dozen', sortOrder: 60 },
  { code: 'BOX', name: 'Box', symbol: 'box', sortOrder: 70 },
  { code: 'PACK', name: 'Packet', symbol: 'packet', sortOrder: 80 },
  { code: 'BOTTLE', name: 'Bottle', symbol: 'bottle', sortOrder: 90 },
]

export interface UnitView {
  id: string
  code: StockUnit
  name: string
  symbol: string
  isActive: boolean
  sortOrder: number
  /** How many stock items currently use it — deactivating one is not free. */
  itemCount: number
}

/**
 * Every unit for this restaurant, seeding the nine on first use.
 *
 * The seed is idempotent (`skipDuplicates`) and runs on read rather than at
 * sign-up, so restaurants created before this feature existed get their list
 * the first time anyone opens the screen instead of needing a data migration
 * to be re-run for every future tenant.
 */
export async function listUnits(restaurantId: string): Promise<UnitView[]> {
  const existing = await prisma.unit.count({ where: { restaurantId } })

  if (existing === 0) {
    await prisma.unit.createMany({
      data: DEFAULT_UNITS.map((unit) => ({ ...unit, restaurantId })),
      skipDuplicates: true,
    })
  }

  const [units, counts] = await Promise.all([
    prisma.unit.findMany({
      where: { restaurantId },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    }),
    prisma.inventoryItem.groupBy({
      by: ['unit'],
      where: { restaurantId, isActive: true },
      _count: true,
    }),
  ])

  const used = new Map(counts.map((row) => [row.unit, row._count]))

  return units.map((unit) => ({
    id: unit.id,
    code: unit.code,
    name: unit.name,
    symbol: unit.symbol,
    isActive: unit.isActive,
    sortOrder: unit.sortOrder,
    itemCount: used.get(unit.code) ?? 0,
  }))
}

/**
 * The units a dropdown should offer.
 *
 * Anything switched off is omitted — except a unit an item already holds, which
 * is always included for that item. Otherwise editing an old item silently
 * changes its unit to whatever happens to be first in the list, and a silent
 * unit change is a corrupted balance.
 */
export async function activeUnits(
  restaurantId: string,
  keep: Array<StockUnit | null | undefined> = [],
): Promise<UnitView[]> {
  const all = await listUnits(restaurantId)
  const required = new Set(keep.filter(Boolean) as StockUnit[])
  return all.filter((unit) => unit.isActive || required.has(unit.code))
}

export async function updateUnit(params: {
  restaurantId: string
  unitId: string
  name: string
  symbol: string
  sortOrder: number
}) {
  const unit = await prisma.unit.findFirst({
    where: { id: params.unitId, restaurantId: params.restaurantId },
    select: { id: true },
  })
  if (!unit) throw new NotFoundError('Unit')

  return prisma.unit.update({
    where: { id: unit.id },
    data: {
      name: params.name.trim(),
      symbol: params.symbol.trim(),
      sortOrder: params.sortOrder,
    },
  })
}

/**
 * Switch a unit on or off.
 *
 * Turning one off never touches stock: items keep their unit, movements keep
 * reading correctly, and the reconciliation still balances. It only stops the
 * unit being offered for new records.
 *
 * Refused while items are still measured in it, because the alternative is an
 * item whose own unit is missing from its own dropdown.
 */
export async function setUnitActive(params: {
  restaurantId: string
  unitId: string
  isActive: boolean
}) {
  const unit = await prisma.unit.findFirst({
    where: { id: params.unitId, restaurantId: params.restaurantId },
  })
  if (!unit) throw new NotFoundError('Unit')

  if (!params.isActive) {
    const inUse = await prisma.inventoryItem.count({
      where: { restaurantId: params.restaurantId, isActive: true, unit: unit.code },
    })
    if (inUse > 0) {
      throw new AppError(
        `${inUse} item${inUse === 1 ? ' is' : 's are'} measured in ${unit.name.toLowerCase()} — change ${inUse === 1 ? 'it' : 'them'} first`,
        409,
        'UNIT_IN_USE',
      )
    }
  }

  return prisma.unit.update({
    where: { id: unit.id },
    data: { isActive: params.isActive },
  })
}

// ── categories ───────────────────────────────────────────────────────────────

export interface CategoryView {
  id: string
  name: string
  description: string | null
  isActive: boolean
  sortOrder: number
  itemCount: number
}

export async function listStockCategories(
  restaurantId: string,
  options: { activeOnly?: boolean } = {},
): Promise<CategoryView[]> {
  const rows = await prisma.inventoryCategory.findMany({
    where: {
      restaurantId,
      ...(options.activeOnly ? { isActive: true } : {}),
    },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    include: { _count: { select: { items: { where: { isActive: true } } } } },
  })

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description,
    isActive: row.isActive,
    sortOrder: row.sortOrder,
    itemCount: row._count.items,
  }))
}

export async function saveStockCategory(params: {
  restaurantId: string
  id?: string
  name: string
  description: string | null
  sortOrder: number
}) {
  const name = params.name.trim()

  /*
   * One name per restaurant, case-insensitively. The database's unique index is
   * exact-case, so "Dairy" and "dairy" would both be accepted by it — which is
   * precisely the duplication free text allowed and this feature exists to end.
   */
  const clash = await prisma.inventoryCategory.findFirst({
    where: {
      restaurantId: params.restaurantId,
      name: { equals: name, mode: 'insensitive' },
      ...(params.id ? { NOT: { id: params.id } } : {}),
    },
    select: { id: true, name: true },
  })
  if (clash) {
    throw new AppError(`“${clash.name}” already exists`, 409, 'CATEGORY_DUPLICATE')
  }

  if (params.id) {
    const existing = await prisma.inventoryCategory.findFirst({
      where: { id: params.id, restaurantId: params.restaurantId },
      select: { id: true },
    })
    if (!existing) throw new NotFoundError('Category')

    /*
     * Renaming updates the string on every item that points here, in the same
     * transaction. Two columns hold this answer — the FK and the legacy string
     * every existing reader still uses — and letting them drift apart would
     * recreate exactly the mess this replaces.
     */
    return prisma.$transaction(async (tx) => {
      const updated = await tx.inventoryCategory.update({
        where: { id: params.id },
        data: { name, description: params.description, sortOrder: params.sortOrder },
      })
      await tx.inventoryItem.updateMany({
        where: { restaurantId: params.restaurantId, categoryId: updated.id },
        data: { category: name },
      })
      return updated
    })
  }

  return prisma.inventoryCategory.create({
    data: {
      restaurantId: params.restaurantId,
      name,
      description: params.description,
      sortOrder: params.sortOrder,
    },
  })
}

/**
 * Retire a category, or bring it back.
 *
 * Never deleted, and items are never detached. A retired category stops being
 * offered for new items and keeps explaining the ones that already have it —
 * the report that says "we spent this much on Cleaning last year" has to keep
 * working after Cleaning is retired.
 */
export async function setStockCategoryActive(params: {
  restaurantId: string
  id: string
  isActive: boolean
}) {
  const category = await prisma.inventoryCategory.findFirst({
    where: { id: params.id, restaurantId: params.restaurantId },
    select: { id: true },
  })
  if (!category) throw new NotFoundError('Category')

  return prisma.inventoryCategory.update({
    where: { id: category.id },
    data: { isActive: params.isActive },
  })
}

/**
 * Resolve whatever an item form sent into the pair of columns to write.
 *
 * The form may send an id (picked from the list) or a bare name (typed, or
 * arriving from an import). Either way both columns end up agreeing, and a
 * typed name that does not exist yet becomes a real category rather than
 * another loose string.
 */
export async function resolveCategory(params: {
  restaurantId: string
  categoryId?: string | null
  categoryName?: string | null
}): Promise<{ categoryId: string | null; category: string | null }> {
  if (params.categoryId) {
    const found = await prisma.inventoryCategory.findFirst({
      where: { id: params.categoryId, restaurantId: params.restaurantId },
      select: { id: true, name: true },
    })
    if (found) return { categoryId: found.id, category: found.name }
  }

  const name = params.categoryName?.trim()
  if (!name) return { categoryId: null, category: null }

  const existing = await prisma.inventoryCategory.findFirst({
    where: { restaurantId: params.restaurantId, name: { equals: name, mode: 'insensitive' } },
    select: { id: true, name: true },
  })
  if (existing) return { categoryId: existing.id, category: existing.name }

  const created = await prisma.inventoryCategory.create({
    data: { restaurantId: params.restaurantId, name },
    select: { id: true, name: true },
  })
  return { categoryId: created.id, category: created.name }
}
