import 'server-only'

import { AUDIT_ACTIONS, audit } from '@/server/audit'
import { prisma } from '@/server/db/prisma'
import { realtime } from '@/server/realtime/emitter'
import { cancelReservation } from './reservations'

/** Who the diary and the report say cancelled it. */
export const AUTO_CANCEL_ACTOR = 'Automatic (no-show)'

/** The longest grace a booking can carry — the schema's cap. Bounds the scan. */
const MAX_GRACE_MINUTES = 240

/**
 * Cancel every booking whose party is later than its own grace period.
 *
 * Only PENDING and CONFIRMED: a SEATED booking is a party that came — the
 * first order at the table seats it — and anything else is already settled.
 * It goes through `cancelReservation`, the same compare-and-swap a host's
 * Cancel uses, so a host cancelling or the party sitting down at the same
 * moment wins cleanly and this skips that booking rather than overwriting it.
 *
 * Run by the job scheduler every quarter hour, so a booking is cancelled up to
 * fifteen minutes after its grace runs out — never before it.
 */
export async function cancelNoShows(now: Date = new Date()): Promise<string> {
  const candidates = await prisma.reservation.findMany({
    where: {
      status: { in: ['PENDING', 'CONFIRMED'] },
      noShowAfterMinutes: { not: null },
      reservedAt: {
        // Nothing can be due before its own start plus the shortest grace,
        // and nothing older than the longest grace needs looking at twice.
        lte: new Date(now.getTime() - 5 * 60_000),
        gte: new Date(now.getTime() - (MAX_GRACE_MINUTES + 24 * 60) * 60_000),
      },
    },
    select: {
      id: true,
      restaurantId: true,
      branchId: true,
      tableId: true,
      customerName: true,
      reservedAt: true,
      noShowAfterMinutes: true,
    },
    orderBy: { reservedAt: 'asc' },
    take: 500,
  })

  const due = candidates.filter(
    (r) => r.noShowAfterMinutes !== null && r.reservedAt.getTime() + r.noShowAfterMinutes * 60_000 <= now.getTime(),
  )

  let cancelled = 0
  for (const booking of due) {
    const reason = `No-show: the party had not arrived ${booking.noShowAfterMinutes} minutes after the booking time`
    try {
      const record = await cancelReservation({
        restaurantId: booking.restaurantId,
        id: booking.id,
        reason,
        actorName: AUTO_CANCEL_ACTOR,
        now,
      })
      cancelled += 1

      await audit({
        restaurantId: booking.restaurantId,
        branchId: booking.branchId,
        actorName: AUTO_CANCEL_ACTOR,
        action: AUDIT_ACTIONS.RESERVATION_CANCELLED,
        entity: 'Reservation',
        entityId: booking.id,
        after: { status: 'CANCELLED', reason, guest: booking.customerName, automatic: true },
      })

      // The floor plan and the waiter board read Reserved from the diary.
      if (record.tableId) {
        const table = await prisma.restaurantTable.findUnique({
          where: { id: record.tableId },
          select: { number: true, branchId: true, status: true },
        })
        realtime.tableUpdated(booking.restaurantId, {
          id: record.tableId,
          number: table?.number ?? '',
          status: table?.status ?? 'AVAILABLE',
          branchId: table?.branchId ?? null,
        })
      }
    } catch {
      // Seated or cancelled by somebody in the meantime — theirs stands.
    }
  }

  return `${cancelled} no-show booking${cancelled === 1 ? '' : 's'} cancelled`
}
