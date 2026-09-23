/**
 * Kitchen production, one flow (recorrection.md §3).
 *
 *   Make an Item → Create prepared item → the item's page → actual qty → Make Done
 *
 * Create writes the ITEM and its RECIPE and starts the batch, and moves no
 * stock. Mark Done runs the one atomic transaction against that batch's own
 * row. This file pins the parts that are new or were wrong:
 *
 *   - Create leaves a prepared item and a prep recipe behind it, and nothing
 *     on the ledger;
 *   - the workspace hands the recipe back, keyed by item, so "Make more"
 *     pre-fills — `listPrepRecipes` had existed with zero callers;
 *   - Mark Done's ledger rows carry the BATCH's number: the first cut drew a
 *     fresh PRD- number on the batch path and wrote that into every reason,
 *     so the order and its movements disagreed and a number was skipped;
 *   - the recipe is left alone when the plan is identical and versioned by
 *     the recipes domain's own rule when it changes;
 *   - a unit the item cannot be measured in, a self-reference and a raw
 *     item's name are refused at Create, not at Mark Done with the pot on
 *     the counter;
 *   - the form has one verb, no location select, and Mark Done demands a
 *     reason from the ledger's vocabulary when the figures differ.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/prepared-item-test.ts
 */
import { existsSync, readFileSync } from 'node:fs'

import { prisma } from '../src/server/db/prisma'
import { postMovement } from '../src/features/inventory/ledger'
import { getProductionWorkspace } from '../src/features/production/queries'
import { completeBatch, startBatch } from '../src/features/production/service'

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
let seq = 0
const key = () => `prep-${stamp}-${++seq}`
let restaurantId: string | null = null

async function cleanup(id: string) {
  await prisma.productionConsumption.deleteMany({ where: { order: { restaurantId: id } } })
  await prisma.productionOutput.deleteMany({ where: { order: { restaurantId: id } } })
  await prisma.wastageRecord.deleteMany({ where: { restaurantId: id } })
  await prisma.productionOrder.deleteMany({ where: { restaurantId: id } })
  await prisma.recipeIngredient.deleteMany({ where: { recipe: { restaurantId: id } } })
  await prisma.recipe.deleteMany({ where: { restaurantId: id } })
  await prisma.stockMovement.deleteMany({ where: { restaurantId: id } })
  await prisma.stockBatch.deleteMany({ where: { restaurantId: id } })
  await prisma.inventoryStock.deleteMany({ where: { restaurantId: id } })
  await prisma.inventoryItem.deleteMany({ where: { restaurantId: id } })
  await prisma.restaurant.deleteMany({ where: { id } })
}

