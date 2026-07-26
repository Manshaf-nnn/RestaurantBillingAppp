import { z } from 'zod'

const money = z.coerce.number().int().min(0, 'Must be zero or more').max(100_000_000)

export const categorySchema = z.object({
  id: z.string().cuid().optional(),
  name: z.string().trim().min(1, 'Name is required').max(60),
  description: z.string().trim().max(300).optional().or(z.literal('')),
  imageUrl: z.string().url().max(2048).optional().or(z.literal('')),
  icon: z.string().trim().max(40).optional().or(z.literal('')),
  sortOrder: z.coerce.number().int().min(0).max(999).default(0),
  isVisible: z.coerce.boolean().default(true),
})
export type CategoryInput = z.infer<typeof categorySchema>

export const reorderCategoriesSchema = z.object({
  ids: z.array(z.string().cuid()).min(1).max(200),
})

export const variantOptionSchema = z.object({
  id: z.string().cuid().optional(),
  name: z.string().trim().min(1, 'Option name is required').max(50),
  priceDelta: z.coerce.number().int().min(-100_000_000).max(100_000_000).default(0),
  isDefault: z.coerce.boolean().default(false),
  isAvailable: z.coerce.boolean().default(true),
  sortOrder: z.coerce.number().int().min(0).default(0),
})

export const variantGroupSchema = z.object({
  id: z.string().cuid().optional(),
  name: z.string().trim().min(1, 'Group name is required').max(50),
  kind: z.enum(['VARIANT', 'ADDON']).default('VARIANT'),
  isRequired: z.coerce.boolean().default(false),
  minSelect: z.coerce.number().int().min(0).max(20).default(0),
  maxSelect: z.coerce.number().int().min(1).max(20).default(1),
  sortOrder: z.coerce.number().int().min(0).default(0),
  options: z.array(variantOptionSchema).min(1, 'Add at least one option').max(30),
})

export const foodSchema = z
  .object({
    id: z.string().cuid().optional(),
    categoryId: z.string().cuid('Choose a category'),
    name: z.string().trim().min(1, 'Name is required').max(80),
    description: z.string().trim().max(600).optional().or(z.literal('')),
    imageUrl: z.string().url('Enter a valid image URL').max(2048).optional().or(z.literal('')),
    price: money,
    discountPrice: money.optional().nullable(),
    costPrice: money.default(0),
    prepTimeMinutes: z.coerce.number().int().min(1, 'At least 1 minute').max(180).default(15),
    calories: z.coerce.number().int().min(0).max(10_000).optional().nullable(),
    isVeg: z.coerce.boolean().default(false),
    spiceLevel: z.enum(['NONE', 'MILD', 'MEDIUM', 'HOT', 'EXTRA_HOT']).default('NONE'),
    isAvailable: z.coerce.boolean().default(true),
    isRecommended: z.coerce.boolean().default(false),
    isPopular: z.coerce.boolean().default(false),
    tags: z.array(z.string().trim().max(24)).max(12).default([]),
    allergens: z.array(z.string().trim().max(24)).max(12).default([]),
    sortOrder: z.coerce.number().int().min(0).max(9999).default(0),
    happyHourPrice: money.optional().nullable(),
    happyHourStartMin: z.coerce.number().int().min(0).max(1439).optional().nullable(),
    happyHourEndMin: z.coerce.number().int().min(0).max(1439).optional().nullable(),
    happyHourDays: z.array(z.coerce.number().int().min(0).max(6)).max(7).default([]),
    variantGroups: z.array(variantGroupSchema).max(10).default([]),
    recipe: z
      .array(
        z.object({
          itemId: z.string().cuid(),
          quantity: z.coerce.number().positive('Quantity must be greater than zero'),
        }),
      )
      .max(40)
      .default([]),
  })
  .refine(
    (data) => data.discountPrice === null || data.discountPrice === undefined || data.discountPrice < data.price,
    { message: 'Offer price must be lower than the regular price', path: ['discountPrice'] },
  )
  .refine(
    (data) =>
      data.happyHourPrice === null ||
      data.happyHourPrice === undefined ||
      (data.happyHourStartMin !== null &&
        data.happyHourStartMin !== undefined &&
        data.happyHourEndMin !== null &&
        data.happyHourEndMin !== undefined),
    { message: 'Set a start and end time for happy hour pricing', path: ['happyHourStartMin'] },
  )
export type FoodInput = z.infer<typeof foodSchema>

export const toggleAvailabilitySchema = z.object({
  id: z.string().cuid(),
  isAvailable: z.coerce.boolean(),
})

export const menuFilterSchema = z.object({
  search: z.string().trim().max(80).optional(),
  categoryId: z.string().optional(),
  availability: z.enum(['ALL', 'AVAILABLE', 'UNAVAILABLE']).default('ALL'),
  diet: z.enum(['ALL', 'VEG', 'NON_VEG']).default('ALL'),
})
export type MenuFilterInput = z.infer<typeof menuFilterSchema>
