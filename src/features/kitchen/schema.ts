import { z } from 'zod'

/*
 * Kept out of `actions.ts` on purpose: a `'use server'` module may export
 * nothing but async functions, and exporting a schema from one does not fail a
 * lint — it breaks every action in the file at runtime.
 */

export const saveStationSchema = z.object({
  stationId: z.string().cuid().optional(),
  branchId: z.string().min(1, 'Choose a location'),
  name: z.string().trim().min(2, 'Name the section').max(60),
  description: z.string().trim().max(200).optional().or(z.literal('')),
  printerName: z.string().trim().max(60).optional().or(z.literal('')),
  sortOrder: z.coerce.number().int().min(0).max(999).optional(),
  /** User ids of the cooks who work this section. */
  staffIds: z.array(z.string().cuid()).max(50).default([]),
})

export const setStationActiveSchema = z.object({
  stationId: z.string().cuid(),
  isActive: z.coerce.boolean(),
})

export const deleteStationSchema = z.object({
  stationId: z.string().cuid(),
})

/** Point every dish this branch sells at one section — the switch-on shortcut. */
export const assignAllDishesSchema = z.object({
  stationId: z.string().cuid(),
  /** Only fill dishes that have no section yet, rather than overwriting. */
  onlyUnassigned: z.coerce.boolean().default(true),
})

export const rejectOrderSchema = z.object({
  orderId: z.string().cuid(),
  reason: z.string().trim().max(200).optional().or(z.literal('')),
})

export const acceptOrderSchema = z.object({
  orderId: z.string().cuid(),
})

export const reassignItemSchema = z.object({
  itemId: z.string().cuid(),
  stationId: z.string().cuid(),
  reason: z.string().trim().max(200).optional().or(z.literal('')),
})

export const setOrderPrioritySchema = z.object({
  orderId: z.string().cuid(),
  priority: z.enum(['NORMAL', 'HIGH', 'URGENT']),
  reason: z.string().trim().max(200).optional().or(z.literal('')),
})
