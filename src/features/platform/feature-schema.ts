import { z } from 'zod'

/*
 * Kept out of the `'use server'` module: it may export nothing but async
 * functions, and exporting a schema from one does not fail a lint — it breaks
 * every action in the file at runtime.
 */

export const savePackageSchema = z.object({
  packageId: z.string().cuid().optional(),
  name: z.string().trim().min(2, 'Name the package').max(60),
  description: z.string().trim().max(300).optional().or(z.literal('')),
  featureKeys: z.array(z.string().min(1)).max(200).default([]),
  sortOrder: z.coerce.number().int().min(0).max(999).optional(),
})

export const deletePackageSchema = z.object({ packageId: z.string().cuid() })

export const setRestaurantFeaturesSchema = z.object({
  restaurantId: z.string().cuid(),
  /** Empty means unrestricted — every feature. */
  featureKeys: z.array(z.string().min(1)).max(200).default([]),
  /** Which package this came from, purely for display. */
  packageId: z.string().cuid().nullable().optional(),
})
