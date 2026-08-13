'use server'

import { revalidatePath } from 'next/cache'

import { runAction, runSafe, type ActionResult } from '@/lib/action'
import { ConflictError, NotFoundError } from '@/lib/errors'
import { PERMISSIONS } from '@/lib/rbac'
import { slugify } from '@/lib/utils'
import { AUDIT_ACTIONS, audit } from '@/server/audit'
import { requirePermission } from '@/server/auth/guard'
import { isUniqueViolation, prisma } from '@/server/db/prisma'
import { realtime } from '@/server/realtime/emitter'
import {
  categorySchema,
  foodSchema,
  reorderCategoriesSchema,
  toggleAvailabilitySchema,
} from './schema'

/** Unique-per-tenant slug, retried until it lands. */
async function uniqueSlug(
  model: 'category' | 'food',
  restaurantId: string,
  name: string,
  excludeId?: string,
): Promise<string> {
  const base = slugify(name) || model
  let slug = base
  for (let attempt = 1; attempt <= 60; attempt += 1) {
    const existing =
      model === 'category'
        ? await prisma.category.findFirst({ where: { restaurantId, slug }, select: { id: true } })
        : await prisma.food.findFirst({ where: { restaurantId, slug }, select: { id: true } })
    if (!existing || existing.id === excludeId) return slug
    slug = `${base}-${attempt}`
  }
  return `${base}-${Date.now().toString(36)}`
}

async function syncRestaurantMenuSnapshot({
  restaurantId,
  entityType,
  entityId,
  name,
  slug,
  categoryName,
  imageUrl,
  price,
  snapshot,
}: {
  restaurantId: string
  entityType: 'CATEGORY' | 'FOOD'
  entityId: string
  name: string
  slug?: string | null
  categoryName?: string | null
  imageUrl?: string | null
  price?: number | null
  snapshot: any
}) {
  await prisma.restaurantMenuSnapshot.upsert({
    where: { restaurantId_entityType_entityId: { restaurantId, entityType, entityId } },
    update: {
      name,
      slug: slug ?? null,
      categoryName: categoryName ?? null,
      imageUrl: imageUrl ?? null,
      price: price ?? null,
      snapshot,
    },
    create: {
      restaurantId,
      entityType,
      entityId,
      name,
      slug: slug ?? null,
      categoryName: categoryName ?? null,
      imageUrl: imageUrl ?? null,
      price: price ?? null,
      snapshot,
    },
  })
}

// ── categories ───────────────────────────────────────────────────────────────

export async function saveCategory(input: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction(
    categorySchema,
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.CATEGORY_MANAGE)
      const slug = await uniqueSlug('category', user.restaurantId, data.name, data.id)

      const payload = {
        name: data.name,
        slug,
        description: data.description || null,
        imageUrl: data.imageUrl || null,
        icon: data.icon || null,
        sortOrder: data.sortOrder,
        isVisible: data.isVisible,
      }

      let record
      if (data.id) {
        const existing = await prisma.category.findFirst({
          where: { id: data.id, restaurantId: user.restaurantId, deletedAt: null },
        })
        if (!existing) throw new NotFoundError('Category')
        record = await prisma.category.update({ where: { id: existing.id }, data: payload })
        await audit({
          restaurantId: user.restaurantId,
          userId: user.id,
          actorName: user.name,
          action: AUDIT_ACTIONS.UPDATE,
          entity: 'Category',
          entityId: record.id,
          before: existing,
          after: record,
        })
      } else {
        record = await prisma.category.create({
          data: { ...payload, restaurantId: user.restaurantId },
        })
        await audit({
          restaurantId: user.restaurantId,
          userId: user.id,
          actorName: user.name,
          action: AUDIT_ACTIONS.CREATE,
          entity: 'Category',
          entityId: record.id,
          after: record,
        })
      }

      await syncRestaurantMenuSnapshot({
        restaurantId: user.restaurantId,
        entityType: 'CATEGORY',
        entityId: record.id,
        name: record.name,
        slug: record.slug,
        categoryName: record.name,
        imageUrl: record.imageUrl,
        snapshot: record,
      })

      realtime.menuUpdated(user.restaurantId)
      revalidatePath('/dashboard/categories')
      revalidatePath('/dashboard/menu')
      return { id: record.id }
    },
    'Category saved.',
  )
}

