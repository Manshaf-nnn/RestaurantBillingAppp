/**
 * Prepared items — kitchen production, end to end (redesignkitchenjob.md).
 *
 * ── What this suite is for ──────────────────────────────────────────────────
 *
 * A prepared item is an ordinary inventory item made out of other ones. The
 * one path that moves stock is `produceItem`, and the properties that stop it
 * lying are: what leaves, what arrives, that the value arriving is EXACTLY the
 * value that left, what happens when the same button is pressed twice, and
 * that cost of sales happens once — when a dish is sold — and never here.
 *
 * §2 is the check that did not hold before this change: value used to be
 * carried through a rounded integer cost-per-unit, so a gram-priced ingredient
 * consumed at 33 rather than 33.33… and the prepared item was born worth less
 * than what went into it. §5 forces a failure part-way and requires the whole
 * run to vanish. §8 walks production → recipe → order → COGS.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/prepared-items-test.ts
 */
import { prisma } from '../src/server/db/prisma'
import { produceItem } from '../src/features/production/service'
import { getProductionRun, getProductionWorkspace } from '../src/features/production/queries'
import { postMovement } from '../src/features/inventory/ledger'
import { saveRecipe } from '../src/features/recipes/service'
import { placeOrder } from '../src/features/orders/service'
import { pinRecipeVersions, reconcileOrderDepletion, snapshotLineCosts } from '../src/features/inventory/depletion'
import { getProfitReport } from '../src/features/reports/profit'
import { customRange } from '../src/features/reports/range'
import { roundQty, sameQty } from '../src/lib/quantity'

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

/** What a branch is holding of one item, summed across its shelves. */
async function onHand(itemId: string, branchId: string): Promise<number> {
  const rows = await prisma.inventoryStock.aggregate({
    where: { itemId, branchId },
    _sum: { available: true },
  })
  return roundQty(rows._sum.available ?? 0)
}

async function valueOf(itemId: string): Promise<number> {
  const item = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: itemId } })
  return Number(item.stockValue)
}

let keySeq = 0
const key = () => `prep-${Date.now().toString(36)}-${++keySeq}`