async function main() {
  const restaurant = await prisma.restaurant.create({
    data: { name: 'Prep Co', slug: `prep-${stamp}`, email: `prep-${stamp}@test.local` },
  })
  restaurantId = restaurant.id
  const kitchen = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Kitchen', code: 'KIT', isDefault: true },
  })
  const cook = await prisma.user.create({
    data: { restaurantId: restaurant.id, email: `cook-${stamp}@test.local`, name: 'Cook', passwordHash: 'x', role: 'MANAGER', branchId: kitchen.id },
  })
  const egg = await prisma.inventoryItem.create({
    data: { restaurantId: restaurant.id, name: `Egg ${stamp}`, unit: 'PIECE', branchId: kitchen.id, costPerUnit: 30_00 },
  })
  const oil = await prisma.inventoryItem.create({
    data: { restaurantId: restaurant.id, name: `Oil ${stamp}`, unit: 'ML', branchId: kitchen.id, costPerUnit: 1_00 },
  })
  for (const [item, qty] of [[egg, 60], [oil, 5000]] as const) {
    await prisma.$transaction((tx) =>
      postMovement(tx, {
        restaurantId: restaurant.id, itemId: item.id, type: 'PURCHASE', quantity: qty,
        branchId: kitchen.id, locationId: null, userId: cook.id,
      }),
    )
  }
  const movements = () => prisma.stockMovement.count({ where: { restaurantId: restaurant.id } })

  const plan = {
    name: `Mayonnaise ${stamp}`,
    quantity: 900,
    unit: 'GRAM' as const,
    ingredients: [
      { itemId: egg.id, quantity: 6, unit: 'PIECE' as const },
      { itemId: oil.id, quantity: 500, unit: 'ML' as const },
    ],
  }

  console.log('\n── 1. Create: the item and its recipe exist; nothing moves ──')
  let batchId = ''
  let batchNumber = ''
  let itemId = ''
  {
    const before = await movements()
    const created = await startBatch({
      restaurantId: restaurant.id, branchId: kitchen.id, userId: cook.id, clientRequestId: key(), plan,
    })
    batchId = created.id
    batchNumber = created.number
    itemId = created.item.id
    check('Create hands back the batch and the item', created.number.startsWith('PRD-') && created.item.name === plan.name)
    check('and says the item is new', created.item.isNew === true && created.replayed === false)

    const item = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: itemId } })
    check('the prepared item exists from Create, not from Mark Done', item.isPrepared && item.unit === 'GRAM')
    check('with nothing on hand', item.quantity === 0)

    const recipe = await prisma.recipe.findFirst({
      where: { restaurantId: restaurant.id, producesItemId: itemId, isActive: true },
      include: { ingredients: true },
    })
    check('a prep recipe was written for it', recipe !== null)
    check('with the yield', recipe?.yieldQty === 900 && recipe?.yieldUnit === 'GRAM')
    check('and the lines', recipe?.ingredients.length === 2 && recipe.ingredients.some((l) => l.inventoryItemId === egg.id && l.quantity === 6))

    const order = await prisma.productionOrder.findUniqueOrThrow({ where: { id: batchId } })
    check('the batch points at both', order.outputItemId === itemId && order.recipeId === recipe?.id)
    check('and is in progress', order.status === 'IN_PROGRESS' && order.plannedQty === 900)
    check('nothing was written to the ledger', (await movements()) === before)
  }

  console.log('\n── 2. The workspace hands the recipe back, keyed by item ──')
  {
    const data = await getProductionWorkspace({ restaurantId: restaurant.id, branchId: kitchen.id })
    const recipe = data.recipes[itemId]
    check('the recipe is on the workspace', recipe !== undefined)
    check('with its lines, so Make more can pre-fill', recipe?.ingredients.some((l) => l.itemId === oil.id && l.quantity === 500 && l.unit === 'ML') === true)
    const open = data.openBatches.find((b) => b.id === batchId)
    check('the open batch knows its item', open?.itemId === itemId)
    check('and what it will consume', open?.ingredients.length === 2)
    check('the item is on Prepared Items already, with nothing on hand', data.prepared.some((p) => p.id === itemId && p.available === 0))
  }

  console.log('\n── 3. Mark Done consumes the plan and keeps the batch number ──')
  {
    const result = await completeBatch({
      restaurantId: restaurant.id, batchId, userId: cook.id, clientRequestId: key(),
      actualQuantity: 850, varianceReason: 'PRODUCTION_LOSS', varianceNote: 'Stuck to the bowl',
    })
    check('the result carries the batch number, not a new one', result.number === batchNumber, result.number)

    const order = await prisma.productionOrder.findUniqueOrThrow({ where: { id: batchId } })
    check('the order kept its number', order.number === batchNumber)
    check('completed, actual and variance recorded', order.status === 'COMPLETED' && order.actualQty === 850 && order.variance === -50)
    check('with the reason from the enum', order.varianceReason === 'PRODUCTION_LOSS' && order.varianceNote === 'Stuck to the bowl')

    const rows = await prisma.stockMovement.findMany({
      where: { restaurantId: restaurant.id, referenceType: 'ProductionOrder', referenceId: batchId },
    })
    check('every ledger row names the batch by its own number', rows.length === 3 && rows.every((r) => (r.reason ?? '').includes(batchNumber)), rows.map((r) => r.reason).join(' | '))
    check('no ledger row names a number the order never had', rows.every((r) => !/PRD-0*\d+/.test((r.reason ?? '').replace(batchNumber, ''))))

    const eggStock = await prisma.inventoryStock.findFirstOrThrow({ where: { itemId: egg.id, branchId: kitchen.id } })
    check('the eggs left', eggStock.available === 54)
    const mayo = await prisma.inventoryStock.findFirstOrThrow({ where: { itemId, branchId: kitchen.id } })
    check('the mayonnaise arrived, at the actual yield', mayo.available === 850)

    // The number sequence has no hole: the next Create takes the next number.
    const next = await startBatch({
      restaurantId: restaurant.id, branchId: kitchen.id, userId: cook.id, clientRequestId: key(),
      plan: { ...plan, itemId },
    })
    const n = (s: string) => Number.parseInt(s.replace(/\D/g, ''), 10)
    check('the next batch takes the very next number — nothing was skipped', n(next.number) === n(batchNumber) + 1, `${batchNumber} → ${next.number}`)
    batchId = next.id
  }

  console.log('\n── 4. The recipe: kept when the plan is the same, versioned when it changes ──')
  {
    const versions = () => prisma.recipe.findMany({ where: { restaurantId: restaurant.id, producesItemId: itemId }, orderBy: { version: 'asc' } })
    const before = await versions()
    check('making it the same way again wrote no new version', before.length === 1 && before[0].version === 1)

    // The first run COMPLETED against v1, so a changed plan supersedes rather
    // than edits — last month's cost must not re-price itself.
    const changed = await startBatch({
      restaurantId: restaurant.id, branchId: kitchen.id, userId: cook.id, clientRequestId: key(),
      plan: { ...plan, itemId, ingredients: [{ itemId: egg.id, quantity: 8, unit: 'PIECE' }, { itemId: oil.id, quantity: 500, unit: 'ML' }] },
    })
    const after = await versions()
    check('a changed plan is a new version', after.length === 2 && after[1].version === 2)
    check('the old one is kept, inactive', after[0].isActive === false && after[1].isActive === true)
    const order = await prisma.productionOrder.findUniqueOrThrow({ where: { id: changed.id } })
    check('the new batch points at the new version', order.recipeId === after[1].id)
    const lines = await prisma.recipeIngredient.findMany({ where: { recipeId: after[1].id } })
    check('with the changed line', lines.some((l) => l.inventoryItemId === egg.id && l.quantity === 8))
  }

  console.log('\n── 5. Refused at Create, not at Mark Done ──')
  {
    await refuses(
      'a yield in a unit the item cannot be measured in',
      () => startBatch({ restaurantId: restaurant.id, branchId: kitchen.id, userId: cook.id, clientRequestId: key(), plan: { ...plan, itemId, unit: 'LITRE' } }),
      /PRODUCTION_UNIT_MISMATCH|stocked in/i,
    )
    await refuses(
      'making something out of itself',
      () => startBatch({ restaurantId: restaurant.id, branchId: kitchen.id, userId: cook.id, clientRequestId: key(), plan: { ...plan, itemId, ingredients: [{ itemId, quantity: 1, unit: 'GRAM' }] } }),
      /SELF_REFERENCE|itself|thing it makes/i,
    )
    await refuses(
      "a raw stock item's name",
      () => startBatch({ restaurantId: restaurant.id, branchId: kitchen.id, userId: cook.id, clientRequestId: key(), plan: { ...plan, itemId: null, name: egg.name } }),
      /PRODUCTION_NAME_IS_RAW_STOCK|raw stock item/i,
    )
    await refuses(
      "another restaurant's ingredient",
      () => startBatch({ restaurantId: restaurant.id, branchId: kitchen.id, userId: cook.id, clientRequestId: key(), plan: { ...plan, itemId, ingredients: [{ itemId: 'not-ours', quantity: 1, unit: 'GRAM' }] } }),
      /not found|Ingredient/i,
    )
  }

  console.log('\n── 6. The screen is the six-step flow (pro.b.md §11) ──')
  {
    // DELIBERATE behaviour change 2026-09 (pro.b.md): Make an Item is the
    // first three screens — recipe, stock check, order — and the order's own
    // page is the last three. The one-verb pins of recorrection.md §3 gave way
    // to that; what they protected (nothing moves at Create) still holds.
    const form = readFileSync('src/features/production/components/make-item-form.tsx', 'utf8')
    check('no "Make it now"', !form.includes('Make it now'))
    check('no "What did you make?"', !form.includes('What did you make?'))
    check('no location select on the form', !form.includes('Made at') && !/<select[^>]*value=\{branch\}/.test(form))
    check('it names the location it is acting on', form.includes('Making at'))
    check('three steps: Recipe Setup, Check Available Stock, Create Production Order',
      form.includes('Recipe Setup') && form.includes('Check Available Stock') && form.includes('Create Production Order'))
    check('step 1 saves the recipe and step 3 creates the order — never the one-shot',
      form.includes('saveProductionRecipeAction') && form.includes('startBatchAction') && !form.includes('produceItemAction'))
    check('costs are the FIFO walk the issue uses', form.includes('walkFifo'))
    check('Create Order leads to the order page, where the ingredients are issued',
      form.includes('router.push(`/dashboard/production/${data.id}`)'))
    check('the old open-batches card is gone', !existsSync('src/features/production/components/open-batches.tsx'))

    const done = readFileSync('src/features/production/components/mark-done-form.tsx', 'utf8')
    check('Complete Production sends the variance reason from the enum', done.includes('varianceReason: needsReason && reason ? reason : undefined'))
    check("and requires a reason AND a note when the figures differ", done.includes("(!needsReason || (reason !== '' && note.trim().length > 0))"))
    check('and asks for the wastage quantity (§6)', done.includes('Wastage Quantity') && done.includes('wastageQuantity'))

    const workspace = readFileSync('src/features/production/components/production-workspace.tsx', 'utf8')
    check('orders in progress are listed under the steps, each linking to its own page',
      !workspace.includes('OpenBatches') && workspace.includes('/dashboard/production/${batch.id}'))
    const table = readFileSync('src/features/production/components/prepared-items-table.tsx', 'utf8')
    check('and each row opens the item\'s page', table.includes('/dashboard/production/items/${row.id}'))
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
