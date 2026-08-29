import type { Metadata } from 'next'

import { defaultCategoryRows } from '@/features/menu/default-categories'
import { MenuManager } from '@/features/menu/components/menu-manager'
import { getManagedMenu } from '@/features/menu/queries'
import { can, PERMISSIONS } from '@/lib/rbac'
import { scopeToOne, selectedBranch } from '@/features/dashboard/selected-branch'
import { requirePagePermission } from '@/server/auth/guard'
import { prisma } from '@/server/db/prisma'
import { requireRestaurant } from '@/server/db/tenant'
import { AutoRefresh } from '@/components/auto-refresh'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Menu' }

export default async function MenuPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const user = await requirePagePermission(PERMISSIONS.MENU_VIEW, '/dashboard/menu')

  /*
   * The menu is now a per-branch thing, so this page follows the top-bar
   * switcher like every other list. It was one of the last that never did —
   * a dish added at Main appeared instantly at Kandy because there was
   * nowhere for the difference to live.
   */
  const selection = await selectedBranch(user, await searchParams)
  const branchId = scopeToOne(selection)

  // Categories are a fixed set. Seed them idempotently so the "add dish"
  // dropdown is never empty — including for restaurants approved before the
  // fixed-category change. The unique (restaurantId, slug) makes this a no-op
  // once they exist.
  await prisma.category.createMany({
    data: defaultCategoryRows(user.restaurantId),
    skipDuplicates: true,
  })

  const [restaurant, menu, stations, allBranches, branch] = await Promise.all([
    requireRestaurant(user.restaurantId),
    getManagedMenu(user.restaurantId, undefined, branchId),
    /*
     * Kitchen sections across every location, so the branch rows can ask which
     * one cooks the dish. Empty for a restaurant that does not use sections,
     * and the picker then never appears.
     */
    prisma.kitchenStation.findMany({
      where: { restaurantId: user.restaurantId, isActive: true },
      select: { id: true, name: true, branchId: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    }),
    // Only the locations this person may see, so the "Available at" list can
    // never be used to share a dish somewhere they have no business.
    prisma.branch.findMany({
      where: { restaurantId: user.restaurantId, deletedAt: null },
      select: { id: true, name: true, type: true, isDefault: true },
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
    }),
    selection.branchId
      ? prisma.branch.findFirst({
          where: { id: selection.branchId, restaurantId: user.restaurantId },
          select: { name: true },
        })
      : Promise.resolve(null),
  ])

  const allowed = selection.branchIds
  const branches = allBranches
    .filter((b) => allowed === null || allowed.includes(b.id))
    .map((b) => ({ id: b.id, name: b.name, type: b.type as string }))

  return (
    <>
      <AutoRefresh scope="catalog" intervalMs={10000} />
    <MenuManager
      currency={restaurant.currency}
      locale={restaurant.locale === 'en' ? 'en-IN' : restaurant.locale}
      canManage={can(user, PERMISSIONS.MENU_MANAGE)}
      branches={branches}
      activeBranchId={selection.branchId}
      activeBranchName={branch?.name ?? null}
      branchCount={menu.branchCount}
      categories={menu.categories.map((category) => ({ id: category.id, name: category.name }))}
      stations={stations}
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
        branchCount: food.branchCount,
        hasPriceOverride: food.hasPriceOverride,
      }))}
    />
    </>
  )
}
