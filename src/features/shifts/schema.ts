import { z } from 'zod'

/**
 * What the shift screens post (shifthandover.md §1–3).
 *
 * Kept out of the actions module because a `'use server'` file may export
 * nothing but async functions.
 */

/** "HH:mm", 24-hour. The restaurant's own wall clock; never a zone. */
export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/

/** "YYYY-MM-DD". A rota day is a calendar day, not an instant. */
export const DATE_KEY_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/

/*
 * CASHIER stays alongside POS (staff.A.md §10) so a template saved before the
 * rename still validates. Nothing offers it — `templates-manager.tsx` lists
 * POS — but a schema that refused a stored value would make an old template
 * uneditable rather than simply out of date.
 */
const ROLES = [
  'OWNER', 'MANAGER', 'KITCHEN', 'POS', 'CASHIER', 'WAITER', 'ADMIN',
  'INVENTORY_MANAGER', 'PURCHASING_MANAGER', 'WAREHOUSE_STAFF', 'STOCK_KEEPER', 'ACCOUNTANT',
] as const

const templateFields = {
  name: z.string().trim().min(2, 'Give the shift a name').max(60),
  startTime: z.string().regex(TIME_RE, 'Start time must be HH:mm'),
  endTime: z.string().regex(TIME_RE, 'End time must be HH:mm'),
  roles: z.array(z.enum(ROLES)).min(1, 'Pick at least one role'),
  /** Empty = every location. */
  branchId: z.string().min(1).optional().or(z.literal('')),
  sortOrder: z.number().int().min(0).max(999).optional(),
}

export const createShiftTemplateSchema = z.object(templateFields)

export const updateShiftTemplateSchema = z.object({
  templateId: z.string().min(1),
  ...templateFields,
})

export const setShiftTemplateActiveSchema = z.object({
  templateId: z.string().min(1),
  isActive: z.boolean(),
})

export const assignShiftSchema = z.object({
  userId: z.string().min(1, 'Pick who is working'),
  templateId: z.string().min(1, 'Pick a shift'),
  branchId: z.string().min(1, 'Pick a location'),
  date: z.string().regex(DATE_KEY_RE, 'Pick a day'),
  notes: z.string().trim().max(300).optional().or(z.literal('')),
})

export const updateShiftAssignmentSchema = z.object({
  assignmentId: z.string().min(1),
  templateId: z.string().min(1).optional(),
  date: z.string().regex(DATE_KEY_RE).optional(),
  notes: z.string().trim().max(300).optional().or(z.literal('')),
})

export const cancelShiftAssignmentSchema = z.object({
  assignmentId: z.string().min(1),
  reason: z.string().trim().min(2, 'Say why').max(300),
})

export const startAssignedShiftSchema = z.object({
  assignmentId: z.string().min(1),
})

export type CreateShiftTemplateInput = z.infer<typeof createShiftTemplateSchema>
export type AssignShiftInput = z.infer<typeof assignShiftSchema>
