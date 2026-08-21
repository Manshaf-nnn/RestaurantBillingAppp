'use server'

import { revalidatePath } from 'next/cache'

import { runAction, type ActionResult } from '@/lib/action'
import { PERMISSIONS } from '@/lib/rbac'
import { AUDIT_ACTIONS, audit } from '@/server/audit'
import { requirePermission } from '@/server/auth/guard'
import { prisma } from '@/server/db/prisma'
import { requireRestaurant } from '@/server/db/tenant'
import { sendMail } from '@/server/mailer'
import { enforceRateLimit } from '@/server/security/rate-limit'
import {
  conciergeRequestSchema,
  importMenuSchema,
  photoMatchSchema,
  type ImportRow,
} from './schema'

/** Slugify a name for the unique per-restaurant slug column. */
function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
}

/**
 * Create menu items in bulk from any import route.
 *
 * Categories are matched by name (case-insensitively) and created when missing,
 * so an owner never has to set categories up first — typing "Starters" in the
 * spreadsheet is enough. Everything runs in one transaction: a spreadsheet with
 * a bad row on line 40 imports nothing rather than leaving a half-built menu
 * the owner has to reconcile by hand.
 */
export async function importMenuRows(
  input: unknown,
): Promise<ActionResult<{ created: number; updated: number; categories: number }>> {
  return runAction(
    importMenuSchema,
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.MENU_MANAGE)
      const restaurant = await requireRestaurant(user.restaurantId)

      // Prices arrive in major units; the database stores integer minor units.
      const toMinor = (value: number) => Math.round(value * 100)

      // Where imported dishes are sold — every location, see the note below.
      const allBranches = await prisma.branch.findMany({
        where: { restaurantId: user.restaurantId, deletedAt: null },
        select: { id: true },
      })
      const branches = allBranches.map((b) => b.id)

      const result = await prisma.$transaction(
        async (tx) => {
          const existingCategories = await tx.category.findMany({
            where: { restaurantId: user.restaurantId, deletedAt: null },
            select: { id: true, name: true },
          })
          const categoryByName = new Map(
            existingCategories.map((entry) => [entry.name.toLowerCase(), entry.id]),
          )

          let categoriesCreated = 0
          let created = 0
          let updated = 0
          let sortOrder = existingCategories.length

          for (const row of data.rows as ImportRow[]) {
            const key = row.categoryName.toLowerCase()
            let categoryId = categoryByName.get(key)

            if (!categoryId) {
              const category = await tx.category.create({
                data: {
                  restaurantId: user.restaurantId,
                  name: row.categoryName,
                  slug: `${slugify(row.categoryName)}-${Date.now().toString(36)}${sortOrder}`,
                  sortOrder: sortOrder++,
                },
                select: { id: true },
              })
              categoryId = category.id
              categoryByName.set(key, categoryId)
              categoriesCreated += 1
            }

            const existing = await tx.food.findFirst({
              where: {
                restaurantId: user.restaurantId,
                categoryId,
                name: row.name,
                deletedAt: null,
              },
              select: { id: true },
            })

            const fields = {
              name: row.name,
              description: row.description || null,
              price: toMinor(row.price),
              isVeg: row.isVeg,
              spiceLevel: row.spiceLevel,
              prepTimeMinutes: row.prepTimeMinutes,
              ...(row.imageUrl ? { imageUrl: row.imageUrl } : {}),
            }

            if (existing) {
              // Skipping rather than overwriting is the safe default: a re-run of
              // the same spreadsheet must not silently revert prices an owner
              // has since adjusted in the app.
              if (!data.overwriteExisting) continue
              await tx.food.update({ where: { id: existing.id }, data: fields })
              updated += 1
              continue
            }

            const food = await tx.food.create({
              data: {
                restaurantId: user.restaurantId,
                categoryId,
                slug: `${slugify(row.name)}-${Date.now().toString(36)}${created}`,
                ...fields,
              },
            })

            /*
             * Put it on a menu, or it exists and nobody can order it.
             *
             * An import is a restaurant setting itself up, so every location
             * gets it — unlike a dish added by hand, which goes only to the
             * branch being worked in. Somebody importing eighty dishes is
             * describing what the business sells, not what one site sells.
             */
            await tx.foodBranch.createMany({
              data: branches.map((branchId) => ({
                restaurantId: user.restaurantId,
                foodId: food.id,
                branchId,
              })),
              skipDuplicates: true,
            })

            created += 1
          }

          return { created, updated, categories: categoriesCreated }
        },
        { timeout: 60_000, maxWait: 10_000 },
      )

      await audit({
        restaurantId: user.restaurantId,
        userId: user.id,
        actorName: user.name,
        action: AUDIT_ACTIONS.CREATE,
        entity: 'Menu',
        entityId: user.restaurantId,
        after: { imported: result, restaurant: restaurant.name },
      })

      revalidatePath('/dashboard/menu')
      revalidatePath('/dashboard/categories')
      return result
    },
    'Menu imported.',
  )
}

