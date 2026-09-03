/**
 * What-if, proven (acCal.md §12).
 *
 * Two things matter here. The arithmetic must be right — an accountant will
 * price a supplier negotiation off it — and the simulation must be unable to
 * touch the books. So the last check counts every row in the database before
 * and after a run: a simulation that writes anything fails.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/what-if-test.ts
 */
import { getIngredientImpact, projectImpact } from '../src/features/reports/what-if'
import { resolveRange } from '../src/features/reports/range'
import { prisma } from '../src/server/db/prisma'

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
  const now = new Date()

  const restaurant = await prisma.restaurant.create({
    data: {
      name: `WhatIf ${stamp}`, slug: `whatif-${stamp}`, status: 'ACTIVE', isActive: true,
      currency: 'LKR', taxRateBps: 0, serviceChargeBps: 0, taxInclusive: false, timezone: 'Asia/Colombo',
    },
  })
  const branch = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Main', code: 'MAIN', isDefault: true },
  })
  const category = await prisma.category.create({
    data: { restaurantId: restaurant.id, name: `Mains ${stamp}`, slug: `mains-${stamp}` },
  })
  // Chicken at 800.00/kg — the spec's own example.
  const chicken = await prisma.inventoryItem.create({
    data: {
      restaurantId: restaurant.id, name: `Chicken ${stamp}`, unit: 'KG',
      quantity: 100, costPerUnit: 80_000,
    },
  })
  const curry = await prisma.food.create({
    data: {
      restaurantId: restaurant.id, categoryId: category.id,
      name: `Chicken curry ${stamp}`, slug: `curry-${stamp}`, price: 100_000, isAvailable: true,
    },
  })
  // Half a kilo per portion, with a 10% wastage margin: 0.55 kg really used.
  await prisma.recipe.create({
    data: {
      restaurantId: restaurant.id, foodId: curry.id, yieldQty: 1,
      ingredients: {
        create: [{ inventoryItemId: chicken.id, quantity: 0.5, unit: 'KG', wastagePercent: 10 }],
      },
    },
  })

  // 100 curries sold at 1,000.00, each costing 440.00 of chicken (0.55 × 800).
  await prisma.order.create({
    data: {
      restaurantId: restaurant.id, branchId: branch.id, orderNumber: `W-${stamp}`,
      customerName: 'Walk-in', customerPhone: '0770000000',
      status: 'COMPLETED', paymentStatus: 'PAID',
      subtotal: 10_000_000, grandTotal: 10_000_000, paidTotal: 10_000_000, placedAt: now,
      items: {
        create: [{
          foodId: curry.id, name: curry.name, unitPrice: 100_000, quantity: 100,
          lineTotal: 10_000_000, costPrice: 44_000,
        }],
      },
      payments: {
        create: [{ restaurantId: restaurant.id, amount: 10_000_000, method: 'CASH', status: 'PAID', paidAt: now }],
      },
    },
  })

  const range = resolveRange({ preset: 'LAST_30', timeZone: restaurant.timezone })
  const before = await prisma.$transaction([
    prisma.order.count(), prisma.orderItem.count(), prisma.stockMovement.count(),
    prisma.inventoryItem.count(), prisma.payment.count(), prisma.recipe.count(),
  ])

  const input = await getIngredientImpact({ restaurantId: restaurant.id, itemId: chicken.id, range })

  console.log('\n── 1. It reads the real recipe and the real sales ──')
  {
    check('the ingredient is found with its current cost',
      input !== null && input.currentUnitCost === 80_000, `${input?.currentUnitCost}`)
    check('one dish uses it, and the wastage margin is counted',
      input?.dishes.length === 1 && Math.abs((input?.dishes[0].quantityPerDish ?? 0) - 0.55) < 1e-9,
      `${input?.dishes[0]?.quantityPerDish}`)
    check('it knows how many were sold and what they earned',
      input?.dishes[0].unitsSold === 100 && input.dishes[0].revenue === 10_000_000)
    check('total ingredient used = 100 × 0.55 kg',
      Math.abs((input?.totalUnitsUsed ?? 0) - 55) < 1e-9, `${input?.totalUnitsUsed}`)
  }

  console.log('\n── 2. The spec’s own question: 800 → 900 a kilo ──')
  {
    const impact = projectImpact(input!, 90_000)
    // 0.55 kg × 100.00 more per kg = 55.00 more per dish; ×100 dishes = 5,500.00
    check('each curry costs 55.00 more', impact.dishes[0].extraPerDish === 5_500,
      `${impact.dishes[0].extraPerDish}`)
    check('the period would have cost 5,500.00 more in total',
      impact.totalExtra === 550_000, `${impact.totalExtra}`)
    // Profit was 10,000,000 − 4,400,000 = 5,600,000; now 5,050,000.
    check('profit falls from 56,000.00 to 50,500.00',
      impact.currentProfit === 5_600_000 && impact.newProfit === 5_050_000,
      `${impact.currentProfit} → ${impact.newProfit}`)
    check('the margin falls with it', impact.newMarginPercent === 50.5, `${impact.newMarginPercent}`)
  }

  console.log('\n── 3. A price cut works the same way, backwards ──')
  {
    const cheaper = projectImpact(input!, 70_000)
    check('a 100.00 cut saves exactly what the rise cost',
      cheaper.totalExtra === -550_000 && cheaper.newProfit === 6_150_000,
      `${cheaper.totalExtra} / ${cheaper.newProfit}`)
    const same = projectImpact(input!, 80_000)
    check('the same price changes nothing', same.totalExtra === 0 && same.newProfit === same.currentProfit)
  }

  console.log('\n── 4. An ingredient no recipe uses says so, honestly ──')
  {
    const unused = await prisma.inventoryItem.create({
      data: { restaurantId: restaurant.id, name: `Napkins ${stamp}`, unit: 'PIECE', quantity: 10, costPerUnit: 500 },
    })
    const result = await getIngredientImpact({ restaurantId: restaurant.id, itemId: unused.id, range })
    check('no dishes, no invented impact', result !== null && result.dishes.length === 0)
    const impact = projectImpact(result!, 900)
    check('…and the projection is zero, not NaN',
      impact.totalExtra === 0 && impact.newMarginPercent === null)
  }

  console.log('\n── 5. Tenancy, and the promise that it writes nothing ──')
  {
    const other = await prisma.restaurant.create({
      data: {
        name: `Other ${stamp}`, slug: `other-wi-${stamp}`, status: 'ACTIVE', isActive: true,
        currency: 'LKR', taxRateBps: 0, serviceChargeBps: 0, taxInclusive: false,
      },
    })
    const foreign = await getIngredientImpact({ restaurantId: other.id, itemId: chicken.id, range })
    check('another restaurant cannot simulate on our ingredient', foreign === null)
    await prisma.restaurant.delete({ where: { id: other.id } })

    const after = await prisma.$transaction([
      prisma.order.count(), prisma.orderItem.count(), prisma.stockMovement.count(),
      prisma.inventoryItem.count(), prisma.payment.count(), prisma.recipe.count(),
    ])
    // One inventory item was created by section 4 on purpose; nothing else moved.
    check('simulating changed no order, no stock movement, no payment',
      after[0] === before[0] && after[1] === before[1] && after[2] === before[2] &&
        after[4] === before[4] && after[5] === before[5],
      `${before.join(',')} → ${after.join(',')}`)
  }

  await prisma.restaurant.delete({ where: { id: restaurant.id } })
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
