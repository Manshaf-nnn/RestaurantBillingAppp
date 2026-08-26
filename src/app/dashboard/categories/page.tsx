import type { Metadata } from 'next'

import { CategoryManager } from '@/features/menu/components/category-manager'
import { scopeToOne, selectedBranch } from '@/features/dashboard/selected-branch'
import { can, PERMISSIONS } from '@/lib/rbac'
import { requirePagePermission } from '@/server/auth/guard'
import { prisma } from '@/server/db/prisma'
import { AutoRefresh } from '@/components/auto-refresh'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Categories' }

export default async function CategoriesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const user = await requirePagePermission(PERMISSIONS.CATEGORY_MANAGE, '/dashboard/categories')

  /*
   * The category LIST stays restaurant-wide, deliberately.
   *
   * A category is shared master data, like a supplier or a unit — the same
   * split the menu already uses, where one `Food` is the dish and `FoodBranch`
   * decides who sells it. Giving each branch its own "Desserts" would fork the
   * menu structure for no gain.
   *
   * The dish COUNT beside each one is a different question, and it was
   * answering the wrong one: it counted every dish in the business, so a branch
   * manager saw "12 items" under a category where their own menu had three.
   */
  const branchId = scopeToOne(await selectedBranch(user, await searchParams))

  const categories = await prisma.category.findMany({
    where: { restaurantId: user.restaurantId, deletedAt: null },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    include: {
      _count: {
        select: {
          foods: {
            where: {
              deletedAt: null,
              ...(branchId ? { branches: { some: { branchId } } } : {}),
            },
          },
        },
      },
    },
  })

  return (
    <>
      <AutoRefresh scope="catalog" intervalMs={10000} />
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
    </>
  )
}