/**
 * Attach already-uploaded photos to existing menu items.
 *
 * The upload itself goes through /api/uploads like any other image, so the
 * bytes land in Postgres and survive a redeploy; this only records which item
 * each one belongs to.
 */
export async function attachMenuPhotos(
  input: unknown,
): Promise<ActionResult<{ attached: number }>> {
  return runAction(
    photoMatchSchema,
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.MENU_MANAGE)

      let attached = 0
      for (const match of data.matches) {
        const result = await prisma.food.updateMany({
          where: { id: match.foodId, restaurantId: user.restaurantId, deletedAt: null },
          data: { imageUrl: match.imageUrl },
        })
        attached += result.count
      }

      revalidatePath('/dashboard/menu')
      return { attached }
    },
    'Photos attached.',
  )
}

/**
 * Ask the platform team to set the menu up on the owner's behalf.
 *
 * The lowest-effort route of all and the fallback when nothing else fits — a
 * handwritten menu the scanner cannot read, or an owner who would simply rather
 * send a photo to a person.
 */
export async function requestConciergeSetup(
  input: unknown,
): Promise<ActionResult<{ sent: boolean }>> {
  return runAction(
    conciergeRequestSchema,
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.MENU_MANAGE)
      await enforceRateLimit('mutation')
      const restaurant = await requireRestaurant(user.restaurantId)

      const lines = [
        `Menu setup request from ${restaurant.name}`,
        '',
        `Contact:  ${data.contactName}`,
        `Phone:    ${data.contactPhone}`,
        data.contactEmail ? `Email:    ${data.contactEmail}` : null,
        data.itemCount ? `Items:    ${data.itemCount}` : null,
        '',
        data.notes ? `Notes:\n${data.notes}` : null,
        '',
        `Restaurant id: ${restaurant.id}`,
        `Requested by:  ${user.name} (${user.email})`,
      ]
        .filter((line) => line !== null)
        .join('\n')

      // Without SMTP configured the mailer logs instead of sending, which keeps
      // this testable locally and never fails the owner's request.
      await sendMail({
        to: process.env.SUPER_ADMIN_EMAIL || user.email,
        subject: `Menu setup request — ${restaurant.name}`,
        text: lines,
        html: `<pre style="font:14px/1.5 ui-monospace,monospace">${lines
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')}</pre>`,
      })

      await audit({
        restaurantId: user.restaurantId,
        userId: user.id,
        actorName: user.name,
        action: AUDIT_ACTIONS.CREATE,
        entity: 'MenuSetupRequest',
        entityId: restaurant.id,
        after: { contact: data.contactName, phone: data.contactPhone },
      })

      return { sent: true }
    },
    'Request sent — we will be in touch.',
  )
}

/**
 * Whether menu scanning is available on this deployment.
 *
 * A `'use server'` module may only export async functions, so this is a function
 * rather than the constant it looks like it wants to be — exporting a plain
 * value here breaks the whole module at runtime, taking every action in it with
 * it. The page reads the same env var server-side; this exists for callers that
 * need it after mount.
 */
export async function isMenuScanConfigured(): Promise<boolean> {
  await requirePermission(PERMISSIONS.MENU_MANAGE)
  return Boolean(process.env.ANTHROPIC_API_KEY)
}