export async function deleteCategory(id: string): Promise<ActionResult<{ id: string }>> {
  return runSafe(async () => {
    const user = await requirePermission(PERMISSIONS.CATEGORY_MANAGE)

    const category = await prisma.category.findFirst({
      where: { id, restaurantId: user.restaurantId, deletedAt: null },
      include: { _count: { select: { foods: { where: { deletedAt: null } } } } },
    })
    if (!category) throw new NotFoundError('Category')
    if (category._count.foods > 0) {
      throw new ConflictError(
        `Move or remove the ${category._count.foods} item(s) in this category first`,
      )
    }

    await prisma.category.update({ where: { id }, data: { deletedAt: new Date() } })
    await prisma.restaurantMenuSnapshot.deleteMany({
      where: { restaurantId: user.restaurantId, entityType: 'CATEGORY', entityId: id },
    })
    await audit({
      restaurantId: user.restaurantId,
      userId: user.id,
      actorName: user.name,
      action: AUDIT_ACTIONS.DELETE,
      entity: 'Category',
      entityId: id,
      before: category,
    })

    realtime.menuUpdated(user.restaurantId)
    revalidatePath('/dashboard/categories')
    return { id }
  }, 'Category deleted.')
}

export async function reorderCategories(input: unknown): Promise<ActionResult<{ count: number }>> {
  return runAction(reorderCategoriesSchema, input, async (data) => {
    const user = await requirePermission(PERMISSIONS.CATEGORY_MANAGE)

    await prisma.$transaction(
      data.ids.map((id, index) =>
        prisma.category.updateMany({
          where: { id, restaurantId: user.restaurantId },
          data: { sortOrder: index },
        }),
      ),
    )

    realtime.menuUpdated(user.restaurantId)
    revalidatePath('/dashboard/categories')
    return { count: data.ids.length }
  })
}

export async function toggleCategoryVisibility(
  id: string,
  isVisible: boolean,
): Promise<ActionResult<{ id: string }>> {
  return runSafe(async () => {
    const user = await requirePermission(PERMISSIONS.CATEGORY_MANAGE)
    const result = await prisma.category.updateMany({
      where: { id, restaurantId: user.restaurantId },
      data: { isVisible },
    })
    if (result.count === 0) throw new NotFoundError('Category')

    realtime.menuUpdated(user.restaurantId)
    revalidatePath('/dashboard/categories')
    return { id }
  })
}

// ── menu items ───────────────────────────────────────────────────────────────

export async function saveFood(input: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction(
    foodSchema,
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.MENU_MANAGE)

      const category = await prisma.category.findFirst({
        where: { id: data.categoryId, restaurantId: user.restaurantId, deletedAt: null },
        select: { id: true, name: true },
      })
      if (!category) throw new NotFoundError('Category')

      const slug = await uniqueSlug('food', user.restaurantId, data.name, data.id)

      const base = {
        categoryId: category.id,
        name: data.name,
        slug,
        description: data.description || null,
        imageUrl: data.imageUrl || null,
        price: data.price,
        discountPrice: data.discountPrice ?? null,
        costPrice: data.costPrice,
        prepTimeMinutes: data.prepTimeMinutes,
        calories: data.calories ?? null,
        isVeg: data.isVeg,
        spiceLevel: data.spiceLevel,
        isAvailable: data.isAvailable,
        isRecommended: data.isRecommended,
        isPopular: data.isPopular,
        tags: data.tags,
        allergens: data.allergens,
        sortOrder: data.sortOrder,
        happyHourPrice: data.happyHourPrice ?? null,
        happyHourStartMin: data.happyHourStartMin ?? null,
        happyHourEndMin: data.happyHourEndMin ?? null,
        happyHourDays: data.happyHourDays,
      }

      const id = await prisma.$transaction(async (tx) => {
        let foodId = data.id

        if (foodId) {
          const existing = await tx.food.findFirst({
            where: { id: foodId, restaurantId: user.restaurantId, deletedAt: null },
          })
          if (!existing) throw new NotFoundError('Menu item')
          await tx.food.update({ where: { id: foodId }, data: base })
          // Option groups are fully replaced — simplest correct semantics for
          // a form that edits them as one unit.
          await tx.variantGroup.deleteMany({ where: { foodId } })
          await tx.recipeItem.deleteMany({ where: { foodId } })
        } else {
          const created = await tx.food.create({
            data: { ...base, restaurantId: user.restaurantId },
          })
          foodId = created.id
        }

        for (const group of data.variantGroups) {
          await tx.variantGroup.create({
            data: {
              foodId,
              name: group.name,
              kind: group.kind,
              isRequired: group.isRequired,
              minSelect: group.minSelect,
              maxSelect: group.maxSelect,
              sortOrder: group.sortOrder,
              options: {
                create: group.options.map((option, index) => ({
                  name: option.name,
                  priceDelta: option.priceDelta,
                  isDefault: option.isDefault,
                  isAvailable: option.isAvailable,
                  sortOrder: option.sortOrder || index,
                })),
              },
            },
          })
        }

        if (data.recipe.length) {
          const validItems = await tx.inventoryItem.findMany({
            where: {
              id: { in: data.recipe.map((line) => line.itemId) },
              restaurantId: user.restaurantId,
            },
            select: { id: true },
          })
          const allowed = new Set(validItems.map((item) => item.id))
          await tx.recipeItem.createMany({
            data: data.recipe
              .filter((line) => allowed.has(line.itemId))
              .map((line) => ({ foodId: foodId!, itemId: line.itemId, quantity: line.quantity })),
            skipDuplicates: true,
          })
        }

        return foodId
      })

      await audit({
        restaurantId: user.restaurantId,
        userId: user.id,
        actorName: user.name,
        action: data.id ? AUDIT_ACTIONS.UPDATE : AUDIT_ACTIONS.CREATE,
        entity: 'Food',
        entityId: id,
        after: base,
      })

      await syncRestaurantMenuSnapshot({
        restaurantId: user.restaurantId,
        entityType: 'FOOD',
        entityId: id,
        name: data.name,
        slug: slug,
        categoryName: category.name,
        imageUrl: data.imageUrl || null,
        price: data.price,
        snapshot: {
          ...base,
          id,
          slug,
          categoryId: category.id,
          categoryName: category.name,
        },
      })

      realtime.menuUpdated(user.restaurantId)
      revalidatePath('/dashboard/menu')
      revalidatePath('/order/menu')
      return { id: id! }
    },
    'Menu item saved.',
  )
}

