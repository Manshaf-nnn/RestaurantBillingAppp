/**
 * The order lifecycle, through the services the UI actually calls.
 *
 * `qa-suite.ts` proves depletion works by calling `reconcileOrderDepletion`
 * directly. That is exactly why three stock-corrupting bugs sat green in 636
 * tests: the buttons do not call the reconciler, they call `cancelOrder`,
 * `voidOrderItem` and the guest edit path, and none of those reached it.
 *
 * So this drives those, and checks the two things a service-level test cannot:
 *
 *   1. the restaurant-wide balance equals the sum of its ledger, and
 *   2. the BRANCH balance does too.
 *
 * (2) is the one that was silently false. Sale postings carried no branch, so
 * `InventoryStock.available` only ever went up — receipts and transfers added to
 * it and sales took nothing away.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/order-lifecycle-test.ts
 */
import { prisma } from '../src/server/db/prisma'
import { postMovement } from '../src/features/inventory/ledger'
import { reconcileOrderDepletion } from '../src/features/inventory/depletion'
import { cancelOrder, updateOrderStatus } from '../src/features/orders/service'
import { voidOrderItem } from '../src/features/cashier/service'

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

const near = (a: number, b: number) => Math.abs(a - b) < 1e-6

async function main() {
  const stamp = Date.now().toString(36)

  const restaurant = await prisma.restaurant.create({
    data: { name: `Lifecycle ${stamp}`, slug: `lifecycle-${stamp}`, status: 'ACTIVE', isActive: true },
  })
  const branch = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Main', code: 'MAIN', isDefault: true },
  })
  const user = await prisma.user.create({
    data: {
      restaurantId: restaurant.id, email: `owner-${stamp}@lifecycle.test`, name: 'Owner',
      role: 'OWNER', passwordHash: 'x', staffCode: 'W-0001',
    },
  })

  const patty = await prisma.inventoryItem.create({
    data: { restaurantId: restaurant.id, name: 'Patty', unit: 'PIECE', quantity: 0, costPerUnit: 100 },
  })
  const bun = await prisma.inventoryItem.create({
    data: { restaurantId: restaurant.id, name: 'Bun', unit: 'PIECE', quantity: 0, costPerUnit: 40 },
  })

  // Stock arrives at the branch, so branch balances start non-zero.
  for (const item of [patty, bun]) {
    await prisma.$transaction((tx) =>
      postMovement(tx, {
        restaurantId: restaurant.id, itemId: item.id, type: 'OPENING_BALANCE',
        quantity: 100, unitCost: item.costPerUnit, branchId: branch.id, userId: user.id,
      }),
    )
  }

  const category = await prisma.category.create({
    data: { restaurantId: restaurant.id, name: 'Mains', slug: `mains-${stamp}`, sortOrder: 1 },
  })
  const burger = await prisma.food.create({
    data: { restaurantId: restaurant.id, categoryId: category.id, name: 'Burger', slug: `burger-${stamp}`, price: 1000, costPrice: 0 },
  })
  const recipe = await prisma.recipe.create({
    data: { restaurantId: restaurant.id, foodId: burger.id, yieldQty: 1, isActive: true, version: 1 },
  })
  await prisma.recipeIngredient.createMany({
    data: [
      { recipeId: recipe.id, inventoryItemId: patty.id, quantity: 1, unit: 'PIECE' },
      { recipeId: recipe.id, inventoryItemId: bun.id, quantity: 2, unit: 'PIECE' },
    ],
  })

  /** Cached balance vs the sum of the ledger, restaurant-wide and per branch. */
  async function balances(itemId: string) {
    const item = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: itemId } })
    const ledger = await prisma.stockMovement.aggregate({
      where: { itemId, restaurantId: restaurant.id },
      _sum: { quantity: true },
    })
    const stock = await prisma.inventoryStock.aggregate({
      where: { itemId, branchId: branch.id },
      _sum: { available: true },
    })
    const branchLedger = await prisma.stockMovement.aggregate({
      where: { itemId, restaurantId: restaurant.id, branchId: branch.id },
      _sum: { quantity: true },
    })
    return {
      cached: item.quantity,
      ledger: ledger._sum.quantity ?? 0,
      branch: stock._sum.available ?? 0,
      branchLedger: branchLedger._sum.quantity ?? 0,
    }
  }

  async function makeOrder(qty: number, lines = 1) {
    const order = await prisma.order.create({
      data: {
        restaurantId: restaurant.id,
        branchId: branch.id,
        orderNumber: `L-${stamp}-${Math.random().toString(36).slice(2, 7)}`,
        type: 'DINE_IN',
        status: 'PENDING',
        paymentStatus: 'UNPAID',
        customerName: 'Test guest',
        customerPhone: '07',
        subtotal: 1000 * qty,
        grandTotal: 1000 * qty,
        items: {
          create: Array.from({ length: lines }, () => ({
            foodId: burger.id, name: 'Burger', quantity: qty, recipeId: recipe.id,
            unitPrice: 1000, lineTotal: 1000 * qty, status: 'QUEUED' as const,
          })),
        },
      },
      include: { items: true },
    })
    await updateOrderStatus({
      restaurantId: restaurant.id, orderId: order.id, status: 'ACCEPTED', actorId: user.id,
    })
    return order
  }

  console.log('\nA sale takes stock off the branch, not just the restaurant')

  const order = await makeOrder(3)
  const afterSale = await balances(patty.id)
  check('restaurant balance fell by 3', near(afterSale.cached, 97), `${afterSale.cached}`)
  check('cached balance equals the ledger', near(afterSale.cached, afterSale.ledger),
    `cached ${afterSale.cached} vs ledger ${afterSale.ledger}`)
  check(
    'BRANCH balance fell by 3 — the bug that made every per-branch figure wrong',
    near(afterSale.branch, 97),
    `branch available ${afterSale.branch}, expected 97`,
  )
  check('every sale movement carries its branch', near(afterSale.branchLedger, afterSale.ledger),
    `branch-attributed ${afterSale.branchLedger} of ${afterSale.ledger}`)

  console.log('\nVoiding a line puts its ingredients back')

  const voidOrder = await makeOrder(2, 2)
  const beforeVoid = await balances(bun.id)
  await voidOrderItem({
    restaurantId: restaurant.id,
    orderId: voidOrder.id,
    itemId: voidOrder.items[0].id,
    reason: 'Sent by mistake',
    actorId: user.id,
  })
  const afterVoid = await balances(bun.id)
  check(
    'the 4 buns come back rather than staying consumed',
    near(afterVoid.cached, beforeVoid.cached + 4),
    `${beforeVoid.cached} → ${afterVoid.cached}, expected ${beforeVoid.cached + 4}`,
  )
  check('and the branch balance comes back with them',
    near(afterVoid.branch, beforeVoid.branch + 4),
    `${beforeVoid.branch} → ${afterVoid.branch}`)

  console.log('\nCancelling returns exactly what was taken — once')

  const beforeCancel = await balances(patty.id)
  await cancelOrder({ restaurantId: restaurant.id, orderId: order.id, reason: 'Guest left', actorId: user.id })
  const afterCancel = await balances(patty.id)
  check(
    'the 3 patties are returned',
    near(afterCancel.cached, beforeCancel.cached + 3),
    `${beforeCancel.cached} → ${afterCancel.cached}`,
  )
  check('cached still equals the ledger', near(afterCancel.cached, afterCancel.ledger),
    `cached ${afterCancel.cached} vs ledger ${afterCancel.ledger}`)
  check('branch balance still equals its own ledger',
    near(afterCancel.branch, afterCancel.branchLedger),
    `branch ${afterCancel.branch} vs branch ledger ${afterCancel.branchLedger}`)

  // Reconciling a cancelled order again must be a no-op. The old hand-rolled
  // cancel left orderStockDepletion untouched, so this returned everything twice.
  await prisma.$transaction((tx) =>
    reconcileOrderDepletion(tx, { restaurantId: restaurant.id, orderId: order.id, userId: user.id, releaseAll: true }),
  )
  const afterSecond = await balances(patty.id)
  check(
    'reconciling the cancelled order again changes nothing',
    near(afterSecond.cached, afterCancel.cached),
    `${afterCancel.cached} → ${afterSecond.cached}`,
  )

  console.log('\nNo movement anywhere is missing its branch')

  // Raw SQL, because `branchId` is NOT NULL now and Prisma will not type a
  // `null` filter against it. The check is kept rather than deleted: it is the
  // one that would notice if the column were ever loosened again.
  const [{ n }] = await prisma.$queryRaw<Array<{ n: bigint }>>`
    SELECT COUNT(*)::bigint AS n FROM "stock_movements"
    WHERE "restaurantId" = ${restaurant.id} AND "branchId" IS NULL
  `
  const orphan = Number(n)
  check('every movement is attributed to a branch', orphan === 0, `${orphan} without one`)

  const nullBalance = await prisma.stockMovement.count({
    where: { restaurantId: restaurant.id, balanceAfter: null },
  })
  check('every movement records the balance it produced', nullBalance === 0, `${nullBalance} without one`)

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
