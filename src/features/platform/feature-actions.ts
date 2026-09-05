'use server'

import { revalidatePath } from 'next/cache'

import { runAction, type ActionResult } from '@/lib/action'
import { AUDIT_ACTIONS, audit } from '@/server/audit'
import { requireSuperAdmin } from '@/server/auth/guard'
import { prisma } from '@/server/db/prisma'
import {
  deletePackageSchema,
  savePackageSchema,
  setRestaurantFeaturesSchema,
} from './feature-schema'
import { deletePackage, savePackage, setRestaurantFeatures } from './feature-service'

/** Create or edit a sellable bundle of features. */
export async function savePackageAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction(
    savePackageSchema,
    input,
    async (data) => {
      await requireSuperAdmin()
      const pkg = await savePackage({
        packageId: data.packageId,
        name: data.name,
        description: data.description || null,
        featureKeys: data.featureKeys,
        sortOrder: data.sortOrder,
      })
      revalidatePath('/admin/plans')
      return { id: pkg.id }
    },
    'Package saved.',
  )
}

export async function deletePackageAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction(
    deletePackageSchema,
    input,
    async (data) => {
      await requireSuperAdmin()
      await deletePackage(data.packageId)
      revalidatePath('/admin/plans')
      return { id: data.packageId }
    },
    'Package removed. Restaurants on it keep the features they had.',
  )
}

/**
 * Change what one restaurant may use — an upgrade, or a downgrade.
 *
 * ── Why every session is dropped ────────────────────────────────────────────
 *
 * The feature list rides on the session, resolved when it was issued. Somebody
 * already signed in would keep using a feature that has just been taken away
 * until their token happened to refresh — and, worse, would not get a feature
 * just granted until the same thing happened. Revoking makes the change take
 * effect on the next request instead of at some unpredictable point later.
 *
 * The same shape `suspendRestaurant` already uses.
 */
export async function setRestaurantFeaturesAction(
  input: unknown,
): Promise<ActionResult<{ id: string; count: number }>> {
  return runAction(
    setRestaurantFeaturesSchema,
    input,
    async (data) => {
      const admin = await requireSuperAdmin()

      const before = await prisma.restaurant.findUnique({
        where: { id: data.restaurantId },
        select: { name: true, enabledFeatures: true },
      })

      const restaurant = await setRestaurantFeatures({
        restaurantId: data.restaurantId,
        featureKeys: data.featureKeys,
        packageId: data.packageId ?? null,
      })

      /*
       * DELIBERATE behaviour change 2026-09-05 (athu.md): this no longer signs
       * anybody out.
       *
       * It used to revoke every session in the restaurant — "same shape
       * suspendRestaurant uses" — so a platform admin ticking one feature box
       * logged an entire restaurant out mid-service. The revocation was never
       * needed for the change to take effect: `availablePermissions` is read
       * from `Restaurant.enabledFeatures` on EVERY request, inside
       * `resolveUser`, so the new feature set applies on each user's very next
       * click. Suspending a restaurant still ends its sessions, because there
       * the point IS to stop people working. A static guard
       * (`no-collateral-session-revocation`) keeps this file from acquiring
       * another `revokedAt` write.
       */

      await audit({
        restaurantId: data.restaurantId,
        userId: admin.id,
        actorName: admin.name,
        action: AUDIT_ACTIONS.PLATFORM_FEATURES_CHANGED,
        entity: 'Restaurant',
        entityId: data.restaurantId,
        before: { features: before?.enabledFeatures ?? [] },
        after: { features: restaurant.enabledFeatures },
      })

      revalidatePath('/admin')
      revalidatePath('/admin/plans')
      return { id: restaurant.id, count: restaurant.enabledFeatures.length }
    },
    'Features updated. Nothing was deleted.',
  )
}
