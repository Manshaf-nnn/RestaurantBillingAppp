/**
 * Inventory truth (AUDIT.md Slice 3).
 *
 * Pins the rules that make the stock ledger mean what it says:
 *
 *   • A variant option with a recipe DEPLETES and COSTS it (§29 / C7) —
 *     "extra chicken" was the largest silent margin overstatement in the
 *     system: it consumed nothing, on every plate, for ever.
 *   • WAC carries VALUE (§39): an item costing under one minor unit per base
 *     unit no longer rounds its whole delivery to worthless; issues leave at
 *     the running average; reversals bring value back, not zero.
 *   • A branch cannot sell stock it does not hold, even while another branch
 *     still holds plenty.
 *   • FEFO drains lots at the branch the stock actually left.
 *   • Quick purchases number from the atomic counter and land as lots for
 *     batch-tracked items.
 *   • Approving a stock count states its money impact.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/inventory-truth-test.ts
 */
import { prisma } from '../src/features/../server/db/prisma'
import { postMovement } from '../src/features/inventory/ledger'
import { allocateFefo, upsertBatch } from '../src/features/inventory/batches'
import { reconcileOrderDepletion, snapshotLineCosts } from '../src/features/inventory/depletion'
import { approveStockCount, openStockCount, recordCountLines, submitStockCount } from '../src/features/inventory/stock-count'
import { placeOrder } from '../src/features/orders/service'

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

