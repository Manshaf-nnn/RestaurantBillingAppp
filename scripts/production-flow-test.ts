/**
 * Kitchen production, end to end (kitchenjobs.md).
 *
 * ── What this suite is for ──────────────────────────────────────────────────
 *
 * The redesign removed the approval step and let the kitchen state what it
 * actually used. Both are changes to the one path in this module that moves
 * stock, so the properties that matter are the ones that stop that path lying:
 * what leaves, what arrives, what it cost, and what happens when the same
 * button is pressed twice.
 *
 * The two checks worth reading first are §5 and §7. §5 forces a failure after
 * the ingredients have been consumed and requires the whole thing to vanish —
 * a production run that half-happened would destroy stock outright. §7 walks
 * the full chain the spec asks to be traceable and proves the produced item's
 * cost reaches the P&L exactly once, through a customer order, and never as
 * production itself: kitchen production is an inventory transformation, not
 * cost of sales, and a second COGS path is the specific thing the spec forbids.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/production-flow-test.ts
 */
import { prisma } from '../src/server/db/prisma'
import {
  completeProduction, createProductionOrder, setProductionStatus,
} from '../src/features/production/service'
import { previewProduction } from '../src/features/production/queries'
import { postMovement } from '../src/features/inventory/ledger'
import { saveRecipe } from '../src/features/recipes/service'
import { placeOrder } from '../src/features/orders/service'
import { pinRecipeVersions, reconcileOrderDepletion, snapshotLineCosts } from '../src/features/inventory/depletion'
import { getProfitReport } from '../src/features/reports/profit'
import { customRange } from '../src/features/reports/range'
import { roundQty } from '../src/lib/quantity'

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

