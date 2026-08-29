/**
 * Saying which section cooks a dish, from the menu form.
 *
 * ── The flow this pins, end to end ──────────────────────────────────────────
 *
 *   create a section → choose it while adding the dish → place an order →
 *   the kitchen accepts → the dish arrives at that section
 *
 * That whole chain was blocked at step two. The section picker lived on a tab
 * whose *button* only rendered for a restaurant with more than one location, so
 * on a single-location restaurant the control existed and could not be reached
 * by any means. Nothing could be mapped; an unmapped dish stops the kitchen
 * accepting the order it is on; so routing looked broken when it was fine.
 *
 * The other half is the save path. `replaceFoodBranches` deletes and re-upserts
 * every row on every menu save, so a field the payload happens not to carry
 * used to be written back as null. A dish's section would have silently
 * unassigned itself the next time anybody edited the price.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/menu-station-test.ts
 */
import { prisma } from '../src/server/db/prisma'
import { replaceFoodBranches, foodBranchRows } from '../src/features/menu/branch-menu'
import { planRouting } from '../src/features/kitchen/routing'
import { unmappedDishes } from '../src/features/kitchen/service'
import { updateOrderStatus } from '../src/features/orders/service'

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

async function main() {
  const stamp = Date.now().toString(36)

  const restaurant = await prisma.restaurant.create({
    data: { name: `MS ${stamp}`, slug: `ms-${stamp}`, status: 'ACTIVE', isActive: true, currency: 'LKR' },
  })
  // Deliberately ONE location: the shape that could not reach the picker.
  const branch = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Main', code: 'MAIN', isDefault: true },
  })
  const category = await prisma.category.create({
    data: { restaurantId: restaurant.id, name: 'Food', slug: `food-${stamp}`, sortOrder: 0 },
  })
  const pizza = await prisma.food.create({
    data: {
      restaurantId: restaurant.id, categoryId: category.id, name: 'Pizza',
      slug: `pizza-${stamp}`, price: 50_000, isAvailable: true,
    },
  })
  const water = await prisma.food.create({
    data: {
      restaurantId: restaurant.id, categoryId: category.id, name: 'Bottled water',
      slug: `water-${stamp}`, price: 10_000, isAvailable: true,
    },
  })

  const oven = await prisma.kitchenStation.create({
    data: { restaurantId: restaurant.id, branchId: branch.id, name: 'Pizza oven' },
  })
  const grill = await prisma.kitchenStation.create({
    data: { restaurantId: restaurant.id, branchId: branch.id, name: 'Grill' },
  })

  console.log('\n1. Choosing a section while saving the dish')

  await replaceFoodBranches(prisma, {
    restaurantId: restaurant.id,
    foodId: pizza.id,
    branches: [{ branchId: branch.id, isAvailable: true, stationId: oven.id }],
  })
  const saved = await foodBranchRows({ restaurantId: restaurant.id, foodId: pizza.id })
  check('the section is stored against the dish at that location',
    saved[0]?.stationId === oven.id, String(saved[0]?.stationId))

  console.log('\n2. Editing the price later does not unassign it')

  /*
   * The menu dialog does not send a station when the restaurant has no
   * sections, and it never sent `sortOrder` at all. `replaceFoodBranches`
   * used to write `x ?? null` for every column, so any field the payload
   * omitted was wiped — a section would come undone the next time anybody
   * touched the price.
   */
  await replaceFoodBranches(prisma, {
    restaurantId: restaurant.id,
    foodId: pizza.id,
    branches: [{ branchId: branch.id, isAvailable: true, price: 60_000 }],
  })
  const afterEdit = await foodBranchRows({ restaurantId: restaurant.id, foodId: pizza.id })
  check('the new price landed', afterEdit[0]?.price === 60_000)
  check('and the section survived a save that never mentioned it',
    afterEdit[0]?.stationId === oven.id,
    'a field the payload omitted was written back as null')

  console.log('\n3. Moving it to another section, and marking one no-kitchen')

  await replaceFoodBranches(prisma, {
    restaurantId: restaurant.id,
    foodId: pizza.id,
    branches: [{ branchId: branch.id, isAvailable: true, stationId: grill.id }],
  })
  check('the dish moves to the section chosen',
    (await foodBranchRows({ restaurantId: restaurant.id, foodId: pizza.id }))[0]?.stationId === grill.id)

  await replaceFoodBranches(prisma, {
    restaurantId: restaurant.id,
    foodId: water.id,
    branches: [{ branchId: branch.id, isAvailable: true, noKitchenRequired: true }],
  })
  const waterRow = await foodBranchRows({ restaurantId: restaurant.id, foodId: water.id })
  check('bottled water can be marked as needing no kitchen',
    waterRow[0]?.noKitchenRequired === true && waterRow[0]?.stationId === null)

  console.log('\n4. What the menu screen warns about')

  const unmappedBefore = await unmappedDishes(prisma, {
    restaurantId: restaurant.id, branchId: branch.id,
  })
  check('a dish with a section is not flagged',
    !unmappedBefore.some((dish) => dish.foodId === pizza.id))
  check('and neither is one that needs no kitchen',
    !unmappedBefore.some((dish) => dish.foodId === water.id))

  const orphan = await prisma.food.create({
    data: {
      restaurantId: restaurant.id, categoryId: category.id, name: 'Kottu',
      slug: `kottu-${stamp}`, price: 40_000, isAvailable: true,
    },
  })
  await replaceFoodBranches(prisma, {
    restaurantId: restaurant.id,
    foodId: orphan.id,
    branches: [{ branchId: branch.id, isAvailable: true }],
  })
  const unmappedAfter = await unmappedDishes(prisma, {
    restaurantId: restaurant.id, branchId: branch.id,
  })
  check('but a dish nobody is assigned to cook is',
    unmappedAfter.some((dish) => dish.name === 'Kottu'),
    unmappedAfter.map((d) => d.name).join(', ') || 'nothing flagged')

  console.log('\n5. The whole point: accept, and it lands at the section')

  const order = await prisma.order.create({
    data: {
      restaurantId: restaurant.id, branchId: branch.id, orderNumber: `MS-${stamp}`,
      status: 'PENDING', type: 'DINE_IN', channel: 'STAFF',
      customerName: 'Guest', customerPhone: '', subtotal: 70_000, grandTotal: 70_000,
      items: {
        create: [
          { foodId: pizza.id, name: 'Pizza', unitPrice: 60_000, quantity: 1, lineTotal: 60_000 },
          { foodId: water.id, name: 'Bottled water', unitPrice: 10_000, quantity: 1, lineTotal: 10_000 },
        ],
      },
    },
  })

  const plan = await planRouting(prisma, { restaurantId: restaurant.id, orderId: order.id })
  check('nothing blocks acceptance once every dish is answered for',
    plan.unmapped.length === 0, plan.unmapped.map((r) => r.name).join(', '))

  await updateOrderStatus({ restaurantId: restaurant.id, orderId: order.id, status: 'ACCEPTED' })

  const items = await prisma.orderItem.findMany({ where: { orderId: order.id } })
  const pizzaItem = items.find((item) => item.name === 'Pizza')
  const waterItem = items.find((item) => item.name === 'Bottled water')

  check('the pizza went to the section the menu said',
    pizzaItem?.stationId === grill.id, String(pizzaItem?.stationName))
  check('carrying the section name for the reports',
    pizzaItem?.stationName === 'Grill')
  check('and the water skipped the kitchen entirely',
    waterItem?.stationId === null && waterItem?.status === 'READY',
    `${waterItem?.status}`)

  console.log('\n6. An unanswered dish still blocks, by name')

  const blocked = await prisma.order.create({
    data: {
      restaurantId: restaurant.id, branchId: branch.id, orderNumber: `MSB-${stamp}`,
      status: 'PENDING', type: 'DINE_IN', channel: 'STAFF',
      customerName: 'Guest', customerPhone: '', subtotal: 40_000, grandTotal: 40_000,
      items: {
        create: [{ foodId: orphan.id, name: 'Kottu', unitPrice: 40_000, quantity: 1, lineTotal: 40_000 }],
      },
    },
  })
  const blockedPlan = await planRouting(prisma, { restaurantId: restaurant.id, orderId: blocked.id })
  check('the dish with no section is named', blockedPlan.unmapped[0]?.name === 'Kottu')

  // Answer it on the menu, exactly as the dialog now can, and it clears.
  await replaceFoodBranches(prisma, {
    restaurantId: restaurant.id,
    foodId: orphan.id,
    branches: [{ branchId: branch.id, isAvailable: true, stationId: grill.id }],
  })
  const fixedPlan = await planRouting(prisma, { restaurantId: restaurant.id, orderId: blocked.id })
  check('and setting it on the menu clears the block', fixedPlan.unmapped.length === 0)

  await prisma.orderStockDepletion.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.stockMovement.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.orderEvent.deleteMany({ where: { order: { restaurantId: restaurant.id } } })
  await prisma.orderItem.deleteMany({ where: { order: { restaurantId: restaurant.id } } })
  await prisma.order.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.foodBranch.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.kitchenStation.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.food.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.category.deleteMany({ where: { restaurantId: restaurant.id } })
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
