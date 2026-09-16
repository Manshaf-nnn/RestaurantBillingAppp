import { z } from 'zod'

export const tableSchema = z.object({
  id: z.string().cuid().optional(),
  /*
   * Which branch this table stands in.
   *
   * The form sends it now. Blank falls back to the branch the switcher is
   * showing (`actingBranchId`), so a single-site restaurant never has to think
   * about it — but it no longer silently means "the default branch", which is
   * what put every table in this system at Main.
   */
  branchId: z.string().min(1).optional().or(z.literal('')),
  number: z
    .string()
    .trim()
    .min(1, 'Table number is required')
    .max(10)
    .regex(/^[A-Za-z0-9-]+$/, 'Use letters and numbers only'),
  label: z.string().trim().max(40).optional().or(z.literal('')),
  area: z.string().trim().max(40).optional().or(z.literal('')),
  capacity: z.coerce.number().int().min(1, 'At least 1 seat').max(50),
  // Empty or Occupied (abc.md §3). Reserved comes from bookings; out of
  // service is `isActive`, toggled from the card.
  status: z.enum(['AVAILABLE', 'OCCUPIED']).default('AVAILABLE'),
  notes: z.string().trim().max(200).optional().or(z.literal('')),
})
export type TableInput = z.infer<typeof tableSchema>

export const bulkTablesSchema = z.object({
  branchId: z.string().min(1).optional().or(z.literal('')),
  count: z.coerce.number().int().min(1).max(100),
  startFrom: z.coerce.number().int().min(1).max(999).default(1),
  capacity: z.coerce.number().int().min(1).max(50).default(4),
  area: z.string().trim().max(40).optional().or(z.literal('')),
})

/**
 * The two states a person may set (abc.md §3). ORDERING / EATING / WAITING_BILL
 * / CLEANING / OUT_OF_SERVICE are gone from the vocabulary: the first three
 * were "occupied" said three ways, cleaning is not a state the system can
 * know, and out of service is `isActive`. RESERVED is never posted — a
 * booking in its window makes a table Reserved by itself.
 */
export const updateTableStatusSchema = z.object({
  id: z.string().cuid(),
  status: z.enum(['AVAILABLE', 'OCCUPIED']),
})

/** What a waiter sets from the floor: seat a walk-in, or clear a table. */
export const serviceTableStatusSchema = z.object({
  id: z.string().cuid(),
  status: z.enum(['AVAILABLE', 'OCCUPIED']),
})

export const reservationSchema = z.object({
  id: z.string().cuid().optional(),
  customerName: z.string().trim().min(2, 'Name is required').max(60),
  customerPhone: z.string().trim().min(7, 'Phone is required').max(20),
  customerEmail: z.string().email().max(255).optional().or(z.literal('')),
  tableId: z.string().cuid().optional().or(z.literal('')),
  partySize: z.coerce.number().int().min(1).max(50),
  reservedAt: z.string().min(1, 'Choose a date and time'),
  durationMinutes: z.coerce.number().int().min(30).max(360).default(90),
  status: z
    .enum(['PENDING', 'CONFIRMED', 'SEATED', 'COMPLETED', 'CANCELLED', 'NO_SHOW'])
    .default('PENDING'),
  notes: z.string().trim().max(300).optional().or(z.literal('')),
})
export type ReservationInput = z.infer<typeof reservationSchema>

/** Moving a table between locations. Deliberate, and its own act. */
export const moveTableSchema = z.object({
  id: z.string().cuid(),
  branchId: z.string().min(1, 'Choose a location'),
})
export type MoveTableInput = z.infer<typeof moveTableSchema>

/** Moving a sitting from an occupied table to an empty one (abc.md §3). */
export const swapTableSchema = z.object({
  fromTableId: z.string().cuid(),
  toTableId: z.string().cuid(),
})
export type SwapTableInput = z.infer<typeof swapTableSchema>

export const swapTargetsSchema = z.object({ fromTableId: z.string().cuid() })