async function main() {
  const stamp = Date.now().toString(36)

  const restaurant = await prisma.restaurant.create({
    data: {
      name: `Prep ${stamp}`, slug: `prep-${stamp}`, status: 'ACTIVE', isActive: true,
      currency: 'LKR', timezone: 'Asia/Colombo',
      taxRateBps: 0, serviceChargeBps: 0, taxInclusive: false,
    },
  })
  // A plain branch, not a production house: any branch may produce.
  const kitchen = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Kitchen', code: 'KIT', isDefault: true, type: 'BRANCH' },
  })
  const user = await prisma.user.create({
    data: {
      restaurantId: restaurant.id, email: `prep-${stamp}@t.local`, name: 'Cook',
      passwordHash: 'x', role: 'INVENTORY_MANAGER', branchId: kitchen.id,
    },
  })

  const item = (name: string, unit: 'KG' | 'GRAM' | 'LITRE' | 'ML' | 'PIECE') =>
    prisma.inventoryItem.create({
      data: { restaurantId: restaurant.id, name: `${name} ${stamp}`, unit, quantity: 0, costPerUnit: 0, branchId: kitchen.id },
    })
  const eggs = await item('Eggs', 'PIECE')
  const oil = await item('Oil', 'LITRE')
  const salt = await item('Salt', 'GRAM')
  const spice = await item('Spice', 'GRAM')
  const chicken = await item('Chicken', 'KG')
  const flour = await item('Flour', 'KG')

  const stock = (it: { id: string }, quantity: number, price: { unitCost?: number; totalValue?: number }) =>
    prisma.$transaction((tx) =>
      postMovement(tx, {
        restaurantId: restaurant.id, itemId: it.id, type: 'OPENING_BALANCE',
        quantity, ...price, branchId: kitchen.id, userId: user.id,
      }),
    )
  await stock(eggs, 100, { unitCost: 30_00 })          // LKR 30 an egg
  await stock(oil, 10, { unitCost: 800_00 })           // LKR 800 a litre → 0.80 a ml
  await stock(salt, 1000, { unitCost: 1_00 })          // LKR 1 a gram
  await stock(spice, 3000, { totalValue: 1_000_00 })   // LKR 1,000 for 3 kg → 33.33… minor a gram
  await stock(chicken, 10, { unitCost: 1_200_00 })     // LKR 1,200 a kg
  await stock(flour, 100, { unitCost: 100_00 })        // LKR 100 a kg

  const base = { restaurantId: restaurant.id, branchId: kitchen.id, userId: user.id }

  console.log('\n── 1. Make a new prepared item — the spec\'s mayonnaise ──')
  let mayoId = ''
  {
    const movementsBefore = await prisma.stockMovement.count({ where: { restaurantId: restaurant.id } })
    const run = await produceItem({
      ...base,
      clientRequestId: key(),
      output: { name: `Mayonnaise ${stamp}`, quantity: 1, unit: 'KG' },
      ingredients: [
        { itemId: eggs.id, quantity: 5, unit: 'PIECE' },
        { itemId: oil.id, quantity: 500, unit: 'ML' },
        { itemId: salt.id, quantity: 100, unit: 'GRAM' },
      ],
    })
    mayoId = run.item.id
    const mayo = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: run.item.id } })

    check('a prepared item was created', run.item.isNew && mayo.isPrepared && mayo.category === 'Prepared')
    check('…stocked in the unit it was made in', mayo.unit === 'KG')
    check('eggs 100 → 95', await onHand(eggs.id, kitchen.id) === 95)
    check('oil 10 L → 9.5 L (500 ml converted)', await onHand(oil.id, kitchen.id) === 9.5)
    check('salt 1000 g → 900 g', await onHand(salt.id, kitchen.id) === 900)
    check('1 kg of mayonnaise on the shelf', await onHand(mayo.id, kitchen.id) === 1)
    check('total cost is 150 + 400 + 100 = LKR 650', run.totalValue === 650_00, `${run.totalValue}`)
    check('…and the item is worth exactly that', Number(mayo.stockValue) === 650_00, `${mayo.stockValue}`)
    check('cost per kg is LKR 650 → 0.65 a gram', mayo.costPerUnit === 650_00 && run.unitCost === 650_00)
    const lines = await prisma.productionConsumption.findMany({ where: { orderId: run.orderId }, orderBy: { lineCost: 'desc' } })
    check('three ingredient snapshots with their exact values',
      lines.map((l) => l.lineCost).join(',') === '40000,15000,10000', lines.map((l) => l.lineCost).join(','))
    check('the oil line is stored in the item\'s base unit', lines.some((l) => l.itemId === oil.id && l.quantity === 0.5 && l.unit === 'LITRE'))
    const order = await prisma.productionOrder.findUniqueOrThrow({ where: { id: run.orderId } })
    check('the record is complete, names its output, and needs no recipe',
      order.status === 'COMPLETED' && order.outputItemId === mayo.id && order.recipeId === null && order.recipeName === mayo.name)
    check('four ledger movements, all pointing at the run',
      (await prisma.stockMovement.count({ where: { restaurantId: restaurant.id, referenceType: 'ProductionOrder', referenceId: run.orderId } })) === 4
      && (await prisma.stockMovement.count({ where: { restaurantId: restaurant.id } })) === movementsBefore + 4)
    check('the run happened at a plain branch — no production house needed', kitchen.type === 'BRANCH')
  }

  console.log('\n── 2. Value is carried exactly, not through a rounded cache ──')
  {
    const spiceRow = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: spice.id } })
    check('the cache says 33 a gram; the ledger knows 33.33…',
      spiceRow.costPerUnit === 33 && Number(spiceRow.stockValue) === 1_000_00)
    const before = await valueOf(spice.id)
    const run = await produceItem({
      ...base, clientRequestId: key(),
      output: { name: `Spice mix ${stamp}`, quantity: 300, unit: 'GRAM' },
      ingredients: [{ itemId: spice.id, quantity: 300, unit: 'GRAM' }],
    })
    const after = await valueOf(spice.id)
    const mix = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: run.item.id } })
    check('300 g left worth exactly LKR 100 — the cache would have said 99', run.totalValue === 100_00, `${run.totalValue}`)
    check('the spice lost exactly that value', sameQty(before - after, 100_00), `${before - after}`)
    check('the mix gained exactly that value', sameQty(Number(mix.stockValue), 100_00), `${mix.stockValue}`)
    check('raw value out == prepared value in', sameQty(before - after, Number(mix.stockValue)))
    const line = await prisma.productionConsumption.findFirstOrThrow({ where: { orderId: run.orderId } })
    check('the snapshot records the exact value', line.lineCost === 100_00, `${line.lineCost}`)
  }

  console.log('\n── 3. Making more of something that exists ──')
  {
    const run = await produceItem({
      ...base, clientRequestId: key(),
      // Different case, different unit: the same item.
      output: { name: `mayonnaise ${stamp}`, quantity: 500, unit: 'GRAM' },
      ingredients: [
        { itemId: eggs.id, quantity: 2, unit: 'PIECE' },
        { itemId: oil.id, quantity: 250, unit: 'ML' },
      ],
    })
    check('the same item is topped up, not a second one created', run.item.id === mayoId && !run.item.isNew)
    check('500 g arrived as 0.5 kg', await onHand(mayoId, kitchen.id) === 1.5)
    const mayo = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: mayoId } })
    // 650.00 + (60 + 200) = 910.00 over 1.5 kg
    check('value accumulates', Number(mayo.stockValue) === 910_00, `${mayo.stockValue}`)
    check('the average blends the two runs', mayo.costPerUnit === Math.round(910_00 / 1.5))
    check('only one mayonnaise exists',
      (await prisma.inventoryItem.count({ where: { restaurantId: restaurant.id, name: { contains: 'ayonnaise' } } })) === 1)

    await refuses('a unit from another family is refused',
      () => produceItem({
        ...base, clientRequestId: key(),
        output: { name: `Mayonnaise ${stamp}`, quantity: 3, unit: 'PIECE' },
        ingredients: [{ itemId: eggs.id, quantity: 1, unit: 'PIECE' }],
      }), /stocked in kg/i)
    await refuses('an ingredient in the wrong unit is refused',
      () => produceItem({
        ...base, clientRequestId: key(),
        output: { name: `Mayonnaise ${stamp}`, quantity: 1, unit: 'KG' },
        ingredients: [{ itemId: eggs.id, quantity: 1, unit: 'KG' }],
      }), /stocked in pc\b/i)
    await refuses('a raw stock item\'s name cannot be used for a prepared item',
      () => produceItem({
        ...base, clientRequestId: key(),
        output: { name: `Eggs ${stamp}`, quantity: 1, unit: 'PIECE' },
        ingredients: [{ itemId: oil.id, quantity: 1, unit: 'ML' }],
      }), /raw stock item/i)
    await refuses('something cannot be made out of itself',
      () => produceItem({
        ...base, clientRequestId: key(),
        output: { itemId: mayoId, name: `Mayonnaise ${stamp}`, quantity: 1, unit: 'KG' },
        ingredients: [{ itemId: mayoId, quantity: 1, unit: 'KG' }],
      }), /out of itself/i)
  }

  console.log('\n── 4. The same batch twice is one batch ──')
  {
    const once = key()
    const input: Parameters<typeof produceItem>[0] = {
      ...base, clientRequestId: once,
      output: { name: `Dough ${stamp}`, quantity: 2, unit: 'KG' },
      ingredients: [{ itemId: flour.id, quantity: 2, unit: 'KG' }],
    }
    const movementsBefore = await prisma.stockMovement.count({ where: { restaurantId: restaurant.id } })
    const first = await produceItem(input)
    const second = await produceItem(input)
    check('the second call is a replay of the first', second.replayed && !first.replayed && second.orderId === first.orderId)
    check('…and moved nothing', (await prisma.stockMovement.count({ where: { restaurantId: restaurant.id } })) === movementsBefore + 2)
    check('…and says the same thing', second.totalValue === first.totalValue && second.number === first.number)
    check('flour 100 → 98, once', await onHand(flour.id, kitchen.id) === 98)

    // The race: two requests with one key at the same moment.
    const raced = key()
    const twin = { ...input, clientRequestId: raced }
    const results = await Promise.allSettled([produceItem(twin), produceItem(twin)])
    const ok = results.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof produceItem>>> => r.status === 'fulfilled')
    check('both callers get an answer', ok.length === 2, results.map((r) => r.status).join('/'))
    check('…the same answer', ok.length === 2 && ok[0].value.orderId === ok[1].value.orderId)
    check('one run was recorded under that key',
      (await prisma.productionOrder.count({ where: { restaurantId: restaurant.id, clientRequestId: raced } })) === 1)
    check('one set of ingredients left', await onHand(flour.id, kitchen.id) === 96)

    const again = await produceItem({ ...input, clientRequestId: key() })
    check('a new key is a new batch', !again.replayed && again.orderId !== first.orderId)
  }

  console.log('\n── 5. A failure part-way through leaves nothing behind ──')
  {
    const movementsBefore = await prisma.stockMovement.count({ where: { restaurantId: restaurant.id } })
    const ordersBefore = await prisma.productionOrder.count({ where: { restaurantId: restaurant.id } })
    const eggsBefore = await onHand(eggs.id, kitchen.id)
    const saltBefore = await onHand(salt.id, kitchen.id)
    const doomed = key()
    await refuses('a shortage refuses the whole run',
      () => produceItem({
        ...base, clientRequestId: doomed,
        output: { name: `Failed sauce ${stamp}`, quantity: 1, unit: 'KG' },
        ingredients: [
          { itemId: eggs.id, quantity: 1, unit: 'PIECE' },
          { itemId: salt.id, quantity: 1, unit: 'GRAM' },
          { itemId: oil.id, quantity: 999_999, unit: 'LITRE' },
        ],
      }), /not enough|insufficient/i)
    check('no movement survived', (await prisma.stockMovement.count({ where: { restaurantId: restaurant.id } })) === movementsBefore)
    check('no run was recorded', (await prisma.productionOrder.count({ where: { restaurantId: restaurant.id } })) === ordersBefore)
    check('the eggs did not move', await onHand(eggs.id, kitchen.id) === eggsBefore)
    check('nor the salt', await onHand(salt.id, kitchen.id) === saltBefore)
    const sauce = await prisma.inventoryItem.findFirst({ where: { restaurantId: restaurant.id, name: `Failed sauce ${stamp}` } })
    check('the item created ahead of the run holds nothing',
      sauce !== null && sauce.quantity === 0 && Number(sauce.stockValue) === 0 && (await onHand(sauce.id, kitchen.id)) === 0)
    check('…and the key is free to try again',
      (await prisma.productionOrder.count({ where: { clientRequestId: doomed } })) === 0)
  }

  console.log('\n── 6. Production never takes a shelf below zero ──')
  {
    await prisma.restaurant.update({ where: { id: restaurant.id }, data: { allowNegativeStock: true } })
    await refuses('short stock is refused even when negative stock is allowed for sales',
      () => produceItem({
        ...base, clientRequestId: key(),
        output: { name: `Omelette mix ${stamp}`, quantity: 1, unit: 'KG' },
        ingredients: [{ itemId: eggs.id, quantity: 1000, unit: 'PIECE' }],
      }), /not enough|insufficient/i)
    await prisma.restaurant.update({ where: { id: restaurant.id }, data: { allowNegativeStock: false } })
  }

  console.log('\n── 7. Waste is deducted, expensed, and kept out of the item\'s cost ──')
  {
    const run = await produceItem({
      ...base, clientRequestId: key(),
      output: { name: `Prepared chicken ${stamp}`, quantity: 800, unit: 'GRAM' },
      ingredients: [{ itemId: chicken.id, quantity: 1, unit: 'KG' }],
      waste: [{ itemId: chicken.id, quantity: 200, unit: 'GRAM', note: 'bones and skin' }],
    })
    check('chicken 10 kg → 8.8 kg: used AND wasted left the shelf', await onHand(chicken.id, kitchen.id) === 8.8)
    const prepared = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: run.item.id } })
    check('the prepared chicken carries the value of the 1 kg used — LKR 1,200', Number(prepared.stockValue) === 1_200_00, `${prepared.stockValue}`)
    check('…not the LKR 240 that was thrown away', run.totalValue === 1_200_00 && run.wasted[0]?.value === 240_00, `${run.wasted[0]?.value}`)
    const waste = await prisma.wastageRecord.findFirst({ where: { productionOrderId: run.orderId } })
    check('a wastage record points at the run, reason Preparation',
      waste !== null && waste.reason === 'PREPARATION' && waste.costValue === 240_00 && waste.reasonNote === 'bones and skin')
    const wasteMovement = await prisma.stockMovement.findFirst({ where: { id: waste?.movementId ?? '' } })
    check('…backed by a WASTAGE movement the wastage board can trace',
      wasteMovement !== null && wasteMovement.type === 'WASTAGE' && wasteMovement.referenceType === 'Wastage' && wasteMovement.referenceId === waste?.id)
    const detail = await getProductionRun({ restaurantId: restaurant.id, orderId: run.orderId })
    check('the run\'s page lists it', detail !== null && detail.wastage.length === 1 && detail.wasteCost === 240_00)
    await refuses('waste of something the run did not use is refused',
      () => produceItem({
        ...base, clientRequestId: key(),
        output: { name: `Prepared chicken ${stamp}`, quantity: 100, unit: 'GRAM' },
        ingredients: [{ itemId: chicken.id, quantity: 100, unit: 'GRAM' }],
        waste: [{ itemId: eggs.id, quantity: 1, unit: 'PIECE' }],
      }), /ingredient this run used/i)
  }

  console.log('\n── 8. Prepared item → dish recipe → order → COGS, once ──')
  {
    const category = await prisma.category.create({
      data: { restaurantId: restaurant.id, name: 'Burgers', slug: `burgers-${stamp}` },
    })
    const burger = await prisma.food.create({
      data: {
        restaurantId: restaurant.id, categoryId: category.id, name: `Burger ${stamp}`,
        slug: `burger-${stamp}`, price: 900_00, isAvailable: true,
      },
    })
    await prisma.foodBranch.create({
      data: { restaurantId: restaurant.id, branchId: kitchen.id, foodId: burger.id, isAvailable: true },
    })
    // The dish recipe uses the PREPARED item like any ingredient: 20 g of mayonnaise.
    await saveRecipe({
      restaurantId: restaurant.id, userId: user.id, foodId: burger.id,
      name: `Burger recipe ${stamp}`, yieldQty: 1,
      ingredients: [{ inventoryItemId: mayoId, quantity: 20, unit: 'GRAM' }],
    })

    const mayoBefore = await onHand(mayoId, kitchen.id)
    const mayoCost = (await prisma.inventoryItem.findUniqueOrThrow({ where: { id: mayoId } })).costPerUnit
    const order = await placeOrder({
      restaurantId: restaurant.id, branchId: kitchen.id, type: 'TAKEAWAY',
      customerName: 'Guest', customerPhone: '',
      items: [{ foodId: burger.id, quantity: 3, optionIds: [] }],
    })
    await prisma.$transaction(async (tx) => {
      await pinRecipeVersions(tx, { restaurantId: restaurant.id, orderId: order.id })
      await snapshotLineCosts(tx, { restaurantId: restaurant.id, orderId: order.id })
      await reconcileOrderDepletion(tx, { restaurantId: restaurant.id, orderId: order.id, userId: user.id })
    })

    check('selling the dish consumes the prepared item — 60 g of mayonnaise',
      sameQty(await onHand(mayoId, kitchen.id), mayoBefore - 0.06), `${await onHand(mayoId, kitchen.id)} vs ${mayoBefore - 0.06}`)
    // 100 − 5 (§1) − 2 (§3) = 93; nothing since has touched them.
    check('…and none of the eggs', await onHand(eggs.id, kitchen.id) === 93, `${await onHand(eggs.id, kitchen.id)}`)
    const sale = await prisma.stockMovement.findFirst({ where: { orderId: order.id, itemId: mayoId, type: 'SALE' } })
    check('prepared stock → the order is in the ledger', sale !== null)
    const line = await prisma.orderItem.findFirstOrThrow({ where: { orderId: order.id } })
    check('the sold line snapshots the mayonnaise at its average cost — LKR 13 for 20 g',
      line.costPrice === Math.round(mayoCost * 0.02), `${line.costPrice} vs ${Math.round(mayoCost * 0.02)}`)
    const range = customRange(new Date(Date.now() - 86_400_000), new Date(Date.now() + 86_400_000), 'Asia/Colombo')
    const profit = await getProfitReport({ restaurantId: restaurant.id, range })
    check('COGS is the sold lines only', profit.totals.cogs === line.costPrice * 3, `${profit.totals.cogs} vs ${line.costPrice * 3}`)
    const runs = await prisma.productionOrder.aggregate({ where: { restaurantId: restaurant.id }, _sum: { totalCost: true } })
    check('…and no production run\'s cost is in cost of sales', profit.totals.cogs < (runs._sum.totalCost ?? 0))
  }

  console.log('\n── 9. A prepared item can make another prepared item ──')
  {
    const mayoValueBefore = await valueOf(mayoId)
    const run = await produceItem({
      ...base, clientRequestId: key(),
      output: { name: `Burger sauce ${stamp}`, quantity: 300, unit: 'GRAM' },
      ingredients: [{ itemId: mayoId, quantity: 300, unit: 'GRAM' }],
    })
    const sauce = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: run.item.id } })
    check('the sauce is worth exactly what the mayonnaise lost',
      sameQty(Number(sauce.stockValue), mayoValueBefore - (await valueOf(mayoId))) && Number(sauce.stockValue) > 0)
    check('a prepared item is an ordinary ingredient', sauce.isPrepared && run.consumed[0].itemId === mayoId)
  }

  console.log('\n── 10. Tenant and branch isolation ──')
  {
    const other = await prisma.restaurant.create({
      data: { name: `Other ${stamp}`, slug: `other-${stamp}`, status: 'ACTIVE', isActive: true, currency: 'LKR' },
    })
    const otherBranch = await prisma.branch.create({
      data: { restaurantId: other.id, name: 'Elsewhere', code: 'ELSE', isDefault: true, type: 'BRANCH' },
    })
    const otherItem = await prisma.inventoryItem.create({
      data: { restaurantId: other.id, name: `Their flour ${stamp}`, unit: 'KG', quantity: 5, costPerUnit: 100_00 },
    })
    await refuses('another restaurant\'s stock cannot be used as an ingredient',
      () => produceItem({
        ...base, clientRequestId: key(),
        output: { name: `Stolen dough ${stamp}`, quantity: 1, unit: 'KG' },
        ingredients: [{ itemId: otherItem.id, quantity: 1, unit: 'KG' }],
      }), /ingredient/i)
    await refuses('another restaurant\'s branch cannot be produced at',
      () => produceItem({
        ...base, branchId: otherBranch.id, clientRequestId: key(),
        output: { name: `Dough ${stamp}`, quantity: 1, unit: 'KG' },
        ingredients: [{ itemId: flour.id, quantity: 1, unit: 'KG' }],
      }), /branch/i)
    check('nothing of theirs moved',
      (await prisma.stockMovement.count({ where: { restaurantId: other.id } })) === 0
      && (await prisma.inventoryItem.count({ where: { restaurantId: other.id } })) === 1)
    await prisma.restaurant.delete({ where: { id: other.id } })
  }

  console.log('\n── 11. What the screen reads ──')
  {
    // A run from the recipe era: no output item on the row, just the name it kept.
    await prisma.productionOrder.create({
      data: {
        restaurantId: restaurant.id, branchId: kitchen.id, number: `PRD-LEGACY-${stamp}`,
        status: 'COMPLETED', recipeName: `Old dough ${stamp}`, plannedQty: 4, actualQty: 4, unit: 'KG',
        totalCost: 400_00, unitCost: 100_00, completedAt: new Date(Date.now() - 3_600_000),
      },
    })
    const data = await getProductionWorkspace({ restaurantId: restaurant.id, branchId: kitchen.id, timeZone: 'Asia/Colombo' })
    const mayo = data.prepared.find((row) => row.id === mayoId)
    check('the prepared items tab lists mayonnaise with what this branch holds',
      mayo !== undefined && sameQty(mayo.available, await onHand(mayoId, kitchen.id)) && mayo.costPerUnit > 0 && mayo.runs === 2 && mayo.lastProducedAt !== null)
    check('…and values it at that quantity', mayo !== undefined && mayo.stockValue === Math.round(mayo.available * mayo.costPerUnit))
    check('raw items are not prepared items', !data.prepared.some((row) => row.id === eggs.id))
    check('the ingredient list offers prepared items too, priced',
      data.items.some((i) => i.id === mayoId && i.isPrepared && i.unitCost > 0) && data.items.some((i) => i.id === eggs.id && i.available === 93))
    check('history names each run by what it made',
      data.history.some((row) => row.itemId === mayoId && row.itemName.includes('Mayonnaise')))
    check('…including a run from before, by the name it kept',
      data.history.some((row) => row.itemName === `Old dough ${stamp}` && row.quantity === 4))
    check('the waste run is flagged', data.history.some((row) => row.wasteCount === 1))
    check('today\'s stats count the runs made here today', data.stats.runsToday >= 7 && data.stats.valueToday > 0 && data.stats.preparedCount >= 5)
  }

  // ── Teardown, in dependency order (Restrict FKs on item) ──────────────────
  await prisma.wastageRecord.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.productionOutput.deleteMany({ where: { order: { restaurantId: restaurant.id } } })
  await prisma.productionConsumption.deleteMany({ where: { order: { restaurantId: restaurant.id } } })
  await prisma.productionOrder.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.orderStockDepletion.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.stockBatch.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.stockMovement.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.recipeIngredient.deleteMany({ where: { recipe: { restaurantId: restaurant.id } } })
  await prisma.recipe.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.restaurant.delete({ where: { id: restaurant.id } })

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
