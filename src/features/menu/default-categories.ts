import type { Prisma } from '@prisma/client'

/**
 * Fixed categories every restaurant starts with. Owners don't manage
 * categories — they just assign each dish to one of these when adding it.
 */
export const DEFAULT_CATEGORIES: Array<{ name: string; slug: string; icon: string }> = [
  { name: 'Starters', slug: 'starters', icon: '🥗' },
  { name: 'Main Course', slug: 'main-course', icon: '🍛' },
  { name: 'Rice & Noodles', slug: 'rice-noodles', icon: '🍜' },
  { name: 'Snacks', slug: 'snacks', icon: '🍟' },
  { name: 'Pizza & Burgers', slug: 'pizza-burgers', icon: '🍕' },
  { name: 'Desserts', slug: 'desserts', icon: '🍰' },
  { name: 'Beverages', slug: 'beverages', icon: '🥤' },
]

/** Prisma `createMany` rows for a restaurant's default categories. */
export function defaultCategoryRows(restaurantId: string): Prisma.CategoryCreateManyInput[] {
  return DEFAULT_CATEGORIES.map((category, index) => ({
    restaurantId,
    name: category.name,
    slug: category.slug,
    icon: category.icon,
    sortOrder: index,
    isVisible: true,
  }))
}
