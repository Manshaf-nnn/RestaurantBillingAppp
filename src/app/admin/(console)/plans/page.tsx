import type { Metadata } from 'next'

import { PlansManager } from '@/features/platform/components/plans-manager'
import { FEATURES, FEATURE_GROUPS } from '@/features/access/features'
import { listPackages } from '@/features/platform/feature-service'
import { requirePageSuperAdmin } from '@/server/auth/guard'
import { prisma } from '@/server/db/prisma'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Feature plans' }

/**
 * What each restaurant has bought.
 *
 * The checkbox list is `FEATURES` — the registry that already drives the
 * sidebar, the role builder and the page guards. Keeping one catalogue means a
 * feature added to the app appears here automatically and cannot be sold
 * without existing.
 */
export default async function PlansPage() {
  await requirePageSuperAdmin('/admin/plans')

  const [packages, restaurants] = await Promise.all([
    listPackages(),
    prisma.restaurant.findMany({
      where: { status: { in: ['ACTIVE', 'SUSPENDED'] } },
      select: {
        id: true,
        name: true,
        slug: true,
        status: true,
        enabledFeatures: true,
        featurePackageId: true,
      },
      orderBy: { name: 'asc' },
      take: 200,
    }),
  ])

  return (
    <PlansManager
      groups={[...FEATURE_GROUPS]}
      features={FEATURES.map((feature) => ({
        key: feature.key,
        label: feature.label,
        group: feature.group,
        description: feature.description,
      }))}
      packages={packages.map((pkg) => ({
        id: pkg.id,
        name: pkg.name,
        description: pkg.description,
        featureKeys: pkg.featureKeys,
        restaurantCount: pkg._count.restaurants,
      }))}
      restaurants={restaurants.map((restaurant) => ({
        id: restaurant.id,
        name: restaurant.name,
        slug: restaurant.slug,
        status: restaurant.status as string,
        enabledFeatures: restaurant.enabledFeatures,
        packageId: restaurant.featurePackageId,
      }))}
    />
  )
}
