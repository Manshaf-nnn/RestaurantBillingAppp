/**
 * A batch can be started before anybody knows what it will yield.
 *
 * ── Why this path exists next to the one-step flow ─────────────────────────
 *
 * `redesignkitchenjob.md` replaced a confusing two-phase "Kitchen Jobs" screen
 * with one-step Make Item, and for chopping vegetables that is right: you know
 * the answer before you start, and a second click carries no information.
 *
 * It is wrong for a pot of stock that reduces, dough that proves, or a bag of
 * flour that becomes fewer rolls than the recipe promised. The one-step flow
 * makes the cook state the yield at the moment they begin — so they guess, and
 * the guess is recorded as measured fact. Yield loss then disappears from the
 * costing entirely, which is the one thing measuring yield is for.
 *
 * correctionA.md §10 asks for the second path. Both exist; the kitchen picks.
 *
 * ── What must be true of it ────────────────────────────────────────────────
 *
 *   1. Starting moves NOTHING. A plan is intent, and a kitchen whose
 *      ingredients read as spent before anybody opened a bag would take every
 *      report with it.
 *   2. Finishing runs the SAME atomic transaction Make Item runs, against the
 *      batch's own row — one pot of mayonnaise, one reference number.
 *   3. The planned quantity survives. Overwriting it with the actual would
 *      make every batch look like it yielded exactly what was intended.
 *   4. Ingredients are what went in, not what came out. Five eggs went into
 *      the mayonnaise whether it made 1kg or 950g, and scaling them down
 *      would write the loss off the books.
 *   5. Two cooks pressing Mark Done deduct the ingredients once.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/production-yield-test.ts
 */
import { prisma } from '../src/server/db/prisma'
import { postMovement } from '../src/features/inventory/ledger'
import {
  cancelBatch,
  completeBatch,
  listOpenBatches,
  startBatch,
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
    const message = error instanceof Error ? error.message : String(error)
    check(name, expect.test(message), `wrong reason: ${message}`)
  }
}

const stamp = Date.now().toString(36)
let keySeq = 0
const key = () => `yield-${stamp}-${++keySeq}-padding`