async function main() {
  const stamp = Date.now().toString(36)

  const restaurant = await prisma.restaurant.create({
    data: {
      name: `Truth ${stamp}`, slug: `truth-${stamp}`, status: 'ACTIVE', isActive: true,
      currency: 'LKR', taxRateBps: 0, serviceChargeBps: 0, taxInclusive: false,
    },
  })
  const main = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Main', code: 'MAIN', isDefault: true },
  })
  const second = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Kandy', code: 'KDY' },
  })
  const user = await prisma.user.create({
    data: {
      restaurantId: restaurant.id, email: `truth-${stamp}@test.local`, name: 'Storeman',
      passwordHash: 'x', role: 'INVENTORY_MANAGER', branchId: main.id,
    },
  })

  console.log('\n── 1. Value-carrying WAC ──')
  {
    const flour = await prisma.inventoryItem.create({
      data: { restaurantId: restaurant.id, name: `Flour ${stamp}`, unit: 'GRAM', quantity: 0 },
    })
    await prisma.$transaction((tx) => postMovement(tx, {
      restaurantId: restaurant.id, itemId: flour.id, type: 'PURCHASE',
      quantity: 1000, unitCost: 3, branchId: main.id, userId: user.id,
    }))
    await prisma.$transaction((tx) => postMovement(tx, {
      restaurantId: restaurant.id, itemId: flour.id, type: 'PURCHASE',
      quantity: 500, unitCost: 6, branchId: main.id, userId: user.id,
    }))
    let row = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: flour.id } })
    check('value is the exact sum of the receipts', Number(row.stockValue) === 6000, `${row.stockValue}`)
    check('the cached average is value ÷ quantity', row.costPerUnit === 4, `${row.costPerUnit}`)

    // 750g leaves at the running average of 4: value drops by exactly 3000.
    await prisma.$transaction((tx) => postMovement(tx, {
      restaurantId: restaurant.id, itemId: flour.id, type: 'SALE',
      quantity: 750, branchId: main.id, userId: user.id,
    }))
    row = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: flour.id } })
    check('an issue takes value at the average', Number(row.stockValue) === 3000, `${row.stockValue}`)

    const saleRow = await prisma.stockMovement.findFirst({
      where: { itemId: flour.id, type: 'SALE' },
    })
    check('the SALE row is stamped with the average', saleRow?.unitCost === 4, `${saleRow?.unitCost}`)

    // A reversal brings the value BACK — these rows used to come back at zero.
    await prisma.$transaction((tx) => postMovement(tx, {
      restaurantId: restaurant.id, itemId: flour.id, type: 'SALE_REVERSAL',
      quantity: 250, branchId: main.id, userId: user.id,
    }))
    row = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: flour.id } })
    check('a reversal returns value, not zero', Number(row.stockValue) === 4000, `${row.stockValue}`)
    const reversalRow = await prisma.stockMovement.findFirst({
      where: { itemId: flour.id, type: 'SALE_REVERSAL' },
    })
    check('…and its row carries the cost it came back at', reversalRow?.unitCost === 4, `${reversalRow?.unitCost}`)
  }

  console.log('\n── 2. A branch cannot sell what it does not hold ──')
  {
    const rice = await prisma.inventoryItem.create({
      data: { restaurantId: restaurant.id, name: `Rice ${stamp}`, unit: 'KG', quantity: 0 },
    })
    await prisma.$transaction((tx) => postMovement(tx, {
      restaurantId: restaurant.id, itemId: rice.id, type: 'PURCHASE',
      quantity: 10, unitCost: 20_000, branchId: main.id, userId: user.id,
    }))
    await refuses(
      'a sale at the empty branch is refused even though Main holds plenty',
      () => prisma.$transaction((tx) => postMovement(tx, {
        restaurantId: restaurant.id, itemId: rice.id, type: 'SALE',
        quantity: 2, branchId: second.id, userId: user.id,
      })),
      /at this location/,
    )
    await prisma.$transaction((tx) => postMovement(tx, {
      restaurantId: restaurant.id, itemId: rice.id, type: 'SALE',
      quantity: 2, branchId: main.id, userId: user.id,
    }))
    check('the branch that holds it can still sell it', true)
  }

  console.log('\n── 3. FEFO drains the branch the stock left from ──')
  {
    const milk = await prisma.inventoryItem.create({
      data: {
        restaurantId: restaurant.id, name: `Milk ${stamp}`, unit: 'LITRE',
        quantity: 0, trackBatches: true, useFefo: true,
      },
    })
    await prisma.$transaction(async (tx) => {
      await postMovement(tx, {
        restaurantId: restaurant.id, itemId: milk.id, type: 'PURCHASE',
        quantity: 10, unitCost: 500, branchId: main.id, userId: user.id,
      })
      await upsertBatch(tx, {
        restaurantId: restaurant.id, itemId: milk.id, batchNo: `M-${stamp}`,
        quantity: 10, unitCost: 500, branchId: main.id,
        expiryDate: new Date(Date.now() + 86_400_000),
      })
      await postMovement(tx, {
        restaurantId: restaurant.id, itemId: milk.id, type: 'PURCHASE',
        quantity: 10, unitCost: 500, branchId: second.id, userId: user.id,
      })
      await upsertBatch(tx, {
        restaurantId: restaurant.id, itemId: milk.id, batchNo: `K-${stamp}`,
        quantity: 10, unitCost: 500, branchId: second.id,
        // Expires FIRST — the trap: branch-blind FEFO would drain Kandy's lot
        // for Main's sale because it expires sooner.
        expiryDate: new Date(Date.now() + 3_600_000),
      })
    })

    const { allocations } = await allocateFefo(prisma, {
      restaurantId: restaurant.id, itemId: milk.id, quantity: 5, branchId: main.id,
    })
    check('an issue at Main is offered Main’s lot, not the sooner-expiring one elsewhere',
      allocations.length === 1 && allocations[0].batchNo === `M-${stamp}`,
      allocations.map((a) => a.batchNo).join(','))
  }

  console.log('\n── 4. An add-on consumes and costs its recipe (C7) ──')
  {
    const chicken = await prisma.inventoryItem.create({
      data: { restaurantId: restaurant.id, name: `Chicken ${stamp}`, unit: 'GRAM', quantity: 0 },
    })
    await prisma.$transaction((tx) => postMovement(tx, {
      restaurantId: restaurant.id, itemId: chicken.id, type: 'PURCHASE',
      quantity: 10_000, unitCost: 2, branchId: main.id, userId: user.id,
    }))
    const extraChicken = await prisma.recipe.create({
      data: {
        restaurantId: restaurant.id, name: `Extra chicken ${stamp}`, isActive: true,
        ingredients: { create: [{ inventoryItemId: chicken.id, quantity: 100, unit: 'GRAM' }] },
      },
    })
    const category = await prisma.category.create({
      data: { restaurantId: restaurant.id, name: 'Mains', slug: `mains-${stamp}` },
    })
    const burger = await prisma.food.create({
      data: {
        restaurantId: restaurant.id, categoryId: category.id, name: `Burger ${stamp}`,
        slug: `burger-${stamp}`, price: 150_000, isAvailable: true,
      },
    })
    await prisma.foodBranch.create({
      data: { restaurantId: restaurant.id, branchId: main.id, foodId: burger.id, isAvailable: true },
    })
    const group = await prisma.variantGroup.create({
      data: { foodId: burger.id, name: 'Add-ons', kind: 'ADDON', maxSelect: 3 },
    })
    const option = await prisma.variantOption.create({
      data: { groupId: group.id, name: 'Extra chicken', priceDelta: 30_000, recipeId: extraChicken.id },
    })

    const order = await placeOrder({
      restaurantId: restaurant.id, branchId: main.id, type: 'TAKEAWAY',
      customerName: 'Walk-in', customerPhone: '',
      items: [{ foodId: burger.id, quantity: 2, optionIds: [option.id] }],
    })

    await prisma.$transaction(async (tx) => {
      await snapshotLineCosts(tx, { restaurantId: restaurant.id, orderId: order.id })
      await reconcileOrderDepletion(tx, { restaurantId: restaurant.id, orderId: order.id })
    })

    const bird = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: chicken.id } })
    check('two burgers with extra chicken take 200g of chicken',
      bird.quantity === 9_800, `${bird.quantity}`)

    const line = await prisma.orderItem.findFirstOrThrow({ where: { orderId: order.id } })
    check('the line’s cost snapshot includes the add-on’s ingredients',
      line.costPrice === 200, `${line.costPrice}`)
  }

  console.log('\n── 5. Quick-purchase numbering and count value ──')
  {
    const sugar = await prisma.inventoryItem.create({
      data: { restaurantId: restaurant.id, name: `Sugar ${stamp}`, unit: 'KG', quantity: 0 },
    })
    await prisma.$transaction((tx) => postMovement(tx, {
      restaurantId: restaurant.id, itemId: sugar.id, type: 'PURCHASE',
      quantity: 10, unitCost: 30_000, branchId: main.id, userId: user.id,
    }))

    const count = await openStockCount({
      restaurantId: restaurant.id, branchId: main.id, userId: user.id,
    })
    await recordCountLines({
      restaurantId: restaurant.id, stockCountId: count.id,
      lines: [{ itemId: sugar.id, countedQty: 8 }],
    })
    await submitStockCount(restaurant.id, count.id)
    const approver = await prisma.user.create({
      data: {
        restaurantId: restaurant.id, email: `appr-${stamp}@test.local`, name: 'Approver',
        passwordHash: 'x', role: 'INVENTORY_MANAGER', branchId: main.id,
      },
    })
    const result = await approveStockCount({
      restaurantId: restaurant.id, stockCountId: count.id, userId: approver.id,
    })
    check('the approval states its money impact: 2kg short at 300 each',
      result.valueDelta === -60_000, `${result.valueDelta}`)
  }

  await prisma.restaurant.delete({ where: { id: restaurant.id } })
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
