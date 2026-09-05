/**
 * Production: editing a recipe, retiring one, and paying for overheads.
 *
 * Three gaps this covers.
 *
 * **Recipes could not be edited.** A yield that turned out wrong, an ingredient
 * that changed, a typo — all of it meant creating a second recipe with almost
 * the same name and hoping people picked the right one. Two recipes for one
 * product is how a kitchen ends up costing the same bread two ways. Editing is
 * safe because completed runs keep the costs they were completed with: cost
 * lives on the consumption rows and on the order, posted at the time and never
 * recalculated from the spec. That is asserted here rather than assumed.
 *
 * **Overheads could not be entered.** `completeProduction` has always added
 * `order.overheadCost` to the numerator before dividing by output — but nothing
 * ever wrote that column, so it was always zero and every finished item looked
 * cheaper to make than it was.
 *
 * **Bad units failed at the mixer.** `toBaseUnits` throws when a line is written
 * in a unit that cannot be resolved to the item's own — "2 BOX of flour" where
 * flour has no pack size — and it threw at COMPLETION, inside the transaction
 * that consumes stock. The recipe saved happily and the run failed days later
 * with someone standing at the mixer. It is now caught when the recipe is saved.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/production-spec-test.ts
 */
import { prisma } from '../src/server/db/prisma'
import {
  completeProduction,
  createProductionOrder,
  setMakeAheadRecipeActive,
  setProductionStatus,
} from '../src/features/production/service'
import { saveRecipe } from '../src/features/recipes/service'
import { getProductionRun } from '../src/features/production/queries'
import { setOpeningBalance } from '../src/features/inventory/operations'

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

async function refuses(name: string, run: () => Promise<unknown>, expect: RegExp) {
  try {
    await run()
    check(name, false, 'it was allowed')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    check(name, expect.test(message), `wrong error: ${message}`)
  }
}

/**
 * A make-ahead recipe, in the shape the old production-spec API used.
 *
 * Saving twice for the same `producesItemId` supersedes rather than duplicates,
 * which is what makes the edit-safety section below meaningful.
 */
function makeAheadRecipe(params: {
  restaurantId: string
  name: string
  outputItemId: string
  outputUnit: 'KG' | 'GRAM' | 'LITRE' | 'ML' | 'PIECE' | 'PACK' | 'BOTTLE' | 'DOZEN' | 'BOX'
  outputQty: number
  shelfLifeDays?: number | null
  items: Array<{ itemId: string; quantity: number; unit?: string | null }>
}) {
  return saveRecipe({
    restaurantId: params.restaurantId,
    producesItemId: params.outputItemId,
    name: params.name,
    yieldQty: params.outputQty,
    yieldUnit: params.outputUnit,
    shelfLifeDays: params.shelfLifeDays ?? null,
    ingredients: params.items.map((line) => ({
      inventoryItemId: line.itemId,
      quantity: line.quantity,
      unit: (line.unit ?? params.outputUnit) as never,
    })),
  })
}

