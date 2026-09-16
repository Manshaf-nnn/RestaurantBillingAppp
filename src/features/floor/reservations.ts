import 'server-only'

import type { Prisma, Reservation, ReservationStatus } from '@prisma/client'

import { ConflictError, NotFoundError } from '@/lib/errors'
import { prisma } from '@/server/db/prisma'
import { reservationsInWindow } from './table-state-server'

/**
 * Bookings (abc.md §4).
 *
 * ── Start, duration, end ────────────────────────────────────────────────────
 *
 * A booking has always stored a start and a duration. The end was never
 * written, so nothing could ask the database "what is booked on table 4 at
 * eight" without doing the arithmetic in the application — and so nothing
 * did, and two bookings on one table at one time were accepted without a
 * word. `endsAt` is now written on every save (and was backfilled), and it is
 * what the overlap check and the Reserved window read.
 *
 * ── The conflict rules ──────────────────────────────────────────────────────
 *
 * A booking that HOLDS a table (PENDING, CONFIRMED, SEATED) must not overlap
 * another holding booking on the same table: `[start, end)` intervals, so a
 * booking ending at 11:30 and one starting at 11:30 are neighbours, not a
 * clash. A cancelled, completed or no-show booking holds nothing and blocks
 * nothing. The party must fit the table. The table row is locked for the
 * check-and-write, so two hosts booking the same slot at the same moment are
 * serialised rather than both succeeding.
 */

/** The statuses under which a booking holds its table. */
export const HOLDING_STATUSES: ReservationStatus[] = ['PENDING', 'CONFIRMED', 'SEATED']

export interface ReservationWrite {
  customerName: string
  customerPhone: string
  customerEmail: string | null
  tableId: string | null
  branchId: string | null
  partySize: number
  reservedAt: Date
  durationMinutes: number
  status: ReservationStatus
  notes: string | null
}

export function reservationEnd(reservedAt: Date, durationMinutes: number): Date {
  return new Date(reservedAt.getTime() + durationMinutes * 60_000)
}

export async function upsertReservation(params: {
  restaurantId: string
  id?: string | null
  data: ReservationWrite
}): Promise<Reservation> {
  const { restaurantId, data } = params
  const endsAt = reservationEnd(data.reservedAt, data.durationMinutes)

  return prisma.$transaction(async (tx) => {
    if (data.tableId) {
      // One host at a time on this table's diary.
      const [table] = await tx.$queryRaw<Array<{ id: string; number: string; capacity: number }>>`
        SELECT id, number, capacity FROM restaurant_tables
         WHERE id = ${data.tableId} AND "restaurantId" = ${restaurantId}
         FOR UPDATE
      `
      if (!table) throw new NotFoundError('Table')

      if (HOLDING_STATUSES.includes(data.status)) {
        if (table.capacity < data.partySize) {
          throw new ConflictError(
            `Table ${table.number} seats ${table.capacity}, and this party is ${data.partySize}`,
          )
        }
        const clash = await tx.reservation.findFirst({
          where: {
            restaurantId,
            tableId: data.tableId,
            status: { in: HOLDING_STATUSES },
            ...(params.id ? { id: { not: params.id } } : {}),
            reservedAt: { lt: endsAt },
            endsAt: { gt: data.reservedAt },
          },
          select: { customerName: true, reservedAt: true, endsAt: true },
          orderBy: { reservedAt: 'asc' },
        })
        if (clash) {
          throw new ConflictError(
            `Table ${table.number} is already booked for ${clash.customerName} at that time`,
          )
        }
      }
    }

    const payload: Prisma.ReservationUncheckedUpdateInput = { ...data, endsAt }
    return params.id
      ? tx.reservation.update({ where: { id: params.id }, data: payload })
      : tx.reservation.create({ data: { ...data, endsAt, restaurantId } })
  })
}

/**
 * The booked party has sat down: the first order at a table whose booking
 * window covers now turns that booking SEATED (abc.md §4), so the table stops
 * reading Reserved and the diary says who actually came. Inside the order's
 * own transaction; nothing to do when no booking is in its window.
 */
export async function seatReservation(
  tx: Prisma.TransactionClient,
  params: { restaurantId: string; tableId: string; now?: Date },
): Promise<string | null> {
  const held = await reservationsInWindow(tx, {
    restaurantId: params.restaurantId,
    tableIds: [params.tableId],
    now: params.now,
  })
  const booking = held.get(params.tableId)
  if (!booking) return null
  await tx.reservation.update({ where: { id: booking.id }, data: { status: 'SEATED' } })
  return booking.id
}
