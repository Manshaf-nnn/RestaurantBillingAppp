/**
 * Bookings hold a table for a window, and two cannot hold the same one
 * (abc.md §4).
 *
 *   - a booking stores its end (start + duration) and the overlap rule reads
 *     it: `[start, end)` — a booking ending at 11:30 and one starting at
 *     11:30 are neighbours, not a clash;
 *   - only PENDING / CONFIRMED / SEATED hold the table; a cancelled booking
 *     blocks nothing;
 *   - the party must fit the table;
 *   - editing a booking keeps its own slot (it does not clash with itself)
 *     and re-computes its end when the duration changes;
 *   - the table reads Reserved in the booking's window, and the party's
 *     first order marks the booking SEATED — a booking outside its window
 *     is untouched by an order.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/reservation-conflict-test.ts
 */
import { prisma } from '../src/server/db/prisma'
import { reservationEnd, upsertReservation } from '../src/features/floor/reservations'
import { tableStatesFor } from '../src/features/floor/table-state-server'
import { cancelOrder, placeOrder } from '../src/features/orders/service'

let passed = 0
let failed = 0

function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failed += 1
    console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`)
  }
}

async function refuses(name: string, run: () => Promise<unknown>, expect: RegExp) {
  try {
    await run()
    check(name, false, 'it was allowed')
  } catch (error) {
    const code = (error as { code?: string }).code ?? ''
    const message = error instanceof Error ? error.message : String(error)
    check(name, expect.test(`${code} ${message}`), `wrong reason: ${code} ${message}`)
  }
}

const stamp = Date.now().toString(36)
const MIN = 60_000
let restaurantId: string | null = null

async function cleanup(id: string) {
  await prisma.orderEvent.deleteMany({ where: { order: { restaurantId: id } } })
  await prisma.orderItem.deleteMany({ where: { order: { restaurantId: id } } })
  await prisma.order.deleteMany({ where: { restaurantId: id } })
  await prisma.tableSession.deleteMany({ where: { restaurantId: id } })
  await prisma.reservation.deleteMany({ where: { restaurantId: id } })
  await prisma.restaurantTable.deleteMany({ where: { restaurantId: id } })
  await prisma.foodBranch.deleteMany({ where: { restaurantId: id } })
  await prisma.food.deleteMany({ where: { restaurantId: id } })
  await prisma.category.deleteMany({ where: { restaurantId: id } })
  await prisma.restaurant.deleteMany({ where: { id } })
}

async function main() {
  const restaurant = await prisma.restaurant.create({
    data: {
      name: `Book ${stamp}`, slug: `book-${stamp}`, status: 'ACTIVE', isActive: true,
      timezone: 'Asia/Colombo', currency: 'LKR',
    },
  })
  restaurantId = restaurant.id
  const branch = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Main', code: 'MAIN', isDefault: true },
  })
  const t1 = await prisma.restaurantTable.create({
    data: { restaurantId: restaurant.id, branchId: branch.id, number: '1', capacity: 4 },
  })
  const t2 = await prisma.restaurantTable.create({
    data: { restaurantId: restaurant.id, branchId: branch.id, number: '2', capacity: 2 },
  })
  const category = await prisma.category.create({
    data: { restaurantId: restaurant.id, name: 'Mains', slug: `m-${stamp}` },
  })
  const rice = await prisma.food.create({
    data: { restaurantId: restaurant.id, categoryId: category.id, name: 'Rice', slug: `rice-${stamp}`, price: 50_000, isAvailable: true },
  })
  await prisma.foodBranch.create({
    data: { restaurantId: restaurant.id, foodId: rice.id, branchId: branch.id, isAvailable: true },
  })

  // Tomorrow at 10:00 UTC, so nothing here is in today's Reserved window.
  const base = new Date(Date.now() + 24 * 60 * MIN)
  base.setUTCHours(10, 0, 0, 0)
  const at = (offsetMinutes: number) => new Date(base.getTime() + offsetMinutes * MIN)
  const book = (extra: Partial<Parameters<typeof upsertReservation>[0]['data']> & { id?: string }) =>
    upsertReservation({
      restaurantId: restaurant.id,
      id: extra.id ?? null,
      data: {
        customerName: 'Perera', customerPhone: '0771111111', customerEmail: null,
        tableId: t1.id, branchId: branch.id, partySize: 2,
        reservedAt: at(0), durationMinutes: 90, status: 'CONFIRMED', notes: null,
        ...extra,
      },
    })

  console.log('\n── 1. Start, duration, end ──')
  const a = await book({})
  {
    check('a booking stores its end', a.endsAt?.getTime() === reservationEnd(at(0), 90).getTime())
    check('ninety minutes after its start', a.endsAt?.getTime() === at(90).getTime())
  }

  console.log('\n── 2. One table, one booking at a time ──')
  {
    await refuses('an overlapping booking on the same table is refused', () => book({ customerName: 'Silva', reservedAt: at(60) }), /CONFLICT|already booked/i)
    await refuses('even one that starts before and ends inside it', () => book({ customerName: 'Silva', reservedAt: at(-60) }), /CONFLICT|already booked/i)
    const next = await book({ customerName: 'Silva', reservedAt: at(90) })
    check('one starting exactly when it ends is a neighbour, not a clash', next.status === 'CONFIRMED')
    const other = await book({ customerName: 'Fernando', tableId: t2.id, reservedAt: at(0) })
    check('the same slot on another table is fine', other.tableId === t2.id)
    const free = await book({ customerName: 'Anyone', tableId: null, reservedAt: at(0) })
    check('a booking with no table yet holds nothing', free.tableId === null)
  }

  console.log('\n── 3. Only a holding booking blocks ──')
  {
    const cancelled = await book({ customerName: 'Gone', reservedAt: at(180), status: 'CANCELLED' })
    check('a cancelled booking is stored', cancelled.status === 'CANCELLED')
    const over = await book({ customerName: 'Came', reservedAt: at(180) })
    check('and does not block the slot', over.status === 'CONFIRMED')
    await refuses('but a pending one does', () => book({ customerName: 'Late', reservedAt: at(200) }), /CONFLICT/)
  }

  console.log('\n── 4. The party has to fit ──')
  {
    await refuses('a party of four on a two-seat table', () => book({ customerName: 'Big', tableId: t2.id, partySize: 4, reservedAt: at(300) }), /CONFLICT|seats 2/i)
    const fits = await book({ customerName: 'Pair', tableId: t2.id, partySize: 2, reservedAt: at(300) })
    check('a party of two fits', fits.partySize === 2)
  }

  console.log('\n── 5. Editing keeps your own slot and re-computes the end ──')
  {
    const same = await book({ id: a.id, durationMinutes: 90 })
    check('the booking does not clash with itself', same.id === a.id && same.endsAt?.getTime() === at(90).getTime())
    // The neighbour starts at +90, so stretching past it is a real clash.
    await refuses('but it cannot stretch into the neighbour', () => book({ id: a.id, durationMinutes: 120 }), /CONFLICT/)
    const shorter = await book({ id: a.id, durationMinutes: 60 })
    check('and its end follows a shorter duration', shorter.endsAt?.getTime() === at(60).getTime())
    const back = await book({ id: a.id, durationMinutes: 90 })
    check('and back again', back.endsAt?.getTime() === at(90).getTime())
  }

  console.log('\n── 6. Reserved in the window; the first order seats the party ──')
  {
    const soon = await book({ customerName: 'Arriving', reservedAt: new Date(Date.now() + 5 * MIN) })
    const before = await tableStatesFor(prisma, { restaurantId: restaurant.id, tableIds: [t1.id] })
    check('the table reads Reserved five minutes before', before.get(t1.id)?.state === 'RESERVED' && before.get(t1.id)?.reservation?.customerName === 'Arriving')

    const order = await placeOrder({
      restaurantId: restaurant.id, branchId: branch.id, tableId: t1.id, type: 'DINE_IN',
      items: [{ foodId: rice.id, quantity: 1, optionIds: [] }],
      customerName: 'Arriving', customerPhone: '0771111111',
    })
    const seated = await prisma.reservation.findUniqueOrThrow({ where: { id: soon.id } })
    check('the first order marks the booking Seated', seated.status === 'SEATED', seated.status)
    const after = await tableStatesFor(prisma, { restaurantId: restaurant.id, tableIds: [t1.id] })
    check('and the table reads Occupied', after.get(t1.id)?.state === 'OCCUPIED')

    const tomorrow = await prisma.reservation.findUniqueOrThrow({ where: { id: a.id } })
    check("tomorrow's booking on the same table is untouched", tomorrow.status === 'CONFIRMED')
    await cancelOrder({ restaurantId: restaurant.id, orderId: order.id, reason: 'Test' })
  }
}

main()
  .catch((error) => {
    console.error(error)
    failed += 1
  })
  .finally(async () => {
    if (restaurantId) await cleanup(restaurantId).catch((error) => console.error('cleanup failed', error))
    await prisma.$disconnect()
    console.log(`\n${passed} passed, ${failed} failed`)
    process.exit(failed > 0 ? 1 : 0)
  })
