import { z } from 'zod'

/*
 * Kept out of `actions.ts` on purpose: a `'use server'` module may export
 * nothing but async functions, and exporting a schema from one does not fail a
 * lint — it breaks every action in the file at runtime.
 */

export const createExperienceSchema = z.object({
  name: z.string().trim().min(2, 'Give this QR menu a name').max(60),
  branchId: z.string().min(1, 'Choose a location'),
  type: z.enum(['ORDERING', 'MENU_ONLY']).default('ORDERING'),
})

const fieldSchema = z.object({
  key: z.string().trim().min(1).max(64),
  label: z.string().trim().min(1, 'Name the question').max(64),
  type: z.enum(['TEXT', 'PHONE', 'EMAIL', 'DATE', 'NUMBER']).default('TEXT'),
  rule: z.enum(['HIDDEN', 'OPTIONAL', 'REQUIRED']).default('OPTIONAL'),
  categoryId: z.string().cuid().nullable().default(null),
  sortOrder: z.coerce.number().int().min(0).max(999).default(0),
})

export const saveExperienceSchema = z.object({
  experienceId: z.string().cuid(),
  name: z.string().trim().min(2, 'Give this QR menu a name').max(60),
  description: z.string().trim().max(200).optional().or(z.literal('')),
  branchId: z.string().min(1, 'Choose a location'),
  type: z.enum(['ORDERING', 'MENU_ONLY']),
  /** False for a delivery or takeaway code — there is no table to ask about. */
  askTable: z.coerce.boolean(),
  menuMode: z.enum(['ALL', 'CUSTOM']),
  menuCategoryIds: z.array(z.string().cuid()).max(200).default([]),
  menuFoodIds: z.array(z.string().cuid()).max(500).default([]),
  identifyCustomer: z.coerce.boolean(),
  askCustomerCategory: z.coerce.boolean(),
  customerCategoryIds: z.array(z.string().cuid()).max(50).default([]),
  showSearch: z.coerce.boolean(),
  showPrices: z.coerce.boolean(),
  showOffers: z.coerce.boolean(),
  /** Ask a delivery guest which of the owner's places it goes to. */
  askLocation: z.coerce.boolean().default(false),
  requireLocation: z.coerce.boolean().default(true),
  /** The owner's own words in the offers panel, beside the live coupons. */
  offerNote: z.string().trim().max(600).optional().or(z.literal('')),
  showLoyalty: z.coerce.boolean(),
  fields: z.array(fieldSchema).max(40).default([]),
})

export const experienceIdSchema = z.object({
  experienceId: z.string().cuid(),
})

export const setExperienceActiveSchema = z.object({
  experienceId: z.string().cuid(),
  isActive: z.coerce.boolean(),
})

/**
 * What a guest sends from the entry screen.
 *
 * `code` is the printed public code, never a row id (ar.md §25). Answers are
 * capped here as well as in the service — this endpoint is unauthenticated, so
 * the size limit belongs at the door as much as at the database.
 */
export const enterExperienceSchema = z.object({
  code: z.string().trim().min(1).max(32),
  categoryId: z.string().cuid().nullable().optional(),
  answers: z.record(z.string().max(64), z.string().max(200)).default({}),
})

export const recordOpenSchema = z.object({
  code: z.string().trim().min(1).max(32),
})
