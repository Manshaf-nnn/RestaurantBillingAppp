import { z } from 'zod'

export const tableSchema = z.object({
  id: z.string().cuid().optional(),
  number: z
    .string()
    .trim()
    .min(1, 'Table number is required')
    .max(10)
    .regex(/^[A-Za-z0-9-]+$/, 'Use letters and numbers only'),
  label: z.string().trim().max(40).optional().or(z.literal('')),
  area: z.string().trim().max(40).optional().or(z.literal('')),
  capacity: z.coerce.number().int().min(1, 'At least 1 seat').max(50),
  status: z.enum(['AVAILABLE', 'OCCUPIED', 'RESERVED', 'CLEANING', 'OUT_OF_SERVICE']).default('AVAILABLE'),
  notes: z.string().trim().max(200).optional().or(z.literal('')),
})
export type TableInput = z.infer<typeof tableSchema>

export const bulkTablesSchema = z.object({
  count: z.coerce.number().int().min(1).max(100),
  startFrom: z.coerce.number().int().min(1).max(999).default(1),
  capacity: z.coerce.number().int().min(1).max(50).default(4),
  area: z.string().trim().max(40).optional().or(z.literal('')),
})

export const updateTableStatusSchema = z.object({
  id: z.string().cuid(),
  status: z.enum([
    'AVAILABLE',
    'ORDERING',
    'EATING',
    'WAITING_BILL',
    'OCCUPIED',
    'RESERVED',
    'CLEANING',
    'OUT_OF_SERVICE',
  ]),
})

/** The everyday statuses a waiter can set from the floor. */
export const serviceTableStatusSchema = z.object({
  id: z.string().cuid(),
  status: z.enum(['AVAILABLE', 'ORDERING', 'EATING', 'WAITING_BILL', 'CLEANING']),
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
