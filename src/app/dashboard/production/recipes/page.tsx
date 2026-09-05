import Link from 'next/link'
import type { Metadata } from 'next'
import { ArrowLeft } from 'lucide-react'

import { PageHeader } from '@/features/dashboard/components/page-header'
import { getProductionConsoleData } from '@/features/production/queries'
import { RecipeManager } from '@/features/production/components/recipe-manager'
import { PERMISSIONS } from '@/lib/rbac'
import { selectedBranch } from '@/features/dashboard/selected-branch'
import { requirePagePermission } from '@/server/auth/guard'
import { requireRestaurant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Make-ahead recipes' }

/**
 * Make-ahead recipes, on their own screen.
 *
 * Split out of the kitchen-jobs console, which had grown to hold two unrelated
 * jobs: making something today, and describing how something is made. Those are
 * done by different people at different times, and whoever came for one had to
 * scroll past the other.
 *
 * Guarded by `PRODUCTION_MANAGE` rather than `PRODUCTION_VIEW`: writing a recipe
 * decides what every future job will consume, which is a management act. The
 * job board keeps the wider `PRODUCTION_VIEW` so a cook can see today's work.
 */
export default async function MakeAheadRecipesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const user = await requirePagePermission(
    PERMISSIONS.PRODUCTION_MANAGE,
    '/dashboard/production/recipes',
  )
  const restaurant = await requireRestaurant(user.restaurantId)
  const selection = await selectedBranch(user, await searchParams)

  const data = await getProductionConsoleData({
    restaurantId: user.restaurantId,
    currency: restaurant.currency,
    branchId: selection.branchId,
  })

  return (
    <>
      <PageHeader
        title="Make-ahead recipes"
        description="What the kitchen makes in advance. Writing one changes no stock — only completing a job does."
        actions={
          <Link
            href="/dashboard/production"
            className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4" />
            Kitchen jobs
          </Link>
        }
      />
      <RecipeManager recipes={data.recipes} items={data.items} />
    </>
  )
}