async function main() {
  const stamp = Date.now().toString(36)

  const restaurant = await prisma.restaurant.create({
    data: {
      name: `Prod ${stamp}`, slug: `prod-${stamp}`, status: 'ACTIVE', isActive: true,
      currency: 'LKR', timezone: 'Asia/Colombo',
      taxRateBps: 0, serviceChargeBps: 0, taxInclusive: false,
    },
  })
  const house = await prisma.branch.create({
    data: {
      restaurantId: restaurant.id, name: 'Bakery', code: 'BAKE',
      isDefault: true, type: 'PRODUCTION_HOUSE',
    },
  })
  const user = await prisma.user.create({
    data: {
      restaurantId: restaurant.id, email: `prod-${stamp}@t.local`, name: 'Baker',
      passwordHash: 'x', role: 'INVENTORY_MANAGER', branchId: house.id,
    },
  })

  // Flour at LKR 200/kg, and a recipe that turns 1 kg of it into 1 kg of dough.
  const flour = await prisma.inventoryItem.create({
    data: {
      restaurantId: restaurant.id, name: `Flour ${stamp}`, unit: 'KG',
      quantity: 0, costPerUnit: 200_00, branchId: house.id,
    },
  })
  const water = await prisma.inventoryItem.create({
    data: {
      restaurantId: restaurant.id, name: `Water ${stamp}`, unit: 'LITRE',
      quantity: 0, costPerUnit: 10_00, branchId: house.id,
    },
  })
  const dough = await prisma.inventoryItem.create({
    data: {
      restaurantId: restaurant.id, name: `Dough ${stamp}`, unit: 'KG',
      quantity: 0, costPerUnit: 0, branchId: house.id,
    },
  })

  const stock = async (item: { id: string }, quantity: number, unitCost: number) => {
    await prisma.$transaction((tx) =>
      postMovement(tx, {
        restaurantId: restaurant.id, itemId: item.id, type: 'OPENING_BALANCE',
        quantity, unitCost, branchId: house.id, userId: user.id,
      }),
    )
  }
  await stock(flour, 500, 200_00)
  await stock(water, 500, 10_00)

  const recipe = await saveRecipe({
    restaurantId: restaurant.id,
    userId: user.id,
    producesItemId: dough.id,
    name: `Dough recipe ${stamp}`,
    yieldQty: 1,
    yieldUnit: 'KG',
    ingredients: [
      { inventoryItemId: flour.id, quantity: 1, unit: 'KG' },
      { inventoryItemId: water.id, quantity: 0.5, unit: 'LITRE' },
    ],
  })

  const newJob = (plannedQty: number) =>
    createProductionOrder({
      restaurantId: restaurant.id, branchId: house.id,
      recipeId: recipe.id, plannedQty, userId: user.id,
    })

  console.log('\n── 1. Create, start, complete — no approval anywhere ──')
  {
    const job = await newJob(10)
    check('a new job is ready to make', job.status === 'DRAFT', job.status)
    check('creating it takes nothing from stock', await onHand(flour.id, house.id) === 500)

    const started = await setProductionStatus({
      restaurantId: restaurant.id, orderId: job.id, status: 'IN_PROGRESS', userId: user.id,
    })
    check('it can be started', started.status === 'IN_PROGRESS')
    check('…and records when', started.startedAt !== null)
    check('starting still takes nothing from stock', await onHand(flour.id, house.id) === 500)

    const done = await completeProduction({
      restaurantId: restaurant.id, orderId: job.id, actualQty: 10, userId: user.id,
    })
    check('completing it needs no approval first', done.producedQty === 10)
    check('flour 500 → 490', await onHand(flour.id, house.id) === 490,
      `${await onHand(flour.id, house.id)}`)
    check('water 500 → 495', await onHand(water.id, house.id) === 495,
      `${await onHand(water.id, house.id)}`)
    check('10 kg of dough on the shelf', await onHand(dough.id, house.id) === 10,
      `${await onHand(dough.id, house.id)}`)
    check('costed at flour + water', done.totalCost === 10 * 200_00 + 5 * 10_00, `${done.totalCost}`)
    check('unit cost is the run over what came out',
      done.unitCost === Math.round(done.totalCost / 10), `${done.unitCost}`)

    /*
     * A job may also be completed straight from ready-to-make. Starting is a
     * convenience for the board, not a gate — which is the whole point of
     * removing the approval step rather than renaming it.
     */
    const straight = await newJob(2)
    const quick = await completeProduction({
      restaurantId: restaurant.id, orderId: straight.id, actualQty: 2, userId: user.id,
    })
    check('a job can be completed without being started', quick.producedQty === 2)
  }

  console.log('\n── 2. The kitchen states what it actually used ──')
  {
    const before = await onHand(flour.id, house.id)
    const job = await newJob(10)

    // The recipe wants 10 kg of flour; the baker used 12.
    const done = await completeProduction({
      restaurantId: restaurant.id, orderId: job.id, actualQty: 10, userId: user.id,
      consumed: [{ itemId: flour.id, quantity: 12 }],
    })
    check('the stated amount is what leaves stock',
      await onHand(flour.id, house.id) === roundQty(before - 12),
      `${await onHand(flour.id, house.id)} vs ${roundQty(before - 12)}`)

    // Water was not stated, so it falls back to the recipe: 0.5 × 10 = 5.
    const consumption = await prisma.productionConsumption.findMany({ where: { orderId: job.id } })
    const waterLine = consumption.find((line) => line.itemId === water.id)
    check('an unstated ingredient falls back to the recipe',
      waterLine?.quantity === 5, `${waterLine?.quantity}`)
    check('the extra flour is in the cost', done.totalCost === 12 * 200_00 + 5 * 10_00,
      `${done.totalCost}`)

    // Zero is a real answer, and is not the same as saying nothing.
    const dry = await newJob(4)
    await completeProduction({
      restaurantId: restaurant.id, orderId: dry.id, actualQty: 4, userId: user.id,
      consumed: [{ itemId: water.id, quantity: 0 }],
    })
    const dryLines = await prisma.productionConsumption.findMany({ where: { orderId: dry.id } })
    check('a stated zero means the ingredient was not used',
      !dryLines.some((line) => line.itemId === water.id), `${dryLines.length} lines`)

    const stray = await newJob(1)
    await refuses(
      'an ingredient the recipe never mentions is refused',
      () => completeProduction({
        restaurantId: restaurant.id, orderId: stray.id, actualQty: 1, userId: user.id,
        consumed: [{ itemId: dough.id, quantity: 1 }],
      }),
      /not in this recipe/i,
    )
    await refuses(
      'a negative amount is refused',
      () => completeProduction({
        restaurantId: restaurant.id, orderId: stray.id, actualQty: 1, userId: user.id,
        consumed: [{ itemId: flour.id, quantity: -1 }],
      }),
      /cannot be negative/i,
    )
    await setProductionStatus({
      restaurantId: restaurant.id, orderId: stray.id, status: 'CANCELLED', userId: user.id,
    })
  }

  console.log('\n── 3. A short run loses yield, not ingredients ──')
  {
    const before = await onHand(flour.id, house.id)
    const job = await newJob(10)

    await refuses(
      'coming up short without a reason is refused',
      () => completeProduction({
        restaurantId: restaurant.id, orderId: job.id, actualQty: 8, userId: user.id,
      }),
      /short of plan/i,
    )

    const done = await completeProduction({
      restaurantId: restaurant.id, orderId: job.id, actualQty: 8,
      varianceReason: 'PRODUCTION_LOSS', userId: user.id,
    })

    /*
     * The rule this pins, and the reason the spec's phrase "actual ingredient
     * quantities" was NOT read as "scale the recipe down to the output": the
     * flour was poured. Deducting only eight kilos' worth would put two kilos
     * back on the shelf that nobody can find, and would report a run that lost
     * a fifth of its yield as perfectly efficient.
     */
    check('all ten kilos of flour still left stock',
      await onHand(flour.id, house.id) === roundQty(before - 10),
      `${await onHand(flour.id, house.id)} vs ${roundQty(before - 10)}`)
    check('only eight kilos of dough arrived', done.producedQty === 8)
    check('the shortfall is recorded as variance', done.variance === -2, `${done.variance}`)
    check('and the job says why',
      (await prisma.productionOrder.findUniqueOrThrow({ where: { id: job.id } })).varianceReason
        === 'PRODUCTION_LOSS')
    check('the loss raises the cost of each one that survived',
      done.unitCost === Math.round(done.totalCost / 8), `${done.unitCost}`)
    check('…and the job is marked partially completed',
      (await prisma.productionOrder.findUniqueOrThrow({ where: { id: job.id } })).status
        === 'PARTIALLY_COMPLETED')

    // Overheads land in the numerator, not beside it.
    const withOverhead = await newJob(10)
    const overheaded = await completeProduction({
      restaurantId: restaurant.id, orderId: withOverhead.id, actualQty: 10,
      overheadCost: 500_00, userId: user.id,
    })
    check('labour and power are inside the unit cost',
      overheaded.unitCost === Math.round((10 * 200_00 + 5 * 10_00 + 500_00) / 10),
      `${overheaded.unitCost}`)
  }

  console.log('\n── 4. Completing twice, and racing it ──')
  {
    const job = await newJob(5)
    await completeProduction({
      restaurantId: restaurant.id, orderId: job.id, actualQty: 5, userId: user.id,
    })
    await refuses(
      'a finished job cannot be finished again',
      () => completeProduction({
        restaurantId: restaurant.id, orderId: job.id, actualQty: 5, userId: user.id,
      }),
      /already finished/i,
    )

    /*
     * The double-click, as a race rather than as two sequential calls. Before
     * the row lock and the compare-and-swap this consumed the ingredients twice
     * and created the finished goods twice.
     */
    const raced = await newJob(5)
    const before = await onHand(flour.id, house.id)
    const results = await Promise.allSettled([
      completeProduction({ restaurantId: restaurant.id, orderId: raced.id, actualQty: 5, userId: user.id }),
      completeProduction({ restaurantId: restaurant.id, orderId: raced.id, actualQty: 5, userId: user.id }),
    ])
    const won = results.filter((r) => r.status === 'fulfilled').length
    check('exactly one of two concurrent completions wins', won === 1, `${won} succeeded`)
    const lines = await prisma.productionConsumption.count({ where: { orderId: raced.id } })
    check('and only one set of ingredients was consumed', lines === 2, `${lines} rows`)
    check('the ledger agrees', await onHand(flour.id, house.id) === roundQty(before - 5),
      `${await onHand(flour.id, house.id)}`)

    const cancelled = await newJob(1)
    await setProductionStatus({
      restaurantId: restaurant.id, orderId: cancelled.id, status: 'CANCELLED', userId: user.id,
    })
    await refuses(
      'a cancelled job cannot be completed',
      () => completeProduction({
        restaurantId: restaurant.id, orderId: cancelled.id, actualQty: 1, userId: user.id,
      }),
      /cancelled/i,
    )
  }

  console.log('\n── 5. A failure part-way through leaves nothing behind ──')
  {
    const before = {
      flour: await onHand(flour.id, house.id),
      water: await onHand(water.id, house.id),
      dough: await onHand(dough.id, house.id),
    }
    const movementsBefore = await prisma.stockMovement.count({ where: { restaurantId: restaurant.id } })

    /*
     * Ask for more flour than the house holds. `assertSufficient` refuses
     * part-way down the ingredient loop — after water has already been posted
     * in this transaction — so this is the real half-done case, not a refusal
     * at the door.
     */
    const job = await newJob(1)
    await refuses(
      'a shortage refuses the whole run',
      () => completeProduction({
        restaurantId: restaurant.id, orderId: job.id, actualQty: 1, userId: user.id,
        consumed: [{ itemId: flour.id, quantity: 999_999 }],
      }),
      /insufficient|not enough/i,
    )

    check('no flour left stock', await onHand(flour.id, house.id) === before.flour)
    check('no water left stock either — the earlier line rolled back too',
      await onHand(water.id, house.id) === before.water,
      `${await onHand(water.id, house.id)} vs ${before.water}`)
    check('no dough was created', await onHand(dough.id, house.id) === before.dough)
    check('not one movement survived',
      await prisma.stockMovement.count({ where: { restaurantId: restaurant.id } }) === movementsBefore)
    check('no consumption rows were left',
      await prisma.productionConsumption.count({ where: { orderId: job.id } }) === 0)
    check('and the job is still open to try again',
      (await prisma.productionOrder.findUniqueOrThrow({ where: { id: job.id } })).status === 'DRAFT')
  }

  console.log('\n── 6. What it needs, before it is created ──')
  {
    const preview = await previewProduction({
      restaurantId: restaurant.id, branchId: house.id, recipeId: recipe.id, plannedQty: 20,
    })
    check('the preview resolves the recipe', preview !== null && preview.ingredients.length === 2)
    const flourLine = preview!.ingredients.find((line) => line.itemId === flour.id)
    check('it states what is required', flourLine?.required === 20, `${flourLine?.required}`)
    check('…and what this kitchen is holding',
      flourLine?.available === await onHand(flour.id, house.id), `${flourLine?.available}`)
    check('nothing is short, so the job can be made', preview!.canMake)

    const huge = await previewProduction({
      restaurantId: restaurant.id, branchId: house.id, recipeId: recipe.id, plannedQty: 999_999,
    })
    check('an impossible quantity reports the shortfall rather than throwing',
      huge !== null && !huge.canMake && huge.ingredients.every((line) => line.short > 0))

    const movementsBefore = await prisma.stockMovement.count({ where: { restaurantId: restaurant.id } })
    await previewProduction({
      restaurantId: restaurant.id, branchId: house.id, recipeId: recipe.id, plannedQty: 5,
    })
    check('and previewing moves no stock at all',
      await prisma.stockMovement.count({ where: { restaurantId: restaurant.id } }) === movementsBefore)
  }

  console.log('\n── 7. Production → prepared stock → an order → COGS, once ──')
  {
    // Make the dough, then sell a dish made of it.
    const job = await newJob(20)
    const run = await completeProduction({
      restaurantId: restaurant.id, orderId: job.id, actualQty: 20, userId: user.id,
    })

    const category = await prisma.category.create({
      data: { restaurantId: restaurant.id, name: 'Bread', slug: `bread-${stamp}` },
    })
    const loaf = await prisma.food.create({
      data: {
        restaurantId: restaurant.id, categoryId: category.id, name: `Loaf ${stamp}`,
        slug: `loaf-${stamp}`, price: 500_00, isAvailable: true,
      },
    })
    await prisma.foodBranch.create({
      data: { restaurantId: restaurant.id, branchId: house.id, foodId: loaf.id, isAvailable: true },
    })
    // A dish recipe that eats the PREPARED item, not the raw flour.
    await saveRecipe({
      restaurantId: restaurant.id, userId: user.id, foodId: loaf.id,
      name: `Loaf recipe ${stamp}`, yieldQty: 1,
      ingredients: [{ inventoryItemId: dough.id, quantity: 2, unit: 'KG' }],
    })

    const doughBefore = await onHand(dough.id, house.id)
    /*
     * The dough's WEIGHTED AVERAGE cost, which is what the sold line will be
     * priced from — not this one run's unit cost.
     *
     * The shelf holds dough from several runs by now, made at different costs,
     * and `resolveRecipe` prices a dish from `InventoryItem.costPerUnit`: the
     * running average the ledger maintains. Asserting against a single run's
     * figure was wrong about the system rather than finding a bug in it, and
     * the average is the right answer — a loaf does not know which batch of
     * dough went into it.
     */
    const doughUnitCost = (
      await prisma.inventoryItem.findUniqueOrThrow({ where: { id: dough.id } })
    ).costPerUnit
    const order = await placeOrder({
      restaurantId: restaurant.id, branchId: house.id, type: 'TAKEAWAY',
      customerName: 'Guest', customerPhone: '',
      items: [{ foodId: loaf.id, quantity: 3, optionIds: [] }],
    })
    await prisma.$transaction(async (tx) => {
      await pinRecipeVersions(tx, { restaurantId: restaurant.id, orderId: order.id })
      await snapshotLineCosts(tx, { restaurantId: restaurant.id, orderId: order.id })
      await reconcileOrderDepletion(tx, { restaurantId: restaurant.id, orderId: order.id, userId: user.id })
    })

    check('selling the dish consumes the PREPARED item, not the raw flour',
      await onHand(dough.id, house.id) === roundQty(doughBefore - 6),
      `${await onHand(dough.id, house.id)} vs ${roundQty(doughBefore - 6)}`)

    // The chain, link by link.
    const outMovement = await prisma.stockMovement.findFirst({
      where: { referenceId: job.id, type: 'PRODUCTION_OUTPUT' },
    })
    const inMovements = await prisma.stockMovement.count({
      where: { referenceId: job.id, type: 'PRODUCTION_CONSUMPTION' },
    })
    const saleMovement = await prisma.stockMovement.findFirst({
      where: { orderId: order.id, itemId: dough.id, type: 'SALE' },
    })
    check('production → recipe version is recorded on the job',
      (await prisma.productionOrder.findUniqueOrThrow({ where: { id: job.id } })).recipeId === recipe.id)
    check('production → ingredients are in the ledger', inMovements === 2, `${inMovements}`)
    check('production → prepared stock is in the ledger', outMovement !== null)
    check('prepared stock → the order that consumed it is in the ledger', saleMovement !== null)

    /*
     * The accounting rule the spec is most insistent about. Production is an
     * inventory TRANSFORMATION: raw materials become prepared stock, and no
     * cost of sales happens. COGS appears only when a customer order consumes
     * that prepared stock, and it comes from `OrderItem.costPrice` — the single
     * snapshot `snapshotLineCosts` writes at kitchen acceptance.
     */
    const line = await prisma.orderItem.findFirstOrThrow({ where: { orderId: order.id } })
    check('the sold line carries a cost snapshot', line.costPrice > 0, `${line.costPrice}`)
    check('…priced from the weighted-average cost of the prepared stock',
      line.costPrice === doughUnitCost * 2, `${line.costPrice} vs ${doughUnitCost * 2}`)
    check('…which is a real cost the production runs put there', doughUnitCost > 0 && run.unitCost > 0)

    const range = customRange(
      new Date(Date.now() - 86_400_000), new Date(Date.now() + 86_400_000), 'Asia/Colombo',
    )
    const profit = await getProfitReport({ restaurantId: restaurant.id, range })
    check('COGS is the sold lines only, never the production run',
      profit.totals.cogs === line.costPrice * 3,
      `${profit.totals.cogs} vs ${line.costPrice * 3}`)
    check('…and the whole run\'s cost is NOT in cost of sales',
      profit.totals.cogs < run.totalCost, `cogs ${profit.totals.cogs}, run ${run.totalCost}`)
  }

  console.log('\n── 8. A finished run keeps the recipe it was made with ──')
  {
    const job = await newJob(5)
    const done = await completeProduction({
      restaurantId: restaurant.id, orderId: job.id, actualQty: 5, userId: user.id,
    })

    // Change the recipe afterwards: double the flour.
    await saveRecipe({
      restaurantId: restaurant.id, userId: user.id, producesItemId: dough.id,
      name: `Dough recipe ${stamp}`, yieldQty: 1, yieldUnit: 'KG',
      ingredients: [
        { inventoryItemId: flour.id, quantity: 2, unit: 'KG' },
        { inventoryItemId: water.id, quantity: 0.5, unit: 'LITRE' },
      ],
    })

    const after = await prisma.productionOrder.findUniqueOrThrow({ where: { id: job.id } })
    check('the finished run keeps its cost', after.unitCost === done.unitCost)
    const lines = await prisma.productionConsumption.findMany({ where: { orderId: job.id } })
    const flourLine = lines.find((line) => line.itemId === flour.id)
    check('…and what it actually consumed', flourLine?.quantity === 5, `${flourLine?.quantity}`)
    check('…and the name it was made under', after.recipeName !== null)
  }

  console.log('\n── 9. Tenant and branch isolation ──')
  {
    const other = await prisma.restaurant.create({
      data: {
        name: `Rival ${stamp}`, slug: `rival-${stamp}`, status: 'ACTIVE', isActive: true, currency: 'LKR',
      },
    })
    const otherHouse = await prisma.branch.create({
      data: {
        restaurantId: other.id, name: 'Rival bakery', code: 'RB',
        isDefault: true, type: 'PRODUCTION_HOUSE',
      },
    })

    /*
     * §8 edited the recipe, and because completed runs pointed at it, saveRecipe
     * SUPERSEDED it — a new version, the old one deactivated. That is the
     * behaviour that keeps finished runs readable, so this section works from
     * whichever version is live now rather than from the id captured at setup.
     */
    const live = await prisma.recipe.findFirstOrThrow({
      where: {
        restaurantId: restaurant.id, producesItemId: dough.id,
        isActive: true, archivedAt: null,
      },
    })
    const job = await createProductionOrder({
      restaurantId: restaurant.id, branchId: house.id, recipeId: live.id,
      plannedQty: 3, userId: user.id,
    })
    await refuses(
      'another restaurant cannot complete this job',
      () => completeProduction({ restaurantId: other.id, orderId: job.id, actualQty: 3 }),
      /kitchen job/i,
    )
    await refuses(
      'another restaurant cannot move it either',
      () => setProductionStatus({ restaurantId: other.id, orderId: job.id, status: 'CANCELLED' }),
      /kitchen job/i,
    )
    await refuses(
      'a job cannot be created against another restaurant\'s recipe',
      () => createProductionOrder({
        restaurantId: other.id, branchId: otherHouse.id, recipeId: live.id, plannedQty: 1,
      }),
      /make-ahead recipe/i,
    )

    const shop = await prisma.branch.create({
      data: { restaurantId: restaurant.id, name: 'Shop', code: 'SHOP', type: 'BRANCH' },
    })
    await refuses(
      'production cannot run at a branch that is not a production house',
      () => createProductionOrder({
        restaurantId: restaurant.id, branchId: shop.id, recipeId: live.id, plannedQty: 1,
      }),
      /not a production house/i,
    )

    const preview = await previewProduction({
      restaurantId: other.id, branchId: otherHouse.id, recipeId: live.id, plannedQty: 1,
    })
    check('and the preview shows another tenant nothing', preview === null)

    await setProductionStatus({
      restaurantId: restaurant.id, orderId: job.id, status: 'CANCELLED', userId: user.id,
    })
    await prisma.restaurant.delete({ where: { id: other.id } })
  }

  /*
   * Explicit teardown, in dependency order.
   *
   * `ProductionConsumption.itemId` and `ProductionOutput.itemId` are
   * `onDelete: Restrict`, so deleting the restaurant cannot cascade through its
   * inventory items while production rows still point at them. The other
   * production suites unwind the same way.
   */
  await prisma.productionOutput.deleteMany({ where: { order: { restaurantId: restaurant.id } } })
  await prisma.productionConsumption.deleteMany({ where: { order: { restaurantId: restaurant.id } } })
  await prisma.productionOrder.deleteMany({ where: { restaurantId: restaurant.id } })
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
