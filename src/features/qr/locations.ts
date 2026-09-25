import 'server-only'

import { ConflictError, NotFoundError } from '@/lib/errors'
import { isUniqueViolation, prisma } from '@/server/db/prisma'

/**
 * The places a delivery goes, written by the owner.
 *
 * ── Why a list and not an address box ───────────────────────────────────────
 *
 * This system has no map and no geocoder, and a campus delivery does not need
 * one: there are perhaps twenty places food goes and everybody already calls
 * them the same thing. A free-text address field collects twenty spellings of
 * "boys hostel", none of which a rider can sort a bag by. A list the owner
 * wrote is exact, sorts itself, prints the same words every time, and can be
 * reordered when the round changes.
 *
 * ── Scoped by customer category ─────────────────────────────────────────────
 *
 * `categoryId` null means everyone sees it; set, and only guests who chose
 * that customer category do. That is what lets "Boys Hostel" and "Girls
 * Hostel" be offered to Campus Student and not to the public, out of one list
 * the owner maintains once.
 *
 * It is a filter over what is SHOWN, never a permission. A guest who somehow
 * submits a location outside their category still gets a valid order — the id
 * is validated against the restaurant and the branch, not against the
 * category — because refusing an order at the last tap over a display rule
 * would lose a sale to protect nothing.
 */

export interface LocationRow {
  id: string
  name: string
  groupName: string | null
  note: string | null
  categoryId: string | null
  categoryName: string | null
  branchId: string | null
  sortOrder: number
  isActive: boolean
}

/** Every location the owner has, for the management screen. */
export async function listLocations(params: {
  restaurantId: string
  branchIds?: string[] | null
}): Promise<LocationRow[]> {
  const rows = await prisma.deliveryLocation.findMany({
    where: {
      restaurantId: params.restaurantId,
      /*
       * A null `branchId` means "every branch", so it must survive a branch
       * filter. Narrowing on `branchId: { in: [...] }` alone would hide
       * exactly the locations that apply everywhere.
       */
      ...(params.branchIds
        ? { OR: [{ branchId: { in: params.branchIds } }, { branchId: null }] }
        : {}),
    },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    include: { category: { select: { name: true } } },
  })

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    groupName: row.groupName,
    note: row.note,
    categoryId: row.categoryId,
    categoryName: row.category?.name ?? null,
    branchId: row.branchId,
    sortOrder: row.sortOrder,
    isActive: row.isActive,
  }))
}

export interface GuestLocation {
  id: string
  name: string
  groupName: string | null
}

/**
 * What THIS guest may pick, at this branch, having chosen this category.
 *
 * Active only, and category-filtered: a location tied to a category is shown
 * to that category and to nobody else, while an untagged one is shown to
 * everyone. A guest who chose no category sees only the untagged ones, which
 * is the honest reading of "this location is for students".
 */
export async function locationsForGuest(params: {
  restaurantId: string
  branchId: string
  categoryId: string | null
}): Promise<GuestLocation[]> {
  const rows = await prisma.deliveryLocation.findMany({
    where: {
      restaurantId: params.restaurantId,
      isActive: true,
      OR: [{ branchId: params.branchId }, { branchId: null }],
      ...(params.categoryId
        ? { AND: [{ OR: [{ categoryId: params.categoryId }, { categoryId: null }] }] }
        : { categoryId: null }),
    },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    select: { id: true, name: true, groupName: true },
  })
  return rows
}

/**
 * Validate a guest's chosen location and return what to write on the order.
 *
 * Returns the id AND the name, because the order stores both: the id answers
 * "how many went to the Girls Hostel", and the name answers it still once the
 * location has been renamed or retired. The rider's `note` is folded into the
 * stored name so the ticket carries it without a second lookup.
 */
export async function resolveLocationForOrder(params: {
  restaurantId: string
  branchId: string | null
  locationId: string | null | undefined
}): Promise<{ id: string; name: string } | null> {
  if (!params.locationId) return null

  const found = await prisma.deliveryLocation.findFirst({
    where: {
      id: params.locationId,
      restaurantId: params.restaurantId,
      isActive: true,
      ...(params.branchId ? { OR: [{ branchId: params.branchId }, { branchId: null }] } : {}),
    },
    select: { id: true, name: true, note: true },
  })
  if (!found) throw new NotFoundError('Delivery location')

  return {
    id: found.id,
    name: found.note ? `${found.name} — ${found.note}` : found.name,
  }
}

export interface SaveLocationInput {
  id?: string | null
  name: string
  groupName?: string | null
  note?: string | null
  categoryId?: string | null
  branchId?: string | null
  sortOrder?: number
  isActive?: boolean
}

/** Create or rename one location. */
export async function saveLocation(params: {
  restaurantId: string
  input: SaveLocationInput
}): Promise<{ id: string }> {
  const { input } = params
  const data = {
    name: input.name.trim(),
    groupName: input.groupName?.trim() || null,
    note: input.note?.trim() || null,
    categoryId: input.categoryId || null,
    branchId: input.branchId || null,
    sortOrder: input.sortOrder ?? 0,
    isActive: input.isActive ?? true,
  }

  try {
    if (input.id) {
      // `updateMany` with the tenant in the predicate: a bare `update` by id
      // would edit another restaurant's row given its id.
      const touched = await prisma.deliveryLocation.updateMany({
        where: { id: input.id, restaurantId: params.restaurantId },
        data,
      })
      if (touched.count === 0) throw new NotFoundError('Delivery location')
      return { id: input.id }
    }

    const created = await prisma.deliveryLocation.create({
      data: { restaurantId: params.restaurantId, ...data },
      select: { id: true },
    })
    return created
  } catch (error) {
    // Two "Villa 1"s in one picker is a mis-delivery, so the database refuses
    // it — this only turns that into words the owner can act on.
    if (isUniqueViolation(error)) {
      throw new ConflictError(`There is already a location called ${data.name} here`)
    }
    throw error
  }
}

/**
 * Retire a location, never delete it.
 *
 * Past orders point at it by id. Deleting the row would SetNull those and lose
 * "where did this go" for every delivery already made — the stored name would
 * survive, but the grouping would not.
 */
export async function setLocationActive(params: {
  restaurantId: string
  id: string
  isActive: boolean
}): Promise<void> {
  const touched = await prisma.deliveryLocation.updateMany({
    where: { id: params.id, restaurantId: params.restaurantId },
    data: { isActive: params.isActive },
  })
  if (touched.count === 0) throw new NotFoundError('Delivery location')
}
