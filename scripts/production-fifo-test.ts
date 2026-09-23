/**
 * Kitchen Production, the six-step flow with FIFO (pro.b.md).
 *
 * The worked example of §18, in the ledger: Chicken Shawarma Filling, 10 kg
 * planned; chicken on the shelf in two lots — 5 kg at 12.00 received first,
 * 20 kg at 12.80 after — plus oil, spices and salt.
 *
 * What this pins:
 *
 *   §3  creating the order moves nothing; the plan is stored intact;
 *   §4  issuing draws the ingredients from the oldest lot first at that lot's
 *       own price — 5 kg @ 12.00 then 7 kg @ 12.80 — records which lots, and
 *       leaves the ledger's value down by exactly the lots' value;
 *   §5  the second lot still holds 13 kg; the first is spent;
 *   §7  completing at 9.60 kg with 0.40 wastage costs the output at total ÷
 *       9.60 — the shortfall is absorbed, never expensed, and no finished
 *       stock is "wasted" because none existed;
 *   §8  the finished item is stock at THIS branch, at that cost, and nothing
 *       at any other; the recipe, being the restaurant's, is visible from the
 *       other branch;
 *   §9  the run's page tells the story lot by lot;
 *   §10 a second issue is refused, a second completion is refused, cancel is
 *       refused once issued; everything moves once;
 *   §4  a batch completed WITHOUT issuing still consumes at completion, FIFO;
 *       and the one-shot `produceItem` API still works, with lots;
 *   §13 history carries planned, actual and wastage.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/production-fifo-test.ts
 */
import { prisma } from '../src/server/db/prisma'
import { upsertBatch } from '../src/features/inventory/batches'
import { postMovement } from '../src/features/inventory/ledger'
import { fifoCostFor } from '../src/features/production/costing'
import { getProductionRun, getProductionWorkspace } from '../src/features/production/queries'
import {
  cancelBatch, completeBatch, issueIngredients, produceItem, saveProductionRecipe, startBatch,
} from '../src/features/production/service'

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
const key = () => `fifo-${stamp}-${++seq}`
let restaurantId: string | null = null

async function cleanup(id: string) {
  await prisma.productionConsumptionLot.deleteMany({ where: { consumption: { order: { restaurantId: id } } } })
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
  await prisma.auditLog.deleteMany({ where: { restaurantId: id } }).catch(() => undefined)
  await prisma.user.deleteMany({ where: { restaurantId: id } })
  await prisma.branch.deleteMany({ where: { restaurantId: id } })
  await prisma.restaurant.deleteMany({ where: { id } })
}

/** Money in minor units; the spec quotes major, so 12.00 is 1200. */
const M = (major: number) => Math.round(major * 100)

