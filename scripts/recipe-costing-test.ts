/**
 * The numbers behind recipes, production and split bills.
 *
 * Every section here failed before the recipes/production merge, and each one
 * was silent — a wrong figure on a screen, or stock quietly out of step, with no
 * error anywhere:
 *
 *   1 · Costing multiplied a quantity in the line's own unit by a cost per BASE
 *       unit, so 200 g of a LKR 250/kg item read as LKR 50,000 instead of LKR 50
 *       — a thousand times over, on the screen whose whole job is to answer "is
 *       this dish worth selling at this price?". It also never divided by the
 *       recipe's yield, and skipped make-ahead lines entirely.
 *   2 · A dish using something the kitchen makes ahead deducted that thing's raw
 *       ingredients a SECOND time, while the made item sat on the shelf untouched.
 *   3 · Finishing a kitchen job read its status outside the transaction, so a
 *       double-click consumed every ingredient twice.
 *   4 · Splitting and merging bills moved order lines without moving the record
 *       of what had already been deducted, so stock went permanently wrong.
 *   5 · A blank "how many came out" box meant zero, which consumed everything and
 *       produced nothing.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/recipe-costing-test.ts
 */

import { prisma } from '../src/server/db/prisma'
import { postMovement } from '../src/features/inventory/ledger'
import { costDraftLines, resolveRecipe } from '../src/features/inventory/recipe-resolver'
import { reconcileOrderDepletion } from '../src/features/inventory/depletion'
import { saveRecipe } from '../src/features/recipes/service'
import { produceItem } from '../src/features/production/service'
import { splitBill, mergeBills } from '../src/features/cashier/service'
import { getProfitReport } from '../src/features/reports/profit'
import { customRange } from '../src/features/reports/range'

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

async function refuses(name: string, run: () => Promise<unknown>, pattern: RegExp) {
  try {
    await run()
    check(name, false, 'it was allowed')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    check(name, pattern.test(message), `wrong error: ${message}`)
  }
}

const qty = async (itemId: string) =>
  (await prisma.inventoryItem.findUniqueOrThrow({ where: { id: itemId } })).quantity

