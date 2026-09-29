/**
 * A booking with a grace period cancels itself when the party is late — and
 * only then, only once, and never over a host or a party that got there first.
 *
 * Needs the database: set -a && source .env && set +a
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/reservation-no-show-test.ts
 */

import { prisma } from '../src/server/db/prisma'
import { AUTO_CANCEL_ACTOR, cancelNoShows } from '../src/features/floor/no-shows'
import { reservationSchema } from '../src/features/floor/schema'

let passed = 0
let failed = 0
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failed += 1
    console.log(`  ✗ ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
  }
}

async function main() {
  const restaurant = await prisma.restaurant.findFirstOrThrow({ select: { id: true }, orderBy: { createdAt: 'asc' } })
  const created: string[] = []
  const now = new Date()
  const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000)

  const make = async (label: string, reservedAt: Date, grace: number | null, status: 'PENDING' | 'CONFIRMED' | 'SEATED' = 'CONFIRMED') => {
    const row = await prisma.reservation.create({
      data: {
        restaurantId: restaurant.id,
        customerName: `No-show test ${label}`,
        customerPhone: '0771234567',
        partySize: 2,
        reservedAt,
        durationMinutes: 90,
        endsAt: new Date(reservedAt.getTime() + 90 * 60_000),
        status,
        noShowAfterMinutes: grace,
      },
    })
    created.push(row.id)
    return row
  }
  const statusOf = async (id: string) => prisma.reservation.findUniqueOrThrow({ where: { id } })

  try {
    console.log('\nThe form')
    const base = { customerName: 'Test', customerPhone: '0771234567', partySize: 2, reservedAt: '2026-10-01T19:00' }
    check('blank means never', reservationSchema.parse({ ...base, noShowAfterMinutes: '' }).noShowAfterMinutes === null)
    check('missing means never', reservationSchema.parse(base).noShowAfterMinutes === null)
    check('"30" is read as 30 minutes', reservationSchema.parse({ ...base, noShowAfterMinutes: '30' }).noShowAfterMinutes === 30)
    check('under 5 minutes is refused', !reservationSchema.safeParse({ ...base, noShowAfterMinutes: '2' }).success)
    check('over 4 hours is refused', !reservationSchema.safeParse({ ...base, noShowAfterMinutes: '300' }).success)

    console.log('\nThe sweep')
    const late = await make('late', minutesAgo(40), 30)
    const pendingLate = await make('pending late', minutesAgo(25), 20, 'PENDING')
    const inGrace = await make('in grace', minutesAgo(10), 30)
    const noGrace = await make('no grace', minutesAgo(120), null)
    const seated = await make('seated', minutesAgo(60), 15, 'SEATED')
    const future = await make('future', new Date(now.getTime() + 60 * 60_000), 15)

    const summary = await cancelNoShows(now)
    const lateAfter = await statusOf(late.id)
    check('a confirmed booking 40 min late with 30 min grace is cancelled', lateAfter.status === 'CANCELLED', summary)
    check('by the automatic actor', lateAfter.cancelledByName === AUTO_CANCEL_ACTOR, lateAfter.cancelledByName)
    check('with a reason that names the grace', lateAfter.cancelReason?.includes('30 minutes') === true, lateAfter.cancelReason)
    check('a pending booking past its grace is cancelled too', (await statusOf(pendingLate.id)).status === 'CANCELLED')
    check('one still inside its grace is left alone', (await statusOf(inGrace.id)).status === 'CONFIRMED')
    check('one with no grace is never touched', (await statusOf(noGrace.id)).status === 'CONFIRMED')
    check('a party that sat down is never cancelled', (await statusOf(seated.id)).status === 'SEATED')
    check('a future booking is left alone', (await statusOf(future.id)).status === 'CONFIRMED')

    const audited = await prisma.auditLog.count({
      where: { entity: 'Reservation', entityId: late.id, action: 'reservation.cancelled' },
    })
    check('the cancellation is in the audit log', audited === 1, audited)

    console.log('\nRunning again')
    const firstCancelledAt = lateAfter.cancelledAt?.getTime()
    // 10 min late with 30 min grace is due at +20; the next quarter-hour tick after that.
    await cancelNoShows(new Date(now.getTime() + 25 * 60_000))
    const again = await statusOf(late.id)
    check('does not cancel it a second time', again.cancelledAt?.getTime() === firstCancelledAt)
    check(
      'nor write a second audit entry',
      (await prisma.auditLog.count({ where: { entity: 'Reservation', entityId: late.id, action: 'reservation.cancelled' } })) === 1,
    )
    check('the in-grace booking is cancelled once its grace runs out', (await statusOf(inGrace.id)).status === 'CANCELLED')
  } finally {
    await prisma.auditLog.deleteMany({ where: { entity: 'Reservation', entityId: { in: created } } }).catch(() => undefined)
    await prisma.reservation.deleteMany({ where: { id: { in: created } } })
    console.log('\nTest bookings removed.')
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
