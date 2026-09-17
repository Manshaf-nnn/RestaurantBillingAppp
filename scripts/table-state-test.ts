/**
 * A table is Empty, Occupied or Reserved (abc.md §3).
 *
 *   - an order seats the table (OCCUPIED) and opens its sitting;
 *   - settling the last bill in full, or cancelling the last order, frees it:
 *     Empty — not Cleaning, which nothing ever cleared — and the sitting is
 *     closed with its `activeTableKey` released;
 *   - Reserved is never stored: a booking whose window covers now
 *     (`RESERVATION_LEAD_MINUTES` before it starts until it ends, while it is
 *     PENDING/CONFIRMED) makes the table read Reserved, and the party sitting
 *     down makes it Occupied;
 *   - the five retired states fold to the three (`normalizeTableStatus`), and
 *     the floor analytics count in the same vocabulary;
 *   - nothing frees a table because food was prepared.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/table-state-test.ts
 */
import { prisma } from '../src/server/db/prisma'
import { getFloorSummary } from '../src/features/analytics/floor-summary'
import { normalizeTableStatus, tableState, RESERVATION_LEAD_MINUTES } from '../src/features/floor/table-state'
import { tableStatesFor } from '../src/features/floor/table-state-server'
import { cancelOrder, placeOrder, updateOrderStatus } from '../src/features/orders/service'
import { capturePayment } from '../src/features/payments/service'
import { resolveRange } from '../src/features/reports/range'

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

const stamp = Date.now().toString(36)
const MIN = 60_000
let restaurantId: string | null = null

