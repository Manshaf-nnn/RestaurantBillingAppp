import type { Metadata } from 'next'

import { ImportHub } from '@/features/menu/import/components/import-hub'
import { PERMISSIONS } from '@/lib/rbac'
import { requirePagePermission } from '@/server/auth/guard'
import { prisma } from '@/server/db/prisma'
import { requireRestaurant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Add your menu' }

export default async function MenuImportPage() {
  const user = await requirePagePermission(PERMISSIONS.MENU_MANAGE, '/dashboard/menu/import')
  const restaurant = await requireRestaurant(user.restaurantId)

  // Targets for the bulk-photo matcher — every item that could take a photo.
  const foods = await prisma.food.findMany({
    where: { restaurantId: user.restaurantId, deletedAt: null },
    select: { id: true, name: true, imageUrl: true, category: { select: { name: true } } },
    orderBy: [{ category: { sortOrder: 'asc' } }, { name: 'asc' }],
  })

  return (
    <ImportHub
      // Resolved on the server so the key is never exposed to the browser.
      scanConfigured={Boolean(process.env.ANTHROPIC_API_KEY)}
      currency={restaurant.currency}
      ownerName={user.name}
      photoTargets={foods.map((food) => ({
        id: food.id,
        name: food.name,
        categoryName: food.category?.name ?? 'Uncategorised',
        imageUrl: food.imageUrl,
      }))}
    />
  )
}