async function main() {
  const restaurant = await prisma.restaurant.create({
    data: { name: 'Shawarma Co', slug: `fifo-${stamp}`, email: `fifo-${stamp}@test.local` },
  })
  restaurantId = restaurant.id
  const kitchen = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Main Kitchen', code: 'MAIN', isDefault: true },
  })
  const other = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Beach Branch', code: 'BCH' },
  })
  const cook = await prisma.user.create({
    data: {
      restaurantId: restaurant.id, email: `cook-${stamp}@test.local`, name: 'Cook',
      passwordHash: 'x', role: 'MANAGER', branchId: kitchen.id,
    },
  })

  // The ingredients. Chicken in KG so the spec's figures read as written;
  // spices and salt in GRAM so a kilo line has to convert.
  const chicken = await prisma.inventoryItem.create({
    data: { restaurantId: restaurant.id, name: `Chicken ${stamp}`, unit: 'KG', branchId: kitchen.id },
  })
  const oil = await prisma.inventoryItem.create({
    data: { restaurantId: restaurant.id, name: `Oil ${stamp}`, unit: 'LITRE', branchId: kitchen.id },
  })
  const spices = await prisma.inventoryItem.create({
    data: { restaurantId: restaurant.id, name: `Spices ${stamp}`, unit: 'GRAM', branchId: kitchen.id },
  })
  const salt = await prisma.inventoryItem.create({
    data: { restaurantId: restaurant.id, name: `Salt ${stamp}`, unit: 'GRAM', branchId: kitchen.id },
  })

  /**
   * A delivery: the ledger movement at its price, and the lot it came in.
   * This is what `receiveGoods` does on every line; `receivedAt` is set
   * explicitly so the order of arrival is not left to the clock.
   */
  const receive = async (item: { id: string }, qty: number, unitCost: number, batchNo: string, receivedAt: Date) => {
    await prisma.$transaction(async (tx) => {
      await postMovement(tx, {
        restaurantId: restaurant.id, itemId: item.id, type: 'PURCHASE', quantity: qty,
        unitCost, totalValue: qty * unitCost, branchId: kitchen.id, locationId: null, userId: cook.id,
        batchNo,
      })
      const lot = await upsertBatch(tx, {
        restaurantId: restaurant.id, itemId: item.id, batchNo, quantity: qty, unitCost, branchId: kitchen.id,
      })
      await tx.stockBatch.update({ where: { id: lot.id }, data: { receivedAt } })
    })
  }
  const day = (n: number) => new Date(Date.UTC(2026, 8, n))
  await receive(chicken, 5, M(12.0), `CHK-A-${stamp}`, day(1))
  await receive(chicken, 20, M(12.8), `CHK-B-${stamp}`, day(2))
  await receive(oil, 5, M(8.0), `OIL-A-${stamp}`, day(1))
  await receive(spices, 2000, 3, `SPC-A-${stamp}`, day(1)) // 0.03/g → 30.00 per kg
  await receive(salt, 5000, 1, `SLT-A-${stamp}`, day(1)) // 0.01/g

  const stockAt = async (itemId: string, branchId: string) =>
    (await prisma.inventoryStock.findFirst({ where: { itemId, branchId } }))?.available ?? 0
  const valueOf = async (itemId: string) => Number((await prisma.inventoryItem.findUniqueOrThrow({ where: { id: itemId } })).stockValue)
  const movements = () => prisma.stockMovement.count({ where: { restaurantId: restaurant.id } })
  const lotsOf = (itemId: string) =>
    prisma.stockBatch.findMany({ where: { itemId }, orderBy: { receivedAt: 'asc' } })

  const name = `Chicken Shawarma Filling ${stamp}`
  const ingredients = [
    { itemId: chicken.id, quantity: 12, unit: 'KG' as const },
    { itemId: oil.id, quantity: 1, unit: 'LITRE' as const },
    { itemId: spices.id, quantity: 500, unit: 'GRAM' as const },
    { itemId: salt.id, quantity: 100, unit: 'GRAM' as const },
  ]
  // What the draw must cost, by hand: chicken 5×12.00 + 7×12.80, oil 8.00,
  // spices 500×0.03, salt 100×0.01.
  const expectedChicken = 5 * M(12.0) + 7 * M(12.8)
  const expectedTotal = expectedChicken + M(8.0) + 500 * 3 + 100 * 1

  console.log('\n── 1. Recipe Setup: the recipe is the restaurant’s, costed FIFO ──')
  let itemId = ''
  {
    const saved = await saveProductionRecipe({
      restaurantId: restaurant.id, branchId: kitchen.id, userId: cook.id,
      output: { name, category: 'Semi-Finished', quantity: 10, unit: 'KG' },
      ingredients,
      instructions: 'Marinate and cook chicken with spices.',
    })
    itemId = saved.item.id
    check('the prepared item is created with its recipe', saved.item.isNew && saved.recipeId !== null)
    const item = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: itemId } })
    check('it is a prepared item in KG with the category', item.isPrepared && item.unit === 'KG' && item.category === 'Semi-Finished')
    const recipe = await prisma.recipe.findFirstOrThrow({ where: { producesItemId: itemId, isActive: true }, include: { ingredients: true } })
    check('the recipe yields 10 kg with the four ingredients and the instructions',
      recipe.yieldQty === 10 && recipe.yieldUnit === 'KG' && recipe.ingredients.length === 4 && recipe.prepNotes === 'Marinate and cook chicken with spices.')
    check('and nothing has moved', (await movements()) === 5)

    const preview = await fifoCostFor(prisma, { restaurantId: restaurant.id, itemId: chicken.id, branchId: kitchen.id, quantity: 12, unit: 'KG' })
    check('the FIFO preview of 12 kg chicken is 5 @ 12.00 + 7 @ 12.80', preview?.totalCost === expectedChicken, String(preview?.totalCost))
    check('and says the next unit costs 12.00 — the oldest lot', preview?.nextUnitCost === M(12.0), String(preview?.nextUnitCost))

    // Idempotent: saving the same recipe again keeps the same version.
    const again = await saveProductionRecipe({
      restaurantId: restaurant.id, branchId: kitchen.id, userId: cook.id,
      output: { itemId, name, quantity: 10, unit: 'KG' }, ingredients, instructions: 'Marinate and cook chicken with spices.',
    })
    check('saving the identical recipe again creates no new version', again.recipeId === saved.recipeId && !again.item.isNew)
    check('the recipe is visible from the other branch — it is the restaurant’s',
      Boolean((await getProductionWorkspace({ restaurantId: restaurant.id, branchId: other.id, timeZone: 'UTC' })).recipes[itemId]))
  }

  console.log('\n── 2. Check Available Stock: the branch’s shelf, oldest lot’s price ──')
  {
    const ws = await getProductionWorkspace({ restaurantId: restaurant.id, branchId: kitchen.id, timeZone: 'UTC' })
    const row = ws.items.find((i) => i.id === chicken.id)
    check('chicken shows 25 kg here in two lots', row?.available === 25 && row.lots.length === 2, JSON.stringify(row?.lots))
    check('oldest first, at 12.00 then 12.80', row?.lots[0]?.unitCost === M(12.0) && row.lots[1]?.unitCost === M(12.8))
    check('and the FIFO cost column is the oldest lot’s price', row?.nextUnitCost === M(12.0))
    check('nothing is unlotted', row?.unlotted === 0)
    const elsewhere = await getProductionWorkspace({ restaurantId: restaurant.id, branchId: other.id, timeZone: 'UTC' })
    const there = elsewhere.items.find((i) => i.id === chicken.id)
    check('the other branch holds none of it and sees no lots', there?.available === 0 && there.lots.length === 0)
  }

  console.log('\n── 3. Create Production Order: nothing moves ──')
  let orderId = ''
  let number = ''
  {
    const before = await movements()
    const created = await startBatch({
      restaurantId: restaurant.id, branchId: kitchen.id, userId: cook.id, clientRequestId: key(),
      plan: { name, itemId, quantity: 10, unit: 'KG', ingredients },
      productionType: 'SEMI_FINISHED', requiredDate: day(10), notes: 'Morning production',
    })
    orderId = created.id
    number = created.number
    check('the order has a PRD- number', /^PRD-\d{6}$/.test(created.number))
    const row = await prisma.productionOrder.findUniqueOrThrow({ where: { id: orderId } })
    check('type, required date and remarks are on the order', row.productionType === 'SEMI_FINISHED' && row.requiredDate?.getTime() === day(10).getTime() && row.notes === 'Morning production')
    check('not issued', row.startedAt === null)
    check('the plan is stored intact', (row.plan as { ingredients: unknown[] }).ingredients.length === 4 && row.plannedQty === 10)
    check('no movement at Create', (await movements()) === before)
    check('chicken still 25 kg', (await stockAt(chicken.id, kitchen.id)) === 25)

    const run = await getProductionRun({ restaurantId: restaurant.id, orderId })
    check('the order page shows the plan costed FIFO, un-issued', run?.issued === false && run.plan.length === 4)
    const chk = run?.plan.find((l) => l.itemId === chicken.id)
    check('chicken: required 12 kg, 25 available, cost 5 @ 12.00 + 7 @ 12.80', chk?.quantity === 12 && chk.available === 25 && chk.lineCost === expectedChicken, JSON.stringify(chk))
    check('the plan total is the hand figure', run?.plan.reduce((s, l) => s + l.lineCost, 0) === expectedTotal)
  }

  console.log('\n── 4. Issue All (FIFO): oldest lot first, at its own price ──')
  {
    const chickenValueBefore = await valueOf(chicken.id)
    const before = await movements()
    const issued = await issueIngredients({ restaurantId: restaurant.id, batchId: orderId, userId: cook.id })
    check('four ingredients issued under the order’s number', issued.number === number && issued.consumed.length === 4)
    check('total issued cost is the hand figure', issued.totalValue === expectedTotal, `${issued.totalValue} vs ${expectedTotal}`)
    check('four movements, one per ingredient', (await movements()) === before + 4)

    const row = await prisma.productionOrder.findUniqueOrThrow({ where: { id: orderId } })
    check('the order is stamped issued and stays in progress', row.startedAt !== null && row.status === 'IN_PROGRESS')
    check('and carries the issued cost', row.totalCost === expectedTotal)

    const chk = await prisma.productionConsumption.findFirstOrThrow({ where: { orderId, itemId: chicken.id }, include: { lots: { orderBy: { createdAt: 'asc' } } } })
    check('chicken line: 12 kg at the blended FIFO cost', chk.quantity === 12 && chk.lineCost === expectedChicken && chk.unitCost === Math.round(expectedChicken / 12))
    check('drawn from two lots: 5 @ 12.00 and 7 @ 12.80', chk.lots.length === 2
      && chk.lots[0].quantity === 5 && chk.lots[0].unitCost === M(12.0) && chk.lots[0].lineCost === 5 * M(12.0)
      && chk.lots[1].quantity === 7 && chk.lots[1].unitCost === M(12.8) && chk.lots[1].lineCost === 7 * M(12.8),
      JSON.stringify(chk.lots))
    check('each lot row names its lot', chk.lots.every((l) => l.batchId !== null && l.batchNo !== null))

    const lots = await lotsOf(chicken.id)
    check('the first lot is spent, the second holds 13 kg', lots[0].remainingQty === 0 && lots[1].remainingQty === 13, lots.map((l) => l.remainingQty).join(','))
    check('chicken is down to 13 kg on the shelf', (await stockAt(chicken.id, kitchen.id)) === 13)
    check('the ledger’s value is down by exactly the lots’ value', Math.round(chickenValueBefore - (await valueOf(chicken.id))) === expectedChicken,
      String(chickenValueBefore - (await valueOf(chicken.id))))
    const move = await prisma.stockMovement.findFirstOrThrow({ where: { itemId: chicken.id, type: 'PRODUCTION_CONSUMPTION' }, orderBy: { createdAt: 'desc' } })
    check('the movement carries the FIFO cost, not the average', move.unitCost === Math.round(expectedChicken / 12))

    // The screens after issue.
    const run = await getProductionRun({ restaurantId: restaurant.id, orderId })
    check('the order page now shows the issued lines, lot by lot', run?.issued === true && run.plan.length === 0
      && run.consumption.find((l) => l.itemId === chicken.id)?.lots.length === 2)
    check('and the material cost', run?.materialCost === expectedTotal)

    await refuses('a second Issue All is refused', () => issueIngredients({ restaurantId: restaurant.id, batchId: orderId, userId: cook.id }), /PRODUCTION_ALREADY_ISSUED/)
    await refuses('cancel is refused once issued', () => cancelBatch({ restaurantId: restaurant.id, batchId: orderId }), /PRODUCTION_ISSUED_CANNOT_CANCEL/)
    check('and nothing moved on either refusal', (await movements()) === before + 4 && (await stockAt(chicken.id, kitchen.id)) === 13)
  }

  console.log('\n── 5–6. Complete Production: 9.60 kg out, 0.40 wastage, cost = total ÷ 9.60 ──')
  let unitCost = 0
  {
    const before = await movements()
    const done = await completeBatch({
      restaurantId: restaurant.id, batchId: orderId, userId: cook.id, clientRequestId: key(),
      actualQuantity: 9.6, actualUnit: 'KG', wastageQuantity: 0.4,
      varianceReason: 'PRODUCTION_LOSS', varianceNote: 'trimming and moisture loss',
    })
    unitCost = done.unitCost
    check('completed under the same number', done.number === number)
    check('9.60 kg produced', done.producedQty === 9.6)
    check('total cost is exactly what was issued — nothing consumed twice', done.totalValue === expectedTotal, String(done.totalValue))
    check('cost per kg is total ÷ 9.60, to the minor unit', done.unitCost === Math.round(expectedTotal / 9.6), `${done.unitCost} vs ${Math.round(expectedTotal / 9.6)}`)
    check('one more movement — the output only', (await movements()) === before + 1)

    const row = await prisma.productionOrder.findUniqueOrThrow({ where: { id: orderId }, include: { _count: { select: { wastage: true } } } })
    check('the order records actual 9.6, variance −0.4, wastage 0.4', row.actualQty === 9.6 && row.variance === -0.4 && row.wastageQty === 0.4)
    check('the wastage moved no stock — it is a figure, not a wastage record', row._count.wastage === 0)
    check('and the reason is kept', row.varianceReason === 'PRODUCTION_LOSS')

    check('9.60 kg of filling on this branch’s shelf', (await stockAt(itemId, kitchen.id)) === 9.6)
    check('and none at the other branch', (await stockAt(itemId, other.id)) === 0)
    const item = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: itemId } })
    check('the item’s value is exactly the issued value', Math.round(Number(item.stockValue)) === expectedTotal, String(item.stockValue))
    check('and its cost per unit the actual cost', item.costPerUnit === unitCost)
    const outLots = await lotsOf(itemId)
    check('the output is a lot of its own, at its actual cost', outLots.length === 1 && outLots[0].remainingQty === 9.6 && outLots[0].unitCost === unitCost && outLots[0].branchId === kitchen.id)
    check('ingredients are down by what was issued', (await stockAt(chicken.id, kitchen.id)) === 13 && (await stockAt(oil.id, kitchen.id)) === 4
      && (await stockAt(spices.id, kitchen.id)) === 1500 && (await stockAt(salt.id, kitchen.id)) === 4900)

    await refuses('a second completion is refused', () => completeBatch({
      restaurantId: restaurant.id, batchId: orderId, userId: cook.id, clientRequestId: key(), actualQuantity: 9.6,
    }), /PRODUCTION_NOT_IN_PROGRESS/)
    await refuses('issuing a completed order is refused', () => issueIngredients({ restaurantId: restaurant.id, batchId: orderId, userId: cook.id }), /PRODUCTION_NOT_IN_PROGRESS/)
    check('and the shelf did not move', (await stockAt(itemId, kitchen.id)) === 9.6 && (await movements()) === before + 1)

    // The screens after completion.
    const run = await getProductionRun({ restaurantId: restaurant.id, orderId })
    check('the order page shows the finished item in stock here', run?.stockNow[itemId] === 9.6 && run.stockNow[chicken.id] === 13)
    check('with the actual cost and the wastage', run?.unitCost === unitCost && run.wastageQty === 0.4 && run.producedQty === 9.6)
    const ws = await getProductionWorkspace({ restaurantId: restaurant.id, branchId: kitchen.id, timeZone: 'UTC' })
    const hist = ws.history.find((h) => h.id === orderId)
    check('history: planned 10, actual 9.6, wastage 0.4, four ingredients', hist?.plannedQty === 10 && hist.actualQty === 9.6 && hist.wastageQty === 0.4 && hist.consumed.length === 4)
    const prepared = ws.prepared.find((p) => p.id === itemId)
    check('Prepared Items shows 9.6 kg here', prepared?.available === 9.6)
    const elsewhere = await getProductionWorkspace({ restaurantId: restaurant.id, branchId: other.id, timeZone: 'UTC' })
    const there = elsewhere.prepared.find((p) => p.id === itemId)
    check('and the item is listed at the other branch, with no stock', there !== undefined && there.available === 0)
  }

  console.log('\n── 7. A batch completed without issuing consumes at completion, FIFO ──')
  {
    const created = await startBatch({
      restaurantId: restaurant.id, branchId: kitchen.id, userId: cook.id, clientRequestId: key(),
      plan: { name, itemId, quantity: 5, unit: 'KG', ingredients: [{ itemId: chicken.id, quantity: 6, unit: 'KG' }] },
    })
    const before = await movements()
    const done = await completeBatch({
      restaurantId: restaurant.id, batchId: created.id, userId: cook.id, clientRequestId: key(), actualQuantity: 5,
    })
    check('completed in one step: consumption and output together', (await movements()) === before + 2)
    check('6 kg drawn from the remaining lot at 12.80', done.totalValue === 6 * M(12.8), String(done.totalValue))
    const chk = await prisma.productionConsumption.findFirstOrThrow({ where: { orderId: created.id }, include: { lots: true } })
    check('traced to that lot', chk.lots.length === 1 && chk.lots[0].quantity === 6 && chk.lots[0].unitCost === M(12.8))
    check('the lot holds 7 kg now', (await lotsOf(chicken.id))[1].remainingQty === 7)
    check('cost per kg = 6 × 12.80 ÷ 5', done.unitCost === Math.round((6 * M(12.8)) / 5))
    const row = await prisma.productionOrder.findUniqueOrThrow({ where: { id: created.id } })
    check('issued-at is stamped at completion when it was not issued before', row.startedAt !== null)
  }

  console.log('\n── 8. Cancel before issue: allowed, nothing to reverse ──')
  {
    const created = await startBatch({
      restaurantId: restaurant.id, branchId: kitchen.id, userId: cook.id, clientRequestId: key(),
      plan: { name, itemId, quantity: 1, unit: 'KG', ingredients: [{ itemId: chicken.id, quantity: 1, unit: 'KG' }] },
    })
    const before = await movements()
    await cancelBatch({ restaurantId: restaurant.id, batchId: created.id })
    const row = await prisma.productionOrder.findUniqueOrThrow({ where: { id: created.id } })
    check('cancelled, nothing moved', row.status === 'CANCELLED' && (await movements()) === before)
    await refuses('issuing a cancelled order is refused', () => issueIngredients({ restaurantId: restaurant.id, batchId: created.id, userId: cook.id }), /PRODUCTION_NOT_IN_PROGRESS/)
  }

  console.log('\n── 9. Issue Qty: less than the plan is allowed; an ingredient off the plan is not ──')
  {
    const created = await startBatch({
      restaurantId: restaurant.id, branchId: kitchen.id, userId: cook.id, clientRequestId: key(),
      plan: { name, itemId, quantity: 2, unit: 'KG', ingredients: [{ itemId: chicken.id, quantity: 3, unit: 'KG' }, { itemId: salt.id, quantity: 50, unit: 'GRAM' }] },
    })
    await refuses('oil is not on the plan', () => issueIngredients({
      restaurantId: restaurant.id, batchId: created.id, userId: cook.id,
      lines: [{ itemId: oil.id, quantity: 1, unit: 'LITRE' }],
    }), /PRODUCTION_ISSUE_NOT_PLANNED/)
    const issued = await issueIngredients({
      restaurantId: restaurant.id, batchId: created.id, userId: cook.id,
      lines: [{ itemId: chicken.id, quantity: 2, unit: 'KG' }, { itemId: salt.id, quantity: 50, unit: 'GRAM' }],
    })
    check('2 kg issued instead of 3, at 12.80', issued.consumed.find((l) => l.itemId === chicken.id)?.quantity === 2 && issued.totalValue === 2 * M(12.8) + 50)
    check('the lot holds 5 kg now', (await lotsOf(chicken.id))[1].remainingQty === 5)
    const greedy = await startBatch({
      restaurantId: restaurant.id, branchId: kitchen.id, userId: cook.id, clientRequestId: key(),
      plan: { name, itemId, quantity: 1, unit: 'KG', ingredients: [{ itemId: chicken.id, quantity: 50, unit: 'KG' }] },
    })
    await refuses('more than the shelf holds is refused', () => issueIngredients({
      restaurantId: restaurant.id, batchId: greedy.id, userId: cook.id,
    }), /INSUFFICIENT/)
    check('and the refused issue left the order un-issued, nothing moved',
      (await prisma.productionOrder.findUniqueOrThrow({ where: { id: greedy.id } })).startedAt === null && (await stockAt(chicken.id, kitchen.id)) === 5)
    const done = await completeBatch({ restaurantId: restaurant.id, batchId: created.id, userId: cook.id, clientRequestId: key(), actualQuantity: 2 })
    check('completion costs from the 2 kg that were issued', done.totalValue === 2 * M(12.8) + 50)
  }

  console.log('\n── 10. Stock received before lots were universal: the remainder layer ──')
  {
    // A legacy balance with no lot behind it: the branch holds more than its
    // lots explain. FIFO takes the lots first, then the rest at the average,
    // and the trace says so with a lot-less row.
    await prisma.$transaction((tx) => postMovement(tx, {
      restaurantId: restaurant.id, itemId: oil.id, type: 'PURCHASE', quantity: 2, unitCost: M(9.0), totalValue: 2 * M(9.0),
      branchId: kitchen.id, locationId: null, userId: cook.id,
    }))
    // Oil: lot holds 4 L @ 8.00; shelf holds 6 L. Average is (4×8 + 2×9) / 6.
    const oilItem = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: oil.id } })
    const average = Number(oilItem.stockValue) / oilItem.quantity
    const preview = await fifoCostFor(prisma, { restaurantId: restaurant.id, itemId: oil.id, branchId: kitchen.id, quantity: 5, unit: 'LITRE' })
    check('5 L previews as 4 from the lot @ 8.00 + 1 unlotted at the average',
      preview?.allocation.lots.length === 1 && preview.allocation.lots[0].quantity === 4 && preview.allocation.remainder?.quantity === 1
      && Math.abs(preview.totalCost - (4 * M(8.0) + average)) < 1, JSON.stringify(preview?.allocation))
    const created = await startBatch({
      restaurantId: restaurant.id, branchId: kitchen.id, userId: cook.id, clientRequestId: key(),
      plan: { name, itemId, quantity: 1, unit: 'KG', ingredients: [{ itemId: oil.id, quantity: 5, unit: 'LITRE' }] },
    })
    const issued = await issueIngredients({ restaurantId: restaurant.id, batchId: created.id, userId: cook.id })
    const line = await prisma.productionConsumption.findFirstOrThrow({ where: { orderId: created.id }, include: { lots: { orderBy: { createdAt: 'asc' } } } })
    check('issued as the preview said', Math.abs(issued.totalValue - Math.round(4 * M(8.0) + average)) <= 1, String(issued.totalValue))
    check('two trace rows: the lot, then the lot-less remainder', line.lots.length === 2 && line.lots[0].batchId !== null && line.lots[1].batchId === null && line.lots[1].quantity === 1)
    check('the shelf holds 1 L, and the lot none', (await stockAt(oil.id, kitchen.id)) === 1 && (await lotsOf(oil.id))[0].remainingQty === 0)
    await completeBatch({ restaurantId: restaurant.id, batchId: created.id, userId: cook.id, clientRequestId: key(), actualQuantity: 1 })
  }

  console.log('\n── 11. The one-shot produceItem still works, with lots ──')
  {
    const before = await movements()
    const done = await produceItem({
      restaurantId: restaurant.id, branchId: kitchen.id, userId: cook.id, clientRequestId: key(),
      output: { itemId, name, quantity: 1, unit: 'KG' },
      ingredients: [{ itemId: chicken.id, quantity: 1, unit: 'KG' }],
      waste: [],
    })
    check('one transaction, two movements', (await movements()) === before + 2)
    check('costed from the lot at 12.80', done.totalValue === M(12.8))
    const chk = await prisma.productionConsumption.findFirstOrThrow({ where: { orderId: done.orderId }, include: { lots: true } })
    check('and traced', chk.lots.length === 1 && chk.lots[0].unitCost === M(12.8))
  }

  console.log('\n── 12. Every receipt is a lot now, whatever the item’s flag says ──')
  {
    const flags = await prisma.inventoryItem.findMany({ where: { restaurantId: restaurant.id }, select: { id: true, trackBatches: true } })
    check('none of these items has trackBatches on', flags.every((f) => !f.trackBatches))
    check('yet every one of them has lots', (await prisma.stockBatch.groupBy({ by: ['itemId'], where: { restaurantId: restaurant.id } })).length === flags.length)
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exitCode = 1
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(async () => {
    if (restaurantId) await cleanup(restaurantId).catch((error) => console.error('cleanup failed', error))
    await prisma.$disconnect()
  })
