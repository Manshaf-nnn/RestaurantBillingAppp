/**
 * The §101 worked example, end to end — the spec's own numbers.
 *
 *   Purchase 100 kg chicken at LKR 800/kg    →  purchase value  80,000.00
 *   Sell 100 curries at 0.5 kg each          →  COGS            40,000.00
 *   Waste 5 kg                               →  waste cost       4,000.00
 *   Remaining 45 kg                          →  stock value     36,000.00
 *
 * And the sentence the whole spec builds to: PURCHASES ARE NOT COGS. The
 * 80,000 that left the bank is not the 40,000 that left the kitchen, and
 * every report must hold that line. This test walks the real services —
 * goods receiving, order flow, wastage — then asks the ledger, the item,
 * the profit report and the reconciliation ladder to explain each figure.
 *
 * (Values in minor units below: LKR 800.00/kg = 80_000 minor per kg.)
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/e2e-reconciliation-test.ts
 */
import { prisma } from '../src/server/db/prisma'
import { postMovement } from '../src/features/inventory/ledger'
import { placeOrder, updateOrderStatus } from '../src/features/orders/service'
import { capturePayment } from '../src/features/payments/service'
import { getProfitReport } from '../src/features/reports/profit'
import { getReconciliationReport } from '../src/features/reports/reconciliation'
import { resolveRange } from '../src/features/reports/range'

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
    data: {
      name: `E2E ${stamp}`, slug: `e2e-${stamp}`, status: 'ACTIVE', isActive: true,
      currency: 'LKR', taxRateBps: 0, serviceChargeBps: 0, taxInclusive: false,
      timezone: 'Asia/Colombo',
    },
  })
  const branch = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Main', code: 'MAIN', isDefault: true },
  })
  const cashier = await prisma.user.create({
    data: {
      restaurantId: restaurant.id, email: `e2e-${stamp}@test.local`, name: 'Cashier',
      passwordHash: 'x', role: 'CASHIER', branchId: branch.id,
    },
  })

  // ── The chicken ─────────────────────────────────────────────────────────────
  const chicken = await prisma.inventoryItem.create({
    data: { restaurantId: restaurant.id, name: `Chicken ${stamp}`, unit: 'KG', quantity: 0 },
  })

  // ── 1. Purchase: 100 kg at 800.00/kg ───────────────────────────────────────
  console.log('\n── 1. Purchase 100 kg at 800/kg ──')
  await prisma.$transaction((tx) => postMovement(tx, {
    restaurantId: restaurant.id, itemId: chicken.id, type: 'PURCHASE',
    quantity: 100, unitCost: 80_000, branchId: branch.id, userId: cashier.id,
    reason: 'GRN §101',
  }))
  {
    const item = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: chicken.id } })
    check('the shelf holds 100 kg', item.quantity === 100, `${item.quantity}`)
    check('worth exactly 80,000.00', Number(item.stockValue) === 8_000_000, `${item.stockValue}`)
  }

  // ── 2. Sell: 100 curries at 0.5 kg each ────────────────────────────────────
  console.log('\n── 2. Sell 100 curries, 0.5 kg each ──')
  const category = await prisma.category.create({
    data: { restaurantId: restaurant.id, name: 'Mains', slug: `mains-${stamp}` },
  })
  const curry = await prisma.food.create({
    data: {
      restaurantId: restaurant.id, categoryId: category.id, name: `Curry ${stamp}`,
      slug: `curry-${stamp}`, price: 120_000, isAvailable: true,
    },
  })
  await prisma.foodBranch.create({
    data: { restaurantId: restaurant.id, branchId: branch.id, foodId: curry.id, isAvailable: true },
  })
  await prisma.recipe.create({
    data: {
      restaurantId: restaurant.id, foodId: curry.id, name: `Curry recipe ${stamp}`, isActive: true,
      ingredients: { create: [{ inventoryItemId: chicken.id, quantity: 0.5, unit: 'KG' }] },
    },
  })

  const order = await placeOrder({
    restaurantId: restaurant.id, branchId: branch.id, type: 'TAKEAWAY',
    customerName: 'Table of many', customerPhone: '',
    items: [{ foodId: curry.id, quantity: 100, optionIds: [] }],
  })
  // Acceptance pins the recipe, snapshots costs and depletes the stock.
  await updateOrderStatus({ restaurantId: restaurant.id, orderId: order.id, status: 'ACCEPTED' })
  await capturePayment({
    restaurantId: restaurant.id, orderId: order.id, method: 'CASH',
    amount: order.grandTotal, tenderedAmount: order.grandTotal, receivedById: cashier.id,
  })

  {
    const item = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: chicken.id } })
    check('50 kg left the kitchen', item.quantity === 50, `${item.quantity}`)
    check('the shelf is now worth 40,000.00', Number(item.stockValue) === 4_000_000, `${item.stockValue}`)

    const sale = await prisma.stockMovement.findFirstOrThrow({
      where: { itemId: chicken.id, type: 'SALE' },
    })
    check('the SALE row explains the COGS: 50 kg at the 800 average',
      Math.round(Math.abs(sale.quantity) * sale.unitCost) === 4_000_000,
      `${Math.abs(sale.quantity)} × ${sale.unitCost}`)

    const line = await prisma.orderItem.findFirstOrThrow({ where: { orderId: order.id } })
    check('each curry is costed at 400.00 of chicken', line.costPrice === 40_000, `${line.costPrice}`)
  }

  // ── 3. Waste: 5 kg ─────────────────────────────────────────────────────────
  console.log('\n── 3. Waste 5 kg ──')
  await prisma.$transaction((tx) => postMovement(tx, {
    restaurantId: restaurant.id, itemId: chicken.id, type: 'WASTAGE',
    quantity: 5, branchId: branch.id, userId: cashier.id, reason: 'Dropped tray',
  }))
  {
    const item = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: chicken.id } })
    check('45 kg remain', item.quantity === 45, `${item.quantity}`)
    check('worth exactly 36,000.00 — the §101 closing figure',
      Number(item.stockValue) === 3_600_000, `${item.stockValue}`)

    const waste = await prisma.stockMovement.findFirstOrThrow({
      where: { itemId: chicken.id, type: 'WASTAGE' },
    })
    check('the waste row carries its 4,000.00 cost',
      Math.round(Math.abs(waste.quantity) * waste.unitCost) === 400_000,
      `${Math.abs(waste.quantity)} × ${waste.unitCost}`)
  }

  // ── 4. Every report explains every figure ──────────────────────────────────
  console.log('\n── 4. The reports agree, and purchases are NOT COGS ──')
  const range = resolveRange({ preset: 'TODAY', timeZone: restaurant.timezone })

  const [profit, ladder] = await Promise.all([
    getProfitReport({ restaurantId: restaurant.id, range }),
    getReconciliationReport({ restaurantId: restaurant.id, range }),
  ])

  check('the profit report states COGS of 40,000.00',
    profit.totals.cogs === 4_000_000, `${profit.totals.cogs}`)
  check('gross profit is revenue minus that COGS',
    profit.totals.grossProfit === profit.totals.revenue - 4_000_000)

  const purchases = await prisma.stockMovement.aggregate({
    where: { restaurantId: restaurant.id, itemId: chicken.id, type: 'PURCHASE' },
    _sum: { quantity: true },
  })
  const purchaseValue = Math.round((purchases._sum.quantity ?? 0) * 80_000)
  check('the purchase ledger states 80,000.00 spent', purchaseValue === 8_000_000)
  check('PURCHASES ≠ COGS: the 80,000 bought is not the 40,000 consumed',
    purchaseValue !== profit.totals.cogs && purchaseValue === 2 * profit.totals.cogs)

  const line = ladder.lines.find((l) => l.itemId === chicken.id)
  check('the reconciliation ladder closes: 0 + 100 − 55 = 45',
    line !== undefined && line.opening === 0 && line.totalIn === 100 &&
      line.totalOut === 55 && line.expected === 45 && line.drift === 0,
    line ? `${line.opening}+${line.totalIn}−${line.totalOut}=${line.expected}, drift ${line.drift}` : 'no line')
  check('…and the ladder’s values close too: 80,000 in, 44,000 out',
    line !== undefined && line.valueIn === 8_000_000 && line.valueOut === 4_400_000,
    line ? `${line.valueIn} in, ${line.valueOut} out` : 'no line')

  check('the whole story: 80,000 = 40,000 consumed + 4,000 wasted + 36,000 on the shelf',
    8_000_000 === profit.totals.cogs + 400_000 + 3_600_000)

  await prisma.restaurant.delete({ where: { id: restaurant.id } })
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
