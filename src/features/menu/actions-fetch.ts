'use server'

import { runSafe } from '@/lib/action'
import { PERMISSIONS } from '@/lib/rbac'
import { toMajor } from '@/lib/money'
import { requireAnyPermission } from '@/server/auth/guard'
import { getFoodForEdit } from './queries'
import { foodBranchRows } from './branch-menu'

/** Loads a menu item and reshapes it into major-unit values the form edits. */
export async function fetchFoodForEdit(foodId: string) {
  return runSafe(async () => {
    const user = await requireAnyPermission([PERMISSIONS.MENU_MANAGE, PERMISSIONS.MENU_VIEW])
    const food = await getFoodForEdit(user.restaurantId, foodId)
    if (!food) throw new Error('Menu item not found')

    // Which locations sell it, with their own prices, so the form can show a
    // branch's figure beside its checkbox and blank where it inherits.
    const branches = await foodBranchRows({ restaurantId: user.restaurantId, foodId })

    return {
      branches: branches.map((row) => ({
        branchId: row.branchId,
        price: row.price !== null ? toMajor(row.price) : null,
        isAvailable: row.isAvailable,
      })),
      id: food.id,
      categoryId: food.categoryId,
      name: food.name,
      description: food.description ?? '',
      imageUrl: food.imageUrl ?? '',
      price: toMajor(food.price),
      discountPrice: food.discountPrice !== null ? toMajor(food.discountPrice) : null,
      costPrice: toMajor(food.costPrice),
      prepTimeMinutes: food.prepTimeMinutes,
      calories: food.calories,
      isVeg: food.isVeg,
      spiceLevel: food.spiceLevel,
      isAvailable: food.isAvailable,
      isRecommended: food.isRecommended,
      isPopular: food.isPopular,
      tags: food.tags,
      allergens: food.allergens,
      sortOrder: food.sortOrder,
      happyHourPrice: food.happyHourPrice !== null ? toMajor(food.happyHourPrice) : null,
      happyHourStartMin: food.happyHourStartMin,
      happyHourEndMin: food.happyHourEndMin,
      happyHourDays: food.happyHourDays,
      variantGroups: food.variantGroups.map((group) => ({
        id: group.id,
        name: group.name,
        kind: group.kind,
        isRequired: group.isRequired,
        minSelect: group.minSelect,
        maxSelect: group.maxSelect,
        options: group.options.map((option) => ({
          id: option.id,
          name: option.name,
          priceDelta: toMajor(option.priceDelta),
          isDefault: option.isDefault,
          isAvailable: option.isAvailable,
        })),
      })),
      recipe: food.recipe.map((line) => ({
        itemId: line.itemId,
        name: line.item.name,
        unit: line.item.unit,
        quantity: line.quantity,
      })),
    }
  })
}
