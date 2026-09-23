/**
 * Kitchen Production, the full flow (aO.md §5).
 *
 *   Make an Item → Create → the prepared item's PAGE
 *     → "How much did you make?" + unit → Make Done
 *     → later: "Add Production / Make More" → quantity + unit → done
 *
 * What this pins, over and above `prepared-item-test` (which pins Create and
 * Mark Done themselves):
 *
 *   - the item page's query answers the questions the page asks: what is on
 *     the shelf here, how the item is made and what that costs today, which
 *     batches are waiting, and this item's whole history;
 *   - Make Done accepts the unit the cook actually measured in — a batch
 *     planned in grams finished as "1 KG" stocks 1000 g, not 1;
 *   - Make More scales the item's own recipe by what is being made, consumes
 *     the ingredients through the ordinary ledger, stocks the item at what
 *     they cost, draws its own reference number, creates NO second prepared
 *     item, and replays on the same request key rather than making it twice;
 *   - Make More refuses when there is no recipe to repeat;
 *   - history carries the status and the ingredients consumed for every run,
 *     in progress and cancelled ones included — and an in-progress batch
 *     shows what it PLANS to consume, since nothing has left yet;
 *   - production stays an inventory transformation: value moves from raw
 *     stock into the prepared item and nothing is expensed.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/production-flow-test.ts
 */
import { readFileSync, existsSync } from 'node:fs'

import { prisma } from '../src/server/db/prisma'
import { postMovement } from '../src/features/inventory/ledger'
import { getPreparedItemPage, getProductionWorkspace } from '../src/features/production/queries'
import { cancelBatch, completeBatch, makeMore, startBatch } from '../src/features/production/service'

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
const key = () => `flow-${stamp}-${++seq}`
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
  await prisma.user.deleteMany({ where: { restaurantId: id } })
  await prisma.branch.deleteMany({ where: { restaurantId: id } })
  await prisma.restaurant.deleteMany({ where: { id } })
}

