import 'server-only'

import type { KitchenStation } from '@prisma/client'

import { AppError, NotFoundError } from '@/lib/errors'
import { prisma, type TxClient } from '@/server/db/prisma'

/**
 * Kitchen sections — the parts of a kitchen a dish can be cooked at.
 *
 * ── Branch-scoped, and that is the whole design ─────────────────────────────
 *
 * A section belongs to one location. Two sites rarely have the same layout —
 * one has a pizza oven, another sends pizza through the main kitchen — and an
 * order taken at one must never appear on the other's screen. Scoping lives in
 * the database (`KitchenStation.branchId`) and in every query, not in a filter
 * the browser applies after the fact.
 *
 * ── Nothing here is hardcoded ───────────────────────────────────────────────
 *
 * Names are the owner's own. "Rice & Curry", "Kottu", "Juice Bar" — whatever
 * the kitchen actually calls them.
 */

/** Sections at one branch, newest config first for the setup screen. */
export async function listStations(params: {
  restaurantId: string
  branchId: string
  includeRetired?: boolean
}) {
  return prisma.kitchenStation.findMany({
    where: {
      restaurantId: params.restaurantId,
      branchId: params.branchId,
      ...(params.includeRetired ? {} : { isActive: true }),
    },
    include: {
      staff: { include: { user: { select: { id: true, name: true, staffCode: true } } } },
      _count: { select: { menu: true } },
    },
    orderBy: [{ isActive: 'desc' }, { sortOrder: 'asc' }, { name: 'asc' }],
  })
}

/**
 * The sections one person may work.
 *
 * Empty means **every** section at the branch, not none. A cook is confined by
 * `User.branchId`; the staff table is a further narrowing that most kitchens
 * will never use, and defaulting a cook with no rows to "sees nothing" would
 * mean every newly hired chef stares at an empty screen until somebody
 * remembers to tick a box.
 *
 * That is the opposite default from `visibleBranchIds`, deliberately: a branch
 * is a tenancy boundary and must fail closed, while a section is a convenience
 * within a boundary already enforced.
 */
export async function stationsFor(params: {
  restaurantId: string
  branchId: string
  userId: string
}): Promise<string[] | null> {
  const mine = await prisma.kitchenStationStaff.findMany({
    where: {
      userId: params.userId,
      station: {
        restaurantId: params.restaurantId,
        branchId: params.branchId,
        isActive: true,
      },
    },
    select: { stationId: true },
  })
  return mine.length === 0 ? null : mine.map((row) => row.stationId)
}

/** One section, confirmed to belong to this tenant and branch. */
export async function requireStation(params: {
  restaurantId: string
  stationId: string
  branchId?: string
}): Promise<KitchenStation> {
  const station = await prisma.kitchenStation.findFirst({
    where: {
      id: params.stationId,
      restaurantId: params.restaurantId,
      ...(params.branchId ? { branchId: params.branchId } : {}),
    },
  })
  if (!station) throw new NotFoundError('Kitchen section')
  return station
}

export async function saveStation(params: {
  restaurantId: string
  stationId?: string
  branchId: string
  name: string
  description?: string | null
  printerName?: string | null
  sortOrder?: number
  staffIds: string[]
}): Promise<KitchenStation> {
  const branch = await prisma.branch.findFirst({
    where: { id: params.branchId, restaurantId: params.restaurantId, deletedAt: null },
    select: { id: true, type: true, name: true },
  })
  if (!branch) throw new NotFoundError('Location')

  /*
   * Only somewhere that serves guests has a kitchen. A warehouse or a
   * production house has its own flows and would clutter the picker.
   */
  if (branch.type !== 'BRANCH') {
    throw new AppError(`${branch.name} is not a place that serves guests`, 400, 'STATION_BAD_BRANCH')
  }

  // Every cook must already belong to this restaurant — an id typed into a
  // payload cannot attach a stranger to a section.
  if (params.staffIds.length > 0) {
    const found = await prisma.user.count({
      where: { id: { in: params.staffIds }, restaurantId: params.restaurantId },
    })
    if (found !== params.staffIds.length) throw new NotFoundError('Staff member')
  }

  const data = {
    name: params.name.trim(),
    description: params.description?.trim() || null,
    printerName: params.printerName?.trim() || null,
    ...(params.sortOrder === undefined ? {} : { sortOrder: params.sortOrder }),
  }

  return prisma.$transaction(async (tx) => {
    const station = params.stationId
      ? await (async () => {
          await requireStation({
            restaurantId: params.restaurantId,
            stationId: params.stationId!,
          })
          return tx.kitchenStation.update({ where: { id: params.stationId! }, data })
        })()
      : await tx.kitchenStation.create({
          data: { ...data, restaurantId: params.restaurantId, branchId: params.branchId },
        })

    /*
     * Staff are replaced wholesale rather than diffed. Nothing references a
     * membership row by id, so a diff would buy nothing and cost a class of bug
     * where a stale row survives the edit.
     */
    await tx.kitchenStationStaff.deleteMany({ where: { stationId: station.id } })
    if (params.staffIds.length > 0) {
      await tx.kitchenStationStaff.createMany({
        data: params.staffIds.map((userId) => ({ stationId: station.id, userId })),
        skipDuplicates: true,
      })
    }

    return station
  })
}

