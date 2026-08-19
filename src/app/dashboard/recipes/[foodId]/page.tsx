import type { Metadata } from 'next'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'

import { PageHeader } from '@/features/dashboard/components/page-header'
import { RecipeEditor } from '@/features/recipes/components/recipe-editor'
import { getRecipeEditorData } from '@/features/recipes/queries'
import { PERMISSIONS } from '@/lib/rbac'
import { requirePagePermission } from '@/server/auth/guard'
import { requireRestaurant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Recipe' }

export default async function RecipePage({
  params,
}: {
  params: Promise<{ foodId: string }>
}) {
  const { foodId } = await params
  const user = await requirePagePermission(PERMISSIONS.MENU_MANAGE, `/dashboard/recipes/${foodId}`)
  const restaurant = await requireRestaurant(user.restaurantId)
  const data = await getRecipeEditorData({
    restaurantId: user.restaurantId,
    foodId,
    currency: restaurant.currency,
  })

  return (
    <>
      <Link
        href="/dashboard/recipes"
        className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        Recipes
      </Link>
      <PageHeader
        title={data.food.name}
        description="What one portion uses, and what that leaves you."
      />
      <RecipeEditor data={data} />
    </>
  )
}
