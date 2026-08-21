import 'server-only'
import { cache } from 'react'

import { prisma } from '@/server/db/prisma'
import { applyBranchOverrides, branchFoodFilter, branchOverrides } from './branch-menu'
import { effectivePrice, type SelectedOption } from '@/features/orders/pricing'

export interface PublicMenuOption {
  id: string
  name: string
  priceDelta: number
  isDefault: boolean
  isAvailable: boolean
}

export interface PublicMenuGroup {
  id: string
  name: string
  kind: 'VARIANT' | 'ADDON'
  isRequired: boolean
  minSelect: number
  maxSelect: number
  options: PublicMenuOption[]
}

export interface PublicMenuItem {
  id: string
  name: string
  slug: string
  description: string | null
  imageUrl: string | null
  price: number
  compareAt: number | null
  priceReason: 'base' | 'discount' | 'happy-hour'
  prepTimeMinutes: number
  calories: number | null
  isVeg: boolean
  spiceLevel: 'NONE' | 'MILD' | 'MEDIUM' | 'HOT' | 'EXTRA_HOT'
  isAvailable: boolean
  isRecommended: boolean
  isPopular: boolean
  tags: string[]
  allergens: string[]
  categoryId: string
  rating: number | null
  ratingCount: number
  groups: PublicMenuGroup[]
}

export interface PublicMenuCategory {
  id: string
  name: string
  slug: string
  description: string | null
  imageUrl: string | null
  icon: string | null
  itemCount: number
}

export interface PublicMenu {
  categories: PublicMenuCategory[]
  items: PublicMenuItem[]
}

/**
 * The guest-facing menu. Prices are resolved server-side (offers and happy hour
 * included) so the client never has to reimplement pricing rules.
 *
 * `branchId` makes it that branch's menu, at that branch's prices. Passing null
 * gives the whole restaurant's list, which is what a single-site restaurant and
 * the owner's own preview both want.
 *
 * The branch is part of the cache key by virtue of being an argument to a
 * `cache()`d function — but the HTTP response in `/api/public/menu` is also
 * cached, and its key must carry the branch too or one branch is served
 * another's menu. That is the same mistake the analytics cache keys made.
 */
export const getPublicMenu = cache(
  async (
    restaurantId: string,
    timezone = 'Asia/Kolkata',
    branchId?: string | null,
  ): Promise<PublicMenu> => {
    const [categories, foods, overrides] = await Promise.all([
      prisma.category.findMany({
        where: { restaurantId, isVisible: true, deletedAt: null },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      }),
      prisma.food.findMany({
        where: {
          restaurantId,
          deletedAt: null,
          category: { isVisible: true, deletedAt: null },
          // Only what this branch actually sells. Filtered in the query rather
          // than afterwards, so a branch with fifty dishes fetches fifty.
          ...branchFoodFilter(branchId),
        },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        include: {
          variantGroups: {
            orderBy: { sortOrder: 'asc' },
            include: { options: { orderBy: { sortOrder: 'asc' } } },
          },
        },
      }),
      branchOverrides({ restaurantId, branchId }),
    ])

    const now = new Date()

    const items: PublicMenuItem[] = foods.map((base) => {
      // The branch's price and availability, merged on before pricing runs, so
      // happy hour and discounts still work exactly as they always have.
      const food = applyBranchOverrides(base, overrides?.get(base.id))
      const pricing = effectivePrice(food, now, timezone)
      return {
        id: food.id,
        name: food.name,
        slug: food.slug,
        description: food.description,
        imageUrl: food.imageUrl,
        price: pricing.price,
        compareAt: pricing.compareAt,
        priceReason: pricing.reason,
        prepTimeMinutes: food.prepTimeMinutes,
        calories: food.calories,
        isVeg: food.isVeg,
        spiceLevel: food.spiceLevel,
        isAvailable: food.isAvailable,
        isRecommended: food.isRecommended,
        isPopular: food.isPopular,
        tags: food.tags,
        allergens: food.allergens,
        categoryId: food.categoryId,
        rating: food.ratingCount > 0 ? food.ratingSum / food.ratingCount : null,
        ratingCount: food.ratingCount,
        groups: food.variantGroups.map((group) => ({
          id: group.id,
          name: group.name,
          kind: group.kind,
          isRequired: group.isRequired,
          minSelect: group.minSelect,
          maxSelect: group.maxSelect,
          options: group.options.map((option) => ({
            id: option.id,
            name: option.name,
            priceDelta: option.priceDelta,
            isDefault: option.isDefault,
            isAvailable: option.isAvailable,
          })),
        })),
      }
    })

    const counts = new Map<string, number>()
    for (const item of items) counts.set(item.categoryId, (counts.get(item.categoryId) ?? 0) + 1)

    return {
      categories: categories
        .map((category) => ({
          id: category.id,
          name: category.name,
          slug: category.slug,
          description: category.description,
          imageUrl: category.imageUrl,
          icon: category.icon,
          itemCount: counts.get(category.id) ?? 0,
        }))
        .filter((category) => category.itemCount > 0),
      items,
    }
  },
)

