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

/**
 * Who runs the place, decided while the place is being created.
 *
 * Three ways, because all three happen: nobody yet, somebody who already works
 * here, or somebody new who needs an account. Making the third route go through
 * the Staff screen first meant creating a location, leaving it, creating a
 * person, coming back and finally joining the two — and a location with no
 * manager is one nobody can be held to.
 */
const MANAGER_MODES = ['NONE', 'EXISTING', 'NEW'] as const

export const locationSchema = z
  .object({
    name: z.string().trim().min(2, 'Give the location a name').max(60),
    code: z.string().trim().min(1, 'Give it a short code').max(12),
    type: z.enum(LOCATION_TYPES),
    address: z.string().trim().max(200).optional().or(z.literal('')),
    phone: z.string().trim().max(30).optional().or(z.literal('')),

    managerMode: z.enum(MANAGER_MODES).default('NONE'),
    /** EXISTING — somebody who already has an account here. */
    managerId: z.string().trim().optional().or(z.literal('')),
    /** NEW — the details a fresh manager account is built from. */
    managerName: z.string().trim().max(80).optional().or(z.literal('')),
    managerEmail: z.string().trim().max(255).optional().or(z.literal('')),
    managerPhone: z.string().trim().max(30).optional().or(z.literal('')),
  })
  /*
   * Validated as a whole rather than field by field, so the message names the
   * thing that is actually missing. Checking `managerEmail` on its own would
   * either demand an email from someone who chose "nobody yet", or accept a
   * half-filled new manager and create an account with no way to sign in.
   */
  .superRefine((data, ctx) => {
    if (data.managerMode === 'EXISTING' && !data.managerId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['managerId'],
        message: 'Choose who manages this location',
      })
    }

    if (data.managerMode === 'NEW') {
      if (!data.managerName || data.managerName.length < 2) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['managerName'],
          message: "Enter the manager's name",
        })
      }
      // The email is their username — without it the account cannot be used.
      if (!data.managerEmail || !z.string().email().safeParse(data.managerEmail).success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['managerEmail'],
          message: 'Enter a valid email — it is what they sign in with',
        })
      }
    }
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

/** Renaming a shelf, or taking it out of use. The branch never moves. */
export const updateStorageLocationSchema = z.object({
  storageLocationId: z.string().min(1),
  name: z.string().trim().min(2, 'Name the storage area').max(60).optional(),
  isActive: z.boolean().optional(),
})
