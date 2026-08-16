import { z } from 'zod'

/**
 * One menu item as it arrives from any import route.
 *
 * Every import method — spreadsheet, menu photo scan, or a future one — reduces
 * to this shape before anything touches the database, so validation, category
 * creation and pricing live in one place instead of once per import method.
 *
 * Prices are in **major units** here (450.00, not 45000). That is what an owner
 * types into a spreadsheet and what a printed menu shows; the conversion to the
 * integer minor units the rest of the app uses happens at the boundary, once.
 */
export const importRowSchema = z.object({
  categoryName: z.string().trim().min(1, 'Category is required').max(60),
  name: z.string().trim().min(1, 'Name is required').max(80),
  description: z.string().trim().max(600).optional().default(''),
  price: z.coerce
    .number()
    .min(0, 'Price cannot be negative')
    .max(1_000_000, 'That price looks wrong'),
  isVeg: z.coerce.boolean().default(false),
  spiceLevel: z.enum(['NONE', 'MILD', 'MEDIUM', 'HOT', 'EXTRA_HOT']).default('NONE'),
  prepTimeMinutes: z.coerce.number().int().min(1).max(180).default(15),
  imageUrl: z.string().trim().max(2048).optional().default(''),
})

export type ImportRow = z.infer<typeof importRowSchema>

export const importMenuSchema = z.object({
  rows: z.array(importRowSchema).min(1, 'Nothing to import').max(500),
  /** Replace an existing item of the same name in the same category. */
  overwriteExisting: z.coerce.boolean().default(false),
})

/** A photo matched to a menu item by filename. */
export const photoMatchSchema = z.object({
  matches: z
    .array(z.object({ foodId: z.string().cuid(), imageUrl: z.string().min(1).max(2048) }))
    .min(1)
    .max(500),
})

export const conciergeRequestSchema = z.object({
  contactName: z.string().trim().min(1, 'Tell us who to reply to').max(80),
  contactPhone: z.string().trim().min(5, 'A phone number helps us reach you').max(24),
  contactEmail: z.string().email().max(255).optional().or(z.literal('')),
  itemCount: z.string().trim().max(40).optional().or(z.literal('')),
  notes: z.string().trim().max(1000).optional().or(z.literal('')),
})
