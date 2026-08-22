/**
 * The four defects that stood between this and a production verdict.
 *
 * Each was named in IMPLEMENTATION_REPORT.md as outstanding, and each could
 * cost a restaurant real money:
 *
 *   1. a double-tapped cart placed two orders and deducted two sets of stock
 *   2. batches were only drawn down by wastage, so FEFO and the expiry board
 *      drifted for anything sold or produced
 *   3. prep recipes never versioned, so editing one re-costed history
 *   4. production yield loss was not costed — a run making 480 of 500 reported
 *      the same unit cost as a perfect one, while the docstring claimed otherwise
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/production-ready-test.ts
 */
import { prisma } from '../src/server/db/prisma'
import { postMovement } from '../src/features/inventory/ledger'
import { placeOrder, updateOrderStatus } from '../src/features/orders/service'
import { saveRecipe } from '../src/features/recipes/service'
import { completeProduction } from '../src/features/production/service'

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
    data: { name: `Ready ${stamp}`, slug: `ready-${stamp}`, status: 'ACTIVE', isActive: true },
  })
  const branch = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Main', code: 'MAIN', isDefault: true },
  })
  const house = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Kitchen', code: 'PROD', type: 'PRODUCTION_HOUSE' },
  })
  const user = await prisma.user.create({
    data: {
      restaurantId: restaurant.id, email: `owner-${stamp}@ready.test`, name: 'Owner',
      role: 'OWNER', passwordHash: 'x', staffCode: 'W-0001',
    },
  })
  // Tables belong to a branch now — the fixture already has one above.
  const table = await prisma.restaurantTable.create({
    data: { restaurantId: restaurant.id, branchId: branch.id, number: '1', capacity: 4 },
  })

  const patty = await prisma.inventoryItem.create({
    data: {
      restaurantId: restaurant.id, name: 'Patty', unit: 'PIECE',
      quantity: 0, costPerUnit: 100, trackBatches: true, useFefo: true,
    },
  })
  await prisma.$transaction(async (tx) => {
    await postMovement(tx, {
      restaurantId: restaurant.id, itemId: patty.id, type: 'OPENING_BALANCE',
      quantity: 100, unitCost: 100, branchId: branch.id,
    })
    await tx.stockBatch.create({
      data: {
        restaurantId: restaurant.id, branchId: branch.id, itemId: patty.id, batchNo: `B-${stamp}`,
        receivedQty: 100, remainingQty: 100, unitCost: 100,
        expiryDate: new Date(Date.now() + 5 * 86_400_000),
      },
    })
  })

  const category = await prisma.category.create({
    data: { restaurantId: restaurant.id, name: 'Mains', slug: `m-${stamp}`, sortOrder: 1 },
  })
  const burger = await prisma.food.create({
    data: {
      restaurantId: restaurant.id, categoryId: category.id, name: 'Burger',
      slug: `b-${stamp}`, price: 1000, costPrice: 0, isAvailable: true,
      // A dish has to be ON a branch's menu to be orderable there. Creating one
      // straight through Prisma skips `saveFood`, which is what normally writes
      // this — so the fixture does it by hand.
      branches: { create: [{ restaurantId: restaurant.id, branchId: branch.id }] },
    },
  })
  const recipe = await prisma.recipe.create({
    data: { restaurantId: restaurant.id, foodId: burger.id, yieldQty: 1, isActive: true, version: 1 },
  })
  await prisma.recipeIngredient.create({
    data: { recipeId: recipe.id, inventoryItemId: patty.id, quantity: 1, unit: 'PIECE' },
  })

  console.log('\n1. A resubmitted cart is one order, not two')

  const cart = {
    restaurantId: restaurant.id,
    tableId: table.id,
    customerName: 'Guest',
    customerPhone: '0770000000',
    items: [{ foodId: burger.id, quantity: 2, optionIds: [] }],
    idempotencyKey: `key-${stamp}-abcdefgh`,
    branchId: branch.id,
  }

  const first = await placeOrder(cart)
  const second = await placeOrder(cart)
  check('the retry returns the same order', first.id === second.id, `${first.id} vs ${second.id}`)

  const orderCount = await prisma.order.count({ where: { restaurantId: restaurant.id } })
  check('only one order exists', orderCount === 1, `${orderCount}`)

  // Simultaneous, which is the case the pre-check cannot cover.
  const racing = await Promise.all([
    placeOrder({ ...cart, idempotencyKey: `race-${stamp}-abcdefgh` }),
    placeOrder({ ...cart, idempotencyKey: `race-${stamp}-abcdefgh` }),
  ])
  check('two simultaneous submissions collapse to one', racing[0].id === racing[1].id)
  const afterRace = await prisma.order.count({ where: { restaurantId: restaurant.id } })
  check('so two orders exist in total, not four', afterRace === 2, `${afterRace}`)

  console.log('\n2. A sale draws stock out of real batches')

  const batchBefore = await prisma.stockBatch.findFirstOrThrow({ where: { itemId: patty.id } })
  await updateOrderStatus({
    restaurantId: restaurant.id, orderId: first.id, status: 'ACCEPTED', actorId: user.id,
  })
  const batchAfter = await prisma.stockBatch.findFirstOrThrow({ where: { itemId: patty.id } })
  check(
    'the batch falls by the 2 patties sold',
    batchAfter.remainingQty === batchBefore.remainingQty - 2,
    `${batchBefore.remainingQty} → ${batchAfter.remainingQty}`,
  )

  const item = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: patty.id } })
  check(
    'and the batch total still agrees with the balance',
    batchAfter.remainingQty === item.quantity,
    `batch ${batchAfter.remainingQty} vs balance ${item.quantity}`,
  )

  console.log('\n3. A prep recipe that history depends on is versioned, not overwritten')

  const sauceItem = await prisma.inventoryItem.create({
    data: { restaurantId: restaurant.id, name: 'Sauce', unit: 'KG', quantity: 0, costPerUnit: 500 },
  })
  const prep = await prisma.recipe.create({
    data: {
      restaurantId: restaurant.id, producesItemId: sauceItem.id, name: 'Burger sauce',
      yieldQty: 1, yieldUnit: 'KG', isActive: true, version: 1,
    },
  })
  await prisma.recipeIngredient.create({
    data: { recipeId: prep.id, inventoryItemId: patty.id, quantity: 1, unit: 'PIECE' },
  })
  // The burger's recipe now nests it, and the burger has been sold.
  await prisma.recipeIngredient.create({
    data: { recipeId: recipe.id, subRecipeId: prep.id, quantity: 1, unit: 'KG' },
  })

  const saved = await saveRecipe({
    restaurantId: restaurant.id,
    producesItemId: sauceItem.id,
    name: 'Burger sauce',
    yieldQty: 1,
    yieldUnit: 'KG',
    ingredients: [{ inventoryItemId: patty.id, quantity: 2, unit: 'PIECE' }],
  })
  check(
    'editing it supersedes rather than overwrites',
    saved.id !== prep.id && saved.version === 2,
    `id ${saved.id === prep.id ? 'same' : 'new'}, version ${saved.version}`,
  )
  const old = await prisma.recipe.findUniqueOrThrow({
    where: { id: prep.id },
    include: { ingredients: true },
  })
  check('the version history was consuming is intact', old.ingredients[0]?.quantity === 1,
    `${old.ingredients[0]?.quantity}`)
  check('and is no longer the active one', old.isActive === false)

  console.log('\n4. A poor yield raises the cost of what it made')

  const flour = await prisma.inventoryItem.create({
    data: { restaurantId: restaurant.id, name: 'Flour', unit: 'KG', quantity: 0, costPerUnit: 100 },
  })
  const bread = await prisma.inventoryItem.create({
    data: { restaurantId: restaurant.id, name: 'Bread', unit: 'PIECE', quantity: 0, costPerUnit: 0 },
  })
  await prisma.$transaction((tx) =>
    postMovement(tx, {
      restaurantId: restaurant.id, itemId: flour.id, type: 'OPENING_BALANCE',
      quantity: 1000, unitCost: 100, branchId: house.id,
    }),
  )
  const spec = await prisma.productionSpec.create({
    data: {
      restaurantId: restaurant.id, name: 'Bread', outputItemId: bread.id, outputQty: 10,
      items: { create: [{ itemId: flour.id, quantity: 10, unit: 'KG' }] },
    },
  })
  const run = await prisma.productionOrder.create({
    data: {
      restaurantId: restaurant.id, branchId: house.id, specId: spec.id,
      number: `PR-${stamp}`, plannedQty: 10, status: 'APPROVED', unit: 'PIECE',
    },
  })

  // Planned 10 batches (100 kg flour, 100 loaves). Only 80 loaves came out.
  const done = await completeProduction({
    restaurantId: restaurant.id,
    orderId: run.id,
    actualQty: 8,
    varianceReason: 'PRODUCTION_LOSS',
    userId: user.id,
  })

  const perfect = 100 * 100 / 100 // 100 kg at 100 = 10,000 over 100 loaves = 100
  check(
    'the shortfall raises unit cost above a perfect run',
    done.unitCost > perfect,
    `unit cost ${done.unitCost}, a perfect run would be ${perfect}`,
  )
  check(
    'planned inputs were consumed, not scaled down to the output',
    done.consumed.reduce((sum, c) => sum + c.quantity, 0) === 100,
    `${done.consumed.reduce((sum, c) => sum + c.quantity, 0)} kg consumed, expected 100`,
  )

  // Clean up.
  await prisma.productionConsumption.deleteMany({ where: { order: { restaurantId: restaurant.id } } })
  await prisma.productionOutput.deleteMany({ where: { order: { restaurantId: restaurant.id } } })
  await prisma.productionOrder.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.productionSpecItem.deleteMany({ where: { spec: { restaurantId: restaurant.id } } })
  await prisma.productionSpec.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.orderStockDepletion.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.stockBatch.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.stockMovement.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.inventoryStock.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.orderEvent.deleteMany({ where: { order: { restaurantId: restaurant.id } } })
  await prisma.orderItem.deleteMany({ where: { order: { restaurantId: restaurant.id } } })
  await prisma.order.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.recipeIngredient.deleteMany({ where: { recipe: { restaurantId: restaurant.id } } })
  await prisma.recipe.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.food.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.category.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.restaurantTable.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.customer.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.inventoryItem.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.user.deleteMany({ where: { restaurantId: restaurant.id } })
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
