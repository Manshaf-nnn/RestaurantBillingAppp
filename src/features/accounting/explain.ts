import type { InventorySummary } from '@/features/inventory/alerts'
import type { AccountingHub } from './hub'

/**
 * "Why is this number?" (acCal.md §3, §18) — ONE explanation builder feeding
 * three surfaces: the [Explain] popover on every hub card, the variance
 * sentences, and the Ask-the-numbers answers.
 *
 * The rule that keeps this honest: builders NEVER query and NEVER compute a
 * new financial figure — they arrange numbers the hub already produced from
 * the authoritative engines. An explanation can therefore never disagree
 * with the card it explains, and `explain-test` proves each one's lines sum
 * to its value.
 *
 * Client-safe: types and pure functions only.
 */

export interface ExplanationLine {
  label: string
  amount: number
  /** How this line joins the story: start value, added, subtracted, result. */
  op: 'start' | '+' | '−' | '='
  href?: string
}

export interface Explanation {
  key: string
  title: string
  value: number
  valueKind: 'money' | 'percent' | 'count'
  /** The formula, with the real numbers. Empty when the value IS the story. */
  lines: ExplanationLine[]
  /** One plain-language sentence. */
  sentence: string
  sources: Array<{ label: string; href: string }>
}

export type MetricKey =
  | 'netSales'
  | 'collected'
  | 'receivables'
  | 'grossProfit'
  | 'foodCostPercent'
  | 'cogs'
  | 'payables'
  | 'expensesPaid'
  | 'inventoryValue'
  | 'cashDifference'
  | 'grossSales'
  | 'cashCollected'
  | 'waste'

const SALES_REPORT = { label: 'Sales report', href: '/dashboard/reports/sales' }
const PROFIT_REPORT = { label: 'Gross profit report', href: '/dashboard/reports/profit' }
const INVOICES = { label: 'Invoices', href: '/dashboard/invoices' }
const ORDERS = { label: 'Orders', href: '/dashboard/orders' }
const PAYABLES = { label: 'Supplier payables', href: '/dashboard/accounting/payables' }
const EXPENSES = { label: 'Expenses', href: '/dashboard/accounting/expenses' }
const DRAWERS = { label: 'Cash drawer report', href: '/dashboard/reports/cash-drawer' }
const RECONCILIATION = { label: 'Stock reconciliation', href: '/dashboard/reports/reconciliation' }
const LEDGER = { label: 'Stock ledger', href: '/dashboard/inventory/ledger' }
const RECIPES = { label: 'Recipes', href: '/dashboard/recipes' }
const WASTAGE_BOARD = { label: 'Wastage board', href: '/dashboard/inventory/wastage' }
const INVENTORY_REPORT = { label: 'Inventory report', href: '/dashboard/reports/inventory' }
const INVENTORY = { label: 'Inventory', href: '/dashboard/inventory' }

