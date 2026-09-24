/**
 * A waiter takes an order at the table and it reaches the kitchen.
 *
 * ── What this is actually proving ──────────────────────────────────────────
 *
 * The new screen at `/waiter?tab=order` calls `createStaffOrder`, which is the
 * same action the till calls. So the question is not "does the pad work" — it
 * is whether the path it uses genuinely delivers an order to the kitchen
 * without a cashier touching it, which is the whole of what was asked for.
 *
 * Four things have to hold, and none of them is visible from the screen:
 *
 *   1. a STAFF-channel order is written ACCEPTED, not PENDING — because
 *      `acceptedOnPlacement(channel)` is true for anything that is not QR or
 *      online, and PENDING is what makes an order wait for the till;
 *   2. `commitToKitchen` ran in the same transaction, so the lines are routed
 *      to stations and the stock is already depleted;
 *   3. `getKitchenQueue` returns it — it selects ACCEPTED/PREPARING/READY with
 *      no channel filter, so a staff order is on the rail immediately;
 *   4. a second order at a seated table JOINS the open sitting rather than
 *      opening a second one, because "what does table 4 owe tonight" is a
 *      question about the sitting and the cashier's bill list is built on it.
 *
 * Plus the one failure a wall tablet on a busy floor will actually produce:
 * a double tap. The pad sends an idempotency key per cart, and the second
 * placement must return the SAME order rather than deducting another full set
 * of ingredients.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/waiter-order-test.ts
 */
import { prisma } from '../src/server/db/prisma'
import { placeOrder } from '../src/features/orders/service'
import { getKitchenQueue } from '../src/features/orders/queries'
import { permissionsFor, PERMISSIONS } from '../src/lib/rbac'
import { resolveWaiterTab, waiterHref } from '../src/features/waiter/tabs'

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

const near = (a: number, b: number) => Math.abs(a - b) < 1e-6

