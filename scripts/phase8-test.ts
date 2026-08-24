/** Phase 8: reporting — ranges, sales, payments, gross profit, comparison. */
import { prisma } from '../src/server/db/prisma'
import { resolveRange, RANGE_LABELS, DASHBOARD_PRESETS } from '../src/features/reports/range'
import { getSalesReport, getPaymentsReport } from '../src/features/reports/sales'
import { getProfitReport, getBranchComparison } from '../src/features/reports/profit'

let pass = 0, fail = 0
const shops: string[] = []
function ok(n: string, c: boolean, d = '') { c ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${d}`)) }

async function main() {
  const S = Date.now().toString(36)
  const now = new Date(2026, 7, 20, 14, 30) // 20 Aug 2026, a Thursday

  console.log('\n── 1. Date ranges ───────────────────────────────────────')
  const today = resolveRange({ preset: 'TODAY', now })
  ok('today starts at local midnight', today.from.getHours() === 0 && today.from.getDate() === 20)
  ok('today ends at 23:59', today.to.getHours() === 23)
  const yest = resolveRange({ preset: 'YESTERDAY', now })
  ok('yesterday is the 19th', yest.from.getDate() === 19 && yest.to.getDate() === 19)
  const week = resolveRange({ preset: 'THIS_WEEK', now })
  ok('the week starts Monday the 17th', week.from.getDate() === 17, `got ${week.from.getDate()}`)
  const month = resolveRange({ preset: 'THIS_MONTH', now })
  ok('this month starts on the 1st', month.from.getDate() === 1 && month.from.getMonth() === 7)
  const lastMonth = resolveRange({ preset: 'LAST_MONTH', now })
  ok('last month is all of July', lastMonth.from.getMonth() === 6 && lastMonth.to.getMonth() === 6)
  ok('last month ends on the 31st', lastMonth.to.getDate() === 31, `got ${lastMonth.to.getDate()}`)
  const l7 = resolveRange({ preset: 'LAST_7', now })
  ok('last 7 days covers the 14th to the 20th', l7.from.getDate() === 14)
  const custom = resolveRange({ preset: 'CUSTOM', from: '2026-08-01', to: '2026-08-10', now })
  ok('a custom range is honoured', custom.from.getDate() === 1 && custom.to.getDate() === 10)
  const backwards = resolveRange({ preset: 'CUSTOM', from: '2026-08-10', to: '2026-08-01', now })
  ok('a backwards range falls back to today', backwards.preset === 'TODAY')
  const huge = resolveRange({ preset: 'CUSTOM', from: '2020-01-01', to: '2026-08-20', now })
  ok('an enormous range is capped, not rejected',
    (huge.to.getTime() - huge.from.getTime()) / 86_400_000 <= 401)
  const junk = resolveRange({ preset: 'NONSENSE', now })
  ok('an unknown preset falls back to today', junk.preset === 'TODAY')
  /*
   * Counting the labels was the old check, and it failed the moment THIS_YEAR
   * and LAST_90 were added — not because anything was wrong, but because the
   * assertion was a headcount wearing the name of a property. It now checks the
   * property: every label is a real string, and every preset the dashboard
   * offers has one, so a new preset without a label fails and a new preset with
   * one does not.
   */
  ok(
    'every label is a non-empty string',
    Object.values(RANGE_LABELS).every((label) => typeof label === 'string' && label.length > 0),
  )
  ok(
    'every dashboard preset has a label',
    DASHBOARD_PRESETS.every((preset) => Boolean(RANGE_LABELS[preset])),
    DASHBOARD_PRESETS.filter((preset) => !RANGE_LABELS[preset]).join(', '),
  )

  console.log('\n── 2. Test data ─────────────────────────────────────────')
  const shop = await prisma.restaurant.create({
    data: { name: `Rpt ${S}`, slug: `rpt-${S}`, currency: 'LKR', timezone: 'Asia/Colombo' },
  })
  shops.push(shop.id)
  const colombo = await prisma.branch.create({
    data: { restaurantId: shop.id, name: 'Colombo', code: 'COL', isDefault: true },
  })
  const kandy = await prisma.branch.create({
    data: { restaurantId: shop.id, name: 'Kandy', code: 'KAN' },
  })
  const cat = await prisma.category.create({
    data: { restaurantId: shop.id, name: 'Mains', slug: `mains-${S}` },
  })
  const burger = await prisma.food.create({
    data: { restaurantId: shop.id, categoryId: cat.id, name: `Burger ${S}`, slug: `burger-${S}`, price: 1_200_00 },
  })

  const mkOrder = async (branchId: string, qty: number, cost: number) =>
    prisma.order.create({
      data: {
        restaurantId: shop.id, branchId, orderNumber: `R-${S}-${Math.random().toString(36).slice(2, 7)}`,
        type: 'DINE_IN', status: 'COMPLETED', paymentStatus: 'PAID',
        customerName: 'T', customerPhone: '07',
        subtotal: 1_200_00 * qty, discountTotal: 0, taxTotal: 100_00,
        serviceCharge: 50_00, grandTotal: 1_200_00 * qty + 150_00,
        paidTotal: 1_200_00 * qty + 150_00, guestCount: 2,
        items: { create: [{ foodId: burger.id, name: burger.name, unitPrice: 1_200_00,
          quantity: qty, lineTotal: 1_200_00 * qty, costPrice: cost }] },
      },
    })

  // Colombo: 3 burgers at Rs 450 cost. Kandy: 2 at the same cost.
  await mkOrder(colombo.id, 2, 450_00)
  await mkOrder(colombo.id, 1, 450_00)
  await mkOrder(kandy.id, 2, 450_00)

  const range = resolveRange({ preset: 'LAST_30' })

  console.log('\n── 3. Sales ─────────────────────────────────────────────')
  const sales = await getSalesReport({ restaurantId: shop.id, range })
  ok('three orders counted', sales.totals.orders === 3, `got ${sales.totals.orders}`)
  ok('gross sales = 5 burgers × 1200', sales.totals.grossSales === 5 * 1_200_00, `got ${sales.totals.grossSales}`)
  ok('tax is reported separately', sales.totals.tax === 3 * 100_00)
  ok('service charge is separate too', sales.totals.serviceCharge === 3 * 50_00)
  ok('net excludes tax and service',
    sales.totals.netSales === sales.totals.grossSales - sales.totals.discounts - sales.totals.refunds)
  ok('collected adds tax and service back',
    sales.totals.collected === sales.totals.netSales + sales.totals.tax + sales.totals.serviceCharge)
  ok('average order value is net over orders',
    sales.totals.averageOrderValue === Math.round(sales.totals.netSales / 3))
  ok('guests are counted', sales.totals.guests === 6)
  ok('split by branch', sales.byBranch.length === 2)
  ok('Colombo sold more than Kandy',
    sales.byBranch[0].label === 'Colombo' && sales.byBranch[0].sales === 3 * 1_200_00)
  ok('split by category', sales.byCategory[0].label === 'Mains')
  ok('split by item with quantity', sales.byItem[0].quantity === 5, `got ${sales.byItem[0].quantity}`)
  ok('hours read chronologically',
    sales.byHour.every((b, i, a) => i === 0 || a[i - 1].key <= b.key))

  console.log('\n── 4. Branch scoping ────────────────────────────────────')
  const colomboOnly = await getSalesReport({ restaurantId: shop.id, range, branchIds: [colombo.id] })
  ok('scoping to Colombo excludes Kandy', colomboOnly.totals.grossSales === 3 * 1_200_00, `got ${colomboOnly.totals.grossSales}`)
  ok('and reports one branch', colomboOnly.byBranch.length === 1)

  console.log('\n── 5. Gross profit ──────────────────────────────────────')
  const profit = await getProfitReport({ restaurantId: shop.id, range })
  ok('revenue matches sales', profit.totals.revenue === 5 * 1_200_00)
  ok('COGS = 5 × 450', profit.totals.cogs === 5 * 450_00, `got ${profit.totals.cogs}`)
  ok('gross profit = revenue − COGS', profit.totals.grossProfit === 5 * 750_00)
  ok('food cost is 37.5%', profit.totals.foodCostPercent === 37.5, `got ${profit.totals.foodCostPercent}`)
  ok('gross margin is 62.5%', profit.totals.grossMarginPercent === 62.5)
  ok('it is labelled gross, never net',
    profit.disclaimer.toLowerCase().includes('gross profit only')
    && profit.disclaimer.toLowerCase().includes('does not include'))
  ok('the disclaimer names the excluded costs',
    ['rent', 'wages', 'utilities'].every((w) => profit.disclaimer.toLowerCase().includes(w)))
  ok('recipe coverage is reported', profit.coverage.percentCovered === 100)

  const noCost = await mkOrder(colombo.id, 1, 0)
  const profit2 = await getProfitReport({ restaurantId: shop.id, range })
  ok('a line with no cost is flagged, not averaged in', profit2.coverage.linesWithoutRecipe === 1)
  ok('its revenue is reported as uncovered', profit2.coverage.revenueWithoutRecipe === 1_200_00)
  ok('coverage drops below 100%', profit2.coverage.percentCovered < 100)
  await prisma.orderItem.deleteMany({ where: { orderId: noCost.id } })
  await prisma.order.delete({ where: { id: noCost.id } })

  console.log('\n── 6. Branch comparison ─────────────────────────────────')
  const cmp = await getBranchComparison({ restaurantId: shop.id, range })
  ok('both branches compared', cmp.rows.length === 2)
  ok('sorted by gross profit', cmp.rows[0].grossProfit >= cmp.rows[1].grossProfit)
  ok('Colombo leads', cmp.rows[0].name === 'Colombo')
  ok('average order value per branch', cmp.rows[0].averageOrderValue === Math.round((3 * 1_200_00) / 2))
  ok('the comparison carries the same disclaimer', cmp.disclaimer === profit.disclaimer)

  console.log('\n── 7. Payments ──────────────────────────────────────────')
  const payments = await getPaymentsReport({ restaurantId: shop.id, range })
  ok('a payments report returns', typeof payments.total === 'number')
  ok('cash discrepancy is separate from takings', typeof payments.cashDiscrepancy === 'number')
  ok('method shares are percentages',
    payments.byMethod.every((m) => m.share >= 0 && m.share <= 100))

  console.log('\n── 8. Tenant isolation ──────────────────────────────────')
  const other = await prisma.restaurant.create({
    data: { name: `Other ${S}`, slug: `oth-${S}`, currency: 'LKR', timezone: 'Asia/Colombo' },
  })
  shops.push(other.id)
  const otherSales = await getSalesReport({ restaurantId: other.id, range })
  ok('another tenant sees no sales', otherSales.totals.grossSales === 0)
  const otherProfit = await getProfitReport({ restaurantId: other.id, range })
  ok('another tenant sees no profit', otherProfit.totals.revenue === 0)
  ok('and no divide-by-zero', otherProfit.totals.foodCostPercent === null)
  const otherCmp = await getBranchComparison({ restaurantId: other.id, range })
  ok('another tenant sees none of these branches', otherCmp.rows.length === 0)

  // cleanup
  await prisma.orderItem.deleteMany({ where: { order: { restaurantId: { in: shops } } } })
  await prisma.order.deleteMany({ where: { restaurantId: { in: shops } } })
  await prisma.food.deleteMany({ where: { restaurantId: { in: shops } } })
  await prisma.category.deleteMany({ where: { restaurantId: { in: shops } } })
  await prisma.branch.deleteMany({ where: { restaurantId: { in: shops } } })
  await prisma.restaurant.deleteMany({ where: { id: { in: shops } } })

  console.log(`\n═══ ${pass} passed, ${fail} failed ═══\n`)
  await prisma.$disconnect()
  process.exit(fail === 0 ? 0 : 1)
}

main().catch(async (e) => { console.error('\nCRASHED:', e); await prisma.$disconnect(); process.exit(1) })
