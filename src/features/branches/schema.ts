import { z } from 'zod'

/*
 * The location schemas live here rather than beside the actions that use them.
 *
 * A 'use server' module may only export async functions — Next turns every
 * export into a callable server reference, and a Zod object is not callable.
 * Exporting one from actions.ts threw "A 'use server' file can only export
 * async functions, found object" on the FIRST call into the module, so every
 * action in the file failed with a bare digest and nothing was ever written.
 */

export const LOCATION_TYPES = ['BRANCH', 'PRODUCTION_HOUSE', 'CENTRAL_WAREHOUSE'] as const

export const locationSchema = z.object({
  name: z.string().trim().min(2, 'Give the location a name').max(60),
  code: z.string().trim().min(1, 'Give it a short code').max(12),
  type: z.enum(LOCATION_TYPES),
  address: z.string().trim().max(200).optional().or(z.literal('')),
  phone: z.string().trim().max(30).optional().or(z.literal('')),
})

const timeOfDay = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a 24-hour time such as 09:00')

const dayHoursSchema = z.object({
  open: timeOfDay,
  close: timeOfDay,
  closed: z.coerce.boolean().optional(),
})

/**
 * A location's own opening hours.
 *
 * Written out day by day rather than generated, so the shape is the same one
 * `OpeningHours` in @/lib/opening-hours describes and `parseOpeningHours`,
 * `isOpenNow` and `todayLabel` read a branch's hours with no second code path.
 * `Branch.openingHours` has always carried the comment "same shape as the
 * restaurant's own"; this is what enforces it.
 */
export const openingHoursSchema = z.object({
  sun: dayHoursSchema.optional(),
  mon: dayHoursSchema.optional(),
  tue: dayHoursSchema.optional(),
  wed: dayHoursSchema.optional(),
  thu: dayHoursSchema.optional(),
  fri: dayHoursSchema.optional(),
  sat: dayHoursSchema.optional(),
})

/**
 * Editing a location.
 *
 * Every field is optional and an omitted one means "leave it alone", so a caller
 * that only wants to rename cannot wipe the address on its way past. The short
 * code is deliberately absent: it is printed on transfers and reports that are
 * already out in the world, so changing it would rewrite what those documents
 * refer to.
 */
export const updateLocationSchema = z.object({
  branchId: z.string().min(1),
  name: z.string().trim().min(2, 'Give the location a name').max(60).optional(),
  type: z.enum(LOCATION_TYPES).optional(),
  address: z.string().trim().max(200).optional(),
  phone: z.string().trim().max(30).optional(),
  isActive: z.coerce.boolean().optional(),
  /** null or '' takes the manager off; omitted leaves whoever is there. */
  managerId: z.string().trim().nullish(),
  /** null means the location follows the restaurant's own hours. */
  openingHours: openingHoursSchema.nullish(),
})

export const storageLocationSchema = z.object({
  branchId: z.string().min(1),
  name: z.string().trim().min(2, 'Name the storage area').max(60),
  code: z.string().trim().min(1).max(12),
})
