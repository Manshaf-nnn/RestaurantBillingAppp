/**
 * smart.md — the Command Center's maths, and the engines it leans on.
 *
 * Pure first: usage / days remaining / reorder, the menu matrix and its change
 * flags, the health score, and period carrying — each with fixture numbers a
 * reader can check by hand. Then the engines: per-dish profit rows summing to
 * the totals, waste by category agreeing with the hub's waste figure for the
 * same window, the new explanations folding, each anomaly check silent on a
 * clean tenant and firing on a seeded case, and a read-only proof — every
 * insights read leaves the row counts exactly where they were.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/insights-test.ts
 */
import { buildExplanations, explainLowStock } from '../src/features/accounting/explain'
import { getAccountingHub } from '../src/features/accounting/hub'
import { runIntegrityChecks } from '../src/features/accounting/integrity'
import { issueExampleHref } from '../src/features/accounting/issue-links'
import { scoreHealth, type HealthInput } from '../src/features/insights/health'
import { classifyMenu, flagProfitChanges } from '../src/features/insights/menu-matrix'
import { ANOMALY_KEYS, carryPeriod, MONEY_TRACE, withPeriod, type TraceNode } from '../src/features/insights/money-trace'
import {
  getCommandCenter,
  getMenuIntelligence,
  getSmartInventory,
  getUsageStats,
  getWasteIntelligence,
  usageWindowStart,
} from '../src/features/insights/queries'
import { computeUsage, DAY_MS, outlookFor, outlookSentence, recommendReorder } from '../src/features/insights/usage'
import { getInventorySummary } from '../src/features/inventory/alerts'
import { postMovement } from '../src/features/inventory/ledger'
import { adjustStock } from '../src/features/inventory/operations'
import { costRecipes, costRecipesDetailed } from '../src/features/inventory/recipe-resolver'
import { getWastageReport, recordWastage } from '../src/features/inventory/wastage'
import { updateOrderStatus } from '../src/features/orders/service'
import { getReorderSuggestions } from '../src/features/purchasing/suggestions'
import { getProfitReport, type FoodProfitRow } from '../src/features/reports/profit'
import { resolveRange } from '../src/features/reports/range'
import { formatMoney } from '../src/lib/money'
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

const close = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps

function foodRow(key: string, quantity: number, revenue: number, cogs: number, uncostedQuantity = 0): FoodProfitRow {
  const grossProfit = revenue - cogs
  return {
    key, label: key, foodId: key, menuPrice: null, quantity, revenue, cogs, grossProfit, uncostedQuantity,
    foodCostPercent: revenue > 0 ? Math.round((cogs / revenue) * 10000) / 100 : null,
    grossMarginPercent: revenue > 0 ? Math.round((grossProfit / revenue) * 10000) / 100 : null,
  }
}

const HREFS = { sales: '/s', profitability: '/p', foodCost: '/f', waste: '/w', inventory: '/i', reconciliation: '/r' }
const perfect = (): HealthInput => ({
  sales: { current: 110, previous: 100 },
  profit: { current: 60, previous: 50, revenue: 110, coveragePercent: 100 },
  foodCost: { percent: 30, targetBps: 3500 },
  waste: { value: 1, cogs: 100 },
  inventory: { totalItems: 10, outOfStock: 0, lowStock: 0, negativeStockCount: 0 },
  reconciliationStatus: 'OK',
  hrefs: HREFS,
})

/** Children first — wastage restricts item deletion, sessions restrict branches. */
async function teardown(restaurantId: string) {
  await prisma.wastageRecord.deleteMany({ where: { restaurantId } })
  await prisma.orderStockDepletion.deleteMany({ where: { restaurantId } })
  await prisma.stockMovement.deleteMany({ where: { restaurantId } })
  await prisma.inventoryStock.deleteMany({ where: { restaurantId } })
  await prisma.cashDrawerSession.deleteMany({ where: { restaurantId } })
  await prisma.cashRegister.deleteMany({ where: { restaurantId } })
  await prisma.auditLog.deleteMany({ where: { restaurantId } })
  await prisma.payment.deleteMany({ where: { restaurantId } })
  await prisma.orderEvent.deleteMany({ where: { order: { restaurantId } } })
  await prisma.orderItem.deleteMany({ where: { order: { restaurantId } } })
  await prisma.order.deleteMany({ where: { restaurantId } })
  await prisma.recipeIngredient.deleteMany({ where: { recipe: { restaurantId } } })
  await prisma.recipe.deleteMany({ where: { restaurantId } })
  await prisma.food.deleteMany({ where: { restaurantId } })
  await prisma.category.deleteMany({ where: { restaurantId } })
  await prisma.supplierItem.deleteMany({ where: { restaurantId } })
  await prisma.supplier.deleteMany({ where: { restaurantId } })
  await prisma.inventoryItem.deleteMany({ where: { restaurantId } })
  await prisma.inventoryCategory.deleteMany({ where: { restaurantId } })
  await prisma.user.deleteMany({ where: { restaurantId } })
  await prisma.branch.deleteMany({ where: { restaurantId } })
  await prisma.restaurant.delete({ where: { id: restaurantId } })
}

/** A crashed earlier run leaves its tenant behind; clear ours before seeding. */
async function sweepStaleFixtures() {
  const stale = await prisma.restaurant.findMany({
    where: { OR: [{ slug: { startsWith: 'insights-' }, name: { startsWith: 'Insights ' } }, { slug: { startsWith: 'other-' }, name: { startsWith: 'Other ' } }] },
    select: { id: true },
  })
  for (const row of stale) await teardown(row.id)
}