async function main() {
  const restaurant = await prisma.restaurant.create({
    data: { name: 'Yield Co', slug: `yield-${stamp}`, email: `yl-${stamp}@test.local` },
  })
  const branch = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Kitchen', code: 'KIT', isDefault: true },
  })
  const cook = await prisma.user.create({
    data: {
      restaurantId: restaurant.id,
      email: `cook-${stamp}@test.local`,
      name: 'Cook',
      passwordHash: 'x',
      role: 'KITCHEN',
      branchId: branch.id,
    },
  })

  // One ingredient, 1000 g on the shelf at 2.00 per gram.
  const flour = await prisma.inventoryItem.create({
    data: {
      restaurantId: restaurant.id,
      name: `Flour ${stamp}`,
      unit: 'GRAM',
      costPerUnit: 200,
      isActive: true,
    },
  })
  /*
   * Seeded through the ledger, not by writing an inventoryStock row.
   *
   * The ledger is what `postMovement` checks against, so a row inserted
   * straight into the cache reads as 1000 g on the shelf and 0 g in the books
   * — and the first real consumption is refused for insufficient stock while
   * the screen says there is plenty. The first run of this file did exactly
   * that. `prepared-items-test` seeds the same way for the same reason.
   */
  await prisma.$transaction((tx) =>
    postMovement(tx, {
      restaurantId: restaurant.id,
      itemId: flour.id,
      type: 'OPENING_BALANCE',
      quantity: 1000,
      unitCost: 200,
      branchId: branch.id,
      userId: cook.id,
    }),
  )

  const plan = {
    name: `Dough ${stamp}`,
    quantity: 900,
    unit: 'GRAM' as const,
    ingredients: [{ itemId: flour.id, quantity: 500, unit: 'GRAM' as const }],
  }

  console.log('\n── 1. Starting a batch moves nothing ──')
  let batchId = ''
  let batchNumber = ''
  {
    // The opening balance above is itself a movement, so the comparison is
    // against what was there before, not against zero.
    const movementsBefore = await prisma.stockMovement.count({
      where: { restaurantId: restaurant.id },
    })

    const started = await startBatch({
      restaurantId: restaurant.id,
      branchId: branch.id,
      userId: cook.id,
      clientRequestId: key(),
      plan,
    })
    batchId = started.id
    batchNumber = started.number
    check('it has a reference number from the moment it exists', started.number.length > 0)

    const stock = await prisma.inventoryStock.findFirstOrThrow({
      where: { itemId: flour.id, branchId: branch.id },
    })
    check('no flour has left the shelf', stock.available === 1000, String(stock.available))

    const movementsAfter = await prisma.stockMovement.count({
      where: { restaurantId: restaurant.id },
    })
    check(
      'and nothing was written to the ledger',
      movementsAfter === movementsBefore,
      `${movementsBefore} → ${movementsAfter}`,
    )

    const row = await prisma.productionOrder.findUniqueOrThrow({ where: { id: batchId } })
    check('the batch is in progress', row.status === 'IN_PROGRESS', row.status)
    check('with the planned quantity on it', row.plannedQty === 900, String(row.plannedQty))
    check('and no actual yet', row.actualQty === null, String(row.actualQty))

    const open = await listOpenBatches({ restaurantId: restaurant.id })
    check('and it shows as open', open.some((b) => b.id === batchId))
  }

  console.log('\n── 2. A double tap starts one batch ──')
  {
    const twice = key()
    const first = await startBatch({
      restaurantId: restaurant.id,
      branchId: branch.id,
      userId: cook.id,
      clientRequestId: twice,
      plan: { ...plan, name: `Twice ${stamp}` },
    })
    const second = await startBatch({
      restaurantId: restaurant.id,
      branchId: branch.id,
      userId: cook.id,
      clientRequestId: twice,
      plan: { ...plan, name: `Twice ${stamp}` },
    })
    check('the same request key returns the same batch', first.id === second.id)
    await cancelBatch({ restaurantId: restaurant.id, batchId: first.id })
  }

  console.log('\n── 3. Finishing it, short ──')
  {
    // Planned 900 g, actually got 850 — the case the one-step flow cannot say.
    const result = await completeBatch({
      restaurantId: restaurant.id,
      batchId,
      userId: cook.id,
      clientRequestId: key(),
      actualQuantity: 850,
      varianceReason: 'PRODUCTION_LOSS',
      varianceNote: 'Stuck to the bowl',
    })

    const row = await prisma.productionOrder.findUniqueOrThrow({ where: { id: batchId } })
    check('the batch is completed', row.status === 'COMPLETED', row.status)
    check('and kept its reference number', row.number === batchNumber, row.number)
    /*
     * The heart of it. Overwriting `plannedQty` with the actual would make
     * every batch look like it yielded exactly what was intended, and the
     * variance column would be zero for ever.
     */
    check('the plan survived', row.plannedQty === 900, String(row.plannedQty))
    check('the actual is what came out', row.actualQty === 850, String(row.actualQty))
    check('and the variance is the difference', row.variance === -50, String(row.variance))
    check('with the reason recorded', row.varianceReason === 'PRODUCTION_LOSS', String(row.varianceReason))

    // The ingredients are what went IN, not scaled to what came out.
    const stock = await prisma.inventoryStock.findFirstOrThrow({
      where: { itemId: flour.id, branchId: branch.id },
    })
    check('all the flour that was planned was consumed', stock.available === 500, String(stock.available))

    const made = await prisma.inventoryItem.findFirstOrThrow({
      where: { restaurantId: restaurant.id, name: plan.name },
    })
    const madeStock = await prisma.inventoryStock.findFirstOrThrow({
      where: { itemId: made.id, branchId: branch.id },
    })
    check('the yield went into stock', madeStock.available === 850, String(madeStock.available))

    /*
     * 500 g of flour at 2.00 = 1,000.00 of value, now carried by 850 g rather
     * than 900. The loss lands in the cost per gram, which is exactly where an
     * owner can see it — not written off silently.
     */
    check(
      'and the value went with it, concentrated by the shortfall',
      made.costPerUnit === Math.round(100_000 / 850),
      `${made.costPerUnit} vs ${Math.round(100_000 / 850)}`,
    )
    check('the run reports the item it made', result.item.id === made.id)
  }

  console.log('\n── 4. It cannot be finished twice ──')
  {
    await refuses(
      'a completed batch refuses a second Mark Done',
      () =>
        completeBatch({
          restaurantId: restaurant.id,
          batchId,
          userId: cook.id,
          clientRequestId: key(),
          actualQuantity: 850,
        }),
      /not in progress/i,
    )

    const stock = await prisma.inventoryStock.findFirstOrThrow({
      where: { itemId: flour.id, branchId: branch.id },
    })
    check('and the flour was deducted only once', stock.available === 500, String(stock.available))
  }

  console.log('\n── 5. A batch nobody made leaves no trace ──')
  {
    const abandoned = await startBatch({
      restaurantId: restaurant.id,
      branchId: branch.id,
      userId: cook.id,
      clientRequestId: key(),
      plan: { ...plan, name: `Abandoned ${stamp}` },
    })
    await cancelBatch({ restaurantId: restaurant.id, batchId: abandoned.id })

    const row = await prisma.productionOrder.findUniqueOrThrow({ where: { id: abandoned.id } })
    check('it is cancelled', row.status === 'CANCELLED', row.status)

    const stock = await prisma.inventoryStock.findFirstOrThrow({
      where: { itemId: flour.id, branchId: branch.id },
    })
    check('with nothing to reverse, because nothing moved', stock.available === 500)

    await refuses(
      'and it cannot then be finished',
      () =>
        completeBatch({
          restaurantId: restaurant.id,
          batchId: abandoned.id,
          userId: cook.id,
          clientRequestId: key(),
          actualQuantity: 100,
        }),
      /not in progress/i,
    )
  }

  console.log('\n── 6. Tenant isolation ──')
  {
    const other = await prisma.restaurant.create({
      data: { name: 'Other Kitchen', slug: `otherk-${stamp}`, email: `ok-${stamp}@test.local` },
    })
    const mine = await startBatch({
      restaurantId: restaurant.id,
      branchId: branch.id,
      userId: cook.id,
      clientRequestId: key(),
      plan: { ...plan, name: `Mine ${stamp}` },
    })
    await refuses(
      "another restaurant cannot finish this one's batch",
      () =>
        completeBatch({
          restaurantId: other.id,
          batchId: mine.id,
          userId: cook.id,
          clientRequestId: key(),
          actualQuantity: 100,
        }),
      /not found|Batch/i,
    )
    await prisma.restaurant.delete({ where: { id: other.id } })
  }

  /*
   * Production rows reference inventory items with onDelete: Restrict — a
   * finished run must not be erasable by deleting the item it consumed — so
   * they are cleared before the cascade, the way `prepared-items-test` clears
   * its ledger rows.
   */
  await prisma.productionConsumption.deleteMany({
    where: { order: { restaurantId: restaurant.id } },
  })
  await prisma.productionOutput.deleteMany({
    where: { order: { restaurantId: restaurant.id } },
  })
  await prisma.productionOrder.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.orderStockDepletion.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.stockBatch.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.stockMovement.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.restaurant.delete({ where: { id: restaurant.id } })
}

main()
  .catch((error) => {
    console.error(error)
    failed += 1
  })
  .finally(async () => {
    await prisma.$disconnect()
    console.log(`\n${passed} passed, ${failed} failed`)
    process.exit(failed > 0 ? 1 : 0)
  })