async function cleanup(id: string) {
  await prisma.payment.deleteMany({ where: { restaurantId: id } })
  await prisma.invoice.deleteMany({ where: { restaurantId: id } })
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
  console.log('\n── 1. The vocabulary ──')
  {
    check('OCCUPIED stays', normalizeTableStatus('OCCUPIED') === 'OCCUPIED')
    check('ORDERING / EATING / WAITING_BILL were "occupied" said three ways',
      ['ORDERING', 'EATING', 'WAITING_BILL'].every((s) => normalizeTableStatus(s) === 'OCCUPIED'))
    check('CLEANING is Empty — the sitting is over', normalizeTableStatus('CLEANING') === 'AVAILABLE')
    // DELIBERATE behaviour change 2026-09 (aO.md §2): a host may hold a table
    // with no booking behind it, so the column means what it says again.
    check('a hand-set RESERVED is Reserved', normalizeTableStatus('RESERVED') === 'RESERVED')
    check('and it survives a read with no booking', tableState({ stored: 'RESERVED', reservedNow: false }) === 'RESERVED')
    check('but whoever is sitting there still wins', tableState({ stored: 'RESERVED', occupied: true, reservedNow: false }) === 'OCCUPIED')
    check('OUT_OF_SERVICE folds to Empty (it is `isActive` now)', normalizeTableStatus('OUT_OF_SERVICE') === 'AVAILABLE')
    check('a booking in its window makes an empty table Reserved',
      tableState({ stored: 'AVAILABLE', reservedNow: true }) === 'RESERVED')
    check('but never an occupied one', tableState({ stored: 'AVAILABLE', occupied: true, reservedNow: true }) === 'OCCUPIED')
  }

  const restaurant = await prisma.restaurant.create({
    data: {
      name: `Tables ${stamp}`, slug: `tables-${stamp}`, status: 'ACTIVE', isActive: true,
      timezone: 'Asia/Colombo', currency: 'LKR',
    },
  })
  restaurantId = restaurant.id
  const branch = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Main', code: 'MAIN', isDefault: true },
  })
  const mkTable = (number: string, extra: { isActive?: boolean } = {}) =>
    prisma.restaurantTable.create({
      data: { restaurantId: restaurant.id, branchId: branch.id, number, capacity: 4, ...extra },
    })
  const t1 = await mkTable('1')
  const t2 = await mkTable('2')
  const t3 = await mkTable('3')
  await mkTable('4', { isActive: false })
  const category = await prisma.category.create({
    data: { restaurantId: restaurant.id, name: 'Mains', slug: `m-${stamp}` },
  })
  const rice = await prisma.food.create({
    data: { restaurantId: restaurant.id, categoryId: category.id, name: 'Rice', slug: `rice-${stamp}`, price: 50_000, isAvailable: true },
  })
  await prisma.foodBranch.create({
    data: { restaurantId: restaurant.id, foodId: rice.id, branchId: branch.id, isAvailable: true },
  })
  const cashier = await prisma.user.create({
    data: { restaurantId: restaurant.id, email: `till-${stamp}@test.local`, name: 'Till', passwordHash: 'x', role: 'CASHIER', branchId: branch.id },
  })

  const table = (id: string) => prisma.restaurantTable.findUniqueOrThrow({ where: { id } })
  const session = (tableId: string) => prisma.tableSession.findFirst({ where: { tableId }, orderBy: { openedAt: 'desc' } })
  const order = (tableId: string, name = 'Party') =>
    placeOrder({
      restaurantId: restaurant.id, branchId: branch.id, tableId, type: 'DINE_IN',
      items: [{ foodId: rice.id, quantity: 2, optionIds: [] }],
      customerName: name, customerPhone: '0770000000',
    })

  console.log('\n── 2. An order seats the table; settling the last bill frees it ──')
  {
    const first = await order(t1.id)
    check('placing an order marks the table Occupied', (await table(t1.id)).status === 'OCCUPIED')
    const open = await session(t1.id)
    check('and opens its sitting, holding the table key', open?.status === 'OPEN' && open.activeTableKey === t1.id)

    // Food prepared changes nothing about the table.
    await updateOrderStatus({ restaurantId: restaurant.id, orderId: first.id, status: 'ACCEPTED', actorId: null, actorName: null })
    await updateOrderStatus({ restaurantId: restaurant.id, orderId: first.id, status: 'READY', actorId: null, actorName: null })
    check('food ready does not free the table', (await table(t1.id)).status === 'OCCUPIED')

    await capturePayment({
      restaurantId: restaurant.id, orderId: first.id, method: 'CASH',
      amount: first.grandTotal, tenderedAmount: first.grandTotal, receivedById: cashier.id,
    })
    const freed = await table(t1.id)
    check('settling in full frees it — Empty, not Cleaning', freed.status === 'AVAILABLE', freed.status)
    const closed = await session(t1.id)
    check('and the sitting is closed with its key released', closed?.status === 'CLOSED' && closed.activeTableKey === null && closed.closedAt !== null)
    const states = await tableStatesFor(prisma, { restaurantId: restaurant.id, tableIds: [t1.id] })
    check('the derived state agrees', states.get(t1.id)?.state === 'AVAILABLE')

    const again = await order(t1.id, 'Second party')
    const reseated = await table(t1.id)
    check('the next party seats it again', reseated.status === 'OCCUPIED')
    const fresh = await session(t1.id)
    check('in a new sitting, not the closed one', fresh?.status === 'OPEN' && fresh.id !== closed?.id)
    await cancelOrder({ restaurantId: restaurant.id, orderId: again.id, reason: 'Changed their minds' })
  }

  console.log('\n── 3. Cancelling the last order frees it too; a second open order keeps it ──')
  {
    const a = await order(t2.id)
    const b = await order(t2.id)
    await cancelOrder({ restaurantId: restaurant.id, orderId: a.id, reason: 'Wrong table' })
    check('one of two orders cancelled: still Occupied', (await table(t2.id)).status === 'OCCUPIED')
    await cancelOrder({ restaurantId: restaurant.id, orderId: b.id, reason: 'Wrong table' })
    check('the last one cancelled: Empty', (await table(t2.id)).status === 'AVAILABLE')
    check('sitting closed', (await session(t2.id))?.status === 'CLOSED')
  }

  console.log('\n── 4. Reserved is a booking holding the table, or a host holding it ──')
  {
    const now = Date.now()
    const booking = await prisma.reservation.create({
      data: {
        restaurantId: restaurant.id, branchId: branch.id, tableId: t3.id,
        customerName: 'Perera', customerPhone: '0771111111', partySize: 2,
        reservedAt: new Date(now + 5 * MIN), durationMinutes: 90, status: 'CONFIRMED',
      },
    })
    const inWindow = await tableStatesFor(prisma, { restaurantId: restaurant.id, tableIds: [t3.id] })
    check(`a booking ${RESERVATION_LEAD_MINUTES} minutes out reads Reserved`, inWindow.get(t3.id)?.state === 'RESERVED')
    check('naming who it is for', inWindow.get(t3.id)?.reservation?.customerName === 'Perera')
    check('while the stored column is untouched', (await table(t3.id)).status === 'AVAILABLE')

    // DELIBERATE behaviour change 2026-09 (aO.md §2): a booking holds its
    // table from the moment it is made, not from fifteen minutes before the
    // guests are due. A host who reserves a table expects to see it reserved.
    await prisma.reservation.update({ where: { id: booking.id }, data: { reservedAt: new Date(now + 60 * MIN) } })
    const later = await tableStatesFor(prisma, { restaurantId: restaurant.id, tableIds: [t3.id] })
    check('an hour out it is Reserved already', later.get(t3.id)?.state === 'RESERVED')

    await prisma.reservation.update({ where: { id: booking.id }, data: { reservedAt: new Date(now + 3 * 24 * 60 * MIN) } })
    const nextWeek = await tableStatesFor(prisma, { restaurantId: restaurant.id, tableIds: [t3.id] })
    check('and a booking days away holds it too', nextWeek.get(t3.id)?.state === 'RESERVED')
    await prisma.reservation.update({ where: { id: booking.id }, data: { reservedAt: new Date(now + 5 * MIN) } })

    await prisma.reservation.update({ where: { id: booking.id }, data: { reservedAt: new Date(now - 100 * MIN) } })
    const over = await tableStatesFor(prisma, { restaurantId: restaurant.id, tableIds: [t3.id] })
    check('and past its end it is Empty again — nothing to un-set', over.get(t3.id)?.state === 'AVAILABLE')

    await prisma.reservation.update({ where: { id: booking.id }, data: { reservedAt: new Date(now + 5 * MIN), status: 'CANCELLED' } })
    const cancelled = await tableStatesFor(prisma, { restaurantId: restaurant.id, tableIds: [t3.id] })
    check('a cancelled booking does not reserve', cancelled.get(t3.id)?.state === 'AVAILABLE')

    await prisma.reservation.update({ where: { id: booking.id }, data: { status: 'CONFIRMED' } })
    const seated = await order(t3.id, 'Perera')
    const nowOccupied = await tableStatesFor(prisma, { restaurantId: restaurant.id, tableIds: [t3.id] })
    check('the booked party ordering makes it Occupied', (await table(t3.id)).status === 'OCCUPIED' && nowOccupied.get(t3.id)?.state === 'OCCUPIED')
    check('and the reservation is no longer what the card says', nowOccupied.get(t3.id)?.reservation === null)
    // Sitting down consumes the booking (abc.md §4): it is Seated, and a
    // Seated booking holds nothing — even after the order is cancelled the
    // table is Empty, not Reserved, because the party did arrive.
    check('the booking is Seated once the party orders', (await prisma.reservation.findUniqueOrThrow({ where: { id: booking.id } })).status === 'SEATED')
    await cancelOrder({ restaurantId: restaurant.id, orderId: seated.id, reason: 'Test' })
    const afterCancel = await tableStatesFor(prisma, { restaurantId: restaurant.id, tableIds: [t3.id] })
    check('and a Seated booking no longer reserves the table', afterCancel.get(t3.id)?.state === 'AVAILABLE')

    // Put the booking back to Confirmed so the next section has a Reserved table.
    await prisma.reservation.update({ where: { id: booking.id }, data: { status: 'CONFIRMED' } })
  }

  console.log('\n── 5. The floor analytics count in the same three states ──')
  {
    // t1 Empty, t2 Empty, t3 Reserved (booking confirmed, in window), t4 out of service.
    await prisma.restaurantTable.update({ where: { id: t2.id }, data: { status: 'OCCUPIED' } })
    const floor = await getFloorSummary({
      restaurantId: restaurant.id,
      range: resolveRange({ preset: 'TODAY', timeZone: 'Asia/Colombo' }),
      branchIds: [branch.id],
    })
    check('in use', floor.inUse === 1, `${floor.inUse}`)
    check('free', floor.free === 1, `${floor.free}`)
    check('reserved — from the booking, not a flag', floor.reserved === 1, `${floor.reserved}`)
    check('out of service — from isActive', floor.outOfService === 1, `${floor.outOfService}`)
    check('total is the active tables', floor.total === 3, `${floor.total}`)
    check('no "cleaning" figure exists any more', !('cleaning' in floor))
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