export async function deleteFood(id: string): Promise<ActionResult<{ id: string }>> {
  return runSafe(async () => {
    const user = await requirePermission(PERMISSIONS.MENU_MANAGE)

    const food = await prisma.food.findFirst({
      where: { id, restaurantId: user.restaurantId, deletedAt: null },
    })
    if (!food) throw new NotFoundError('Menu item')

    // Soft delete keeps historical order lines intact.
    await prisma.food.update({
      where: { id },
      data: { deletedAt: new Date(), isAvailable: false },
    })

    await prisma.restaurantMenuSnapshot.deleteMany({
      where: { restaurantId: user.restaurantId, entityType: 'FOOD', entityId: id },
    })
    await audit({
      restaurantId: user.restaurantId,
      userId: user.id,
      actorName: user.name,
      action: AUDIT_ACTIONS.DELETE,
      entity: 'Food',
      entityId: id,
      before: food,
    })

    realtime.menuUpdated(user.restaurantId)
    revalidatePath('/dashboard/menu')
    return { id }
  }, 'Menu item removed.')
}

export async function toggleFoodAvailability(input: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction(toggleAvailabilitySchema, input, async (data) => {
    const user = await requirePermission(PERMISSIONS.MENU_MANAGE)

    const result = await prisma.food.updateMany({
      where: { id: data.id, restaurantId: user.restaurantId, deletedAt: null },
      data: { isAvailable: data.isAvailable },
    })
    if (result.count === 0) throw new NotFoundError('Menu item')

    realtime.menuUpdated(user.restaurantId)
    revalidatePath('/dashboard/menu')
    revalidatePath('/order/menu')
    return { id: data.id }
  })
}

export async function duplicateFood(id: string): Promise<ActionResult<{ id: string }>> {
  return runSafe(async () => {
    const user = await requirePermission(PERMISSIONS.MENU_MANAGE)

    const food = await prisma.food.findFirst({
      where: { id, restaurantId: user.restaurantId, deletedAt: null },
      include: { variantGroups: { include: { options: true } } },
    })
    if (!food) throw new NotFoundError('Menu item')

    const name = `${food.name} (copy)`
    const slug = await uniqueSlug('food', user.restaurantId, name)

    try {
      const copy = await prisma.food.create({
        data: {
          restaurantId: user.restaurantId,
          categoryId: food.categoryId,
          name,
          slug,
          description: food.description,
          imageUrl: food.imageUrl,
          price: food.price,
          discountPrice: food.discountPrice,
          costPrice: food.costPrice,
          prepTimeMinutes: food.prepTimeMinutes,
          calories: food.calories,
          isVeg: food.isVeg,
          spiceLevel: food.spiceLevel,
          isAvailable: false,
          tags: food.tags,
          allergens: food.allergens,
          sortOrder: food.sortOrder + 1,
          variantGroups: {
            create: food.variantGroups.map((group) => ({
              name: group.name,
              kind: group.kind,
              isRequired: group.isRequired,
              minSelect: group.minSelect,
              maxSelect: group.maxSelect,
              sortOrder: group.sortOrder,
              options: {
                create: group.options.map((option) => ({
                  name: option.name,
                  priceDelta: option.priceDelta,
                  isDefault: option.isDefault,
                  isAvailable: option.isAvailable,
                  sortOrder: option.sortOrder,
                })),
              },
            })),
          },
        },
      })

      revalidatePath('/dashboard/menu')
      return { id: copy.id }
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictError('A copy already exists')
      throw error
    }
  }, 'Duplicated. The copy starts unavailable.')
}
