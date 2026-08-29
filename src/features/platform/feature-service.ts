import 'server-only'

import { AppError, NotFoundError } from '@/lib/errors'
import { FEATURES } from '@/features/access/features'
import { prisma } from '@/server/db/prisma'

/**
 * What each restaurant has bought.
 *
 * ── The catalogue already exists ────────────────────────────────────────────
 *
 * `FEATURES` in `src/features/access/features.ts` is the list — 45 entries,
 * each already carrying the permissions it implies and the routes it owns. It
 * drives the sidebar, the role builder and a build-breaking guard. The platform
 * operator's checkboxes are that list; there is deliberately no second one to
 * drift from it.
 *
 * ── Empty means everything ──────────────────────────────────────────────────
 *
 * A restaurant with no list is unrestricted. "We have not scoped this tenant"
 * is the ordinary case and must not require writing 45 keys for every customer
 * that already exists — so there is no backfill anywhere in this feature.
 *
 * ── Nothing is ever deleted ─────────────────────────────────────────────────
 *
 * Switching a feature off is a read-side gate and touches no rows. Everything
 * comes back on the moment it is switched on again, which is what makes
 * downgrading safe to offer.
 */

const KNOWN = new Set(FEATURES.map((feature) => feature.key))

/** Reject anything that is not a real feature, so a typo cannot lock a tenant. */
function checkKeys(keys: string[]): string[] {
  const unknown = keys.filter((key) => !KNOWN.has(key))
  if (unknown.length > 0) {
    throw new AppError(`Unknown feature: ${unknown.join(', ')}`, 400, 'UNKNOWN_FEATURE')
  }
  return [...new Set(keys)]
}

export async function listPackages() {
  return prisma.featurePackage.findMany({
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    include: { _count: { select: { restaurants: true } } },
  })
}

export async function savePackage(params: {
  packageId?: string
  name: string
  description?: string | null
  featureKeys: string[]
  sortOrder?: number
}) {
  const featureKeys = checkKeys(params.featureKeys)
  const data = {
    name: params.name.trim(),
    description: params.description?.trim() || null,
    featureKeys,
    ...(params.sortOrder === undefined ? {} : { sortOrder: params.sortOrder }),
  }

  if (params.packageId) {
    const existing = await prisma.featurePackage.findUnique({ where: { id: params.packageId } })
    if (!existing) throw new NotFoundError('Package')
    return prisma.featurePackage.update({ where: { id: params.packageId }, data })
  }
  return prisma.featurePackage.create({ data })
}

/**
 * Remove a package.
 *
 * Restaurants on it keep every feature they have: the list was copied onto them
 * when it was applied, so deleting the package they came from cannot take
 * anything away. `featurePackageId` is `SetNull`, so they simply stop naming a
 * package.
 */
export async function deletePackage(packageId: string) {
  const existing = await prisma.featurePackage.findUnique({ where: { id: packageId } })
  if (!existing) throw new NotFoundError('Package')
  await prisma.featurePackage.delete({ where: { id: packageId } })
}

/**
 * Set what one restaurant may use.
 *
 * The package's keys are COPIED rather than referenced. Editing a package later
 * must not silently re-scope every tenant already on it — an operator changing
 * what "Standard" means should be making a decision about future sales, not
 * quietly taking Inventory away from forty restaurants mid-service.
 */
export async function setRestaurantFeatures(params: {
  restaurantId: string
  featureKeys: string[]
  packageId?: string | null
}) {
  const restaurant = await prisma.restaurant.findUnique({
    where: { id: params.restaurantId },
    select: { id: true },
  })
  if (!restaurant) throw new NotFoundError('Restaurant')

  return prisma.restaurant.update({
    where: { id: params.restaurantId },
    data: {
      enabledFeatures: checkKeys(params.featureKeys),
      featurePackageId: params.packageId ?? null,
    },
  })
}

/** Apply a package to a restaurant, copying its keys across. */
export async function applyPackage(params: { restaurantId: string; packageId: string }) {
  const pkg = await prisma.featurePackage.findUnique({ where: { id: params.packageId } })
  if (!pkg) throw new NotFoundError('Package')
  return setRestaurantFeatures({
    restaurantId: params.restaurantId,
    featureKeys: pkg.featureKeys,
    packageId: pkg.id,
  })
}