async function main() {
  await sweepStaleFixtures()

  console.log('\n── 1. Usage, days remaining, reorder (pure) ──')
  {
    const now = new Date('2026-09-05T10:00:00Z')
    const windowStart = new Date(now.getTime() - 28 * DAY_MS)
    const old = new Date(now.getTime() - 60 * DAY_MS)

    const steady = computeUsage({ used: 28, windowStart, now, firstMovementAt: old, available: 0.6 })
    check('28 used over 28 days is 1 a day', close(steady.avgDailyUsage, 1) && close(steady.observedDays, 28), `${steady.avgDailyUsage}/${steady.observedDays}`)
    check('0.6 on hand at 1 a day is 0.6 days remaining', steady.daysRemaining === 0.6, `${steady.daysRemaining}`)

    const young = computeUsage({ used: 14, windowStart, now, firstMovementAt: new Date(now.getTime() - 7 * DAY_MS), available: 10 })
    check('an item that first moved 7 days ago is averaged over 7 days, not 28', close(young.avgDailyUsage, 2) && close(young.observedDays, 7), `${young.avgDailyUsage}`)

    const idle = computeUsage({ used: 0, windowStart, now, firstMovementAt: old, available: 5 })
    check('no usage → no days-remaining figure, not infinity', idle.avgDailyUsage === 0 && idle.daysRemaining === null)

    const empty = computeUsage({ used: 6, windowStart, now, firstMovementAt: old, available: 0 })
    check('an empty shelf with usage is 0 days remaining', empty.daysRemaining === 0)

    const usageOnly = recommendReorder({ available: 20, avgDailyUsage: 5, leadTimeDays: 3, thresholdSuggestedQty: null, unitsPerPurchaseUnit: null })
    check('5 a day × (3 lead + 7 cover) − 20 on hand = 30 to order', usageOnly.usageBasedQty === 30 && usageOnly.recommendedQty === 30 && usageOnly.basis === 'usage', JSON.stringify(usageOnly))

    const thresholdWins = recommendReorder({ available: 20, avgDailyUsage: 5, leadTimeDays: 3, thresholdSuggestedQty: 45, unitsPerPurchaseUnit: null })
    check('the reorder rule wins when it asks for more', thresholdWins.recommendedQty === 45 && thresholdWins.basis === 'threshold')

    const packs = recommendReorder({ available: 20, avgDailyUsage: 5, leadTimeDays: 3, thresholdSuggestedQty: 45, unitsPerPurchaseUnit: 25 })
    check('45 rounds UP to 2 packs of 25 = 50', packs.purchaseUnits === 2 && packs.recommendedQty === 50)

    const exact = recommendReorder({ available: 0, avgDailyUsage: 5, leadTimeDays: 3, thresholdSuggestedQty: null, unitsPerPurchaseUnit: 25 })
    check('exactly 50 is 2 packs, not 3 (no float creep)', exact.usageBasedQty === 50 && exact.purchaseUnits === 2 && exact.recommendedQty === 50)

    const sentence = outlookSentence(
      'Chicken', 'KG',
      { observedDays: 28, avgDailyUsage: 3, daysRemaining: 0.6 },
      { usageBasedQty: 25.2, recommendedQty: 50, purchaseUnits: null, basis: 'threshold' },
    )
    check('the sentence reads as the spec wrote it', sentence === 'Chicken: 0.6 days remaining — recommend ordering 50 kg', sentence)

    check('outlook bands: out / urgent / soon / ok / no usage',
      outlookFor({ observedDays: 1, avgDailyUsage: 1, daysRemaining: 0 }, 2) === 'OUT' &&
        outlookFor({ observedDays: 1, avgDailyUsage: 1, daysRemaining: 0.6 }, 2) === 'URGENT' &&
        outlookFor({ observedDays: 1, avgDailyUsage: 1, daysRemaining: 5 }, 2) === 'SOON' &&
        outlookFor({ observedDays: 1, avgDailyUsage: 1, daysRemaining: 20 }, 2) === 'OK' &&
        outlookFor({ observedDays: 1, avgDailyUsage: 0, daysRemaining: null }, 2) === 'NO_USAGE')
  }

  console.log('\n── 2. Menu matrix and change flags (pure) ──')
  {
    const rows = [
      foodRow('A', 100, 150_000, 100_000),
      foodRow('B', 100, 60_000, 50_000),
      foodRow('C', 10, 15_000, 6_000),
      foodRow('D', 10, 2_000, 1_500),
      foodRow('E', 0, 0, 0),
      foodRow('F', 20, 30_000, 0, 20),
    ]
    const { thresholds, rows: classed } = classifyMenu(rows)
    const cls = (key: string) => classed.find((row) => row.key === key)?.class
    check('popularity threshold is 70% of the average costed dish (220 units / 4 × 0.7 = 38.5)', thresholds.popularity === 38.5 && thresholds.itemsSold === 4, `${thresholds.popularity}/${thresholds.itemsSold}`)
    check('profit threshold is the weighted GP per unit (69,500 / 220 ≈ 316)', thresholds.profitPerUnit === 316, `${thresholds.profitPerUnit}`)
    check('A is a Star (popular, 500/unit)', cls('A') === 'STAR', cls('A'))
    check('B is a Workhorse (popular, 100/unit)', cls('B') === 'WORKHORSE', cls('B'))
    check('C is a Hidden gem (10 sold, 900/unit)', cls('C') === 'HIDDEN_GEM', cls('C'))
    check('D is a Problem (10 sold, 50/unit)', cls('D') === 'PROBLEM', cls('D'))
    check('E did not sell', cls('E') === 'NOT_SOLD')
    check('F sold without a cost — UNCOSTED, and left out of the averages', cls('F') === 'UNCOSTED')
    check('a lone dish is classified against itself, as a Star', classifyMenu([rows[0]]).rows[0].class === 'STAR')

    const cur = classifyMenu([foodRow('X', 10, 10_000, 2_800)]).rows[0]
    check('unit cost 250 → 280 is flagged (+12%)', flagProfitChanges(cur, foodRow('X', 10, 10_000, 2_500), null).includes('unit cost up 12%'), flagProfitChanges(cur, foodRow('X', 10, 10_000, 2_500), null).join(' | '))
    const gentle = classifyMenu([foodRow('X', 10, 10_000, 2_600)]).rows[0]
    check('unit cost 250 → 260 is not flagged (+4%)', !flagProfitChanges(gentle, foodRow('X', 10, 10_000, 2_500), null).some((f) => f.startsWith('unit cost')))
    const marginDrop = classifyMenu([foodRow('Y', 10, 10_000, 6_600)]).rows[0]
    check('margin 40% → 34% is flagged (−6 pts)', flagProfitChanges(marginDrop, foodRow('Y', 10, 10_000, 6_000), null).includes('margin down 6 pts'), flagProfitChanges(marginDrop, foodRow('Y', 10, 10_000, 6_000), null).join(' | '))
    check('a recipe costing 300 today against 250 as sold is flagged (+20%)', flagProfitChanges(classifyMenu([foodRow('Z', 10, 10_000, 2_500)]).rows[0], undefined, 300).some((f) => f.includes('20% more')))
    check('selling below cost is flagged', flagProfitChanges(classifyMenu([foodRow('L', 5, 1_000, 2_000)]).rows[0], undefined, null).includes('sold below cost'))
    check('an uncosted dish says so', flagProfitChanges(classifyMenu([foodRow('U', 5, 1_000, 0, 5)]).rows[0], undefined, null).includes('cost unknown'))
  }

  console.log('\n── 3. Health score (pure) ──')
  {
    const all = scoreHealth(perfect())
    check('every signal at its best scores 100, healthy, no issues', all.score === 100 && all.band === 'HEALTHY' && all.issues.length === 0 && all.signalsUsed === 6, `${all.score}`)

    const nothing = scoreHealth({
      ...perfect(),
      sales: { current: 0, previous: 0 },
      profit: { current: 0, previous: 0, revenue: 0, coveragePercent: 100 },
      foodCost: { percent: null, targetBps: null },
      waste: { value: 0, cogs: 0 },
      inventory: { totalItems: 0, outOfStock: 0, lowStock: 0, negativeStockCount: 0 },
    })
    check('with no trade only the books can be judged — five signals excluded, not invented', nothing.excluded.length === 5 && nothing.signalsUsed === 1 && nothing.score === 100, `${nothing.excluded.join(',')}`)

    const broken = scoreHealth({ ...perfect(), reconciliationStatus: 'ERROR' })
    check('books ERROR scores 20 at weight 20 → (20×20 + 100×80) / 100 = 84', broken.score === 84 && broken.issues.length === 1 && broken.issues[0].key === 'reconciliation', `${broken.score}`)

    const noWaste = scoreHealth({ ...perfect(), waste: { value: 0, cogs: 0 } })
    check('an excluded signal renormalises the weights (still 100 of 5 signals)', noWaste.score === 100 && noWaste.signalsUsed === 5 && noWaste.excluded[0] === 'waste')

    const blind = scoreHealth({ ...perfect(), profit: { current: 60, previous: 50, revenue: 110, coveragePercent: 50 } })
    const profitability = blind.components.find((c) => c.key === 'profitability')
    check('half the sales without a recipe cost caps profitability at 55', profitability?.score === 55 && profitability.detail.includes('50%'), `${profitability?.score}`)

    const overTarget = scoreHealth({ ...perfect(), foodCost: { percent: 42, targetBps: 3500 } })
    check('food cost 7 points over target scores 25', overTarget.components.find((c) => c.key === 'foodCost')?.score === 25)
    const defaultTarget = scoreHealth({ ...perfect(), foodCost: { percent: 36, targetBps: null } })
    const fc = defaultTarget.components.find((c) => c.key === 'foodCost')
    check('no target set → judged against 35% and the detail says so', fc?.score === 80 && fc.detail.includes('no target set'), fc?.detail)

    const messy = scoreHealth({
      ...perfect(),
      sales: { current: 80, previous: 100 },          // −20% → 25 × 15 = 1125 short
      foodCost: { percent: 40, targetBps: 3500 },     // +5 → 55 × 20 = 900 short
      waste: { value: 6, cogs: 100 },                 // 6% → 45 × 15 = 825 short
      reconciliationStatus: 'WARNING',                // 60 × 20 = 800 short
    })
    check('top-3 issues are the biggest weighted shortfalls, in order', messy.issues.map((i) => i.key).join(',') === 'sales,foodCost,waste', messy.issues.map((i) => `${i.key}:${i.score}`).join(','))
    check('…and the score lands in "needs attention"', messy.band === 'ATTENTION', `${messy.score}`)
  }

  console.log('\n── 4. Carrying the period (pure) ──')
  {
    const query = { preset: 'LAST_30', from: '', to: '', branch: 'b1' }
    check('a plain href gains the period and branch, empty dates skipped', withPeriod('/dashboard/reports/sales', query) === '/dashboard/reports/sales?preset=LAST_30&branch=b1', withPeriod('/dashboard/reports/sales', query))
    check('an href with a query string is appended to, not broken', withPeriod('/x?tab=issues', query) === '/x?tab=issues&preset=LAST_30&branch=b1')
    const carried = carryPeriod(
      { key: 'k', title: 't', value: 5, valueKind: 'money', sentence: 's', lines: [{ label: 'a', amount: 5, op: 'start', href: '/a' }], sources: [{ label: 'S', href: '/s' }] },
      query,
    )
    check('carrying the period touches links only', carried.value === 5 && carried.lines[0].amount === 5 && carried.lines[0].href === '/a?preset=LAST_30&branch=b1' && carried.sources[0].href === '/s?preset=LAST_30&branch=b1')
  }

  // ── DB fixture ───────────────────────────────────────────────────────────────
  const stamp = Date.now().toString(36)
  const timeZone = 'Asia/Colombo'
  const restaurant = await prisma.restaurant.create({
    data: {
      name: `Insights ${stamp}`, slug: `insights-${stamp}`, status: 'ACTIVE', isActive: true,
      currency: 'LKR', taxRateBps: 0, serviceChargeBps: 0, taxInclusive: false, timezone: timeZone,
      targetFoodCostBps: 3000,
      approvalPolicy: { adjustmentValueAbove: 100_000, cashVarianceAbove: 50_000 },
    },
  })
  const money = (minor: number) => formatMoney(minor, 'LKR')
  const branch = await prisma.branch.create({ data: { restaurantId: restaurant.id, name: 'Main', code: 'MAIN', isDefault: true } })
  const other = await prisma.branch.create({ data: { restaurantId: restaurant.id, name: 'Annex', code: 'B2' } })
  const owner = await prisma.user.create({
    data: { restaurantId: restaurant.id, email: `owner-${stamp}@insights.test`, name: 'Owner', role: 'OWNER', passwordHash: 'x', staffCode: 'W-0001' },
  })
  const cashier = await prisma.user.create({
    data: { restaurantId: restaurant.id, email: `cashier-${stamp}@insights.test`, name: 'Cashier', role: 'CASHIER', passwordHash: 'x', branchId: branch.id },
  })
  const proteins = await prisma.inventoryCategory.create({ data: { restaurantId: restaurant.id, name: 'Proteins' } })

  const chicken = await prisma.inventoryItem.create({
    data: {
      restaurantId: restaurant.id, name: 'Chicken', unit: 'KG', quantity: 0, costPerUnit: 0,
      categoryId: proteins.id, category: 'Proteins', reorderLevel: 10, maxStock: 50, unitsPerPurchaseUnit: 10,
    },
  })
  const fish = await prisma.inventoryItem.create({
    data: { restaurantId: restaurant.id, name: 'Fish', unit: 'KG', quantity: 0, costPerUnit: 0, categoryId: proteins.id, category: 'Proteins' },
  })
  const lettuce = await prisma.inventoryItem.create({
    data: { restaurantId: restaurant.id, name: 'Lettuce', unit: 'PIECE', quantity: 0, costPerUnit: 0, category: 'Veg' },
  })
  const oil = await prisma.inventoryItem.create({
    data: { restaurantId: restaurant.id, name: 'Oil', unit: 'LITRE', quantity: 0, costPerUnit: 0 },
  })
  const supplier = await prisma.supplier.create({ data: { restaurantId: restaurant.id, name: 'Farm' } })
  await prisma.supplierItem.create({
    data: { restaurantId: restaurant.id, supplierId: supplier.id, itemId: chicken.id, price: 50_000, leadTimeDays: 2, isPreferred: true, isActive: true },
  })

  const receive = (itemId: string, quantity: number, unitCost: number) =>
    prisma.$transaction((tx) =>
      postMovement(tx, { restaurantId: restaurant.id, itemId, type: 'PURCHASE', quantity, unitCost, branchId: branch.id, userId: owner.id }),
    )
  await receive(chicken.id, 4.8, 50_000)
  await receive(fish.id, 5, 20_000)
  await receive(lettuce.id, 20, 5_000)
  await receive(oil.id, 3, 80_000)

  const category = await prisma.category.create({ data: { restaurantId: restaurant.id, name: 'Mains', slug: `mains-${stamp}` } })
  const grilled = await prisma.food.create({
    data: { restaurantId: restaurant.id, categoryId: category.id, name: 'Grilled chicken', slug: `grilled-${stamp}`, price: 150_000, costPrice: 0, isAvailable: true },
  })
  const rice = await prisma.food.create({
    data: { restaurantId: restaurant.id, categoryId: category.id, name: 'Plain rice', slug: `rice-${stamp}`, price: 20_000, costPrice: 0, isAvailable: true },
  })
  const dessert = await prisma.food.create({
    data: { restaurantId: restaurant.id, categoryId: category.id, name: 'Dessert', slug: `dessert-${stamp}`, price: 30_000, isAvailable: true },
  })
  const recipe = await prisma.recipe.create({ data: { restaurantId: restaurant.id, foodId: grilled.id, yieldQty: 1, isActive: true, version: 1 } })
  await prisma.recipeIngredient.create({ data: { recipeId: recipe.id, inventoryItemId: chicken.id, quantity: 0.5, unit: 'KG' } })

  const sell = async (foodId: string, name: string, quantity: number, unitPrice: number, number: string) => {
    const order = await prisma.order.create({
      data: {
        restaurantId: restaurant.id, branchId: branch.id, orderNumber: `${number}-${stamp}`, type: 'DINE_IN',
        status: 'PENDING', paymentStatus: 'UNPAID', customerName: 'Guest', customerPhone: '07',
        subtotal: unitPrice * quantity, grandTotal: unitPrice * quantity,
        items: { create: [{ foodId, name, quantity, unitPrice, lineTotal: unitPrice * quantity, status: 'QUEUED' }] },
      },
    })
    await updateOrderStatus({ restaurantId: restaurant.id, orderId: order.id, status: 'ACCEPTED', actorId: owner.id })
    return order
  }
  await sell(grilled.id, 'Grilled chicken', 6, 150_000, 'G')   // 3 kg of chicken leaves; COGS 6 × 25,000
  await sell(rice.id, 'Plain rice', 2, 20_000, 'R')            // no recipe → uncosted

  const today = resolveRange({ preset: 'TODAY', timeZone })
  const yesterday = resolveRange({ preset: 'YESTERDAY', timeZone })

  console.log('\n── 5. The clean tenant: every new check is OK ──')
  const NEW_KEYS = ['unusual-cancellations', 'void-concentration', 'unusual-stock-adjustments', 'unusual-wastage', 'unusual-cash-variance', 'after-hours-activity']
  {
    const clean = await runIntegrityChecks(restaurant.id)
    const byKey = new Map(clean.checks.map((c) => [c.key, c]))
    check('all six new checks are present and OK on a clean tenant', NEW_KEYS.every((key) => byKey.get(key)?.status === 'OK'), NEW_KEYS.map((k) => `${k}:${byKey.get(k)?.status}`).join(' '))
    check('…and the report as a whole is OK (hardening-test relies on this)', clean.status === 'OK', clean.checks.filter((c) => c.status !== 'OK').map((c) => c.key).join(','))
    check('after-hours says why it found nothing', byKey.get('after-hours-activity')?.detail.includes('not set') === true)
    check('every anomaly key the Command Center lists exists in the checker', ANOMALY_KEYS.every((key) => byKey.has(key)), ANOMALY_KEYS.filter((k) => !byKey.has(k)).join(','))
  }

  console.log('\n── 6. Per-dish profit rows ──')
  {
    const profit = await getProfitReport({ restaurantId: restaurant.id, range: today })
    const sum = (rows: Array<{ revenue: number; cogs: number; quantity: number }>) =>
      rows.reduce((acc, r) => ({ revenue: acc.revenue + r.revenue, cogs: acc.cogs + r.cogs, quantity: acc.quantity + r.quantity }), { revenue: 0, cogs: 0, quantity: 0 })
    const byFood = sum(profit.byFood)
    const byItem = sum(profit.byItem)
    check('Σ byFood revenue and COGS are the totals', byFood.revenue === profit.totals.revenue && byFood.cogs === profit.totals.cogs, `${byFood.revenue}/${byFood.cogs} vs ${profit.totals.revenue}/${profit.totals.cogs}`)
    check('Σ byFood quantity equals Σ byItem quantity', byFood.quantity === byItem.quantity && byFood.quantity === 8)
    const chickenRow = profit.byFood.find((r) => r.foodId === grilled.id)
    check('the chicken dish is keyed on its foodId, with menu price and full cost coverage',
      chickenRow?.key === grilled.id && chickenRow.menuPrice === 150_000 && chickenRow.quantity === 6 && chickenRow.cogs === 150_000 && chickenRow.uncostedQuantity === 0,
      JSON.stringify(chickenRow))
    const riceRow = profit.byFood.find((r) => r.foodId === rice.id)
    check('the recipe-less dish counts its units as uncosted', riceRow?.uncostedQuantity === 2 && riceRow.cogs === 0, JSON.stringify(riceRow))
    check('byItem is unchanged: still the top-50 name-keyed rows', profit.byItem.every((r) => !('foodId' in r)) && profit.byItem.length === 2)
  }

  console.log('\n── 7. Recipe costing keeps its problems ──')
  {
    const a = await prisma.recipe.create({ data: { restaurantId: restaurant.id, name: 'Loop A', yieldQty: 1, isActive: true } })
    const b = await prisma.recipe.create({ data: { restaurantId: restaurant.id, name: 'Loop B', yieldQty: 1, isActive: true } })
    await prisma.recipeIngredient.create({ data: { recipeId: a.id, subRecipeId: b.id, quantity: 1, unit: 'PIECE' } })
    await prisma.recipeIngredient.create({ data: { recipeId: b.id, subRecipeId: a.id, quantity: 1, unit: 'PIECE' } })
    const detailed = await costRecipesDetailed(prisma, restaurant.id, [a.id, recipe.id])
    const plain = await costRecipes(prisma, restaurant.id, [a.id, recipe.id])
    check('a cyclic recipe costs 0 AND says why', detailed.get(a.id)?.cost === 0 && (detailed.get(a.id)?.problems.length ?? 0) > 0, JSON.stringify(detailed.get(a.id)))
    check('a good recipe costs what its ingredients cost (0.5 kg × 500.00)', detailed.get(recipe.id)?.cost === 25_000 && detailed.get(recipe.id)?.problems.length === 0, `${detailed.get(recipe.id)?.cost}`)
    check('costRecipes is unchanged: 0 for the cycle, 25,000 for the dish', plain.get(a.id) === 0 && plain.get(recipe.id) === 25_000)
  }

  console.log('\n── 8. Menu intelligence from the real rows ──')
  {
    const menu = await getMenuIntelligence({ restaurantId: restaurant.id, range: today, branchIds: null, timeZone })
    const chickenRow = menu.rows.find((r) => r.foodId === grilled.id)
    check('the chicken dish carries list price, today’s recipe cost, units and COGS from the engines',
      chickenRow?.menuPrice === 150_000 && chickenRow.recipeCost === 25_000 && chickenRow.quantity === 6 && chickenRow.cogs === 150_000 && chickenRow.unitCogs === 25_000 && chickenRow.avgSoldPrice === 150_000,
      JSON.stringify(chickenRow && { menuPrice: chickenRow.menuPrice, recipeCost: chickenRow.recipeCost, q: chickenRow.quantity, cogs: chickenRow.cogs }))
    check('…and is classed (the only costed dish is a Star against itself)', chickenRow?.class === 'STAR', chickenRow?.class)
    const riceRow = menu.rows.find((r) => r.foodId === rice.id)
    check('the recipe-less dish is UNCOSTED, flagged, and reports "No active recipe"', riceRow?.class === 'UNCOSTED' && riceRow.changes.includes('cost unknown') && riceRow.problems.some((p) => /no active recipe/i.test(p)), JSON.stringify(riceRow?.problems))
    check('the dessert nobody ordered is listed as not sold', menu.notSold.some((d) => d.foodId === dessert.id) && menu.counts.NOT_SOLD === 1)
    check('the counts add up to the rows plus the unsold', Object.values(menu.counts).reduce((a, b) => a + b, 0) === menu.rows.length + menu.notSold.length)
    check('coverage is honest: 6 of 8 units costed', menu.coverage.linesWithRecipe === 1 && menu.coverage.linesWithoutRecipe === 1)
  }

  console.log('\n── 9. Smart inventory from the ledger ──')
  {
    const now = new Date()
    const windowStart = usageWindowStart(now, timeZone)
    const usage = await getUsageStats({ restaurantId: restaurant.id, branchId: null, windowStart, now })
    check('the ledger says 3 kg of chicken left through trade', close(usage.get(chicken.id)?.used ?? -1, 3), `${usage.get(chicken.id)?.used}`)
    check('purchases are not usage (fish, lettuce, oil at 0)', close(usage.get(fish.id)?.used ?? -1, 0) && close(usage.get(oil.id)?.used ?? -1, 0))
    const scoped = await getUsageStats({ restaurantId: restaurant.id, branchId: other.id, windowStart, now })
    check('a location with no movements has no usage rows', !scoped.has(chicken.id))
    const before = await getUsageStats({ restaurantId: restaurant.id, branchId: null, windowStart, now: new Date(now.getTime() - DAY_MS) })
    check('the window bounds hold: nothing counts after "now"', (before.get(chicken.id)?.used ?? 0) === 0)

    const stock = await getSmartInventory({ restaurantId: restaurant.id, branchId: branch.id, timeZone, now })
    const row = stock.rows.find((r) => r.itemId === chicken.id)
    check('Chicken: 1.8 kg on hand, 3 kg/day (over its first day), 0.6 days remaining',
      row !== undefined && close(row.available, 1.8) && close(row.avgDailyUsage, 3) && row.daysRemaining === 0.6,
      JSON.stringify(row && { available: row.available, avg: row.avgDailyUsage, days: row.daysRemaining, observed: row.observedDays }))
    check('…recommend 50 kg: the reorder rule’s 48.2 rounded up to 5 packs of 10', row?.recommendedQty === 50 && row.purchaseUnits === 5 && row.basis === 'threshold', `${row?.recommendedQty}/${row?.purchaseUnits}/${row?.basis}`)
    check('…the exact sentence from the spec', row?.sentence === 'Chicken: 0.6 days remaining — recommend ordering 50 kg', row?.sentence)
    check('…urgent, with the supplier’s lead time', row?.outlook === 'URGENT' && row.leadTimeDays === 2 && row.supplierName === 'Farm')
    const suggestions = await getReorderSuggestions({ restaurantId: restaurant.id, branchId: branch.id })
    const suggested = suggestions.find((s) => s.itemId === chicken.id)?.suggestedQty ?? 0
    check('never less than the purchasing module’s own suggestion', suggested > 0 && (row?.recommendedQty ?? 0) >= suggested, `${row?.recommendedQty} vs ${suggested}`)
    check('every active item appears, whatever its branchId column says', [chicken.id, fish.id, lettuce.id, oil.id].every((id) => stock.rows.some((r) => r.itemId === id)))
    check('totals: one to order, one urgent', stock.totals.needOrder === 1 && stock.totals.urgent === 1, JSON.stringify(stock.totals))

    const annex = await getSmartInventory({ restaurantId: restaurant.id, branchId: other.id, timeZone, now })
    const annexRow = annex.rows.find((r) => r.itemId === chicken.id)
    check('at a location that never moved it, chicken shows no usage and nothing on hand', annexRow?.outlook === 'NO_USAGE' && annexRow.available === 0 && annexRow.sentence.includes('no usage'), annexRow?.sentence)
  }

  console.log('\n── 10. Anomalies fire on seeded cases ──')
  // A bill cancelled with money still on it.
  const cancelled = await prisma.order.create({
    data: {
      restaurantId: restaurant.id, branchId: branch.id, orderNumber: `X-${stamp}`, type: 'TAKEAWAY',
      status: 'CANCELLED', cancelledAt: new Date(), cancelReason: 'test', paymentStatus: 'PAID',
      customerName: 'Guest', customerPhone: '07', subtotal: 5_000, grandTotal: 5_000, paidTotal: 5_000,
      items: { create: [{ name: 'Ghost', quantity: 1, unitPrice: 5_000, lineTotal: 5_000 }] },
      payments: { create: [{ restaurantId: restaurant.id, amount: 5_000, method: 'CASH', status: 'PAID', paidAt: new Date(), receivedById: cashier.id }] },
    },
  })
  // A hand adjustment moving 40% of the fish.
  await adjustStock({ restaurantId: restaurant.id, itemId: fish.id, quantity: 2, unit: 'KG', branchId: branch.id, userId: owner.id, direction: 'OUT', reason: 'Insights test' })
  // Fish wasted three times with no usage at all; lettuce and oil once each (for the categories).
  for (let i = 0; i < 3; i += 1) {
    await recordWastage({ restaurantId: restaurant.id, itemId: fish.id, quantity: 1, unit: 'KG', reason: 'SPOILED', branchId: branch.id, userId: owner.id })
  }
  await recordWastage({ restaurantId: restaurant.id, itemId: lettuce.id, quantity: 1, unit: 'PIECE', reason: 'DROPPED', branchId: branch.id, userId: owner.id })
  const oilWaste = await recordWastage({ restaurantId: restaurant.id, itemId: oil.id, quantity: 0.5, unit: 'LITRE', reason: 'EXPIRED', branchId: branch.id, userId: owner.id })
  // A drawer 600.00 short against a 500.00 review threshold.
  const register = await prisma.cashRegister.create({ data: { restaurantId: restaurant.id, branchId: branch.id, name: 'Till 1' } })
  const session = await prisma.cashDrawerSession.create({
    data: {
      restaurantId: restaurant.id, branchId: branch.id, registerId: register.id, sessionNumber: `D-${stamp}`,
      openedById: cashier.id, openingFloat: 0, closedById: cashier.id, closedAt: new Date(),
      countedCash: 0, expectedCash: 60_000, variance: -60_000, varianceReason: 'test', status: 'CLOSED',
    },
  })
  // Twelve voids by the cashier this week, one by the owner.
  await prisma.auditLog.createMany({
    data: [
      ...Array.from({ length: 12 }, (_, i) => ({
        restaurantId: restaurant.id, userId: cashier.id, actorName: 'Cashier', action: 'order.item_voided',
        entity: 'OrderItem', entityId: `void-${i}`, after: { reason: 'test', orderId: cancelled.id },
      })),
      { restaurantId: restaurant.id, userId: owner.id, actorName: 'Owner', action: 'order.cancelled', entity: 'Order', entityId: cancelled.id, after: { reason: 'test' } },
    ],
  })
  {
    const dirty = await runIntegrityChecks(restaurant.id)
    const get = (key: string) => dirty.checks.find((c) => c.key === key)
    check('a bill cancelled with money on it → unusual-cancellations WARNING, naming the order', get('unusual-cancellations')?.status === 'WARNING' && get('unusual-cancellations')?.examples.includes(cancelled.id) === true, get('unusual-cancellations')?.status)
    check('a 40% hand adjustment → unusual-stock-adjustments WARNING, naming the item', get('unusual-stock-adjustments')?.status === 'WARNING' && get('unusual-stock-adjustments')?.examples.includes(fish.id) === true, get('unusual-stock-adjustments')?.status)
    check('three wastes with nothing sold → unusual-wastage WARNING for fish only', get('unusual-wastage')?.status === 'WARNING' && get('unusual-wastage')?.examples.includes(fish.id) === true && !get('unusual-wastage')?.examples.includes(lettuce.id), JSON.stringify(get('unusual-wastage')?.examples))
    check('a 600.00 shortfall → unusual-cash-variance WARNING, naming the session', get('unusual-cash-variance')?.status === 'WARNING' && get('unusual-cash-variance')?.examples.includes(session.id) === true, get('unusual-cash-variance')?.status)
    check('twelve voids by one person → void-concentration WARNING', get('void-concentration')?.status === 'WARNING' && (get('void-concentration')?.count ?? 0) === 12, `${get('void-concentration')?.status}/${get('void-concentration')?.count}`)
    check('pattern checks warn — never ERROR', NEW_KEYS.every((key) => get(key)?.status !== 'ERROR'))
    check('the links go somewhere sensible',
      issueExampleHref('unusual-cash-variance', session.id) === `/dashboard/cash-drawer/${session.id}` &&
        issueExampleHref('unusual-cancellations', cancelled.id) === `/dashboard/orders/${cancelled.id}` &&
        issueExampleHref('unusual-wastage', fish.id) === `/dashboard/inventory/${fish.id}` &&
        issueExampleHref('void-concentration', 'x') === '/dashboard/audit-logs' &&
        issueExampleHref('after-hours-activity', 'x') === '/dashboard/reports/sales')
  }

  console.log('\n── 11. After hours, only once hours exist ──')
  {
    const allDays = Object.fromEntries(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].map((d) => [d, { open: '09:00', close: '17:00' }]))
    await prisma.restaurant.update({ where: { id: restaurant.id }, data: { openingHours: allDays } })
    // Colombo is UTC+5:30. 18:00Z yesterday = 23:30 local (well after close); 12:00Z = 17:30 local (inside the hour of grace).
    const base = new Date(); base.setUTCDate(base.getUTCDate() - 1)
    const late = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), 18, 0, 0))
    const grace = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), 12, 0, 0))
    const paidAt = async (at: Date, number: string) => {
      const order = await prisma.order.create({
        data: {
          restaurantId: restaurant.id, branchId: branch.id, orderNumber: `${number}-${stamp}`, type: 'TAKEAWAY',
          status: 'COMPLETED', paymentStatus: 'PAID', customerName: 'Guest', customerPhone: '07',
          subtotal: 1_000, grandTotal: 1_000, paidTotal: 1_000, placedAt: at,
          items: { create: [{ name: 'Tea', quantity: 1, unitPrice: 1_000, lineTotal: 1_000 }] },
          payments: { create: [{ restaurantId: restaurant.id, amount: 1_000, method: 'CASH', status: 'PAID', paidAt: at, receivedById: cashier.id }] },
        },
        include: { payments: true },
      })
      return order.payments[0].id
    }
    const latePayment = await paidAt(late, 'LATE')
    const gracePayment = await paidAt(grace, 'GRACE')
    const report = await runIntegrityChecks(restaurant.id)
    const hours = report.checks.find((c) => c.key === 'after-hours-activity')
    // The earlier fixture payments are stamped "now", which may itself be after
    // hours depending on when this suite runs — so the assertion names rows.
    check('a 23:30 payment against 09:00–17:00 hours is flagged; 17:30 is inside the grace hour',
      hours?.status === 'WARNING' && hours.examples.includes(latePayment) && !hours.examples.includes(gracePayment),
      `${hours?.status}/${hours?.count}`)
  }

  console.log('\n── 12. Waste: one number everywhere, and by category ──')
  {
    const [report, hub] = await Promise.all([
      getWastageReport({ restaurantId: restaurant.id, range: today, branchIds: [branch.id] }),
      getAccountingHub({ restaurantId: restaurant.id, range: today, branchIds: [branch.id] }),
    ])
    check('the waste page total IS the hub’s waste figure for the same window and branch', report.totalValue === hub.inventory.wasteValue && report.totalValue > 0, `${report.totalValue} vs ${hub.inventory.wasteValue}`)
    const names = report.byCategory.map((c) => c.name).sort()
    check('by category: the managed category, the legacy text, and Uncategorised', names.join(',') === 'Proteins,Uncategorised,Veg', names.join(','))
    const sumCat = report.byCategory.reduce((s, c) => s + c.value, 0)
    const sumReason = report.byReason.reduce((s, r) => s + r.value, 0)
    check('categories and reasons both sum to the total', sumCat === report.totalValue && sumReason === report.totalValue)
    check('an empty allow-list sees nothing', (await getWastageReport({ restaurantId: restaurant.id, range: today, branchIds: [] })).totalValue === 0)
    check('the old rolling-period signature still works', (await getWastageReport({ restaurantId: restaurant.id, period: 'WEEK', branchId: branch.id })).totalValue === report.totalValue)

    // Move the oil record to 01:00 yesterday, restaurant time: the range decides, not the server's midnight.
    await prisma.wastageRecord.update({ where: { id: oilWaste.id }, data: { createdAt: new Date(yesterday.from.getTime() + 3_600_000) } })
    const [todayAfter, yesterdayReport] = await Promise.all([
      getWastageReport({ restaurantId: restaurant.id, range: today, branchIds: [branch.id] }),
      getWastageReport({ restaurantId: restaurant.id, range: yesterday, branchIds: [branch.id] }),
    ])
    check('a record at 01:00 yesterday (restaurant time) belongs to yesterday', yesterdayReport.totalValue === oilWaste.costValue && todayAfter.totalValue === report.totalValue - oilWaste.costValue, `${yesterdayReport.totalValue}/${todayAfter.totalValue}`)

    const waste = await getWasteIntelligence({ restaurantId: restaurant.id, range: today, branchIds: [branch.id] })
    check('waste intelligence passes the report through and names the biggest loss', waste.report.totalValue === todayAfter.totalValue && waste.biggest?.itemId === fish.id && waste.cogs === 150_000, JSON.stringify({ biggest: waste.biggest?.name, cogs: waste.cogs }))
  }

  console.log('\n── 13. The Command Center: the numbers are the engines’ numbers ──')
  {
    const query = { preset: 'TODAY', from: '', to: '', branch: null }
    const data = await getCommandCenter({
      restaurantId: restaurant.id, range: today, branchIds: null, branchId: null, timeZone,
      targetFoodCostBps: 3000, money, query,
    })
    const [hub, summary] = await Promise.all([
      getAccountingHub({ restaurantId: restaurant.id, range: today, branchIds: null }),
      getInventorySummary({ restaurantId: restaurant.id, branchId: null }),
    ])
    const raw = buildExplanations(hub, money)
    check('sales / net revenue / COGS / gross profit are the hub’s', data.hub.sales.grossSales === hub.sales.grossSales && data.hub.sales.netSales === hub.sales.netSales && data.hub.profit.cogs === hub.profit.cogs && data.hub.profit.grossProfit === hub.profit.grossProfit)
    check('the new explanations exist and their values are the hub’s',
      data.explanations.grossSales.value === hub.sales.grossSales &&
        data.explanations.cashCollected.value === (hub.collections.byMethod.find((m) => m.method === 'CASH')?.amount ?? 0) &&
        data.explanations.waste.value === hub.inventory.wasteValue &&
        raw.cashCollected.value === data.explanations.cashCollected.value)
    check('low stock is the inventory summary’s low + out', data.lowStock.value === summary.lowStock + summary.outOfStock && data.lowStock.valueKind === 'count')
    const allHrefs = [...Object.values(data.explanations), data.lowStock].flatMap((e) => [...e.sources.map((s) => s.href), ...e.lines.map((l) => l.href).filter((h): h is string => Boolean(h))])
    check('every drill-down link carries the period', allHrefs.length > 0 && allHrefs.every((href) => href.includes('preset=TODAY')), allHrefs.find((h) => !h.includes('preset=TODAY')))
    const traceKeys: string[] = []
    const walk = (nodes: TraceNode[]) => nodes.forEach((n) => { traceKeys.push(n.key); if (n.children) walk(n.children) })
    walk(MONEY_TRACE)
    check('every node of the money trace is an explanation that exists', traceKeys.every((key) => key === 'lowStock' || key in data.explanations), traceKeys.join(','))
    check('the seeded anomalies are on the list, nothing else invented', data.anomalies.some((a) => a.key === 'unusual-cancellations') && data.anomalies.every((a) => a.key.startsWith('identity:') || (ANOMALY_KEYS as readonly string[]).includes(a.key)))
    check('the health score is a number with six components', data.health.score !== null && data.health.components.length === 6, `${data.health.score}`)
    // 150,000 of chicken over 940,000 of revenue (chicken 900,000 + rice 40,000) = 15.96% → 16.0
    check('food cost is the profit report’s (150,000 / 940,000 ≈ 16%) against the 30% target', data.foodCostPercent === 16 && data.targetFoodCostPercent === 30, `${data.foodCostPercent}`)
  }

  console.log('\n── 14. Reads only ──')
  {
    const counts = async () => ({
      orders: await prisma.order.count({ where: { restaurantId: restaurant.id } }),
      items: await prisma.orderItem.count({ where: { order: { restaurantId: restaurant.id } } }),
      payments: await prisma.payment.count({ where: { restaurantId: restaurant.id } }),
      refunds: await prisma.refund.count({ where: { restaurantId: restaurant.id } }),
      movements: await prisma.stockMovement.count({ where: { restaurantId: restaurant.id } }),
      waste: await prisma.wastageRecord.count({ where: { restaurantId: restaurant.id } }),
      drawers: await prisma.cashDrawerSession.count({ where: { restaurantId: restaurant.id } }),
      approvals: await prisma.approvalRequest.count({ where: { restaurantId: restaurant.id } }),
      notifications: await prisma.notification.count({ where: { restaurantId: restaurant.id } }),
      audit: await prisma.auditLog.count({ where: { restaurantId: restaurant.id } }),
    })
    const before = await counts()
    const query = { preset: 'TODAY', from: '', to: '', branch: null }
    await Promise.all([
      getCommandCenter({ restaurantId: restaurant.id, range: today, branchIds: null, branchId: null, timeZone, targetFoodCostBps: 3000, money, query }),
      getMenuIntelligence({ restaurantId: restaurant.id, range: today, branchIds: null, timeZone }),
      getSmartInventory({ restaurantId: restaurant.id, branchId: null, timeZone }),
      getWasteIntelligence({ restaurantId: restaurant.id, range: today, branchIds: null }),
      runIntegrityChecks(restaurant.id),
    ])
    const after = await counts()
    check('every insights read leaves every table exactly as it was', JSON.stringify(before) === JSON.stringify(after), `${JSON.stringify(before)} → ${JSON.stringify(after)}`)
  }

  console.log('\n── 15. Another tenant’s records never appear ──')
  {
    const otherRestaurant = await prisma.restaurant.create({
      data: { name: `Other ${stamp}`, slug: `other-${stamp}`, status: 'ACTIVE', isActive: true, currency: 'LKR' },
    })
    const otherBranch = await prisma.branch.create({ data: { restaurantId: otherRestaurant.id, name: 'Main', code: 'MAIN', isDefault: true } })
    const foreign = await prisma.order.create({
      data: {
        restaurantId: otherRestaurant.id, branchId: otherBranch.id, orderNumber: `F-${stamp}`, type: 'TAKEAWAY',
        status: 'CANCELLED', cancelledAt: new Date(), paymentStatus: 'PAID', customerName: 'Guest', customerPhone: '07',
        subtotal: 5_000, grandTotal: 5_000, paidTotal: 5_000,
        items: { create: [{ name: 'Ghost', quantity: 1, unitPrice: 5_000, lineTotal: 5_000 }] },
        payments: { create: [{ restaurantId: otherRestaurant.id, amount: 5_000, method: 'CASH', status: 'PAID', paidAt: new Date() }] },
      },
    })
    const report = await runIntegrityChecks(restaurant.id)
    check('the other tenant’s cancelled bill is not among our examples', !JSON.stringify(report).includes(foreign.id))
    await prisma.restaurant.delete({ where: { id: otherRestaurant.id } })
  }

  await teardown(restaurant.id)
  await prisma.$disconnect()

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch(async (error) => {
  console.error(error)
  await prisma.$disconnect()
  process.exit(1)
})