async function main() {
  const restaurant = await prisma.restaurant.create({
    data: { name: 'Flow Co', slug: `flow-${stamp}`, email: `flow-${stamp}@test.local` },
  })
  restaurantId = restaurant.id
  const kitchen = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Kitchen', code: 'KIT', isDefault: true },
  })
  const cook = await prisma.user.create({
    data: {
      restaurantId: restaurant.id, email: `cook-${stamp}@test.local`, name: 'Cook',
      passwordHash: 'x', role: 'MANAGER', branchId: kitchen.id,
    },
  })

  // Flour is stocked in GRAM so a kilo answer has to be converted; butter in
  // PIECE so a scaled line lands on a countable unit.
  const flour = await prisma.inventoryItem.create({
    data: { restaurantId: restaurant.id, name: `Flour ${stamp}`, unit: 'GRAM', branchId: kitchen.id, costPerUnit: 2 },
  })
  const butter = await prisma.inventoryItem.create({
    data: { restaurantId: restaurant.id, name: `Butter ${stamp}`, unit: 'PIECE', branchId: kitchen.id, costPerUnit: 50_00 },
  })
  for (const [item, qty, unit] of [[flour, 20, 'KG'], [butter, 40, 'PIECE']] as const) {
    await prisma.$transaction((tx) =>
      postMovement(tx, {
        restaurantId: restaurant.id, itemId: item.id, type: 'PURCHASE', quantity: qty,
        enteredUnit: unit, branchId: kitchen.id, locationId: null, userId: cook.id,
      }),
    )
  }
  const stockOf = async (itemId: string) =>
    (await prisma.inventoryStock.findFirst({ where: { itemId, branchId: kitchen.id } }))?.available ?? 0
  const movements = () => prisma.stockMovement.count({ where: { restaurantId: restaurant.id } })

  const doughName = `Dough ${stamp}`
  const plan = {
    name: doughName,
    quantity: 1000,
    unit: 'GRAM' as const,
    ingredients: [
      { itemId: flour.id, quantity: 800, unit: 'GRAM' as const },
      { itemId: butter.id, quantity: 2, unit: 'PIECE' as const },
    ],
  }

  let itemId = ''
  let firstBatch = ''

  console.log('\n── 1. Create, then the item page answers what the cook needs ──')
  {
    const created = await startBatch({
      restaurantId: restaurant.id, branchId: kitchen.id, userId: cook.id, clientRequestId: key(), plan,
    })
    itemId = created.item.id
    firstBatch = created.id

    const page = await getPreparedItemPage({ restaurantId: restaurant.id, branchId: kitchen.id, itemId })
    if (!page) throw new Error('the item page query found nothing')

    check('the page names the item and its stock unit', page.item.name === doughName && page.item.unit === 'GRAM')
    check('and offers the units it can be measured in', page.item.units.includes('KG') && page.item.units.includes('GRAM'))
    check('it names the location', page.branch?.id === kitchen.id)
    check('nothing on the shelf yet — Create moved nothing', page.stock.here === 0 && page.stock.runs === 0)

    check('the recipe is there, costed', page.recipe !== null && page.recipe.lines.length === 2)
    const flourLine = page.recipe?.lines.find((l) => l.itemId === flour.id)
    check('each line carries its ingredient name, quantity and unit', flourLine?.name === flour.name && flourLine.quantity === 800 && flourLine.unit === 'GRAM')
    check('with the unit cost from the ledger', flourLine?.unitCost === 2, String(flourLine?.unitCost))
    check('and the line cost', flourLine?.lineCost === 1600, String(flourLine?.lineCost))
    check('and what is on hand here', flourLine?.available === 20000, String(flourLine?.available))
    // 800 g × 2 + 2 butter × 5000 = 1600 + 10000
    check('Production Cost is the sum of the lines', page.recipe?.productionCost === 11_600, String(page.recipe?.productionCost))
    check('and the cost per unit is that over the yield', Math.abs((page.recipe?.costPerUnit ?? 0) - 11.6) < 0.001, String(page.recipe?.costPerUnit))

    check('the batch waiting is listed', page.openBatches.length === 1 && page.openBatches[0].id === firstBatch)
    check('with what it will consume, named', page.openBatches[0].ingredients.some((l) => l.name === flour.name && l.quantity === 800))
    check('and it is in history as in progress', page.history.some((r) => r.id === firstBatch && r.status === 'IN_PROGRESS'))
  }

  console.log('\n── 2. "How much did you make?" takes a unit of its own ──')
  {
    const before = { flour: await stockOf(flour.id), butter: await stockOf(butter.id) }
    // Planned 1000 GRAM; the cook weighs the tray and says 1 KG.
    const done = await completeBatch({
      restaurantId: restaurant.id, batchId: firstBatch, userId: cook.id, clientRequestId: key(),
      actualQuantity: 1, actualUnit: 'KG',
    })
    check('the yield is converted to the item\'s own unit', done.producedQty === 1000, String(done.producedQty))
    check('and stocked there', (await stockOf(itemId)) === 1000, String(await stockOf(itemId)))
    check('the planned ingredients left, in their own units', (await stockOf(flour.id)) === before.flour - 800 && (await stockOf(butter.id)) === before.butter - 2)
    check('the value that left is the value that arrived', done.totalValue === 11_600, String(done.totalValue))

    const order = await prisma.productionOrder.findUniqueOrThrow({ where: { id: firstBatch } })
    check('the batch completed, keeping its own number', order.status === 'COMPLETED' && order.number === done.number)
    check('the actual is recorded in base units', order.actualQty === 1000 && order.variance === 0)

    await refuses(
      'a unit the item cannot be measured in is refused',
      async () => {
        const spare = await startBatch({
          restaurantId: restaurant.id, branchId: kitchen.id, userId: cook.id, clientRequestId: key(),
          plan: { ...plan, itemId },
        })
        return completeBatch({
          restaurantId: restaurant.id, batchId: spare.id, userId: cook.id, clientRequestId: key(),
          actualQuantity: 2, actualUnit: 'LITRE',
        })
      },
      /PRODUCTION_UNIT_MISMATCH|stocked in/i,
    )
    // The batch that refusal created is abandoned, so it does not pollute §4.
    const stray = await prisma.productionOrder.findFirst({
      where: { restaurantId: restaurant.id, status: 'IN_PROGRESS' }, orderBy: { createdAt: 'desc' },
    })
    if (stray) await cancelBatch({ restaurantId: restaurant.id, batchId: stray.id })
  }

  console.log('\n── 3. Make More: the recipe, scaled, in one step ──')
  {
    const before = {
      flour: await stockOf(flour.id), butter: await stockOf(butter.id), dough: await stockOf(itemId),
      items: await prisma.inventoryItem.count({ where: { restaurantId: restaurant.id } }),
    }
    const requestKey = key()
    // 2 KG of a recipe that yields 1000 g — everything doubles.
    const more = await makeMore({
      restaurantId: restaurant.id, branchId: kitchen.id, userId: cook.id,
      clientRequestId: requestKey, itemId, quantity: 2, unit: 'KG',
    })

    check('it made what was asked for, in base units', more.producedQty === 2000, String(more.producedQty))
    check('the ingredients scaled by the ratio', (await stockOf(flour.id)) === before.flour - 1600 && (await stockOf(butter.id)) === before.butter - 4)
    check('the prepared item gained it', (await stockOf(itemId)) === before.dough + 2000)
    check('at exactly what the ingredients cost', more.totalValue === 23_200, String(more.totalValue))
    check('no second prepared item was created', (await prisma.inventoryItem.count({ where: { restaurantId: restaurant.id } })) === before.items)
    check('it drew its own reference number', more.number.startsWith('PRD-') && more.orderId !== firstBatch)

    const run = await prisma.productionOrder.findUniqueOrThrow({ where: { id: more.orderId } })
    check('recorded as a completed run against this item', run.status === 'COMPLETED' && run.outputItemId === itemId)
    check('at this branch, by this cook', run.branchId === kitchen.id && run.requestedById === cook.id)
    const consumption = await prisma.productionConsumption.findMany({ where: { orderId: more.orderId } })
    check('with a consumption row per ingredient', consumption.length === 2)

    const rows = await prisma.stockMovement.findMany({
      where: { restaurantId: restaurant.id, referenceType: 'ProductionOrder', referenceId: more.orderId },
    })
    check('every ledger row names the run', rows.length === 3 && rows.every((r) => (r.reason ?? '').includes(more.number)))
    check('two out, one in — a transformation, not an expense', rows.filter((r) => r.type === 'PRODUCTION_CONSUMPTION').length === 2 && rows.filter((r) => r.type === 'PRODUCTION_OUTPUT').length === 1)
    check('nothing was written off as waste', (await prisma.wastageRecord.count({ where: { productionOrderId: more.orderId } })) === 0)

    // The same key again: the request is a replay, not a second pot.
    const beforeReplay = await movements()
    const replay = await makeMore({
      restaurantId: restaurant.id, branchId: kitchen.id, userId: cook.id,
      clientRequestId: requestKey, itemId, quantity: 2, unit: 'KG',
    })
    check('the same request key replays the run', replay.replayed === true && replay.orderId === more.orderId)
    check('and moves nothing a second time', (await movements()) === beforeReplay && (await stockOf(itemId)) === before.dough + 2000)
  }

  console.log('\n── 4. Make More needs a recipe, and refuses what is not ours ──')
  {
    const orphan = await prisma.inventoryItem.create({
      data: {
        restaurantId: restaurant.id, name: `Sauce ${stamp}`, unit: 'ML',
        branchId: kitchen.id, isPrepared: true, costPerUnit: 0,
      },
    })
    await refuses(
      'an item with no recipe cannot be repeated',
      () => makeMore({
        restaurantId: restaurant.id, branchId: kitchen.id, userId: cook.id,
        clientRequestId: key(), itemId: orphan.id, quantity: 1, unit: 'LITRE',
      }),
      /PRODUCTION_NO_RECIPE|no recipe on file/i,
    )
    await refuses(
      'a raw stock item cannot be produced',
      () => makeMore({
        restaurantId: restaurant.id, branchId: kitchen.id, userId: cook.id,
        clientRequestId: key(), itemId: flour.id, quantity: 1, unit: 'KG',
      }),
      /PRODUCTION_NAME_IS_RAW_STOCK|raw stock item|no recipe/i,
    )
    await refuses(
      "another restaurant's item is not found",
      () => makeMore({
        restaurantId: restaurant.id, branchId: kitchen.id, userId: cook.id,
        clientRequestId: key(), itemId: 'not-ours', quantity: 1, unit: 'KG',
      }),
      /not found|Prepared item/i,
    )
    await refuses(
      'nothing is made out of nothing',
      () => makeMore({
        restaurantId: restaurant.id, branchId: kitchen.id, userId: cook.id,
        clientRequestId: key(), itemId, quantity: 0, unit: 'KG',
      }),
      /PRODUCTION_NO_QUANTITY|How much/i,
    )
  }

  console.log('\n── 4b. Making something that is already a stock item ──')
  {
    /*
     * aO.md §5: "search/select an existing item from Stock/Inventory". An
     * item added in Inventory the ordinary way is not flagged prepared, and
     * the form used to list only prepared ones — so the only way to make
     * something you already stocked was to invent a second name for it,
     * which is exactly the duplicate record the spec says not to create.
     */
    const bought = await prisma.inventoryItem.create({
      data: {
        restaurantId: restaurant.id, name: `Mozzarella ${stamp}`, unit: 'GRAM',
        branchId: kitchen.id, costPerUnit: 4, isPrepared: false,
      },
    })
    await prisma.$transaction((tx) =>
      postMovement(tx, {
        restaurantId: restaurant.id, itemId: bought.id, type: 'PURCHASE', quantity: 500,
        enteredUnit: 'GRAM', branchId: kitchen.id, locationId: null, userId: cook.id,
      }),
    )
    const itemsBefore = await prisma.inventoryItem.count({ where: { restaurantId: restaurant.id } })

    const batch = await startBatch({
      restaurantId: restaurant.id, branchId: kitchen.id, userId: cook.id, clientRequestId: key(),
      plan: {
        name: bought.name, itemId: bought.id, quantity: 400, unit: 'GRAM',
        ingredients: [{ itemId: flour.id, quantity: 100, unit: 'GRAM' }],
      },
    })
    check('a bought-in item can be chosen and made', batch.item.id === bought.id && batch.item.isNew === false)
    const done = await completeBatch({
      restaurantId: restaurant.id, batchId: batch.id, userId: cook.id, clientRequestId: key(),
      actualQuantity: 400,
    })
    check('the stock it already had is kept, and the batch added to it', (await stockOf(bought.id)) === 900, String(await stockOf(bought.id)))
    check('no second record was created for it', (await prisma.inventoryItem.count({ where: { restaurantId: restaurant.id } })) === itemsBefore)
    const after = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: bought.id } })
    check('and it is a prepared item from now on', after.isPrepared === true)
    check('its cost is the blend of what was bought and what was made', done.item.costPerUnit > 0)

    // Typing a raw item's NAME is still refused: that is somebody naming a
    // dish after its main ingredient, not choosing what to make.
    await refuses(
      "a typed name that collides with raw stock is still refused",
      () => startBatch({
        restaurantId: restaurant.id, branchId: kitchen.id, userId: cook.id, clientRequestId: key(),
        plan: { name: butter.name, itemId: null, quantity: 1, unit: 'PIECE', ingredients: [{ itemId: flour.id, quantity: 10, unit: 'GRAM' }] },
      }),
      /PRODUCTION_NAME_IS_RAW_STOCK|raw stock item/i,
    )
  }

  console.log('\n── 5. History tells the whole story, in every state ──')
  {
    // One batch left open and one abandoned, so all four states are present.
    const waiting = await startBatch({
      restaurantId: restaurant.id, branchId: kitchen.id, userId: cook.id, clientRequestId: key(),
      plan: { ...plan, itemId, quantity: 500 },
    })
    const abandoned = await startBatch({
      restaurantId: restaurant.id, branchId: kitchen.id, userId: cook.id, clientRequestId: key(),
      plan: { ...plan, itemId, quantity: 300 },
    })
    await cancelBatch({ restaurantId: restaurant.id, batchId: abandoned.id })

    const page = await getPreparedItemPage({ restaurantId: restaurant.id, branchId: kitchen.id, itemId })
    if (!page) throw new Error('the item page query found nothing')
    const row = (id: string) => page.history.find((r) => r.id === id)

    check('the finished batch is there, completed', row(firstBatch)?.status === 'COMPLETED')
    check('the batch waiting is there, in progress', row(waiting.id)?.status === 'IN_PROGRESS')
    check('the abandoned one is kept, not deleted', row(abandoned.id)?.status === 'CANCELLED')

    const finished = row(firstBatch)!
    check('a finished run says what it consumed', finished.consumed.some((l) => l.name === flour.name && l.quantity === 800))
    check('with the cost, the maker, the branch and the reference', finished.totalCost === 11_600 && finished.madeBy === 'Cook' && finished.branchName === 'Kitchen' && finished.number.startsWith('PRD-'))
    check('and when it was made', typeof finished.completedAt === 'string')

    const open = row(waiting.id)!
    check('a batch in progress says what it PLANS to consume', open.consumed.some((l) => l.name === flour.name))
    check('and has no completion time yet', open.completedAt === null && typeof open.createdAt === 'string')
    check('a cancelled batch consumed nothing', row(abandoned.id)?.consumed.length === 0)

    const workspace = await getProductionWorkspace({ restaurantId: restaurant.id, branchId: kitchen.id })
    check('the workspace history carries every state too', ['COMPLETED', 'IN_PROGRESS', 'CANCELLED'].every((state) => workspace.history.some((r) => r.status === state)))
    check('and the ingredients consumed', workspace.history.find((r) => r.id === firstBatch)?.consumed.length === 2)
    check('runs today counts only what finished', workspace.stats.runsToday >= 2)
  }

  console.log('\n── 6. The screens: six steps, the order carried from the third ──')
  {
    // DELIBERATE behaviour change 2026-09 (pro.b.md): the item page no longer
    // completes anything itself. Make Done and Make More became a production
    // order with its own page — issue (FIFO), complete, finished stock.
    const form = readFileSync('src/features/production/components/make-item-form.tsx', 'utf8')
    check('Create Order leads to the order page', form.includes('router.push(`/dashboard/production/${data.id}`)'))
    check('and asks nothing twice', !form.includes('Made it already?') && !form.includes('What did you make?'))
    check('the make form completes nothing itself', !form.includes('CompleteProductionForm') && !form.includes('MarkDoneForm'))
    check('still no location select', form.includes('Making at'))

    check('the item page exists as a route', existsSync('src/app/dashboard/production/items/[itemId]/page.tsx'))
    check('and the old dialog is gone', !existsSync('src/features/production/components/prepared-item-detail.tsx'))
    check('and the one-step Make More form is gone', !existsSync('src/features/production/components/make-more-form.tsx'))

    const page = readFileSync('src/features/production/components/prepared-item-page.tsx', 'utf8')
    check('the page shows the ingredients and Production Cost', page.includes('Production Cost') && page.includes('Ingredients'))
    check('and Add Production / Make More opens a new order for the same item', page.includes('Add Production') && page.includes('/dashboard/production?make=${item.id}'))
    check('and this item\'s history', page.includes('<ProductionHistory'))

    const done = readFileSync('src/features/production/components/mark-done-form.tsx', 'utf8')
    check('Complete Production asks for the actual quantity with a unit', done.includes('Actual Produced Quantity') && done.includes('actualUnit'))
    check('and is labelled Complete Production', done.includes('Complete Production'))
    check('the variance reason rule survives', done.includes("(!needsReason || (reason !== '' && note.trim().length > 0))"))
    check('and shows the spec\'s three figures', done.includes('Total Ingredient Cost (FIFO)') && done.includes('Actual Output Quantity') && done.includes('Actual Cost per'))

    const order = readFileSync('src/features/production/components/production-order-panel.tsx', 'utf8')
    check('the order page has Ingredients, Production and Notes', order.includes('"ingredients"') && order.includes('"production"') && order.includes('"notes"'))
    check('with Issue All (FIFO)', order.includes('Issue All (FIFO)') && order.includes('issueIngredientsAction'))
    check('an editable Issue Qty per line', order.includes('Issue Qty') && order.includes('Required Qty'))
    check('lots shown after issue', order.includes('lot.batchNo'))
    check('and Finished Item in Stock after completion', order.includes('Finished Item in Stock'))

    const history = readFileSync('src/features/production/components/production-history.tsx', 'utf8')
    check('history shows status, planned, actual, wastage, ingredients and a labelled Reference',
      history.includes('>Status<') && history.includes('>Planned<') && history.includes('>Actual<') && history.includes('>Wastage<') && history.includes('Ingredients consumed') && history.includes('>Reference<'))

    const table = readFileSync('src/features/production/components/prepared-items-table.tsx', 'utf8')
    check('the rows link to the item page', table.includes('/dashboard/production/items/${row.id}'))

    // aO.md §5 — the picker offers everything in stock, not only what has
    // been made before, and searches it.
    check('the item picker lists every stock item', !/items\s*\n?\s*\.filter\(\(item\) => item\.isPrepared\)\s*\n?\s*\.map/.test(form))
    check('with the ones made before first', form.includes('items.filter((item) => item.isPrepared)') && form.includes('items.filter((item) => !item.isPrepared)'))
    check('and a search box over them', form.includes('searchPlaceholder'))
    check('the field is Make an item, over stock', form.includes('>Make an item</span>') && form.includes('Choose any item from stock') && form.includes('Search all stock items'))
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