export function buildExplanations(hub: AccountingHub, money: (minor: number) => string): Record<MetricKey, Explanation> {
  const { sales, collections, profit, purchasing, expenses, inventory, cash } = hub

  // The cash figure the Command Center shows: what guests handed over in
  // cash, before refunds — one of three "cash" definitions in the product,
  // named as such (the drawer report shows expected vs counted, the Collected
  // card shows every method net of refunds).
  const cashTaken = collections.byMethod.find((row) => row.method === 'CASH')?.amount ?? 0

  return {
    grossSales: {
      key: 'grossSales',
      title: 'Sales',
      value: sales.grossSales,
      valueKind: 'money',
      lines: [],
      sentence: `Everything sold in this period came to ${money(sales.grossSales)} at menu prices, before ${money(sales.discounts)} of discounts and ${money(sales.refunds)} of refunds. Cancelled bills are not in it.`,
      sources: [SALES_REPORT, ORDERS],
    },
    netSales: {
      key: 'netSales',
      title: 'Net sales',
      value: sales.netSales,
      valueKind: 'money',
      lines: [
        { label: 'Everything sold', amount: sales.grossSales, op: 'start', href: SALES_REPORT.href },
        { label: 'Discounts given', amount: sales.discounts, op: '−' },
        { label: 'Refunds', amount: sales.refunds, op: '−' },
        { label: 'Net sales', amount: sales.netSales, op: '=' },
      ],
      sentence: `You sold ${money(sales.grossSales)} worth, gave ${money(sales.discounts)} in discounts and returned ${money(sales.refunds)} — what you actually earned from food and drink is ${money(sales.netSales)}. Tax and service charge sit on top, never inside.`,
      sources: [SALES_REPORT, INVOICES],
    },
    collected: {
      key: 'collected',
      title: 'Collected',
      value: collections.collected,
      valueKind: 'money',
      lines: [
        ...collections.byMethod.map((row, index) => ({
          label: row.label,
          amount: row.amount,
          op: index === 0 ? ('start' as const) : ('+' as const),
        })),
        { label: 'Refunded back', amount: collections.refunded, op: '−' },
        { label: 'Collected', amount: collections.collected, op: '=' },
      ],
      sentence: `${money(collections.collected)} actually arrived after refunds. Money collected is not the same as sales — a bill from yesterday can be paid today.`,
      sources: [SALES_REPORT, DRAWERS],
    },
    receivables: {
      key: 'receivables',
      title: 'Receivables',
      value: collections.outstanding,
      valueKind: 'money',
      lines: [],
      sentence:
        collections.outstanding > 0
          ? `Guests were billed ${money(collections.outstanding)} more than they have paid so far. Each open bill is listed under Invoices.`
          : 'Every bill in this period has been settled in full.',
      sources: [INVOICES],
    },
    cogs: {
      key: 'cogs',
      title: 'COGS',
      value: profit.cogs,
      valueKind: 'money',
      lines: [],
      sentence: `The ingredients inside everything sold cost ${money(profit.cogs)}, priced at the recipe cost pinned when each item was sold. Buying stock is not a cost until the food is sold.`,
      sources: [PROFIT_REPORT, LEDGER, RECIPES, RECONCILIATION],
    },
    grossProfit: {
      key: 'grossProfit',
      title: 'Gross profit',
      value: profit.grossProfit,
      valueKind: 'money',
      lines: [
        { label: 'Revenue (net of discounts and refunds)', amount: profit.revenue, op: 'start', href: PROFIT_REPORT.href },
        { label: 'Ingredient cost (COGS)', amount: profit.cogs, op: '−' },
        { label: 'Gross profit', amount: profit.grossProfit, op: '=' },
      ],
      sentence: `Sales of ${money(profit.revenue)} minus ${money(profit.cogs)} of ingredients leaves ${money(profit.grossProfit)}${profit.grossMarginPercent !== null ? ` — a ${profit.grossMarginPercent}% margin` : ''}. Rent, wages and other expenses still come out of this.`,
      sources: [PROFIT_REPORT],
    },
    foodCostPercent: {
      key: 'foodCostPercent',
      title: 'Food cost',
      value: profit.revenue > 0 ? Math.round((profit.cogs / profit.revenue) * 1000) / 10 : 0,
      valueKind: 'percent',
      lines: [
        { label: 'Ingredient cost (COGS)', amount: profit.cogs, op: 'start', href: PROFIT_REPORT.href },
        { label: 'Revenue it earned', amount: profit.revenue, op: '+' },
      ],
      sentence:
        profit.revenue > 0
          ? `Out of every 100 sold, ${(Math.round((profit.cogs / profit.revenue) * 1000) / 10).toFixed(1)} went on ingredients.`
          : 'No revenue in this period, so there is no food cost percentage to compute.',
      sources: [PROFIT_REPORT],
    },
    payables: {
      key: 'payables',
      title: 'Supplier payables',
      value: purchasing.payablesOutstanding,
      valueKind: 'money',
      lines: [],
      sentence: `Goods worth ${money(purchasing.payablesOutstanding)} have been received and not yet paid for. The statement shows who is owed and for how long.`,
      sources: [PAYABLES],
    },
    expensesPaid: {
      key: 'expensesPaid',
      title: 'Expenses paid',
      value: expenses.paid,
      valueKind: 'money',
      // Top categories plus one honest remainder — the lines must always sum
      // to the value, even with twenty categories.
      lines: (() => {
        const top = expenses.byCategory.slice(0, 6)
        const rest = expenses.paid - top.reduce((sum, row) => sum + row.amount, 0)
        const lines: ExplanationLine[] = top.map((row, index) => ({
          label: row.category,
          amount: row.amount,
          op: index === 0 ? ('start' as const) : ('+' as const),
        }))
        if (rest !== 0) lines.push({ label: 'Other categories', amount: rest, op: '+' })
        if (lines.length > 0) lines.push({ label: 'Expenses paid', amount: expenses.paid, op: '=' })
        return lines
      })(),
      sentence: `${money(expenses.paid)} of formal business costs were paid this period${expenses.pendingApproval > 0 ? `, with ${money(expenses.pendingApproval)} more waiting for approval` : ''}.`,
      sources: [EXPENSES],
    },
    inventoryValue: {
      key: 'inventoryValue',
      title: 'Stock on hand',
      value: inventory.stockValueNow,
      valueKind: 'money',
      lines: [],
      sentence: `The stock on the shelves right now cost ${money(inventory.stockValueNow)}. This is money already spent, waiting to become COGS when the food sells.`,
      sources: [RECONCILIATION],
    },
    cashDifference: {
      key: 'cashDifference',
      title: 'Cash difference',
      value: cash.drawerVariance,
      valueKind: 'money',
      lines: [],
      sentence:
        cash.drawerVariance === 0
          ? `Every counted drawer matched its records exactly (${cash.drawersClosed} closed this period).`
          : cash.drawerVariance < 0
            ? `Cash is short by ${money(Math.abs(cash.drawerVariance))} across ${cash.drawersClosed} closed drawer(s). Each shortfall names its session and needs a signed review.`
            : `Drawers counted ${money(cash.drawerVariance)} MORE than expected — an over is still a difference to explain.`,
      sources: [DRAWERS],
    },
    cashCollected: {
      key: 'cashCollected',
      title: 'Cash collected',
      value: cashTaken,
      valueKind: 'money',
      lines: [
        { label: 'Cash payments taken', amount: cashTaken, op: 'start', href: DRAWERS.href },
        { label: 'Cash collected', amount: cashTaken, op: '=' },
      ],
      sentence: `${money(cashTaken)} was handed over in cash this period; card and other methods are counted separately, and refunds are deducted on the Collected card, not here. ${cash.drawersClosed} drawer(s) closed with a counted difference of ${money(cash.drawerVariance)}.`,
      sources: [DRAWERS, SALES_REPORT],
    },
    waste: {
      key: 'waste',
      title: 'Waste',
      value: inventory.wasteValue,
      valueKind: 'money',
      lines: [],
      sentence: `Stock worth ${money(inventory.wasteValue)} was recorded as waste this period, valued at what it cost when it was thrown away${
        profit.cogs > 0
          ? ` — ${(Math.round((inventory.wasteValue / profit.cogs) * 1000) / 10).toFixed(1)}% of the ingredient cost of what was sold`
          : ''
      }. Waste is an expense on its own line; it never enters COGS.`,
      sources: [WASTAGE_BOARD, RECONCILIATION],
    },
  }
}