async function main() {
  const stamp = Date.now().toString(36)

  const restaurant = await prisma.restaurant.create({
    data: { name: `Cost ${stamp}`, slug: `cost-${stamp}`, status: 'ACTIVE', isActive: true, currency: 'LKR' },
  })
  const branch = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Main', code: 'MAIN', isDefault: true },
  })
  const house = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Kitchen', code: 'PH', type: 'PRODUCTION_HOUSE' },
  })
  const user = await prisma.user.create({
    data: {
      restaurantId: restaurant.id, email: `owner-${stamp}@cost.test`, name: 'Owner',
      role: 'OWNER', passwordHash: 'x', staffCode: 'W-0001',
    },
  })
  const category = await prisma.category.create({
    data: { restaurantId: restaurant.id, name: 'Food', slug: `food-${stamp}`, sortOrder: 0 },
  })

  const stock = async (itemId: string, quantity: number, unitCost: number, branchId: string) =>
    prisma.$transaction((tx) =>
      postMovement(tx, {
        restaurantId: restaurant.id, itemId, type: 'OPENING_BALANCE',
        quantity, unitCost, branchId, userId: user.id,
      }),
    )

  // ── 1 · the thousandfold costing error ──────────────────────────────────

  console.log('\n1. A gram is not a kilo')

  // Rice: base unit KG, LKR 250/kg = 25,000 minor units per kg.
  const rice = await prisma.inventoryItem.create({
    data: { restaurantId: restaurant.id, name: 'Rice', unit: 'KG', quantity: 0, costPerUnit: 25_000 },
  })
  await stock(rice.id, 100, 25_000, branch.id)

  const curry = await prisma.food.create({
    data: {
      restaurantId: restaurant.id, categoryId: category.id, name: 'Rice & curry',
      slug: `curry-${stamp}`, price: 50_000, costPrice: 0, isAvailable: true,
    },
  })

  // 200 GRAM of a KG-based item. The truth is 0.2 × 25,000 = 5,000.
  const curryRecipe = await saveRecipe({
    restaurantId: restaurant.id,
    foodId: curry.id,
    yieldQty: 1,
    ingredients: [{ inventoryItemId: rice.id, quantity: 200, unit: 'GRAM' }],
  })

  const resolved = await resolveRecipe(prisma, {
    restaurantId: restaurant.id, recipeId: curryRecipe.id, portions: 1,
  })
  check('the resolver converts grams to kilos before pricing', resolved.totalCost === 5_000,
    `${resolved.totalCost}, expected 5000`)

  // The editor's live preview. It computed 200 × 25,000 = 5,000,000 before.
  const draft = await costDraftLines(prisma, {
    restaurantId: restaurant.id,
    yieldQty: 1,
    lines: [{ inventoryItemId: rice.id, quantity: 200, unit: 'GRAM' }],
  })
  check('and so does the editor preview, through the same code', draft.totalCost === 5_000,
    `${draft.totalCost}, expected 5000 — 5000000 means the old inline arithmetic is back`)

  // Yield: a recipe making 10 portions from the same 200 g costs a tenth each.
  const tenth = await costDraftLines(prisma, {
    restaurantId: restaurant.id,
    yieldQty: 10,
    lines: [{ inventoryItemId: rice.id, quantity: 200, unit: 'GRAM' }],
  })
  check('a recipe that makes ten portions costs a tenth per portion', tenth.totalCost === 500,
    `${tenth.totalCost}, expected 500`)

  // Wastage sits on top of the quantity, not inside it: 5% on 200 g draws 210 g.
  const wasted = await costDraftLines(prisma, {
    restaurantId: restaurant.id,
    yieldQty: 1,
    lines: [{ inventoryItemId: rice.id, quantity: 200, unit: 'GRAM', wastagePercent: 5 }],
  })
  check('and wastage is added on top of the quantity', wasted.totalCost === 5_250,
    `${wasted.totalCost}, expected 5250`)

  // ── 2 · the double-count ────────────────────────────────────────────────

  console.log('\n2. Something made ahead comes off the shelf, not out of its ingredients twice')

  const tomato = await prisma.inventoryItem.create({
    data: { restaurantId: restaurant.id, name: 'Tomato', unit: 'KG', quantity: 0, costPerUnit: 10_000 },
  })
  const sauce = await prisma.inventoryItem.create({
    data: { restaurantId: restaurant.id, name: 'Sauce', unit: 'KG', quantity: 0, costPerUnit: 0, isPrepared: true },
  })
  await stock(tomato.id, 50, 10_000, house.id)

  // One run makes 2 kg of sauce from 1 kg of tomatoes.
  const sauceRecipe = await saveRecipe({
    restaurantId: restaurant.id,
    producesItemId: sauce.id,
    name: 'Tomato sauce',
    yieldQty: 2,
    yieldUnit: 'KG',
    ingredients: [{ inventoryItemId: tomato.id, quantity: 1, unit: 'KG' }],
  })

  // Made in one step (redesignkitchenjob.md): what came out, what went in.
  await produceItem({
    restaurantId: restaurant.id, branchId: house.id, userId: user.id, clientRequestId: `rc-${stamp}-sauce`,
    output: { itemId: sauce.id, name: 'Sauce', quantity: 2, unit: 'KG' },
    ingredients: [{ itemId: tomato.id, quantity: 1, unit: 'KG' }],
  })

  check('making 2 kg of sauce used 1 kg of tomatoes', await qty(tomato.id) === 49,
    `tomato at ${await qty(tomato.id)}, expected 49`)
  check('and put 2 kg of sauce on the shelf', await qty(sauce.id) === 2,
    `sauce at ${await qty(sauce.id)}`)

  const sauceCost = (await prisma.inventoryItem.findUniqueOrThrow({ where: { id: sauce.id } })).costPerUnit
  check('the sauce now knows what it cost to make', sauceCost === 5_000,
    `${sauceCost} per kg, expected 5000 (1 kg of tomato at 10000, over 2 kg)`)

  // A burger using 100 g of that sauce must draw the SAUCE, never the tomatoes.
  const burger = await prisma.food.create({
    data: {
      restaurantId: restaurant.id, categoryId: category.id, name: 'Burger',
      slug: `burger-${stamp}`, price: 90_000, costPrice: 0, isAvailable: true,
    },
  })
  const burgerRecipe = await saveRecipe({
    restaurantId: restaurant.id,
    foodId: burger.id,
    yieldQty: 1,
    ingredients: [{ subRecipeId: sauceRecipe.id, quantity: 100, unit: 'GRAM' }],
  })

  const burgerCost = await resolveRecipe(prisma, {
    restaurantId: restaurant.id, recipeId: burgerRecipe.id, portions: 1,
  })
  check('a burger costs 100 g of sauce', burgerCost.totalCost === 500,
    `${burgerCost.totalCost}, expected 500`)
  check('and its only ingredient is the sauce, not the tomatoes',
    burgerCost.ingredients.length === 1 && burgerCost.ingredients[0]?.itemId === sauce.id,
    burgerCost.ingredients.map((i) => i.name).join(', ') || 'nothing')

  /*
   * DELIBERATE behaviour change 2026-09 (AUDIT.md Slice 3). The sauce was
   * produced at the production house and this test used to sell it at the
   * branch with no transfer in between — which the ledger now refuses: a
   * branch cannot sell stock it does not hold, even while another site does.
   * The honest step the real workflow performs is the transfer, so the test
   * performs it too.
   */
  await prisma.$transaction(async (tx) => {
    await postMovement(tx, {
      restaurantId: restaurant.id, itemId: sauce.id, type: 'TRANSFER_OUT',
      quantity: 2, branchId: house.id, userId: user.id, reason: 'To the branch',
    })
    await postMovement(tx, {
      restaurantId: restaurant.id, itemId: sauce.id, type: 'TRANSFER_IN',
      quantity: 2, branchId: branch.id, userId: user.id, reason: 'From the kitchen',
    })
  })

  const tomatoBefore = await qty(tomato.id)
  const order = await prisma.order.create({
    data: {
      restaurantId: restaurant.id, branchId: branch.id, orderNumber: `SAUCE-${stamp}`,
      status: 'ACCEPTED', type: 'DINE_IN', channel: 'STAFF',
      customerName: 'Guest', customerPhone: '', subtotal: 90_000, grandTotal: 90_000,
      items: {
        create: [{
          foodId: burger.id, name: 'Burger', unitPrice: 90_000, quantity: 10,
          lineTotal: 900_000, recipeId: burgerRecipe.id, costPrice: 0,
        }],
      },
    },
  })
  await prisma.$transaction((tx) =>
    reconcileOrderDepletion(tx, { restaurantId: restaurant.id, orderId: order.id, userId: user.id }),
  )

  check('selling 10 burgers takes 1 kg of sauce off the shelf', await qty(sauce.id) === 1,
    `sauce at ${await qty(sauce.id)}, expected 1`)
  check('and does NOT deduct the tomatoes a second time', await qty(tomato.id) === tomatoBefore,
    `tomato moved from ${tomatoBefore} to ${await qty(tomato.id)} — the sauce was exploded again`)

  // ── 3 · the profit report agrees with the resolver ───────────────────────

  console.log('\n3. The profit report prices a line the same way the kitchen does')

  const soldAt = new Date()
  const riceOrder = await prisma.order.create({
    data: {
      restaurantId: restaurant.id, branchId: branch.id, orderNumber: `RICE-${stamp}`,
      status: 'COMPLETED', type: 'DINE_IN', channel: 'STAFF',
      customerName: 'Guest', customerPhone: '', subtotal: 50_000, grandTotal: 50_000,
      placedAt: soldAt, completedAt: soldAt,
      items: {
        create: [{
          foodId: curry.id, name: 'Rice & curry', unitPrice: 50_000, quantity: 1,
          lineTotal: 50_000,
          // Pinned recipe, no cost snapshot — this is exactly the shape that
          // reaches the report's recipe fallback.
          recipeId: curryRecipe.id, costPrice: 0,
        }],
      },
    },
  })

  const report = await getProfitReport({
    restaurantId: restaurant.id,
    range: customRange(new Date(soldAt.getTime() - 86_400_000), new Date(soldAt.getTime() + 86_400_000)),
  })
  /*
   * Per dish, not per report: the burger order from section 2 is inside this
   * window too, and asserting on the total would only say the two happen to sum
   * to something.
   */
  const riceRow = report.byItem.find((row) => row.label === 'Rice & curry')
  check('the report costs the rice at 5,000, not 5,000,000', riceRow?.cogs === 5_000,
    `${riceRow?.cogs}`)
  check('so its gross profit is the real 45,000', riceRow?.grossProfit === 45_000,
    `${riceRow?.grossProfit}`)

  // A recipe whose only line is a make-ahead one used to contribute nothing at
  // all, because the report skipped every line that was not a raw ingredient.
  const burgerRow = report.byItem.find((row) => row.label === 'Burger')
  check('and a make-ahead-only recipe is not free', (burgerRow?.cogs ?? 0) === 5_000,
    `${burgerRow?.cogs}, expected 5000 — 10 burgers at 100 g of sauce`)

  // ── 4 · finishing a job twice ───────────────────────────────────────────

  console.log('\n4. A double-click cannot consume the ingredients twice')

  const flour = await prisma.inventoryItem.create({
    data: { restaurantId: restaurant.id, name: 'Flour', unit: 'KG', quantity: 0, costPerUnit: 20_000 },
  })
  const bread = await prisma.inventoryItem.create({
    data: { restaurantId: restaurant.id, name: 'Bread', unit: 'PIECE', quantity: 0, costPerUnit: 0, isPrepared: true },
  })
  await stock(flour.id, 1_000, 20_000, house.id)

  // A prep recipe for bread still exists for the recipe editor; production no
  // longer needs it.
  await saveRecipe({
    restaurantId: restaurant.id, producesItemId: bread.id, name: 'Bread',
    yieldQty: 10, yieldUnit: 'PIECE',
    ingredients: [{ inventoryItemId: flour.id, quantity: 10, unit: 'KG' }],
  })

  const flourBefore = await qty(flour.id)

  /*
   * DELIBERATE behaviour change 2026-09-05 (redesignkitchenjob.md). There is no
   * job to finish twice any more; what can be sent twice is the same request,
   * and the request key makes the second a replay of the first rather than a
   * refusal. The ledger pin — 100 kg once, not 200 — is unchanged.
   */
  const bake = () => produceItem({
    restaurantId: restaurant.id, branchId: house.id, userId: user.id, clientRequestId: `rc-${stamp}-bread`,
    output: { itemId: bread.id, name: 'Bread', quantity: 100, unit: 'PIECE' },
    ingredients: [{ itemId: flour.id, quantity: 100, unit: 'KG' }],
  })
  const settled = await Promise.allSettled([bake(), bake()])
  const won = settled.filter((s): s is PromiseFulfilledResult<Awaited<ReturnType<typeof produceItem>>> => s.status === 'fulfilled')
  check('both simultaneous submissions are answered', won.length === 2, `${won.length} succeeded`)
  check('…with the same run', won.length === 2 && won[0].value.orderId === won[1].value.orderId)
  const breadRunId = won[0]?.value.orderId ?? ''
  check('100 kg of flour was consumed, not 200',
    flourBefore - (await qty(flour.id)) === 100,
    `${flourBefore - (await qty(flour.id))} kg went`)
  check('one consumption row, not two',
    (await prisma.productionConsumption.count({ where: { orderId: breadRunId } })) === 1)
  check('and one output row, not two',
    (await prisma.productionOutput.count({ where: { orderId: breadRunId } })) === 1)

  // ── 5 · zero is a cancellation, not "all of it" ─────────────────────────

  console.log('\n5. "None came out" is refused rather than silently costing nothing')

  const flourBeforeZero = await qty(flour.id)
  await refuses(
    'a blank "how much came out" is refused',
    () => produceItem({
      restaurantId: restaurant.id, branchId: house.id, userId: user.id, clientRequestId: `rc-${stamp}-zero`,
      output: { itemId: bread.id, name: 'Bread', quantity: 0, unit: 'PIECE' },
      ingredients: [{ itemId: flour.id, quantity: 10, unit: 'KG' }],
    }),
    /how much came out/i,
  )
  check('and nothing was consumed by the attempt', await qty(flour.id) === flourBeforeZero,
    `flour moved from ${flourBeforeZero} to ${await qty(flour.id)}`)

  // ── 6 · one active recipe per owner ─────────────────────────────────────

  console.log('\n6. One dish cannot have two live recipes')

  await refuses(
    'a second active recipe for the same dish is refused by the database',
    () =>
      prisma.recipe.create({
        data: {
          restaurantId: restaurant.id, foodId: curry.id, version: 99, isActive: true, yieldQty: 1,
          ingredients: { create: [{ inventoryItemId: rice.id, quantity: 1, unit: 'KG' }] },
        },
      }),
    /unique|constraint/i,
  )
  await refuses(
    'and so is a second active recipe for the same made item',
    () =>
      prisma.recipe.create({
        data: {
          restaurantId: restaurant.id, producesItemId: sauce.id, version: 99, isActive: true,
          yieldQty: 1, yieldUnit: 'KG',
          ingredients: { create: [{ inventoryItemId: tomato.id, quantity: 1, unit: 'KG' }] },
        },
      }),
    /unique|constraint/i,
  )

  // ── 7 · splitting and merging keep stock honest ─────────────────────────

  console.log('\n7. Moving a line between bills moves what it deducted')

  const bun = await prisma.inventoryItem.create({
    data: { restaurantId: restaurant.id, name: 'Bun', unit: 'PIECE', quantity: 0, costPerUnit: 5_000 },
  })
  await stock(bun.id, 100, 5_000, branch.id)

  const plainBurger = await prisma.food.create({
    data: {
      restaurantId: restaurant.id, categoryId: category.id, name: 'Plain burger',
      slug: `plain-${stamp}`, price: 40_000, costPrice: 0, isAvailable: true,
    },
  })
  const plainRecipe = await saveRecipe({
    restaurantId: restaurant.id, foodId: plainBurger.id, yieldQty: 1,
    ingredients: [{ inventoryItemId: bun.id, quantity: 1, unit: 'PIECE' }],
  })

  const makeBill = async (label: string, quantity: number) => {
    const bill = await prisma.order.create({
      data: {
        restaurantId: restaurant.id, branchId: branch.id, orderNumber: `${label}-${stamp}`,
        status: 'ACCEPTED', type: 'DINE_IN', channel: 'STAFF',
        customerName: 'Guest', customerPhone: '',
        subtotal: 40_000 * quantity, grandTotal: 40_000 * quantity,
        items: {
          create: [{
            foodId: plainBurger.id, name: 'Plain burger', unitPrice: 40_000,
            quantity, lineTotal: 40_000 * quantity, recipeId: plainRecipe.id, costPrice: 0,
          }],
        },
      },
      include: { items: true },
    })
    await prisma.$transaction((tx) =>
      reconcileOrderDepletion(tx, { restaurantId: restaurant.id, orderId: bill.id, userId: user.id }),
    )
    return bill
  }

  const splitSource = await makeBill('SPLIT', 2)
  check('two burgers took two buns', await qty(bun.id) === 98, `bun at ${await qty(bun.id)}`)

  const { target: splitTarget } = await splitBill({
    restaurantId: restaurant.id,
    orderId: splitSource.id,
    selections: [{ itemId: splitSource.items[0].id, quantity: 1 }],
  })

  check('splitting moves no stock by itself', await qty(bun.id) === 98,
    `bun at ${await qty(bun.id)}`)

  const applied = await prisma.orderStockDepletion.findMany({
    where: { orderId: { in: [splitSource.id, splitTarget.id] }, itemId: bun.id },
  })
  const totalApplied = applied.reduce((sum, row) => sum + row.appliedQty, 0)
  check('and the two bills together still claim exactly two buns', totalApplied === 2,
    `${totalApplied} claimed across ${applied.length} rows`)

  const moved = await prisma.orderItem.findFirstOrThrow({ where: { orderId: splitTarget.id } })
  check('the moved line keeps its pinned recipe', moved.recipeId === plainRecipe.id,
    'the split dropped recipeId, so the remainder would re-resolve against a newer recipe')

  // Cancel the split-off bill: its one bun comes back, and only its one.
  await prisma.orderItem.updateMany({ where: { orderId: splitTarget.id }, data: { status: 'CANCELLED' } })
  await prisma.$transaction((tx) =>
    reconcileOrderDepletion(tx, { restaurantId: restaurant.id, orderId: splitTarget.id, userId: user.id }),
  )
  check('cancelling the split-off bill returns exactly its own bun', await qty(bun.id) === 99,
    `bun at ${await qty(bun.id)}, expected 99`)

  const mergeA = await makeBill('MERGEA', 1)
  const mergeB = await makeBill('MERGEB', 1)
  const bunBeforeMerge = await qty(bun.id)
  check('two more bills took two more buns', bunBeforeMerge === 97, `bun at ${bunBeforeMerge}`)

  await mergeBills({ restaurantId: restaurant.id, targetId: mergeA.id, sourceIds: [mergeB.id] })

  check('merging moves no stock by itself', await qty(bun.id) === 97, `bun at ${await qty(bun.id)}`)
  const sourceRows = await prisma.orderStockDepletion.findMany({
    where: { orderId: mergeB.id, appliedQty: { not: 0 } },
  })
  check('the absorbed bill no longer claims anything', sourceRows.length === 0,
    `${sourceRows.length} orphaned rows would never be given back`)
  const targetRow = await prisma.orderStockDepletion.findFirstOrThrow({
    where: { orderId: mergeA.id, itemId: bun.id },
  })
  check('and the surviving bill claims both buns', targetRow.appliedQty === 2,
    `${targetRow.appliedQty}`)

  // Cancelling the merged bill must return both, not one.
  await prisma.orderItem.updateMany({ where: { orderId: mergeA.id }, data: { status: 'CANCELLED' } })
  await prisma.$transaction((tx) =>
    reconcileOrderDepletion(tx, { restaurantId: restaurant.id, orderId: mergeA.id, userId: user.id }),
  )
  check('cancelling the merged bill returns both buns', await qty(bun.id) === 99,
    `bun at ${await qty(bun.id)}, expected 99`)

  // ── cleanup ─────────────────────────────────────────────────────────────

  await prisma.productionConsumption.deleteMany({ where: { order: { restaurantId: restaurant.id } } })
  await prisma.productionOutput.deleteMany({ where: { order: { restaurantId: restaurant.id } } })
  await prisma.productionOrder.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.orderStockDepletion.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.stockMovement.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.stockBatch.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.inventoryStock.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.orderEvent.deleteMany({ where: { order: { restaurantId: restaurant.id } } })
  await prisma.orderItem.deleteMany({ where: { order: { restaurantId: restaurant.id } } })
  await prisma.order.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.recipeIngredient.deleteMany({ where: { recipe: { restaurantId: restaurant.id } } })
  await prisma.recipe.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.food.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.category.deleteMany({ where: { restaurantId: restaurant.id } })
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