async function main() {
  const stamp = Date.now().toString(36)

  const restaurant = await prisma.restaurant.create({
    data: { name: `Waiter ${stamp}`, slug: `waiter-${stamp}`, status: 'ACTIVE', isActive: true },
  })
  const branch = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Main', code: 'MAIN', isDefault: true },
  })
  const other = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Beach', code: 'BEACH' },
  })
  const waiter = await prisma.user.create({
    data: {
      restaurantId: restaurant.id, branchId: branch.id, email: `waiter-${stamp}@test.dev`,
      name: 'Ravi', role: 'WAITER', passwordHash: 'x', staffCode: 'W-9001',
    },
  })

  const table = await prisma.restaurantTable.create({
    data: { restaurantId: restaurant.id, branchId: branch.id, number: '4', capacity: 4 },
  })

  const category = await prisma.category.create({
    data: { restaurantId: restaurant.id, name: 'Mains', slug: `mains-${stamp}`, isVisible: true },
  })
  const cheese = await prisma.inventoryItem.create({
    data: { restaurantId: restaurant.id, name: 'Cheese', unit: 'KG', quantity: 0, costPerUnit: 80_00 },
  })
  await prisma.inventoryStock.create({
    data: { restaurantId: restaurant.id, branchId: branch.id, itemId: cheese.id, available: 20 },
  })
  await prisma.inventoryItem.update({ where: { id: cheese.id }, data: { quantity: 20 } })

  const pizza = await prisma.food.create({
    data: {
      restaurantId: restaurant.id, categoryId: category.id, name: 'Pizza',
      slug: `pizza-${stamp}`, price: 900_00, isAvailable: true,
    },
  })
  const burger = await prisma.food.create({
    data: {
      restaurantId: restaurant.id, categoryId: category.id, name: 'Burger',
      slug: `burger-${stamp}`, price: 500_00, isAvailable: true,
    },
  })
  // One dish with a recipe, so depletion has something real to do.
  const recipe = await prisma.recipe.create({
    data: { restaurantId: restaurant.id, foodId: pizza.id, yieldQty: 1, isActive: true, version: 1 },
  })
  await prisma.recipeIngredient.create({
    data: { recipeId: recipe.id, inventoryItemId: cheese.id, quantity: 0.2, unit: 'KG' },
  })

  const station = await prisma.kitchenStation.create({
    data: { restaurantId: restaurant.id, branchId: branch.id, name: 'Hot pass', isActive: true },
  })
  /*
   * Routing is per BRANCH, not per dish — the same pizza can come off a
   * dedicated station at one site and the main kitchen at another — so the
   * mapping lives on `FoodBranch`.
   */
  for (const food of [pizza, burger]) {
    await prisma.foodBranch.create({
      data: {
        restaurantId: restaurant.id,
        foodId: food.id,
        branchId: branch.id,
        isAvailable: true,
        stationId: station.id,
      },
    })
  }

  /* ── 1. The waiter already had the permission ───────────────────────────── */
  console.log('\n1. A waiter was always allowed to take an order')

  const granted = permissionsFor({ role: 'WAITER', rolePermissions: undefined } as never)
  check(
    'WAITER holds order.create — the screen was missing, not the permission',
    granted.has(PERMISSIONS.ORDER_CREATE),
  )
  check('and waiter.view, which opens the station', granted.has(PERMISSIONS.WAITER_VIEW))

  /* ── 2. Straight to the kitchen ─────────────────────────────────────────── */
  console.log('\n2. The order goes to the kitchen with no cashier in the way')

  const first = await placeOrder({
    restaurantId: restaurant.id,
    // Exactly what the pad sends.
    type: 'DINE_IN',
    channel: 'STAFF',
    branchId: branch.id,
    tableId: table.id,
    guestCount: 3,
    customerName: '',
    customerPhone: '',
    notes: 'No chilli',
    idempotencyKey: `waiter-${stamp}-1`,
    createdById: waiter.id,
    servedById: waiter.id,
    items: [
      { foodId: pizza.id, quantity: 2, optionIds: [] },
      { foodId: burger.id, quantity: 1, optionIds: [] },
    ],
  })

  const written = await prisma.order.findUniqueOrThrow({
    where: { id: first.id },
    include: { items: true, table: true },
  })

  check('the order is ACCEPTED, not PENDING', written.status === 'ACCEPTED', written.status)
  check('with acceptedAt stamped', written.acceptedAt !== null)
  check('on the STAFF channel', written.channel === 'STAFF', written.channel)
  check('credited to the waiter', written.servedById === waiter.id)
  check('at the table’s own branch', written.branchId === branch.id)
  check('and seated at the table', written.tableId === table.id)
  check('carrying the kitchen note', written.notes === 'No chilli')

  check(
    'every line was routed to a station — commitToKitchen ran',
    written.items.length === 2 && written.items.every((i) => i.stationId === station.id),
    written.items.map((i) => `${i.name}:${i.stationId ?? 'none'}`).join(' '),
  )
  check(
    'the recipe version was pinned on the line',
    written.items.find((i) => i.name === 'Pizza')?.recipeId === recipe.id,
  )

  const stock = await prisma.inventoryStock.findFirstOrThrow({
    where: { restaurantId: restaurant.id, branchId: branch.id, itemId: cheese.id },
  })
  check(
    'and the stock was depleted: 20 − (2 × 0.2) = 19.6',
    near(stock.available, 19.6),
    `available ${stock.available}`,
  )

  const queue = await getKitchenQueue(restaurant.id, [branch.id])
  check(
    'the kitchen rail has it, with no cashier acceptance',
    queue.some((order) => order.id === first.id),
    `${queue.length} on the rail`,
  )
  check(
    'and another branch’s rail does not',
    (await getKitchenQueue(restaurant.id, [other.id])).every((o) => o.id !== first.id),
  )

  /* ── 3. A second round joins the sitting ────────────────────────────────── */
  console.log('\n3. A second order at the same table is a new round on one bill')

  const second = await placeOrder({
    restaurantId: restaurant.id,
    type: 'DINE_IN',
    channel: 'STAFF',
    branchId: branch.id,
    tableId: table.id,
    // Deliberately different, to prove it is ignored on a later round.
    guestCount: 99,
    customerName: '',
    customerPhone: '',
    idempotencyKey: `waiter-${stamp}-2`,
    createdById: waiter.id,
    servedById: waiter.id,
    items: [{ foodId: burger.id, quantity: 1, optionIds: [] }],
  })

  check('it is a different order', second.id !== first.id)

  const sessions = await prisma.tableSession.findMany({
    where: { restaurantId: restaurant.id, tableId: table.id },
  })
  check('there is exactly ONE sitting, not two', sessions.length === 1, `${sessions.length} sittings`)
  check('and it is still open', sessions[0]?.status === 'OPEN')

  const [a, b] = await Promise.all([
    prisma.order.findUniqueOrThrow({ where: { id: first.id } }),
    prisma.order.findUniqueOrThrow({ where: { id: second.id } }),
  ])
  check(
    'both orders hang off that one sitting — which is what the bill is built on',
    a.tableSessionId !== null && a.tableSessionId === b.tableSessionId,
  )
  check(
    'the party recorded is the one from the FIRST order, not the second',
    sessions[0]?.guestCount === 3,
    `guestCount ${sessions[0]?.guestCount}`,
  )

  /* ── 4. The double tap ──────────────────────────────────────────────────── */
  console.log('\n4. A double tap on a wall tablet places one order')

  const before = await prisma.order.count({ where: { restaurantId: restaurant.id } })
  const again = await placeOrder({
    restaurantId: restaurant.id,
    type: 'DINE_IN',
    channel: 'STAFF',
    branchId: branch.id,
    tableId: table.id,
    customerName: '',
    customerPhone: '',
    // The same key the first send used.
    idempotencyKey: `waiter-${stamp}-1`,
    createdById: waiter.id,
    servedById: waiter.id,
    items: [
      { foodId: pizza.id, quantity: 2, optionIds: [] },
      { foodId: burger.id, quantity: 1, optionIds: [] },
    ],
  })
  const after = await prisma.order.count({ where: { restaurantId: restaurant.id } })

  check('the retry returns the order that already exists', again.id === first.id)
  check('no second order was written', after === before, `${before} → ${after}`)

  const stockAfter = await prisma.inventoryStock.findFirstOrThrow({
    where: { restaurantId: restaurant.id, branchId: branch.id, itemId: cheese.id },
  })
  check(
    'and no second set of ingredients was deducted',
    near(stockAfter.available, 19.6),
    `available ${stockAfter.available}`,
  )

  /* ── 5. The tab is in the URL ───────────────────────────────────────────── */
  console.log('\n5. The pad is its own URL, not a panel inside the refresh loop')

  check("?tab=order opens the pad", resolveWaiterTab('order') === 'order')
  check('anything else is the board', resolveWaiterTab(undefined) === 'board' && resolveWaiterTab('serve') === 'board')
  check(
    'and the link keeps the station on its own floor',
    waiterHref('order', branch.id) === `/waiter?tab=order&branch=${branch.id}`,
    waiterHref('order', branch.id),
  )
  check('the board link is plain /waiter when no branch is chosen', waiterHref('board', null) === '/waiter')

  /* ── Clean up ───────────────────────────────────────────────────────────── */
  await prisma.restaurant.delete({ where: { id: restaurant.id } })

  console.log(`\n═══ ${passed} passed, ${failed} failed ═══\n`)
  process.exitCode = failed > 0 ? 1 : 0
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
