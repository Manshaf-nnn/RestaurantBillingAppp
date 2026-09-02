/**
 * Every screen answers the same question with the same number (§102).
 *
 * The product used to ship three revenue definitions at once: the dashboard
 * summed grandTotal (tax, service and tips counted as income), the reports
 * hub summed it again through its own server-clock date resolver, and the
 * sales report said net-of-discounts. Three screens, one question, three
 * answers — the exact failure a restaurant owner cannot argue with their
 * accountant about.
 *
 * This pins the identity: for one seeded day of trade,
 *
 *   dashboard revenue  ===  sales report net sales  ===  summary revenue
 *   profit revenue − COGS === gross profit
 *   net sales = gross − discounts − refunds  (and tips appear in NONE of it)
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/report-agreement-test.ts
 */
import { prisma } from '../src/server/db/prisma'
import { placeOrder } from '../src/features/orders/service'
import { capturePayment, refundPayment } from '../src/features/payments/service'
import { getDashboardStats, getReportSummary } from '../src/features/analytics/queries'
import { getSalesReport } from '../src/features/reports/sales'
import { getProfitReport } from '../src/features/reports/profit'
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
      name: `Agree ${stamp}`, slug: `agree-${stamp}`, status: 'ACTIVE', isActive: true,
      currency: 'LKR', taxLabel: 'VAT', taxRateBps: 1000, serviceChargeBps: 500,
      taxInclusive: false, timezone: 'Asia/Colombo',
    },
  })
  const branch = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Main', code: 'MAIN', isDefault: true },
  })
  const category = await prisma.category.create({
    data: { restaurantId: restaurant.id, name: 'Mains', slug: `mains-${stamp}` },
  })
  const dish = await prisma.food.create({
    data: {
      restaurantId: restaurant.id, categoryId: category.id, name: `Rice ${stamp}`,
      slug: `rice-${stamp}`, price: 100_000, isAvailable: true,
    },
  })
  await prisma.foodBranch.create({
    data: { restaurantId: restaurant.id, branchId: branch.id, foodId: dish.id, isAvailable: true },
  })
  const cashier = await prisma.user.create({
    data: {
      restaurantId: restaurant.id, email: `agree-${stamp}@test.local`, name: 'Cashier',
      passwordHash: 'x', role: 'CASHIER', branchId: branch.id,
    },
  })
  const coupon = await prisma.coupon.create({
    data: {
      restaurantId: restaurant.id, code: `AGREE${stamp}`.toUpperCase(),
      type: 'FIXED', value: 20_000, isActive: true,
    },
  })

  /*
   * One day of trade with every complication the definitions disagree on:
   *   order A — plain, settled WITH A TIP (tip must appear in no revenue figure)
   *   order B — coupon discount, settled
   *   order C — settled then partially refunded
   *   order D — cancelled (must be excluded everywhere)
   */
  const a = await placeOrder({
    restaurantId: restaurant.id, branchId: branch.id, type: 'TAKEAWAY',
    customerName: 'A', customerPhone: '', items: [{ foodId: dish.id, quantity: 2, optionIds: [] }],
  })
  await capturePayment({
    restaurantId: restaurant.id, orderId: a.id, method: 'CASH',
    amount: a.grandTotal + 15_000, tenderedAmount: a.grandTotal + 15_000,
    tipAmount: 15_000, receivedById: cashier.id,
  })

  const b = await placeOrder({
    restaurantId: restaurant.id, branchId: branch.id, type: 'TAKEAWAY',
    customerName: 'B', customerPhone: '', couponCode: coupon.code,
    items: [{ foodId: dish.id, quantity: 1, optionIds: [] }],
  })
  await capturePayment({
    restaurantId: restaurant.id, orderId: b.id, method: 'CARD',
    amount: b.grandTotal, receivedById: cashier.id,
  })

  const c = await placeOrder({
    restaurantId: restaurant.id, branchId: branch.id, type: 'TAKEAWAY',
    customerName: 'C', customerPhone: '', items: [{ foodId: dish.id, quantity: 1, optionIds: [] }],
  })
  const cPaid = await capturePayment({
    restaurantId: restaurant.id, orderId: c.id, method: 'CASH',
    amount: c.grandTotal, tenderedAmount: c.grandTotal, receivedById: cashier.id,
  })
  await refundPayment({
    restaurantId: restaurant.id, paymentId: cPaid.payment.id,
    reason: 'Half the rice was cold', actorId: cashier.id, amount: 40_000,
  })

  const d = await placeOrder({
    restaurantId: restaurant.id, branchId: branch.id, type: 'TAKEAWAY',
    customerName: 'D', customerPhone: '', items: [{ foodId: dish.id, quantity: 5, optionIds: [] }],
  })
  await prisma.order.update({
    where: { id: d.id },
    data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: 'test' },
  })

  const range = resolveRange({ preset: 'TODAY', timeZone: restaurant.timezone })

  const [stats, sales, summary, profit] = await Promise.all([
    getDashboardStats({ restaurantId: restaurant.id, range }),
    getSalesReport({ restaurantId: restaurant.id, range }),
    getReportSummary(restaurant.id, range),
    getProfitReport({ restaurantId: restaurant.id, range }),
  ])

  console.log('\n── The §102 identity ──')

  // gross = 4 sold portions × 1000.00 (D's five are cancelled and gone)
  check('gross sales are the goods sold, cancellations excluded',
    sales.totals.grossSales === 400_000, `${sales.totals.grossSales}`)
  check('net = gross − discounts − refunds',
    sales.totals.netSales ===
      sales.totals.grossSales - sales.totals.discounts - sales.totals.refunds,
    `${sales.totals.netSales} vs ${sales.totals.grossSales} − ${sales.totals.discounts} − ${sales.totals.refunds}`)
  check('the discount is the coupon’s 200.00', sales.totals.discounts === 20_000, `${sales.totals.discounts}`)
  check('the refund is the 400.00 that went back', sales.totals.refunds === 40_000, `${sales.totals.refunds}`)

  check('dashboard revenue IS the sales report’s net sales',
    stats.revenue === sales.totals.netSales, `${stats.revenue} vs ${sales.totals.netSales}`)
  check('the reports hub IS the sales report',
    summary.revenue === sales.totals.netSales && summary.netSales === sales.totals.netSales,
    `${summary.revenue}/${summary.netSales} vs ${sales.totals.netSales}`)
  check('and its top-line agrees field by field',
    summary.grossSales === sales.totals.grossSales &&
      summary.discounts === sales.totals.discounts &&
      summary.refunds === sales.totals.refunds &&
      summary.tax === sales.totals.tax,
    'a field drifted')

  console.log('\n── Tips are nobody’s revenue ──')
  check('the tip is recorded', sales.totals.tips === 15_000, `${sales.totals.tips}`)
  check('…and lives in NO revenue figure',
    !([sales.totals.grossSales, sales.totals.netSales, stats.revenue, summary.revenue]
      .some((v) => v === 415_000 || v === 400_000 + 15_000)),
    'a revenue figure moved by exactly the tip')

  console.log('\n── Profit arithmetic holds ──')
  check('revenue − COGS === gross profit',
    profit.totals.grossProfit === profit.totals.revenue - profit.totals.cogs,
    `${profit.totals.grossProfit} vs ${profit.totals.revenue} − ${profit.totals.cogs}`)
  check('the hub’s profit figures are the profit report’s',
    summary.grossProfit === profit.totals.grossProfit && summary.foodCost === profit.totals.cogs)

  console.log('\n── Collected is cash-basis and separate ──')
  // A: 1015 (with tip) + B: settled − C: 400 refunded of its payment
  const expectedCollected =
    (a.grandTotal + 15_000) + b.grandTotal + (c.grandTotal - 40_000)
  check('collected = payments in − refunds out',
    stats.collected === expectedCollected && summary.collected === expectedCollected,
    `${stats.collected}/${summary.collected} vs ${expectedCollected}`)

  await prisma.restaurant.delete({ where: { id: restaurant.id } })
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
