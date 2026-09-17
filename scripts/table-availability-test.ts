/**
 * A table's availability to a QR guest is automatic and decided on the
 * server (aO.md §2).
 *
 *   - Empty: the guest may order;
 *   - Occupied (an open order or sitting, anybody's, paid or not): a stranger
 *     cannot start another order there — the same party (the guest session
 *     that owns an order in the sitting) may order a second round;
 *   - Reserved (a booking in its window, not yet seated): nobody orders by QR
 *     until the host seats the booking; the till may always seat a table;
 *   - paying in full does not empty a table whose food is still coming: the
 *     order completes — and the table frees itself — when it is served, with
 *     no status set by hand anywhere; a bill settled after the food was
 *     ready or served closes the sitting at once, as before;
 *   - the guest screens say "unavailable", never "your order will be added".
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/table-availability-test.ts
 */
import { readFileSync } from 'node:fs'

import { prisma } from '../src/server/db/prisma'
import { cancelOrder, placeOrder, updateOrderStatus } from '../src/features/orders/service'
import { tableAvailability } from '../src/features/orders/table-availability'
import { acceptGuestOrder } from '../src/features/cashier/service'
import { capturePayment } from '../src/features/payments/service'
import { upsertReservation } from '../src/features/floor/reservations'

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
  await prisma.notification.deleteMany({ where: { restaurantId: id } })
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
  const restaurant = await prisma.restaurant.create({
    data: {
      name: `Avail ${stamp}`, slug: `avail-${stamp}`, status: 'ACTIVE', isActive: true,
      timezone: 'Asia/Colombo', currency: 'LKR',
    },
  })
  restaurantId = restaurant.id
  const branch = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Main', code: 'MAIN', isDefault: true },
  })
  const mk = (number: string) =>
    prisma.restaurantTable.create({ data: { restaurantId: restaurant.id, branchId: branch.id, number, capacity: 4 } })
  const t1 = await mk('1')
  const t2 = await mk('2')
  const t3 = await mk('3')
  const t4 = await mk('4')
  const t5 = await mk('5')
  const category = await prisma.category.create({ data: { restaurantId: restaurant.id, name: 'Mains', slug: `m-${stamp}` } })
  const rice = await prisma.food.create({
    data: { restaurantId: restaurant.id, categoryId: category.id, name: 'Rice', slug: `rice-${stamp}`, price: 50_000, isAvailable: true },
  })
  await prisma.foodBranch.create({ data: { restaurantId: restaurant.id, foodId: rice.id, branchId: branch.id, isAvailable: true } })
  const cashier = await prisma.user.create({
    data: { restaurantId: restaurant.id, email: `avail-${stamp}@test.local`, name: 'Till', passwordHash: 'x', role: 'CASHIER', branchId: branch.id },
  })
  const actor = { actorId: cashier.id, actorName: cashier.name }
  const ALICE = `guest-a-${stamp}`
  const BOB = `guest-b-${stamp}`

  const qrOrder = (tableId: string, guestSessionId: string, name: string) =>
    placeOrder({
      restaurantId: restaurant.id, branchId: branch.id, tableId, type: 'DINE_IN', channel: 'QR', guestSessionId,
      items: [{ foodId: rice.id, quantity: 1, optionIds: [] }],
      customerName: name, customerPhone: '',
    })
  const staffOrder = (tableId: string) =>
    placeOrder({
      restaurantId: restaurant.id, branchId: branch.id, tableId, type: 'DINE_IN', channel: 'STAFF',
      items: [{ foodId: rice.id, quantity: 1, optionIds: [] }],
      customerName: 'Walk-in', customerPhone: '', createdById: cashier.id,
    })
  const availability = async (tableId: string, guestSessionId: string | null) => {
    const row = await tableAvailability(prisma, { restaurantId: restaurant.id, tableId, guestSessionId })
    if (!row) throw new Error('table not found')
    return row
  }
  const table = (id: string) => prisma.restaurantTable.findUniqueOrThrow({ where: { id } })
  const sitting = (tableId: string) => prisma.tableSession.findFirst({ where: { tableId, status: 'OPEN' } })
  const step = (orderId: string, status: 'PREPARING' | 'READY' | 'SERVED') =>
    updateOrderStatus({ restaurantId: restaurant.id, orderId, status, ...actor })
  const pay = (orderId: string, amount: number) =>
    capturePayment({ restaurantId: restaurant.id, orderId, method: 'CASH', amount, tenderedAmount: amount, receivedById: cashier.id })

  console.log('\n── 1. Empty: the guest may order ──')
  {
    const before = await availability(t1.id, ALICE)
    check('an empty table reads Empty, with nothing of the guest’s on it', before.state === 'AVAILABLE' && before.ownOrder === null && before.reason === null)
    const alice = await qrOrder(t1.id, ALICE, 'Alice')
    check('and takes the order, waiting at the till', alice.status === 'PENDING' && alice.tableId === t1.id)
    check('the table is Occupied from that moment', (await table(t1.id)).status === 'OCCUPIED' && (await sitting(t1.id)) !== null)
  }

  console.log('\n── 2. Occupied: a stranger cannot start another order ──')
  {
    const asBob = await availability(t1.id, BOB)
    check('to another guest the table reads Occupied, with a reason to show', asBob.state === 'OCCUPIED' && asBob.ownOrder === null && /in use/i.test(asBob.reason ?? ''), JSON.stringify(asBob))
    await refuses('and their QR order is refused on the server', () => qrOrder(t1.id, BOB, 'Bob'), /TABLE_OCCUPIED/)
    check('no second sitting or order appeared', (await prisma.order.count({ where: { tableId: t1.id } })) === 1)

    const asAlice = await availability(t1.id, ALICE)
    check('to the party already sitting there it is their table', asAlice.state === 'OCCUPIED' && asAlice.ownOrder?.status === 'PENDING', JSON.stringify(asAlice))
    check('and their open order is editable', asAlice.ownOrder?.editable === true)

    // Paid but not served: still Occupied — they are still eating.
    const alice = (await prisma.order.findFirstOrThrow({ where: { tableId: t1.id } }))
    await acceptGuestOrder({ restaurantId: restaurant.id, orderId: alice.id, ...actor })
    await pay(alice.id, alice.grandTotal)
    check('paying in full while the food is still coming keeps the table Occupied', (await table(t1.id)).status === 'OCCUPIED' && (await sitting(t1.id)) !== null)
    await refuses('so a stranger is still refused', () => qrOrder(t1.id, BOB, 'Bob'), /TABLE_OCCUPIED/)
    const again = await availability(t1.id, ALICE)
    check('and the party sees their order, no longer editable once paid', again.ownOrder?.id === alice.id && again.ownOrder?.editable === false)
    const round2 = await qrOrder(t1.id, ALICE, 'Alice')
    check('the same party may order a second round', round2.tableSessionId === alice.tableSessionId)
    await cancelOrder({ restaurantId: restaurant.id, orderId: round2.id, reason: 'Test' })

    const staff = await staffOrder(t5.id)
    check('the till may always seat a table', staff.status === 'ACCEPTED' && staff.tableId === t5.id)
    await refuses('and a stranger cannot join a staff-seated table either', () => qrOrder(t5.id, BOB, 'Bob'), /TABLE_OCCUPIED/)
  }

  console.log('\n── 3. Reserved: nobody orders by QR until the host seats the booking ──')
  {
    const booking = await upsertReservation({
      restaurantId: restaurant.id, id: null,
      data: {
        customerName: 'Perera', customerPhone: '0771111111', customerEmail: null,
        tableId: t2.id, branchId: branch.id, partySize: 2,
        reservedAt: new Date(Date.now() + 5 * MIN), durationMinutes: 90, status: 'CONFIRMED', notes: null,
      },
    })
    const reserved = await availability(t2.id, BOB)
    check('a booking in its window reads Reserved, naming the time', reserved.state === 'RESERVED' && /reserved/i.test(reserved.reason ?? ''), JSON.stringify(reserved))
    await refuses('a QR order on it is refused', () => qrOrder(t2.id, BOB, 'Bob'), /TABLE_RESERVED/)

    /*
     * aO.md §2 — the booking holds the table the moment it is saved, not
     * fifteen minutes before the guests are due. A host who books a table
     * for tonight and sees it still Empty reads that as the reservation not
     * working, which is what was reported.
     */
    const far = await upsertReservation({
      restaurantId: restaurant.id, id: null,
      data: {
        customerName: 'Fernando', customerPhone: '0773333333', customerEmail: null,
        tableId: t4.id, branchId: branch.id, partySize: 2,
        reservedAt: new Date(Date.now() + 6 * 60 * MIN), durationMinutes: 90, status: 'CONFIRMED', notes: null,
      },
    })
    const tonight = await availability(t4.id, BOB)
    check('a booking hours away holds its table already', tonight.state === 'RESERVED', JSON.stringify(tonight))
    check('and the guest is told when it is booked for', /reserved for a booking/i.test(tonight.reason ?? ''), tonight.reason ?? '')
    await refuses('so a QR order on it is refused too', () => qrOrder(t4.id, BOB, 'Bob'), /TABLE_RESERVED/)

    // Cancelling releases it: nothing has to be un-set by hand.
    await upsertReservation({
      restaurantId: restaurant.id, id: far.id,
      data: {
        customerName: 'Fernando', customerPhone: '0773333333', customerEmail: null,
        tableId: t4.id, branchId: branch.id, partySize: 2,
        reservedAt: far.reservedAt, durationMinutes: 90, status: 'CANCELLED', notes: null,
      },
    })
    check('cancelling the booking frees the table by itself', (await availability(t4.id, BOB)).state === 'AVAILABLE')

    // A host may also hold a table with no booking behind it (aO.md §2).
    await prisma.restaurantTable.update({ where: { id: t4.id }, data: { status: 'RESERVED' } })
    const held = await availability(t4.id, BOB)
    check('a table held by hand reads Reserved', held.state === 'RESERVED', JSON.stringify(held))
    await refuses('and refuses a QR order', () => qrOrder(t4.id, BOB, 'Bob'), /TABLE_RESERVED/)
    await prisma.restaurantTable.update({ where: { id: t4.id }, data: { status: 'AVAILABLE' } })
    await upsertReservation({
      restaurantId: restaurant.id, id: booking.id,
      data: {
        customerName: 'Perera', customerPhone: '0771111111', customerEmail: null,
        tableId: t2.id, branchId: branch.id, partySize: 2,
        reservedAt: booking.reservedAt, durationMinutes: 90, status: 'SEATED', notes: null,
      },
    })
    const seated = await availability(t2.id, BOB)
    check('once the host seats the booking the table reads Empty', seated.state === 'AVAILABLE')
    const perera = await qrOrder(t2.id, BOB, 'Perera')
    check('and the party may order', perera.tableId === t2.id)

    await upsertReservation({
      restaurantId: restaurant.id, id: null,
      data: {
        customerName: 'Silva', customerPhone: '0772222222', customerEmail: null,
        tableId: t3.id, branchId: branch.id, partySize: 2,
        reservedAt: new Date(Date.now() + 5 * MIN), durationMinutes: 90, status: 'CONFIRMED', notes: null,
      },
    })
    const staff = await staffOrder(t3.id)
    check('the till seating a reserved table marks the booking Seated', staff.tableId === t3.id && (await prisma.reservation.findFirst({ where: { tableId: t3.id } }))?.status === 'SEATED')
  }

  console.log('\n── 4. Payment → Empty, only once the sitting is over ──')
  {
    const order = await qrOrder(t4.id, ALICE, 'Alice')
    await acceptGuestOrder({ restaurantId: restaurant.id, orderId: order.id, ...actor })
    await step(order.id, 'PREPARING')
    await pay(order.id, order.grandTotal)
    const paid = await prisma.order.findUniqueOrThrow({ where: { id: order.id } })
    check('paid in full while cooking: PAID, still PREPARING, table still Occupied', paid.paymentStatus === 'PAID' && paid.status === 'PREPARING' && (await table(t4.id)).status === 'OCCUPIED')
    await step(order.id, 'READY')
    check('ready does not free it either', (await table(t4.id)).status === 'OCCUPIED')
    const served = await step(order.id, 'SERVED')
    check('served + paid completes the order by itself', served.status === 'COMPLETED' && served.completedAt !== null)
    check('and the table is Empty, the sitting closed, the key released', (await table(t4.id)).status === 'AVAILABLE' && (await sitting(t4.id)) === null && (await prisma.tableSession.count({ where: { tableId: t4.id, activeTableKey: t4.id } })) === 0)
    const next = await availability(t4.id, BOB)
    check('the next guest may order there', next.state === 'AVAILABLE')

    // The old rule still holds: settling a bill whose food is ready closes it at once.
    const ready = await qrOrder(t4.id, BOB, 'Bob')
    await acceptGuestOrder({ restaurantId: restaurant.id, orderId: ready.id, ...actor })
    await step(ready.id, 'PREPARING')
    await step(ready.id, 'READY')
    await pay(ready.id, ready.grandTotal)
    check('a bill settled once the food is ready completes and frees the table', (await prisma.order.findUniqueOrThrow({ where: { id: ready.id } })).status === 'COMPLETED' && (await table(t4.id)).status === 'AVAILABLE')
  }

  console.log('\n── 5. The screens ──')
  {
    const cover = readFileSync('src/components/CoverPage.tsx', 'utf8')
    check('the cover screen says the table is unavailable', cover.includes('currently unavailable'))
    check('and never that the order will be added to a bill', !/will be added to it/i.test(cover) && !/joins this bill/i.test(cover))
    check('it offers the party their own order instead', cover.includes('View your order'))
    const menu = readFileSync('src/features/orders/components/menu-browser.tsx', 'utf8')
    check('the menu no longer invites ordering on a reserved or occupied table', !menu.includes('go ahead and order') && !menu.includes('joins this bill'))
    const actions = readFileSync('src/features/orders/actions.ts', 'utf8')
    check('resolveTable reads the live state through one helper', actions.includes('tableAvailability('))
    const service = readFileSync('src/features/orders/service.ts', 'utf8')
    check('and placeOrder refuses on the server through the same helper', service.includes('tableAvailability(tx') && service.includes("'TABLE_OCCUPIED'") && service.includes("'TABLE_RESERVED'"))
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