/**
 * Retire a section, or bring it back.
 *
 * Retiring is refused while items are still queued at it, because those items
 * would become invisible: the station KDS shows active sections only, and
 * nothing else would pick them up. §17 asks for a controlled exception rather
 * than silent rerouting, so the refusal names the count and the supervisor
 * moves them deliberately.
 */
export async function setStationActive(params: {
  restaurantId: string
  stationId: string
  isActive: boolean
}): Promise<KitchenStation> {
  await requireStation(params)

  if (!params.isActive) {
    const pending = await prisma.orderItem.count({
      where: {
        stationId: params.stationId,
        status: { in: ['QUEUED', 'PREPARING'] },
        order: { status: { notIn: ['COMPLETED', 'CANCELLED'] } },
      },
    })
    if (pending > 0) {
      throw new AppError(
        `${pending} item${pending === 1 ? ' is' : 's are'} still cooking at this section — finish or move ${pending === 1 ? 'it' : 'them'} first`,
        409,
        'STATION_IN_USE',
      )
    }
  }

  return prisma.kitchenStation.update({
    where: { id: params.stationId },
    data: { isActive: params.isActive },
  })
}

/**
 * Delete a section outright.
 *
 * Allowed only when nothing has ever been cooked at it. Once an item points at
 * it, retiring is the honest operation: the item keeps `stationName` either way,
 * but deleting would strip a live ticket of its destination mid-service.
 */
export async function deleteStation(params: {
  restaurantId: string
  stationId: string
}): Promise<void> {
  await requireStation(params)

  const used = await prisma.orderItem.count({ where: { stationId: params.stationId } })
  if (used > 0) {
    throw new AppError(
      'This section has cooked orders before, so it can only be retired — that keeps the old tickets readable',
      409,
      'STATION_HAS_HISTORY',
    )
  }

  await prisma.kitchenStation.delete({ where: { id: params.stationId } })
}

/**
 * Point this branch's dishes at one section.
 *
 * The switch-on shortcut. The moment a restaurant creates its first section,
 * every dish becomes unmapped and the kitchen cannot accept anything — so the
 * setup screen offers to send the whole menu to that section in one go, and the
 * owner splits it out afterwards. Without this the feature is unusable on the
 * day it is turned on.
 *
 * `onlyUnassigned` is the default so running it twice cannot undo hand-made
 * routing.
 */
export async function assignAllDishesToStation(params: {
  restaurantId: string
  stationId: string
  onlyUnassigned?: boolean
}): Promise<number> {
  const station = await requireStation(params)

  const result = await prisma.foodBranch.updateMany({
    where: {
      restaurantId: params.restaurantId,
      branchId: station.branchId,
      noKitchenRequired: false,
      ...(params.onlyUnassigned === false ? {} : { stationId: null }),
    },
    data: { stationId: station.id },
  })
  return result.count
}

/**
 * Dishes this branch sells that no section is responsible for.
 *
 * Read by the setup screen's banner and by the kitchen queue, so an unmapped
 * dish is discovered while somebody is looking at a menu rather than by a button
 * failing at eight o'clock on a Friday.
 */
export async function unmappedDishes(
  db: TxClient | typeof prisma,
  params: { restaurantId: string; branchId: string },
): Promise<Array<{ foodId: string; name: string }>> {
  const rows = await db.foodBranch.findMany({
    where: {
      restaurantId: params.restaurantId,
      branchId: params.branchId,
      isAvailable: true,
      noKitchenRequired: false,
      OR: [{ stationId: null }, { station: { isActive: false } }],
      food: { deletedAt: null },
    },
    select: { foodId: true, food: { select: { name: true } } },
    orderBy: { food: { name: 'asc' } },
  })
  return rows.map((row) => ({ foodId: row.foodId, name: row.food.name }))
}

/** Whether this branch routes to sections at all. */
export async function stationsConfigured(
  db: TxClient | typeof prisma,
  params: { restaurantId: string; branchId: string },
): Promise<boolean> {
  const count = await db.kitchenStation.count({
    where: { restaurantId: params.restaurantId, branchId: params.branchId, isActive: true },
  })
  return count > 0
}
