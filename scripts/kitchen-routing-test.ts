/**
 * Sending dishes to the sections that cook them, and reading the order back.
 *
 * Two behaviours here carry the whole feature, and both are invisible when they
 * break:
 *
 *   · **Nothing flattens.** An order whose items have gone to sections is a
 *     READOUT of those items. If the old order-level cascade were still
 *     running, one supervisor tap would mark every untouched dish ready.
 *   · **A restaurant with no sections is untouched.** Every existing kitchen
 *     keeps cascading exactly as it did, decided per order and fixed for that
 *     order's life — so an order taken before the first section was created
 *     never changes mode halfway through service.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/kitchen-routing-test.ts
 */
import { prisma } from '../src/server/db/prisma'
import { planRouting, routeOrderItems, orderIsRouted } from '../src/features/kitchen/routing'
import { deriveOrderStatus, updateOrderStatus } from '../src/features/orders/service'

let passed = 0
let failed = 0

function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failed += 1
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const statusOf = async (orderId: string) =>
  (await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status

const itemStatus = async (itemId: string) =>
  (await prisma.orderItem.findUniqueOrThrow({ where: { id: itemId } })).status

async function main() {
  const stamp = Date.now().toString(36)

  const restaurant = await prisma.restaurant.create({
    data: { name: `KS ${stamp}`, slug: `ks-${stamp}`, status: 'ACTIVE', isActive: true, currency: 'LKR' },
  })
  const main = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Main', code: 'MAIN', isDefault: true },
  })
  const other = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Kandy', code: 'KND' },
  })
  const category = await prisma.category.create({
    data: { restaurantId: restaurant.id, name: 'Food', slug: `food-${stamp}`, sortOrder: 0 },
  })

  const dish = async (name: string) =>
    prisma.food.create({
      data: {
        restaurantId: restaurant.id, categoryId: category.id, name,
        slug: `${name.toLowerCase().replace(/\W+/g, '-')}-${stamp}`,
        price: 50_000, isAvailable: true,
      },
    })

  const pizza = await dish('Pizza')
  const rice = await dish('Fried rice')
  const juice = await dish('Mango juice')
  const water = await dish('Bottled water')

  const order = async (branchId: string, foods: Array<{ id: string; name: string }>) =>
    prisma.order.create({
      data: {
        restaurantId: restaurant.id, branchId, orderNumber: `K-${stamp}-${Math.random().toString(36).slice(2, 7)}`,
        status: 'PENDING', type: 'DINE_IN', channel: 'STAFF',
        customerName: 'Guest', customerPhone: '',
        subtotal: 50_000 * foods.length, grandTotal: 50_000 * foods.length,
        items: {
          create: foods.map((food) => ({
            foodId: food.id, name: food.name, unitPrice: 50_000, quantity: 1, lineTotal: 50_000,
          })),
        },
      },
      include: { items: true },
    })

  // ── 1 · a restaurant with no sections is completely untouched ────────────

  console.log('\n1. With no sections, everything behaves exactly as before')

  const legacy = await order(main.id, [pizza, rice])
  const plan0 = await planRouting(prisma, { restaurantId: restaurant.id, orderId: legacy.id })
  check('routing reports itself as not configured', plan0.configured === false)

  await updateOrderStatus({
    restaurantId: restaurant.id, orderId: legacy.id, status: 'PREPARING',
  })
  check('the order cascaded down to its items, as it always did',
    (await itemStatus(legacy.items[0].id)) === 'PREPARING',
    await itemStatus(legacy.items[0].id))
  check('and nothing was marked as routed', (await orderIsRouted(prisma, legacy.id)) === false)

  // ── 2 · sections exist; an unmapped dish blocks and names itself ─────────

  console.log('\n2. A dish nobody cooks blocks the order, by name')

  const pizzaStation = await prisma.kitchenStation.create({
    data: { restaurantId: restaurant.id, branchId: main.id, name: 'Pizza oven' },
  })
  const riceStation = await prisma.kitchenStation.create({
    data: { restaurantId: restaurant.id, branchId: main.id, name: 'Rice range' },
  })
  const kandyStation = await prisma.kitchenStation.create({
    data: { restaurantId: restaurant.id, branchId: other.id, name: 'Kandy kitchen' },
  })

  const map = (foodId: string, branchId: string, stationId: string | null, noKitchen = false) =>
    prisma.foodBranch.create({
      data: {
        restaurantId: restaurant.id, foodId, branchId,
        stationId, noKitchenRequired: noKitchen, isAvailable: true,
      },
    })

  await map(pizza.id, main.id, pizzaStation.id)
  await map(rice.id, main.id, riceStation.id)
  await map(juice.id, main.id, null) // deliberately unmapped
  await map(water.id, main.id, null, true)

  const blocked = await order(main.id, [pizza, juice])
  const planBlocked = await planRouting(prisma, {
    restaurantId: restaurant.id, orderId: blocked.id,
  })
  check('the plan names the dish that has no section',
    planBlocked.unmapped.some((row) => row.name === 'Mango juice'),
    planBlocked.unmapped.map((r) => r.name).join(', ') || 'nothing reported')

  const routedNone = await prisma.$transaction((tx) =>
    routeOrderItems(tx, { restaurantId: restaurant.id, orderId: blocked.id }),
  )
  check('and routing is all-or-nothing, so not even the pizza moved', routedNone === 0)
  check('leaving no half-routed order behind',
    (await orderIsRouted(prisma, blocked.id)) === false,
    'some items routed and one did not — that item is now on no screen at all')

  // ── 3 · a mappable order routes, and bottled water is ready at once ──────

  console.log('\n3. Three dishes, three destinations')

  const live = await order(main.id, [pizza, rice, water])
  await updateOrderStatus({ restaurantId: restaurant.id, orderId: live.id, status: 'ACCEPTED' })

  const routedItems = await prisma.orderItem.findMany({
    where: { orderId: live.id },
    select: { id: true, name: true, stationId: true, stationName: true, status: true, routedAt: true },
  })
  const byName = new Map(routedItems.map((item) => [item.name, item]))

  check('the pizza went to the pizza oven',
    byName.get('Pizza')?.stationId === pizzaStation.id, String(byName.get('Pizza')?.stationName))
  check('the rice went to the rice range',
    byName.get('Fried rice')?.stationId === riceStation.id)
  check('the section name was snapshotted, so a rename cannot rewrite history',
    byName.get('Pizza')?.stationName === 'Pizza oven')
  check('bottled water went to no section at all',
    byName.get('Bottled water')?.stationId === null)
  check(
    'and is READY the moment the order is accepted, not waiting on a cook',
    byName.get('Bottled water')?.status === 'READY',
    `${byName.get('Bottled water')?.status} — an item no section advances would hold the order short of ready for ever`,
  )
  check('everything is marked routed', routedItems.every((item) => item.routedAt !== null))

  // ── 4 · the cascade is off, and one section cannot flatten the others ────

  console.log('\n4. One section finishing does not finish the others')

  const pizzaItem = byName.get('Pizza')!
  const riceItem = byName.get('Fried rice')!

  await prisma.orderItem.update({ where: { id: pizzaItem.id }, data: { status: 'PREPARING' } })
  await deriveOrderStatus({ restaurantId: restaurant.id, orderId: live.id })
  check('one section starting makes the whole order PREPARING',
    (await statusOf(live.id)) === 'PREPARING', await statusOf(live.id))
  check('but the rice is still queued — nothing was flattened',
    (await itemStatus(riceItem.id)) === 'QUEUED', await itemStatus(riceItem.id))

  /*
   * The assertion this whole gate exists for. Driving the ORDER to READY from
   * the old board used to mark every item READY, including ones no cook had
   * touched. Once an order is routed, its items own their own status.
   */
  await updateOrderStatus({ restaurantId: restaurant.id, orderId: live.id, status: 'READY' })
  check(
    'and driving the ORDER to READY leaves the untouched rice alone',
    (await itemStatus(riceItem.id)) === 'QUEUED',
    `${await itemStatus(riceItem.id)} — the order-level cascade is still running and has flattened a section's work`,
  )

  // ── 5 · the order follows its items up, and stops at the slowest ─────────

  console.log('\n5. The order is a readout of its sections')

  const fresh = await order(main.id, [pizza, rice])
  await updateOrderStatus({ restaurantId: restaurant.id, orderId: fresh.id, status: 'ACCEPTED' })
  const freshItems = await prisma.orderItem.findMany({ where: { orderId: fresh.id } })
  const [a, b] = freshItems

  await prisma.orderItem.update({ where: { id: a.id }, data: { status: 'READY' } })
  await deriveOrderStatus({ restaurantId: restaurant.id, orderId: fresh.id })
  check('one section ready is not the whole order ready',
    (await statusOf(fresh.id)) !== 'READY', await statusOf(fresh.id))

  await prisma.orderItem.update({ where: { id: b.id }, data: { status: 'READY' } })
  await deriveOrderStatus({ restaurantId: restaurant.id, orderId: fresh.id })
  check('but the last one is', (await statusOf(fresh.id)) === 'READY', await statusOf(fresh.id))

  const withStamp = await prisma.order.findUniqueOrThrow({ where: { id: fresh.id } })
  check('and readyAt was stamped on the way, not skipped', withStamp.readyAt !== null)
  check('as was acceptedAt, which the old board never set', withStamp.acceptedAt !== null)

  // A cancelled dish must not hold the order open.
  const withCancel = await order(main.id, [pizza, rice])
  await updateOrderStatus({ restaurantId: restaurant.id, orderId: withCancel.id, status: 'ACCEPTED' })
  const cancelItems = await prisma.orderItem.findMany({ where: { orderId: withCancel.id } })
  await prisma.orderItem.update({ where: { id: cancelItems[0].id }, data: { status: 'CANCELLED' } })
  await prisma.orderItem.update({ where: { id: cancelItems[1].id }, data: { status: 'READY' } })
  await deriveOrderStatus({ restaurantId: restaurant.id, orderId: withCancel.id })
  check('a cancelled dish is excluded from the reckoning',
    (await statusOf(withCancel.id)) === 'READY', await statusOf(withCancel.id))

  // ── 6 · branch isolation, in the query ──────────────────────────────────

  console.log('\n6. One branch never routes to another branch’s sections')

  await map(pizza.id, other.id, kandyStation.id)
  const away = await order(other.id, [pizza])
  await updateOrderStatus({ restaurantId: restaurant.id, orderId: away.id, status: 'ACCEPTED' })

  const awayItem = await prisma.orderItem.findFirstOrThrow({ where: { orderId: away.id } })
  check('a Kandy order went to the Kandy section', awayItem.stationId === kandyStation.id)

  const mainStationItems = await prisma.orderItem.count({
    where: { stationId: { in: [pizzaStation.id, riceStation.id] }, orderId: away.id },
  })
  check('and reaches no section at Main', mainStationItems === 0)

  const kandySeesMain = await prisma.orderItem.count({
    where: { stationId: kandyStation.id, order: { branchId: main.id } },
  })
  check('nor does Main’s work appear at Kandy', kandySeesMain === 0)

  // ── 7 · asking for more of something already cooked ─────────────────────

  console.log('\n7. More of a dish already cooked is a new line, not a bigger one')

  const addTo = await order(main.id, [pizza])
  await updateOrderStatus({ restaurantId: restaurant.id, orderId: addTo.id, status: 'ACCEPTED' })
  const original = await prisma.orderItem.findFirstOrThrow({ where: { orderId: addTo.id } })
  await prisma.orderItem.update({ where: { id: original.id }, data: { status: 'READY', readyAt: new Date() } })

  /*
   * The shape `updateGuestOrderItems` now writes: the cooked line is left
   * exactly as it is and the difference becomes its own queued line.
   */
  await prisma.orderItem.create({
    data: {
      orderId: addTo.id, foodId: pizza.id, name: 'Pizza', unitPrice: 50_000,
      quantity: 2, lineTotal: 100_000, status: 'QUEUED',
      stationId: original.stationId, stationName: original.stationName,
    },
  })

  const after = await prisma.orderItem.findMany({ where: { orderId: addTo.id }, orderBy: { createdAt: 'asc' } })
  check('the cooked line is untouched', after[0]?.status === 'READY', String(after[0]?.status))
  check('and the extra is its own queued line', after[1]?.status === 'QUEUED' && after[1]?.quantity === 2)
  check('pointing at the same section', after[1]?.stationId === original.stationId)

  const routedAdd = await prisma.$transaction((tx) =>
    routeOrderItems(tx, { restaurantId: restaurant.id, orderId: addTo.id }),
  )
  check('routing picks up the addition without disturbing the rest', routedAdd === 1, `${routedAdd} routed`)
  const afterRoute = await prisma.orderItem.findUniqueOrThrow({ where: { id: after[0].id } })
  check('the already-ready line still reads ready', afterRoute.status === 'READY')

  // ── cleanup ─────────────────────────────────────────────────────────────

  await prisma.orderStockDepletion.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.stockMovement.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.orderEvent.deleteMany({ where: { order: { restaurantId: restaurant.id } } })
  await prisma.orderItem.deleteMany({ where: { order: { restaurantId: restaurant.id } } })
  await prisma.order.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.foodBranch.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.kitchenStationStaff.deleteMany({ where: { station: { restaurantId: restaurant.id } } })
  await prisma.kitchenStation.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.food.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.category.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.restaurantTable.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.customer.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.notification.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.auditLog.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.branch.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.restaurant.delete({ where: { id: restaurant.id } })
  await prisma.$disconnect()

  console.log(`\n═══ ${passed} passed, ${failed} failed ═══\n`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch(async (error) => {
  console.error(error)
  await prisma.$disconnect()
  process.exit(1)
})
