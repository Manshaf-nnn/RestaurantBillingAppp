import type { Metadata } from 'next'

import { CategoryManager } from '@/features/menu/components/category-manager'
import { can, PERMISSIONS } from '@/lib/rbac'
import { requirePagePermission } from '@/server/auth/guard'
import { prisma } from '@/server/db/prisma'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Categories' }

export default async function CategoriesPage() {
  const user = await requirePagePermission(PERMISSIONS.CATEGORY_MANAGE, '/dashboard/categories')

  const categories = await prisma.category.findMany({
    where: { restaurantId: user.restaurantId, deletedAt: null },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    include: { _count: { select: { foods: { where: { deletedAt: null } } } } },
  })

  return (
    <CategoryManager
      canManage={can(user, PERMISSIONS.CATEGORY_MANAGE)}
      categories={categories.map((category) => ({
        id: category.id,
        name: category.name,
        description: category.description,
        icon: category.icon,
        isVisible: category.isVisible,
        sortOrder: category.sortOrder,
        itemCount: category._count.foods,
      }))}
    />
  )
}
