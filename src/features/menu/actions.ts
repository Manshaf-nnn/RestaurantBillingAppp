'use server'

import type { Prisma } from '@prisma/client'
import { revalidatePath } from 'next/cache'

import { runAction, runSafe, type ActionResult } from '@/lib/action'
import { ConflictError, NotFoundError } from '@/lib/errors'
import { PERMISSIONS } from '@/lib/rbac'
import { slugify } from '@/lib/utils'
import { AUDIT_ACTIONS, audit } from '@/server/audit'
import { requirePermission } from '@/server/auth/guard'
import { isUniqueViolation, prisma } from '@/server/db/prisma'
import { defaultBranchId, replaceFoodBranches } from './branch-menu'
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
  snapshot: Prisma.InputJsonValue
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
        } else {
          const created = await tx.food.create({
            data: { ...base, restaurantId: user.restaurantId },
          })
          foodId = created.id
        }

        /*
         * Which branches sell it. Replaced wholesale in the same transaction
         * that replaces the variant groups and recipe, so a dish and its reach
         * can never be half-saved.
         *
         * A new dish with nothing chosen goes to the branch being worked in —
         * `data.branches` is filled by the form from the top-bar switcher — and
         * failing that, to the restaurant's default. Never to every branch:
         * that is what the old restaurant-wide menu did, and undoing it is the
         * point of this whole change.
         */
        const branches = data.branches.length
          ? data.branches
          : data.id
            ? [] // An edit that sent nothing means "leave it where it is".
            : [{ branchId: await defaultBranchId(user.restaurantId), isAvailable: true }]

        if (branches.length || !data.id) {
          await replaceFoodBranches(tx, {
            restaurantId: user.restaurantId,
            foodId,
            branches,
          })
        }

        /*
         * ── Option ids have to survive a save ─────────────────────────────
         *
         * This used to `deleteMany` every group and recreate them, which mints
         * fresh cuids for every group and option on every save. The form has
         * always sent the ids back; they were accepted by zod and then thrown
         * away.
         *
         * The cost was not historical — an order snapshots its choices onto
         * `OrderItem.options`, so past orders were never at risk. It was LIVE
         * carts. A guest browsing with a basket open, an owner correcting a
         * typo on that dish, and the guest's next tap fails `INVALID_OPTION` —
         * the tamper check, fired at somebody who tampered with nothing. Their
         * basket dies and the message accuses them.
         *
         * So: update what came back with an id, create what is new, and delete
         * only what the form actually dropped.
         */
        const keptGroupIds = data.variantGroups
          .map((group) => group.id)
          .filter((id): id is string => Boolean(id))

        await tx.variantGroup.deleteMany({
          where: { foodId, ...(keptGroupIds.length ? { id: { notIn: keptGroupIds } } : {}) },
        })

        for (const [groupIndex, group] of data.variantGroups.entries()) {
          const groupFields = {
            name: group.name,
            kind: group.kind,
            isRequired: group.isRequired,
            minSelect: group.minSelect,
            maxSelect: group.maxSelect,
            sortOrder: group.sortOrder || groupIndex,
          }

          /*
           * `updateMany` rather than `update`, and scoped by `foodId` — an id
           * from the payload is only trusted once it is proved to belong to
           * this dish. `count === 0` means it did not, and the group is created
           * fresh rather than silently editing another dish's options.
           */
          let groupId = group.id ?? null
          if (groupId) {
            const touched = await tx.variantGroup.updateMany({
              where: { id: groupId, foodId },
              data: groupFields,
            })
            if (touched.count === 0) groupId = null
          }
          if (!groupId) {
            const created = await tx.variantGroup.create({ data: { foodId, ...groupFields } })
            groupId = created.id
          }

          const keptOptionIds = group.options
            .map((option) => option.id)
            .filter((id): id is string => Boolean(id))

          await tx.variantOption.deleteMany({
            where: { groupId, ...(keptOptionIds.length ? { id: { notIn: keptOptionIds } } : {}) },
          })

          for (const [index, option] of group.options.entries()) {
            const optionFields = {
              name: option.name,
              priceDelta: option.priceDelta,
              isDefault: option.isDefault,
              isAvailable: option.isAvailable,
              // `??`, not `||`: an option that genuinely sorts first has
              // sortOrder 0, and the old falsy check pushed it to its index.
              sortOrder: option.sortOrder ?? index,
            }

            const touched = option.id
              ? await tx.variantOption.updateMany({
                  where: { id: option.id, groupId },
                  data: optionFields,
                })
              : { count: 0 }

            if (touched.count === 0) {
              await tx.variantOption.create({ data: { groupId, ...optionFields } })
            }
          }
        }

        /*
         * A dish's ingredients are edited on the Recipes screen, not here.
         *
         * This used to write a second, flat recipe table that the depletion
         * resolver ignored whenever the dish also had a versioned recipe — so
         * ingredients typed into this dialog saved successfully and then did
         * nothing, while stock moved by somebody else's numbers.
         */
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
      include: {
        variantGroups: { include: { options: true } },
        // A copy is sold where the original is, with the same overrides. Any
        // other answer is a guess: copying to every branch would spread it and
        // copying to none would make a dish nobody can order.
        branches: true,
      },
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

      // Sold wherever the original is, at the same overrides. The copy starts
      // unavailable anyway, so nothing goes on sale by accident.
      if (food.branches.length) {
        await prisma.foodBranch.createMany({
          data: food.branches.map((row) => ({
            restaurantId: user.restaurantId,
            foodId: copy.id,
            branchId: row.branchId,
            price: row.price,
            discountPrice: row.discountPrice,
            isAvailable: row.isAvailable,
            sortOrder: row.sortOrder,
          })),
          skipDuplicates: true,
        })
      }

      revalidatePath('/dashboard/menu')
      return { id: copy.id }
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictError('A copy already exists')
      throw error
    }
  }, 'Duplicated. The copy starts unavailable.')
}
