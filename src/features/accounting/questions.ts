import type { NumbersAnswer } from './components/ask-the-numbers'
import { buildExplanations, compareMetric } from './explain'
import type { AccountingHub } from './hub'
import type { IntegrityReport } from './integrity'

/**
 * The question catalogue behind "Ask the numbers" (acCal.md §18). Every
 * answer is assembled HERE, on the server, from figures the engines already
 * produced — the client only picks which one to show. Adding a question
 * means adding real data for it; there is no path to a made-up answer.
 */
export function buildNumbersAnswers(params: {
  hub: AccountingHub
  prevHub: AccountingHub
  integrity: IntegrityReport
  money: (minor: number) => string
  comparisonLabel: string
}): NumbersAnswer[] {
  const { hub, prevHub, integrity, money, comparisonLabel } = params
  const explanations = buildExplanations(hub, money)
  const pct = (value: number | null) => (value === null ? '—' : `${value}%`)

  const answers: NumbersAnswer[] = []

  answers.push({
    id: 'net-sales',
    question: 'Why is net sales this number?',
    keywords: ['revenue', 'sales', 'earned', 'net'],
    answer: explanations.netSales.sentence,
    table: explanations.netSales.lines.map((line) => ({
      label: `${line.op === '−' ? '− ' : line.op === '=' ? '= ' : ''}${line.label}`,
      value: money(line.amount),
    })),
    sources: explanations.netSales.sources,
  })

  const salesShift = compareMetric('netSales', 'Net sales', hub.sales.netSales, prevHub.sales.netSales, money, comparisonLabel)
  answers.push({
    id: 'sales-change',
    question: 'Why did sales change?',
    keywords: ['sales', 'drop', 'decrease', 'increase', 'change', 'less', 'more'],
    answer: salesShift.sentence,
    table: [
      { label: 'Everything sold', value: `${money(prevHub.sales.grossSales)} → ${money(hub.sales.grossSales)}` },
      { label: 'Discounts given', value: `${money(prevHub.sales.discounts)} → ${money(hub.sales.discounts)}` },
      { label: 'Refunds', value: `${money(prevHub.sales.refunds)} → ${money(hub.sales.refunds)}` },
    ],
    sources: explanations.netSales.sources,
  })

  const profitShift = compareMetric('grossProfit', 'Gross profit', hub.profit.grossProfit, prevHub.profit.grossProfit, money, comparisonLabel)
  answers.push({
    id: 'profit-change',
    question: 'Why did profit change?',
    keywords: ['profit', 'decrease', 'drop', 'margin', 'less', 'gross'],
    answer: `${profitShift.sentence} Profit moves when revenue moves, when ingredient cost moves, or both — the split is below.`,
    table: [
      { label: 'Revenue', value: `${money(prevHub.profit.revenue)} → ${money(hub.profit.revenue)}` },
      { label: 'Ingredient cost (COGS)', value: `${money(prevHub.profit.cogs)} → ${money(hub.profit.cogs)}` },
      { label: 'Gross profit', value: `${money(prevHub.profit.grossProfit)} → ${money(hub.profit.grossProfit)}` },
    ],
    sources: explanations.grossProfit.sources,
  })

  const fcNow = hub.profit.revenue > 0 ? Math.round((hub.profit.cogs / hub.profit.revenue) * 1000) / 10 : null
  const fcThen = prevHub.profit.revenue > 0 ? Math.round((prevHub.profit.cogs / prevHub.profit.revenue) * 1000) / 10 : null
  answers.push({
    id: 'food-cost-change',
    question: 'Why did food cost change?',
    keywords: ['food', 'cost', 'ingredients', 'cogs', 'percentage'],
    answer:
      fcNow === null
        ? 'There is no revenue in this period, so no food cost percentage to compare.'
        : `Food cost is ${pct(fcNow)} of sales now${fcThen !== null ? `, against ${pct(fcThen)} ${comparisonLabel}` : ''}. It rises when ingredient prices climb, recipes drift, or discounting sells the same food for less.`,
    table: [
      { label: 'Ingredient cost (COGS)', value: `${money(prevHub.profit.cogs)} → ${money(hub.profit.cogs)}` },
      { label: 'Revenue', value: `${money(prevHub.profit.revenue)} → ${money(hub.profit.revenue)}` },
      { label: 'Food cost', value: `${pct(fcThen)} → ${pct(fcNow)}` },
    ],
    sources: explanations.foodCostPercent.sources,
  })

  answers.push({
    id: 'lowest-margin',
    question: 'Which items have the lowest margin?',
    keywords: ['margin', 'lowest', 'worst', 'items', 'menu', 'thin'],
    answer:
      hub.profit.lowMarginItems.length > 0
        ? 'These items keep the least of every rupee they bring in (at least 5 sold in the period):'
        : 'Not enough sales in this period to rank item margins (an item needs at least 5 sold).',
    table: hub.profit.lowMarginItems.map((row) => ({
      label: row.label,
      value: `${row.marginPercent === null ? '—' : `${row.marginPercent}%`} margin · ${money(row.grossProfit)} profit`,
    })),
    sources: [{ label: 'Gross profit report', href: '/dashboard/reports/profit' }],
  })

  answers.push({
    id: 'most-profitable',
    question: 'Which items make the most profit?',
    keywords: ['profitable', 'best', 'top', 'items', 'menu', 'earners'],
    answer:
      hub.profit.topItems.length > 0
        ? 'The biggest earners this period (at least 5 sold):'
        : 'Not enough sales in this period to rank items (an item needs at least 5 sold).',
    table: hub.profit.topItems.map((row) => ({
      label: row.label,
      value: `${money(row.grossProfit)} profit · ${row.marginPercent === null ? '—' : `${row.marginPercent}%`} margin`,
    })),
    sources: [{ label: 'Gross profit report', href: '/dashboard/reports/profit' }],
  })

  const cashIn = hub.collections.byMethod.find((row) => row.method === 'CASH')?.amount ?? 0
  answers.push({
    id: 'where-cash',
    question: 'Where did the cash go?',
    keywords: ['cash', 'drawer', 'missing', 'where', 'physical'],
    answer: `${money(cashIn)} was taken in cash this period. Drawers closed: ${hub.cash.drawersClosed}, with a counted difference of ${money(hub.cash.drawerVariance)}. ${explanations.cashDifference.sentence}`,
    sources: explanations.cashDifference.sources,
  })

  answers.push({
    id: 'who-we-owe',
    question: 'Who do we owe?',
    keywords: ['owe', 'suppliers', 'payables', 'debt', 'outstanding'],
    answer: explanations.payables.sentence,
    sources: explanations.payables.sources,
  })

  answers.push({
    id: 'unpaid-customers',
    question: 'What is still unpaid by customers?',
    keywords: ['unpaid', 'receivables', 'outstanding', 'customers', 'bills', 'owed'],
    answer: explanations.receivables.sentence,
    sources: explanations.receivables.sources,
  })

  const unusual = integrity.checks.find((check) => check.key === 'unusual-discounts')
  if (unusual) {
    answers.push({
      id: 'unusual-discounts',
      question: 'Show unusual discounts.',
      keywords: ['discount', 'unusual', 'suspicious', 'big', 'staff'],
      answer:
        unusual.status === 'OK'
          ? 'No order in the last 30 days carries a discount far outside your normal pattern.'
          : `${unusual.count} order(s) carry discounts far above your normal pattern. ${unusual.detail}`,
      sources: [{ label: 'Issues', href: '/dashboard/accounting/reconciliation' }],
    })
  }

  answers.push({
    id: 'spend-categories',
    question: 'What did we spend on?',
    keywords: ['spend', 'expenses', 'costs', 'categories', 'rent', 'utilities'],
    answer: explanations.expensesPaid.sentence,
    table: hub.expenses.byCategory.slice(0, 8).map((row) => ({ label: row.category, value: money(row.amount) })),
    sources: explanations.expensesPaid.sources,
  })

  return answers
}
