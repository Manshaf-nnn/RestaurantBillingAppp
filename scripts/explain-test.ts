/**
 * The explain layer, proven (acCal.md §3, §18).
 *
 * The contract that keeps "Why is this number?" honest: every explanation's
 * lines fold to exactly its value, and the values come from the same hub the
 * cards render — so a popover can never disagree with its card, and the
 * card's number is the engine's number.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/explain-test.ts
 */
import { buildExplanations, compareMetric, type Explanation } from '../src/features/accounting/explain'
import { getAccountingHub } from '../src/features/accounting/hub'
import { runIntegrityChecks } from '../src/features/accounting/integrity'
import { buildNumbersAnswers } from '../src/features/accounting/questions'
import { getSalesReport } from '../src/features/reports/sales'
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

/** Fold the formula lines the way a reader would; '=' rows must match. */
function foldsCorrectly(explanation: Explanation): { ok: boolean; detail: string } {
  let acc = 0
  for (const line of explanation.lines) {
    if (line.op === 'start') acc = line.amount
    else if (line.op === '+') acc += line.amount
    else if (line.op === '−') acc -= line.amount
    else if (line.op === '=') {
      if (acc !== line.amount) return { ok: false, detail: `folded ${acc}, line says ${line.amount}` }
    }
  }
  const closing = explanation.lines.filter((line) => line.op === '=').at(-1)
  if (closing && explanation.valueKind === 'money' && closing.amount !== explanation.value) {
    return { ok: false, detail: `closing line ${closing.amount} ≠ value ${explanation.value}` }
  }
  return { ok: true, detail: '' }
}

async function main() {
  const stamp = Date.now().toString(36)
  const restaurant = await prisma.restaurant.create({
    data: {
      name: `Explain ${stamp}`, slug: `explain-${stamp}`, status: 'ACTIVE', isActive: true,
      currency: 'LKR', taxRateBps: 0, serviceChargeBps: 0, taxInclusive: false,
      timezone: 'Asia/Colombo',
    },
  })
  const branch = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Main', code: 'MAIN', isDefault: true },
  })
  const money = (minor: number) => formatMoney(minor, 'LKR')
  const now = new Date()

  // Two settled orders — one discounted — and eight paid expense categories,
  // enough to exercise every formula including the "Other categories" fold.
  await prisma.order.create({
    data: {
      restaurantId: restaurant.id, branchId: branch.id, orderNumber: `${stamp}-1`,
      status: 'COMPLETED', paymentStatus: 'PAID', customerName: 'Walk-in', customerPhone: '0770000000',
      subtotal: 100_000, discountTotal: 10_000, manualDiscount: 10_000,
      taxTotal: 9_000, serviceCharge: 4_500, tipAmount: 2_000,
      grandTotal: 103_500, paidTotal: 105_500, placedAt: now,
      payments: { create: { restaurantId: restaurant.id, amount: 105_500, method: 'CASH', status: 'PAID', paidAt: now } },
    },
  })
  await prisma.order.create({
    data: {
      restaurantId: restaurant.id, branchId: branch.id, orderNumber: `${stamp}-2`,
      status: 'COMPLETED', paymentStatus: 'PAID', customerName: 'Walk-in', customerPhone: '0770000000',
      subtotal: 40_000, taxTotal: 0, serviceCharge: 0,
      grandTotal: 40_000, paidTotal: 40_000, placedAt: now,
      payments: { create: { restaurantId: restaurant.id, amount: 40_000, method: 'CARD', status: 'PAID', paidAt: now } },
    },
  })
  for (let index = 0; index < 8; index += 1) {
    const category = await prisma.expenseCategory.create({
      data: { restaurantId: restaurant.id, name: `Category ${index} ${stamp}` },
    })
    await prisma.outgoingPayment.create({
      data: {
        restaurantId: restaurant.id, branchId: branch.id, number: `OP-TEST-${stamp}-${index}`,
        kind: 'EXPENSE', status: 'PAID', expenseCategoryId: category.id,
        amount: 1_000 * (index + 1), method: 'BANK_TRANSFER',
        description: `Expense ${index}`, paymentDate: now, createdByName: 'Seeder',
      },
    })
  }

  const range = resolveRange({ preset: 'TODAY', timeZone: restaurant.timezone })
  const [hub, sales, integrity] = await Promise.all([
    getAccountingHub({ restaurantId: restaurant.id, range }),
    getSalesReport({ restaurantId: restaurant.id, range }),
    runIntegrityChecks(restaurant.id),
  ])
  const explanations = buildExplanations(hub, money)

  console.log('\n── Every formula folds to its own value ──')
  for (const explanation of Object.values(explanations)) {
    const fold = foldsCorrectly(explanation)
    check(`${explanation.key} lines fold cleanly`, fold.ok, fold.detail)
    check(`${explanation.key} has a sentence and at least one source`,
      explanation.sentence.length > 10 && explanation.sources.length > 0)
  }

  console.log('\n── The explained numbers ARE the engine numbers ──')
  check('net sales explanation = the sales report, to the rupee',
    explanations.netSales.value === sales.totals.netSales &&
      sales.totals.netSales === 130_000,
    `${explanations.netSales.value} vs ${sales.totals.netSales}`)
  check('collected explanation folds method totals minus refunds',
    explanations.collected.value === hub.collections.collected)
  check('expenses fold includes the Other-categories remainder (8 categories, 6 shown)',
    explanations.expensesPaid.lines.some((line) => line.label === 'Other categories') &&
      explanations.expensesPaid.value === 36_000)

  console.log('\n── Comparisons say what moved, without inventing anything ──')
  {
    const up = compareMetric('netSales', 'Net sales', 200, 100, money, 'vs yesterday')
    check('doubling reads as +100%', up.delta === 100 && up.changePercent === 100)
    const fromZero = compareMetric('netSales', 'Net sales', 500, 0, money, 'vs yesterday')
    check('growth from zero has no percentage — null, never Infinity', fromZero.changePercent === null)
    const flat = compareMetric('cogs', 'COGS', 300, 300, money, 'vs yesterday')
    check('no change reads as unchanged', flat.delta === 0 && flat.sentence.includes('unchanged'))
  }

  console.log('\n── The question catalogue ──')
  {
    const answers = buildNumbersAnswers({ hub, prevHub: hub, integrity, money, comparisonLabel: 'vs yesterday' })
    check('at least ten questions are answerable', answers.length >= 10, `${answers.length}`)
    check('every answer names a source', answers.every((entry) => entry.sources.length > 0))
    check('question ids are unique', new Set(answers.map((entry) => entry.id)).size === answers.length)
    check('answers carry real formatted figures, not placeholders',
      answers.every((entry) => !entry.answer.includes('undefined') && !entry.answer.includes('NaN')))
  }

  await prisma.restaurant.delete({ where: { id: restaurant.id } })
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
