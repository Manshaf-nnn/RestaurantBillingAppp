import type { Metadata } from 'next'

import { MenuManager } from '@/features/menu/components/menu-manager'
import { getManagedMenu } from '@/features/menu/queries'
import { can, PERMISSIONS } from '@/lib/rbac'
import { requirePagePermission } from '@/server/auth/guard'
import { prisma } from '@/server/db/prisma'
import { requireRestaurant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Menu' }

export default async function MenuPage() {
  const user = await requirePagePermission(PERMISSIONS.MENU_VIEW, '/dashboard/menu')
  const [restaurant, menu, inventory] = await Promise.all([
    requireRestaurant(user.restaurantId),
    getManagedMenu(user.restaurantId),
    prisma.inventoryItem.findMany({
      where: { restaurantId: user.restaurantId, isActive: true },
      select: { id: true, name: true, unit: true },
      orderBy: { name: 'asc' },
    }),
  ])

  return (
    <MenuManager
      currency={restaurant.currency}
      locale={restaurant.locale === 'en' ? 'en-IN' : restaurant.locale}
      canManage={can(user, PERMISSIONS.MENU_MANAGE)}
      categories={menu.categories.map((category) => ({ id: category.id, name: category.name }))}
      inventoryItems={inventory}
      foods={menu.foods.map((food) => ({
        id: food.id,
        name: food.name,
        imageUrl: food.imageUrl,
        price: food.price,
        discountPrice: food.discountPrice,
        isVeg: food.isVeg,
        spiceLevel: food.spiceLevel,
        isAvailable: food.isAvailable,
        isPopular: food.isPopular,
        isRecommended: food.isRecommended,
        prepTimeMinutes: food.prepTimeMinutes,
        soldCount: food.soldCount,
        categoryId: food.categoryId,
        categoryName: food.category.name,
        variantCount: food.variantGroups.length,
      }))}
    />
  )
}
