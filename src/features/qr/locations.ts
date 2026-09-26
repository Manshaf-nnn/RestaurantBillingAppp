import 'server-only'

import { AppError, ConflictError, NotFoundError } from '@/lib/errors'
import { isUniqueViolation, prisma } from '@/server/db/prisma'

/**
 * The places a delivery goes, written by the owner — two levels deep.
 *
 * ── A place under a place ───────────────────────────────────────────────────
 *
 * The owner thinks of a MAIN place ("University") and the places inside it
 * ("Boys Hostel", "Girls Hostel", "Villa 2"). A row with no parent is a main
 * place; a row with one is what the guest actually picks. Two levels only: a
 * campus has buildings, and nobody delivers to a corridor.
 *
 * A main place with nothing under it is offered on its own — "Main Gate" is a
 * real destination and should not need a made-up sub-place before a guest can
 * choose it.
 *
 * ── Why a list and not an address box ───────────────────────────────────────
 *
 * This system has no map and no geocoder, and a campus delivery does not need
 * one: there are perhaps twenty places food goes and everybody already calls
 * them the same thing. A free-text address field collects twenty spellings of
 * "boys hostel", none of which a rider can sort a bag by.
 *
 * ── Not scoped by customer category ────────────────────────────────────────
 *
 * The first version filtered places by the customer category a guest chose,
 * and that is precisely why an owner who had turned the feature on saw no
 * picker at all: a guest who chose no category saw only untagged places, and
 * the owner had tagged every one. A place is a place. The `categoryId` column
 * stays because a column cannot be dropped; nothing reads it now.
 */

export interface LocationRow {
  id: string
  name: string
  note: string | null
  parentId: string | null
  branchId: string | null
  sortOrder: number
  isActive: boolean
}

/** Every place the owner has, flat, for the manager to nest. */
export async function listLocations(params: {
  restaurantId: string
  branchIds?: string[] | null
}): Promise<LocationRow[]> {
  const rows = await prisma.deliveryLocation.findMany({
    where: {
      restaurantId: params.restaurantId,
      // A null branch means "every branch" and must survive a branch filter.
      ...(params.branchIds
        ? { OR: [{ branchId: { in: params.branchIds } }, { branchId: null }] }
        : {}),
    },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    select: {
      id: true, name: true, note: true, parentId: true, branchId: true,
      sortOrder: true, isActive: true,
    },
  })
  return rows
}

export interface GuestLocation {
  id: string
  name: string
  /** The main place this sits under — the heading in the picker. Null for a
   *  standalone place with nothing under it. */
  groupName: string | null
}

/**
 * What a guest at this branch may pick.
 *
 * Sub-places, headed by their main place, plus any main place that has no
 * sub-places of its own. Active only, and a sub-place under a retired main
 * place is hidden with it — retiring "University" should take its hostels
 * off the list in one move.
 */
export async function locationsForGuest(params: {
  restaurantId: string
  branchId: string
}): Promise<GuestLocation[]> {
  const rows = await prisma.deliveryLocation.findMany({
    where: {
      restaurantId: params.restaurantId,
      isActive: true,
      OR: [{ branchId: params.branchId }, { branchId: null }],
    },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    select: { id: true, name: true, parentId: true },
  })

  const byId = new Map(rows.map((row) => [row.id, row]))
  const hasChildren = new Set(rows.map((row) => row.parentId).filter((id): id is string => Boolean(id)))

  const out: GuestLocation[] = []
  /*
   * Main places first, in the owner's order; each one's sub-places directly
   * after it. So the picker reads University → its hostels → Town → its
   * streets, which is the order the owner built it in.
   */
  for (const main of rows.filter((row) => row.parentId === null)) {
    if (!hasChildren.has(main.id)) {
      out.push({ id: main.id, name: main.name, groupName: null })
      continue
    }
    for (const sub of rows.filter((row) => row.parentId === main.id)) {
      out.push({ id: sub.id, name: sub.name, groupName: main.name })
    }
  }
  // A sub-place whose main place is retired or belongs to another branch has
  // no heading to sit under; `byId` guards the join, and it is left out.
  return out.filter((place) => place.groupName === null || byId.has(place.id))
}

/**
 * Validate a guest's chosen place and return what to write on the order.
 *
 * Returns the id AND the full name — "University — Boys Hostel" — because the
 * order stores both: the id answers "how many went to the Girls Hostel", the
 * name answers it still once the place has been renamed or retired. The rider's
 * `note` is folded in so the ticket carries it without a second lookup.
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
    select: {
      id: true, name: true, note: true,
      parent: { select: { name: true, isActive: true } },
    },
  })
  if (!found) throw new NotFoundError('Delivery location')
  if (found.parent && !found.parent.isActive) throw new NotFoundError('Delivery location')

  const full = found.parent ? `${found.parent.name} — ${found.name}` : found.name
  return { id: found.id, name: found.note ? `${full} (${found.note})` : full }
}

export interface SaveLocationInput {
  id?: string | null
  name: string
  note?: string | null
  /** The main place this goes under. Null makes it a main place itself. */
  parentId?: string | null
  branchId?: string | null
  sortOrder?: number
  isActive?: boolean
}

/** Create or rename one place, main or sub. */
export async function saveLocation(params: {
  restaurantId: string
  input: SaveLocationInput
}): Promise<{ id: string }> {
  const { input } = params
  const name = input.name.trim()
  if (!name) throw new AppError('Give the place a name', 400, 'LOCATION_NAME')

  let parentId: string | null = null
  if (input.parentId) {
    const parent = await prisma.deliveryLocation.findFirst({
      where: { id: input.parentId, restaurantId: params.restaurantId },
      select: { id: true, parentId: true },
    })
    if (!parent) throw new NotFoundError('Main place')
    // Two levels only — see the note at the top of this file.
    if (parent.parentId) {
      throw new AppError('A place can only go under a main place, not under another sub-place', 400, 'LOCATION_DEPTH')
    }
    if (input.id && input.id === parent.id) {
      throw new AppError('A place cannot go under itself', 400, 'LOCATION_SELF')
    }
    parentId = parent.id
  }

  const data = {
    name,
    note: input.note?.trim() || null,
    parentId,
    branchId: input.branchId || null,
    sortOrder: input.sortOrder ?? 0,
    isActive: input.isActive ?? true,
  }

  try {
    if (input.id) {
      const touched = await prisma.deliveryLocation.updateMany({
        where: { id: input.id, restaurantId: params.restaurantId },
        data,
      })
      if (touched.count === 0) throw new NotFoundError('Delivery location')
      return { id: input.id }
    }
    return await prisma.deliveryLocation.create({
      data: { restaurantId: params.restaurantId, ...data },
      select: { id: true },
    })
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictError(`There is already a place called ${name} here`)
    }
    throw error
  }
}

/**
 * Retire a place, never delete it. Retiring a main place retires everything
 * under it in the same breath — the sub-places have no meaning on their own.
 */
export async function setLocationActive(params: {
  restaurantId: string
  id: string
  isActive: boolean
}): Promise<void> {
  const touched = await prisma.deliveryLocation.updateMany({
    where: {
      restaurantId: params.restaurantId,
      OR: [{ id: params.id }, { parentId: params.id }],
    },
    data: { isActive: params.isActive },
  })
  if (touched.count === 0) throw new NotFoundError('Delivery location')
}
