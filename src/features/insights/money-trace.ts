import type { Explanation, MetricKey } from '@/features/accounting/explain'

/**
 * Money Trace (smart.md §3): Profit → Revenue / COGS → Orders / Inventory →
 * Payments / Purchases / Recipes.
 *
 * There is nothing to compute. Every node of the trace is an `Explanation`
 * the hub already produced — title, value, the formula with real numbers, and
 * the screens where the rows live. This module only says which explanation
 * hangs under which, and carries the period on every link so a click lands
 * on the same days the card was showing.
 */

export type TraceKey = MetricKey | 'lowStock'

export interface TraceNode {
  key: TraceKey
  /** A one-line reading aid for the branch, shown beside the title. */
  note?: string
  children?: TraceNode[]
}

export const MONEY_TRACE: TraceNode[] = [
  {
    key: 'grossProfit',
    note: 'revenue minus the ingredients inside it',
    children: [
      {
        key: 'netSales',
        note: 'everything sold, less discounts and refunds',
        children: [{ key: 'grossSales', note: 'the bills themselves' }],
      },
      { key: 'cogs', note: 'stock that left the kitchen, at the cost pinned when it sold' },
    ],
  },
  {
    key: 'collected',
    note: 'money that actually arrived — not the same as sales',
    children: [
      { key: 'cashCollected', note: 'the cash part, before refunds' },
      { key: 'receivables', note: 'billed in this period, still unpaid' },
    ],
  },
  {
    key: 'inventoryValue',
    note: 'money already spent, sitting on the shelves',
    children: [
      { key: 'waste', note: 'thrown away — an expense, never COGS' },
      { key: 'payables', note: 'goods received, suppliers not yet paid' },
    ],
  },
]

export interface PeriodQuery {
  preset: string
  from: string
  to: string
  branch: string | null
}

/** `preset=LAST_30&from=…&to=…&branch=…`, skipping whatever is empty. */
export function periodQueryString(query: PeriodQuery): string {
  const params = new URLSearchParams()
  if (query.preset) params.set('preset', query.preset)
  if (query.from) params.set('from', query.from)
  if (query.to) params.set('to', query.to)
  if (query.branch) params.set('branch', query.branch)
  return params.toString()
}

export function withPeriod(href: string, query: PeriodQuery): string {
  const qs = periodQueryString(query)
  if (!qs) return href
  return `${href}${href.includes('?') ? '&' : '?'}${qs}`
}

/** The same explanation, every link carrying the period. Amounts untouched. */
export function carryPeriod(explanation: Explanation, query: PeriodQuery): Explanation {
  return {
    ...explanation,
    lines: explanation.lines.map((line) => (line.href ? { ...line, href: withPeriod(line.href, query) } : line)),
    sources: explanation.sources.map((source) => ({ ...source, href: withPeriod(source.href, query) })),
  }
}

/**
 * The integrity checks that are anomaly detectors (smart.md §7) — the ones
 * the Command Center surfaces as "needs review". The arithmetic checks stay on
 * the reconciliation screen where an accountant reads them.
 */
export const ANOMALY_KEYS = [
  'duplicate-payments',
  'unusual-discounts',
  'unusual-refunds',
  'backdated-transactions',
  'unusual-cancellations',
  'void-concentration',
  'unusual-stock-adjustments',
  'unusual-wastage',
  'unusual-cash-variance',
  'after-hours-activity',
  'negative-stock',
  'cogs-uncosted-sale',
  'cogs-above-revenue',
] as const

export type AnomalyKey = (typeof ANOMALY_KEYS)[number]

export function isAnomalyKey(key: string): key is AnomalyKey {
  return (ANOMALY_KEYS as readonly string[]).includes(key)
}
