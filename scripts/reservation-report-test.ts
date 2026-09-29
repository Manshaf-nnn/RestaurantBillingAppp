/**
 * Reservations: cancelling, and the report (Reservations tab → Report).
 *
 * Pinned: a cancellation keeps the reason, the time and who did it, and the
 * table stops being held; only a booking that holds a table can be
 * cancelled, and two hosts cancelling together record one cancellation; the
 * report's bookings, covers, honoured, cancelled and no-show figures add up
 * and the trend sums to the total; the branch narrows; another restaurant's
 * diary never shows.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/reservation-report-test.ts
 */
import { prisma } from '../src/server/db/prisma'
import { cancelReservation, upsertReservation } from '../src/features/floor/reservations'
import { reservationsHolding } from '../src/features/floor/table-state-server'
import { getReservationReport } from '../src/features/floor/reservation-report'

let passed = 0
let failed = 0
function check(name: string, ok: boolean, detail = '') {
  if (ok) { passed += 1; console.log(`  ✓ ${name}`) }
  else { failed += 1; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}
async function refuses(name: string, run: () => Promise<unknown>, pattern: RegExp) {
  try { await run(); check(name, false, 'it was allowed') }
  catch (error) { const m = error instanceof Error ? error.message : String(error); check(name, pattern.test(m), `wrong reason: ${m}`) }
}

const stamp = Date.now().toString(36)
const restaurantIds: string[] = []

async function main() {
  const restaurant = await prisma.restaurant.create({
    data: { name: `Diary ${stamp}`, slug: `diary-${stamp}`, status: 'ACTIVE', isActive: true, timezone: 'Asia/Colombo', currency: 'LKR' },
  })
  restaurantIds.push(restaurant.id)
  const other = await prisma.restaurant.create({
    data: { name: `Other ${stamp}`, slug: `odiary-${stamp}`, status: 'ACTIVE', isActive: true, timezone: 'Asia/Colombo', currency: 'LKR' },
  })
  restaurantIds.push(other.id)
  const main = await prisma.branch.create({ data: { restaurantId: restaurant.id, name: 'Main', code: 'MAIN', isDefault: true } })
  const kandy = await prisma.branch.create({ data: { restaurantId: restaurant.id, name: 'Kandy', code: 'KDY' } })
  const t4 = await prisma.restaurantTable.create({ data: { restaurantId: restaurant.id, branchId: main.id, number: '4', capacity: 4 } })
  const t7 = await prisma.restaurantTable.create({ data: { restaurantId: restaurant.id, branchId: kandy.id, number: '7', capacity: 6 } })

  const now = new Date()
  const at = (minutes: number) => new Date(now.getTime() + minutes * 60_000)
  const book = (data: Partial<Parameters<typeof upsertReservation>[0]['data']> & { reservedAt: Date }, restaurantId = restaurant.id) =>
    upsertReservation({
      restaurantId,
      data: {
        customerName: 'Guest', customerPhone: '0771234567', customerEmail: null, tableId: null, branchId: main.id,
        partySize: 2, durationMinutes: 90, status: 'CONFIRMED', notes: null, ...data,
      },
    })

  console.log('\n── 1. Cancelling releases the table and keeps the reason ──')
  const tonight = await book({ customerName: 'Nila', tableId: t4.id, reservedAt: at(30), partySize: 4 })
  const heldBefore = await reservationsHolding(prisma, { restaurantId: restaurant.id })
  check('the booked table is held', heldBefore.get(t4.id)?.id === tonight.id)
  const cancelled = await cancelReservation({ restaurantId: restaurant.id, id: tonight.id, reason: 'Guest called', actorName: 'Host' })
  check('status is CANCELLED with the reason, time and who', cancelled.status === 'CANCELLED' && cancelled.cancelReason === 'Guest called' && cancelled.cancelledByName === 'Host' && cancelled.cancelledAt !== null)
  const heldAfter = await reservationsHolding(prisma, { restaurantId: restaurant.id })
  check('the table is no longer held', !heldAfter.has(t4.id))
  check('the row still exists', (await prisma.reservation.count({ where: { id: tonight.id } })) === 1)
  await refuses('cancelling it again is refused', () => cancelReservation({ restaurantId: restaurant.id, id: tonight.id, reason: 'again', actorName: null }), /already cancelled/)
  await refuses('a reason is required', () => cancelReservation({ restaurantId: restaurant.id, id: tonight.id, reason: ' ', actorName: null }), /why/)
  const done = await book({ customerName: 'Done', reservedAt: at(-600), status: 'COMPLETED' })
  await refuses('a completed booking cannot be cancelled', () => cancelReservation({ restaurantId: restaurant.id, id: done.id, reason: 'late', actorName: null }), /cannot be cancelled/)
  await refuses("another restaurant's booking is not found", () => cancelReservation({ restaurantId: other.id, id: done.id, reason: 'no such booking', actorName: null }), /not found/i)
  check('the table can be booked again for the same slot', (await book({ customerName: 'Next', tableId: t4.id, reservedAt: at(30), partySize: 3 })).status === 'CONFIRMED')

  console.log('\n── 2. Two hosts cancelling at once ──')
  const race = await book({ customerName: 'Race', reservedAt: at(120) })
  const results = await Promise.allSettled([
    cancelReservation({ restaurantId: restaurant.id, id: race.id, reason: 'Guest called (A)', actorName: 'A' }),
    cancelReservation({ restaurantId: restaurant.id, id: race.id, reason: 'Guest called (B)', actorName: 'B' }),
  ])
  check('exactly one cancellation is recorded', results.filter((r) => r.status === 'fulfilled').length === 1, results.map((r) => r.status).join(','))

  console.log('\n── 3. The report adds up ──')
  await book({ customerName: 'Seated', reservedAt: at(-200), status: 'SEATED', partySize: 5 })
  await book({ customerName: 'Ghost', reservedAt: at(-300), status: 'NO_SHOW', partySize: 2, tableId: t7.id, branchId: kandy.id })
  await book({ customerName: 'Elsewhere', reservedAt: at(10) }, other.id)
  const window = { from: at(-24 * 60), to: at(24 * 60), previous: { from: at(-72 * 60), to: at(-24 * 60 - 1) }, timeZone: 'Asia/Colombo', now }
  const report = await getReservationReport({ restaurantId: restaurant.id, branchIds: null, ...window })
  // tonight(cancelled), done(completed), Next(confirmed), Race(cancelled), Seated, Ghost(no-show) = 6
  check('six bookings in the window', report.bookings === 6, String(report.bookings))
  check('covers are the sum of party sizes', report.covers === 4 + 2 + 3 + 2 + 5 + 2, String(report.covers))
  check('two cancelled, one no-show', report.cancelled === 2 && report.noShows === 1)
  check('honoured = seated + completed', report.honoured === 2)
  check('honoured rate is over the non-cancelled', report.honouredRate === 2 / 4, String(report.honouredRate))
  check('one still to come (the confirmed one)', report.upcoming === 1, String(report.upcoming))
  check('the trend sums to the total', report.trend.reduce((s, d) => s + d.bookings, 0) === 6)
  check('status shares sum to one', Math.abs(report.byStatus.reduce((s, r) => s + r.share, 0) - 1) < 1e-9)
  check('the cancellation list carries the reason', report.cancellations.some((c) => c.guest === 'Nila' && c.reason === 'Guest called' && c.by === 'Host'))
  check('table 4 is the most booked', report.byTable[0]?.table === '4' && report.byTable[0].bookings === 2)
  check("the other restaurant's booking is not counted", !report.cancellations.some((c) => c.guest === 'Elsewhere') && report.bookings === 6)
  const kandyOnly = await getReservationReport({ restaurantId: restaurant.id, branchIds: [kandy.id], ...window })
  check('the branch narrows: Kandy has only the no-show', kandyOnly.bookings === 1 && kandyOnly.noShows === 1)
}

main()
  .catch((error) => { console.error(error); failed += 1 })
  .finally(async () => {
    for (const id of restaurantIds) await prisma.restaurant.delete({ where: { id } }).catch((error) => console.error('cleanup', error.message))
    await prisma.$disconnect()
    console.log(`\n${passed} passed, ${failed} failed`)
    process.exit(failed > 0 ? 1 : 0)
  })