/**
 * Low stock is the one Command Center figure that is not on the hub: it is
 * live, not period-scoped, and it is judged per location by the inventory
 * summary. Same contract as every other explanation — the number is the
 * engine's, the words are ours.
 */
export function explainLowStock(summary: InventorySummary): Explanation {
  const total = summary.lowStock + summary.outOfStock
  return {
    key: 'lowStock',
    title: 'Low stock',
    value: total,
    valueKind: 'count',
    lines: [],
    sentence:
      total === 0
        ? `Every active item is above its reorder level right now (${summary.totalItems} items checked). This is live, not period-scoped.`
        : `${summary.lowStock} item(s) are at or below their reorder level and ${summary.outOfStock} are out of stock, out of ${summary.totalItems} active items — judged by the same rule as the inventory report: the higher of reorder level and minimum stock, with thresholds of zero ignored. This is live, not period-scoped.`,
    sources: [INVENTORY_REPORT, INVENTORY],
  }
}

/** "Why did X change?" — the same numbers, across two periods. */
export interface MetricComparison {
  key: MetricKey
  title: string
  current: number
  previous: number
  delta: number
  /** Percent change, null when the previous period was zero. */
  changePercent: number | null
  sentence: string
}

export function compareMetric(
  key: MetricKey,
  title: string,
  current: number,
  previous: number,
  money: (minor: number) => string,
  comparisonLabel: string,
): MetricComparison {
  const delta = current - previous
  const changePercent = previous !== 0 ? Math.round((delta / Math.abs(previous)) * 1000) / 10 : null
  const direction = delta === 0 ? 'is unchanged' : delta > 0 ? `is up ${money(Math.abs(delta))}` : `is down ${money(Math.abs(delta))}`
  return {
    key,
    title,
    current,
    previous,
    delta,
    changePercent,
    sentence: `${title} ${direction} vs ${comparisonLabel}${changePercent !== null ? ` (${changePercent > 0 ? '+' : ''}${changePercent}%)` : ''}: ${money(previous)} then, ${money(current)} now.`,
  }
}