/**
 * Admin listing — includes hidden categories and unavailable items.
 *
 * `branchId` shows that branch's menu: what it sells, at its prices, with its
 * availability. Null shows every dish in the restaurant, which is what an owner
 * on "All locations" wants and what a single-site restaurant always sees.
 */
export async function getManagedMenu(
  restaurantId: string,
  filter?: { search?: string; categoryId?: string; availability?: string; diet?: string },
  branchId?: string | null,
) {
  const where = {
    restaurantId,
    deletedAt: null,
    ...branchFoodFilter(branchId),
    ...(filter?.search
      ? {
          OR: [
            { name: { contains: filter.search, mode: 'insensitive' as const } },
            { description: { contains: filter.search, mode: 'insensitive' as const } },
          ],
        }
      : {}),
    ...(filter?.categoryId && filter.categoryId !== 'ALL' ? { categoryId: filter.categoryId } : {}),
    ...(filter?.availability === 'AVAILABLE' ? { isAvailable: true } : {}),
    ...(filter?.availability === 'UNAVAILABLE' ? { isAvailable: false } : {}),
    ...(filter?.diet === 'VEG' ? { isVeg: true } : {}),
    ...(filter?.diet === 'NON_VEG' ? { isVeg: false } : {}),
  }

  const [rows, categories, overrides, branchCount] = await Promise.all([
    prisma.food.findMany({
      where,
      orderBy: [{ category: { sortOrder: 'asc' } }, { sortOrder: 'asc' }, { name: 'asc' }],
      include: {
        category: { select: { id: true, name: true } },
        variantGroups: { select: { id: true, kind: true } },
        // How widely a dish is shared, so the list can say "3 of 5 locations"
        // without a second query per row.
        _count: { select: { branches: true } },
      },
    }),
    prisma.category.findMany({
      where: { restaurantId, deletedAt: null },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      include: {
        _count: {
          select: {
            foods: {
              where: { deletedAt: null, ...branchFoodFilter(branchId) },
            },
          },
        },
      },
    }),
    branchOverrides({ restaurantId, branchId }),
    prisma.branch.count({ where: { restaurantId, deletedAt: null } }),
  ])

  /*
   * With a branch chosen, the figures shown are that branch's — its price, its
   * availability. Showing the base price beside a branch's name would be a
   * number nobody at that branch charges.
   */
  const foods = rows.map((row) => {
    const merged = applyBranchOverrides(row, overrides?.get(row.id))
    return {
      ...merged,
      category: row.category,
      variantGroups: row.variantGroups,
      branchCount: row._count.branches,
      /** True when this branch charges something other than the base price. */
      hasPriceOverride: Boolean(overrides?.get(row.id)?.price),
    }
  })

  return { foods, categories, branchCount }
}

export async function getFoodForEdit(restaurantId: string, foodId: string) {
  return prisma.food.findFirst({
    where: { id: foodId, restaurantId, deletedAt: null },
    include: {
      variantGroups: {
        orderBy: { sortOrder: 'asc' },
        include: { options: { orderBy: { sortOrder: 'asc' } } },
      },
      recipe: { include: { item: { select: { id: true, name: true, unit: true } } } },
    },
  })
}

/** Formats the option snapshot stored on an order item for display. */
export function describeOptions(options: unknown): string {
  const list = (options as SelectedOption[] | null) ?? []
  if (!Array.isArray(list) || list.length === 0) return ''
  return list.map((option) => option.name).join(', ')
}