async function main() {
  const stamp = Date.now().toString(36)

  const restaurant = await prisma.restaurant.create({
    data: { name: `Prod ${stamp}`, slug: `prod-${stamp}`, status: 'ACTIVE', isActive: true },
  })
  const house = await prisma.branch.create({
    data: {
      restaurantId: restaurant.id,
      name: 'Bakery',
      code: 'BKY',
      type: 'PRODUCTION_HOUSE',
      isDefault: true,
    },
  })

  const flour = await prisma.inventoryItem.create({
    data: {
      restaurantId: restaurant.id,
      name: 'Flour',
      unit: 'KG',
      quantity: 0,
      costPerUnit: 20_000, // LKR 200.00 a kilo, in minor units
    },
  })
  const bread = await prisma.inventoryItem.create({
    data: { restaurantId: restaurant.id, name: 'Bread', unit: 'PIECE', quantity: 0, costPerUnit: 0 },
  })

  await setOpeningBalance({
    restaurantId: restaurant.id,
    itemId: flour.id,
    branchId: house.id,
    quantity: 500,
    reason: 'Opening',
  })

  console.log('\n── a recipe validates its units when it is saved ──')

  await refuses(
    'a unit that cannot be resolved is refused at save time',
    () =>
      makeAheadRecipe({
        restaurantId: restaurant.id,
        name: 'Bad units',
        outputItemId: bread.id,
        outputUnit: 'PIECE',
        outputQty: 10,
        items: [{ itemId: flour.id, quantity: 2, unit: 'BOX' }],
      }),
    /cannot convert|purchase unit/i,
  )

  await refuses(
    'and so is a recipe that eats its own output',
    () =>
      makeAheadRecipe({
        restaurantId: restaurant.id,
        name: 'Ouroboros',
        outputItemId: bread.id,
        outputUnit: 'PIECE',
        outputQty: 10,
        items: [{ itemId: bread.id, quantity: 1, unit: 'PIECE' }],
      }),
    /the thing it makes/i,
  )

  await refuses(
    'and one that lists the same ingredient twice',
    () =>
      makeAheadRecipe({
        restaurantId: restaurant.id,
        name: 'Double flour',
        outputItemId: bread.id,
        outputUnit: 'PIECE',
        outputQty: 10,
        items: [
          { itemId: flour.id, quantity: 5, unit: 'KG' },
          { itemId: flour.id, quantity: 3, unit: 'KG' },
        ],
      }),
    /twice/i,
  )

  const spec = await makeAheadRecipe({
    restaurantId: restaurant.id,
    name: 'White loaf',
    outputItemId: bread.id,
    outputUnit: 'PIECE',
    outputQty: 10, // one run of the recipe makes 10 loaves
    shelfLifeDays: 3,
    items: [{ itemId: flour.id, quantity: 10, unit: 'KG' }], // 10kg per run
  })
  check('a good recipe saves', Boolean(spec.id))

  console.log('\n── a run, with overheads ──')

  const order = await createProductionOrder({
    restaurantId: restaurant.id,
    branchId: house.id,
    recipeId: spec.id,
    // 100 LOAVES, not 10 batches. The recipe makes 10, so it runs ten times over
    // and still draws 100kg of flour — the arithmetic below is unchanged, which
    // is the point: only the unit the owner types in has changed.
    plannedQty: 100,
  })
  /*
   * DELIBERATE behaviour change 2026-09-04 (kitchenjobs.md): no approve step.
   *
   * The old flow was create → approve → complete, and this line approved. The
   * approval gate required `production.approve` to authorise a step that moved
   * no stock, while completion — which moves all of it — needed only
   * `production.manage`. It was also never the maker-checker mechanism, so it
   * carried no threshold and no self-approval refusal. A job is now completed
   * straight from DRAFT; every figure asserted below is unchanged.
   */
  const result = await completeProduction({
    restaurantId: restaurant.id,
    orderId: order.id,
    actualQty: 80, // twenty loaves caught and were binned
    // LKR 5,000 of labour and power on top of the flour. Passed in rather than
    // written first, so a job that fails to finish does not keep the overhead.
    overheadCost: 500_000,
    varianceReason: 'PRODUCTION_LOSS',
  })

  check('80 loaves came out of the 100 planned', result.producedQty === 80, `${result.producedQty}`)
  check(
    'all 100kg of flour was consumed, not 80kg',
    result.consumed[0]?.quantity === 100,
    `${result.consumed[0]?.quantity}kg`,
  )
  check(
    'materials cost 100kg × LKR 200',
    result.totalCost === 100 * 20_000,
    `${result.totalCost}`,
  )

  /*
   * The point of the overhead field. Materials alone are 2,000,000 minor units
   * over 80 loaves = 25,000 each. With 500,000 of overheads it is 2,500,000
   * over 80 = 31,250. Without a way to enter the overhead the second number
   * could never be reached, and every loaf looked a fifth cheaper than it was.
   */
  check(
    'and the unit cost includes the overheads',
    result.unitCost === Math.round((100 * 20_000 + 500_000) / 80),
    `${result.unitCost} — expected ${Math.round((100 * 20_000 + 500_000) / 80)}`,
  )
  check(
    'which is more than materials alone would give',
    result.unitCost > Math.round((100 * 20_000) / 80),
    'the overhead was ignored',
  )

  console.log('\n── the run detail page has something to show ──')

  const run = await getProductionRun({ restaurantId: restaurant.id, orderId: order.id })
  check('the run is readable', Boolean(run), 'the route that traceability links to returns nothing')
  check('it knows what went in', run?.consumption.length === 1, `${run?.consumption.length}`)
  check('and what came out', run?.outputs.length === 1, `${run?.outputs.length}`)
  check('it separates materials from overheads', run?.overheadCost === 500_000, `${run?.overheadCost}`)
  /*
   * `outputQtyPerBatch` used to be asserted here, so the screen could render
   * "10 batches = 100 loaves". It is gone along with the multiplier: the job
   * stores 100 and means 100.
   */
  check('the planned figure is already in loaves', run?.plannedQty === 100, `${run?.plannedQty}`)

  console.log('\n── editing a recipe leaves finished runs alone ──')

  const costBefore = run!.unitCost

  await makeAheadRecipe({
    restaurantId: restaurant.id,
    name: 'White loaf (larger)',
    outputItemId: bread.id,
    outputUnit: 'PIECE',
    outputQty: 20, // one run makes twice as much from here on
    shelfLifeDays: 3,
    items: [{ itemId: flour.id, quantity: 12, unit: 'KG' }],
  })

  const after = await getProductionRun({ restaurantId: restaurant.id, orderId: order.id })
  check(
    'last month’s cost is still last month’s cost',
    after?.unitCost === costBefore,
    `${after?.unitCost} vs ${costBefore}`,
  )
  check(
    'and what it actually consumed is unchanged',
    after?.consumption[0]?.quantity === 100,
    `${after?.consumption[0]?.quantity}`,
  )

  /*
   * The edit superseded rather than overwrote, because a completed job points at
   * the old version. That is stronger than the spec table managed: it edited in
   * place and relied on the consumption rows alone to preserve history.
   */
  const edited = await prisma.recipe.findFirstOrThrow({
    where: { restaurantId: restaurant.id, producesItemId: bread.id, isActive: true },
    include: { ingredients: true },
  })
  check('the recipe itself did change', edited.yieldQty === 20, `${edited.yieldQty}`)
  check('and its lines were replaced, not appended', edited.ingredients.length === 1, `${edited.ingredients.length}`)
  check('the version the finished job used is still there', edited.id !== spec.id, 'edited in place')

  await refuses(
    'an edit with an impossible unit is refused too',
    () =>
      makeAheadRecipe({
        restaurantId: restaurant.id,
        name: 'White loaf',
        outputItemId: bread.id,
        outputUnit: 'PIECE',
        outputQty: 20,
        items: [{ itemId: flour.id, quantity: 1, unit: 'BOTTLE' }],
      }),
    /cannot convert|purchase unit/i,
  )

  console.log('\n── retiring a recipe ──')

  const openRun = await createProductionOrder({
    restaurantId: restaurant.id,
    branchId: house.id,
    recipeId: edited.id,
    plannedQty: 1,
  })

  await refuses(
    'a recipe with a job still in flight cannot be retired',
    () => setMakeAheadRecipeActive({ restaurantId: restaurant.id, recipeId: edited.id, isActive: false }),
    /still using this recipe/i,
  )

  await setProductionStatus({
    restaurantId: restaurant.id,
    orderId: openRun.id,
    status: 'CANCELLED',
  })

  const retired = await setMakeAheadRecipeActive({
    restaurantId: restaurant.id,
    recipeId: edited.id,
    isActive: false,
  })
  check('once nothing depends on it, it retires', retired.isActive === false)

  await refuses(
    'and a retired recipe cannot start a new run',
    () =>
      createProductionOrder({
        restaurantId: restaurant.id,
        branchId: house.id,
        recipeId: edited.id,
        plannedQty: 1,
      }),
    /retired/i,
  )

  const restored = await setMakeAheadRecipeActive({
    restaurantId: restaurant.id,
    recipeId: edited.id,
    isActive: true,
  })
  check('but it can be brought back', restored.isActive === true)

  const stillThere = await getProductionRun({ restaurantId: restaurant.id, orderId: order.id })
  check(
    'and the completed run never stopped being readable',
    stillThere?.recipeName !== null,
    'retiring a recipe orphaned the runs that used it',
  )

  await prisma.productionOutput.deleteMany({ where: { order: { restaurantId: restaurant.id } } })
  await prisma.productionConsumption.deleteMany({ where: { order: { restaurantId: restaurant.id } } })
  await prisma.productionOrder.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.recipeIngredient.deleteMany({ where: { recipe: { restaurantId: restaurant.id } } })
  await prisma.recipe.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.stockMovement.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.stockBatch.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.inventoryStock.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.inventoryItem.deleteMany({ where: { restaurantId: restaurant.id } })
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
