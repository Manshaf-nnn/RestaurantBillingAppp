/**
 * COGS and margin come from the ledger, not from a number typed into the menu.
 *
 * Three defects met here and each produced a confidently wrong figure on the
 * owner's reports screen:
 *
 *   • `OrderItem.costPrice` was copied from `Food.costPrice`, a menu field that
 *     defaults to zero, so an owner who never filled it in saw COGS 0 and a
 *     gross margin of 100%.
 *   • The recipe fallback meant to cover that was unreachable — `costPrice ??
 *     recipeCost` never fires, because the column is not nullable.
 *   • The profit report summed `lineTotal` while the sales report netted
 *     discounts and refunds, so the two screens disagreed about revenue for the
 *     same period.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/cogs-test.ts
 */
import { customRange } from '../src/features/reports/range'
import { prisma } from '../src/server/db/prisma'
import { postMovement } from '../src/features/inventory/ledger'
import { updateOrderStatus } from '../src/features/orders/service'
import { getProfitReport } from '../src/features/reports/profit'
import { getSalesReport } from '../src/features/reports/sales'

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

  const restaurant = await prisma.restaurant.create({
    data: { name: `COGS ${stamp}`, slug: `cogs-${stamp}`, status: 'ACTIVE', isActive: true, currency: 'LKR' },
  })
  const branch = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Main', code: 'MAIN', isDefault: true },
  })
  const user = await prisma.user.create({
    data: {
      restaurantId: restaurant.id, email: `owner-${stamp}@cogs.test`, name: 'Owner',
      role: 'OWNER', passwordHash: 'x', staffCode: 'W-0001',
    },
  })

  // 100 patties at 250 each. The recipe uses one per burger, so the true cost of
  // a burger is 250 — a number that exists only in the ledger.
  const patty = await prisma.inventoryItem.create({
    data: { restaurantId: restaurant.id, name: 'Patty', unit: 'PIECE', quantity: 0, costPerUnit: 0 },
  })
  await prisma.$transaction((tx) =>
    postMovement(tx, {
      restaurantId: restaurant.id, itemId: patty.id, type: 'PURCHASE',
      quantity: 100, unitCost: 250, branchId: branch.id, userId: user.id,
    }),
  )

  const category = await prisma.category.create({
    data: { restaurantId: restaurant.id, name: 'Mains', slug: `mains-${stamp}`, sortOrder: 1 },
  })
  // costPrice deliberately left at 0 — this is the owner who never filled it in.
  const burger = await prisma.food.create({
    data: {
      restaurantId: restaurant.id, categoryId: category.id, name: 'Burger',
      slug: `burger-${stamp}`, price: 1000, costPrice: 0,
    },
  })
  const recipe = await prisma.recipe.create({
    data: { restaurantId: restaurant.id, foodId: burger.id, yieldQty: 1, isActive: true, version: 1 },
  })
  await prisma.recipeIngredient.create({
    data: { recipeId: recipe.id, inventoryItemId: patty.id, quantity: 1, unit: 'PIECE' },
  })

  const order = await prisma.order.create({
    data: {
      restaurantId: restaurant.id, branchId: branch.id, orderNumber: `C-${stamp}`,
      type: 'DINE_IN', status: 'PENDING', paymentStatus: 'UNPAID',
      customerName: 'Guest', customerPhone: '07',
      subtotal: 10_000, discountTotal: 1_000, grandTotal: 9_000,
      items: {
        create: [{
          foodId: burger.id, name: 'Burger', quantity: 10,
          unitPrice: 1_000, lineTotal: 10_000, status: 'QUEUED',
        }],
      },
    },
  })

  await updateOrderStatus({
    restaurantId: restaurant.id, orderId: order.id, status: 'ACCEPTED', actorId: user.id,
  })

  console.log('\nThe cost of a sale is captured when it is sold')

  const line = await prisma.orderItem.findFirstOrThrow({ where: { orderId: order.id } })
  check(
    'the line records the real ingredient cost, not the menu zero',
    line.costPrice === 250,
    `costPrice ${line.costPrice}, expected 250`,
  )
  check('and it is pinned to the recipe it was costed against', Boolean(line.recipeId))

  const saleMovement = await prisma.stockMovement.findFirstOrThrow({
    where: { orderId: order.id, type: 'SALE' },
  })
  check(
    'the ledger records what the stock leaving was worth',
    saleMovement.unitCost === 250,
    `unitCost ${saleMovement.unitCost}`,
  )

  console.log('\nThe reports agree with each other')

  const range = customRange(new Date(Date.now() - 86_400_000), new Date(Date.now() + 86_400_000))
  const profit = await getProfitReport({ restaurantId: restaurant.id, range })
  const sales = await getSalesReport({ restaurantId: restaurant.id, range })

  check(
    'COGS is 10 × 250, not zero',
    profit.totals.cogs === 2_500,
    `cogs ${profit.totals.cogs}`,
  )
  check(
    'margin is a real number rather than 100%',
    profit.totals.grossMarginPercent !== null && profit.totals.grossMarginPercent < 100,
    `margin ${profit.totals.grossMarginPercent}%`,
  )
  check(
    'profit revenue nets the discount, matching the sales report',
    profit.totals.revenue === sales.totals.netSales,
    `profit ${profit.totals.revenue} vs sales net ${sales.totals.netSales}`,
  )
  check(
    'revenue is 10,000 less the 1,000 discount',
    profit.totals.revenue === 9_000,
    `revenue ${profit.totals.revenue}`,
  )
  check(
    'gross profit is revenue less COGS',
    profit.totals.grossProfit === profit.totals.revenue - profit.totals.cogs,
  )
  check(
    'every line is covered by a recipe, so the margin has no blind spot',
    profit.coverage.percentCovered === 100,
    `${profit.coverage.percentCovered}% covered`,
  )

  // Clean up, children first.
  await prisma.orderStockDepletion.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.stockMovement.deleteMany({ where: { restaurantId: restaurant.id } })
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
