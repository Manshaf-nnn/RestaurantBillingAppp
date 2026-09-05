import type { IntegrityStatus } from '@/features/accounting/integrity'

/**
 * Restaurant Health Score (smart.md §8): one number from 0 to 100, built from
 * six signals the engines already produce — sales, profitability, food cost,
 * waste, inventory and reconciliation — and the three issues most worth an
 * owner's attention.
 *
 * Every band is written down here and shown on the card ("How this is
 * scored"), so the score is an arithmetic fact about the records, not an
 * opinion. Nothing is read or written; the caller passes the engine figures
 * in. A signal with no data (no sales in either period, no stock items) is
 * left out and the weights renormalise over what remains, and the card says
 * "based on N of 6 signals" rather than inventing a neutral score.
 *
 * Gross margin and food-cost percentage are the same ratio seen from two
 * sides, so they are NOT both scored on level: profitability is the gross
 * profit TREND against the previous period, food cost is the LEVEL against
 * the owner's target.
 */

export type HealthComponentKey = 'sales' | 'profitability' | 'foodCost' | 'waste' | 'inventory' | 'reconciliation'

export const WEIGHTS: Record<HealthComponentKey, number> = {
  sales: 15,
  profitability: 15,
  foodCost: 20,
  waste: 15,
  inventory: 15,
  reconciliation: 20,
}

/** Used when the owner has not set a food-cost target: 35% (3500 bps). */
export const DEFAULT_TARGET_BPS = 3500

export interface HealthInput {
  /** Net sales, this period and the one before. */
  sales: { current: number; previous: number }
  /** Gross profit, this period and the one before, plus how much of it carries a recipe cost. */
  profit: { current: number; previous: number; revenue: number; coveragePercent: number }
  /** Food cost as a percentage of revenue (already rounded), and the owner's target in bps. */
  foodCost: { percent: number | null; targetBps: number | null }
  waste: { value: number; cogs: number }
  inventory: { totalItems: number; outOfStock: number; lowStock: number; negativeStockCount: number }
  reconciliationStatus: IntegrityStatus
  hrefs: Record<HealthComponentKey, string>
}

export interface HealthComponent {
  key: HealthComponentKey
  label: string
  weight: number
  /** 0–100, or null when there was no data to judge. */
  score: number | null
  detail: string
  href: string
}

export type HealthBand = 'HEALTHY' | 'ATTENTION' | 'AT_RISK'

export interface HealthScore {
  score: number | null
  band: HealthBand | null
  components: HealthComponent[]
  /** The three lowest-scoring signals, weighted — what to look at first. */
  issues: HealthComponent[]
  excluded: HealthComponentKey[]
  signalsUsed: number
}

const LABELS: Record<HealthComponentKey, string> = {
  sales: 'Sales trend',
  profitability: 'Profit trend',
  foodCost: 'Food cost',
  waste: 'Waste',
  inventory: 'Stock levels',
  reconciliation: 'Books balance',
}

function percentChange(current: number, previous: number): number | null {
  if (previous <= 0) return null
  return ((current - previous) / previous) * 100
}

/** Trend bands shared by sales and profit: ≥+5% → 100, flat → 80, soft → 55, falling → 25. */
function trendScore(current: number, previous: number): number | null {
  if (current === 0 && previous === 0) return null
  if (previous <= 0) return current > 0 ? 100 : 25
  const change = percentChange(current, previous) ?? 0
  if (change >= 5) return 100
  if (change >= -5) return 80
  if (change >= -15) return 55
  return 25
}

function describeTrend(current: number, previous: number, noun: string): string {
  if (current === 0 && previous === 0) return `No ${noun} in this period or the one before.`
  if (previous <= 0) return current > 0 ? `${noun} where there was none before.` : `${noun} fell to nothing.`
  const change = percentChange(current, previous) ?? 0
  const rounded = Math.round(Math.abs(change))
  if (Math.abs(change) < 0.5) return `${noun} unchanged on the previous period.`
  return `${noun} ${change > 0 ? 'up' : 'down'} ${rounded}% on the previous period.`
}

export function scoreHealth(input: HealthInput): HealthScore {
  const components: HealthComponent[] = []
  const push = (key: HealthComponentKey, score: number | null, detail: string) =>
    components.push({ key, label: LABELS[key], weight: WEIGHTS[key], score, detail, href: input.hrefs[key] })

  // Sales — trend of net sales.
  push('sales', trendScore(input.sales.current, input.sales.previous), describeTrend(input.sales.current, input.sales.previous, 'Net sales'))

  // Profitability — trend of gross profit, capped when the cost side is mostly blind.
  {
    let score = input.profit.revenue > 0 || input.profit.previous !== 0
      ? trendScore(input.profit.current, input.profit.previous)
      : null
    let detail = describeTrend(input.profit.current, input.profit.previous, 'Gross profit')
    if (score !== null && input.profit.coveragePercent < 80) {
      score = Math.min(score, 55)
      detail += ` Only ${Math.round(input.profit.coveragePercent)}% of what sold carries a recipe cost, so the margin is partly blind.`
    }
    push('profitability', score, detail)
  }

  // Food cost — level against the target.
  {
    const target = (input.foodCost.targetBps ?? DEFAULT_TARGET_BPS) / 100
    const percent = input.foodCost.percent
    let score: number | null = null
    let detail = 'No revenue in this period, so there is no food cost to judge.'
    if (percent !== null && input.profit.revenue > 0) {
      const over = percent - target
      score = over <= 0 ? 100 : over <= 3 ? 80 : over <= 6 ? 55 : 25
      const targetText = input.foodCost.targetBps === null ? `${target}% (no target set — this is the default)` : `${target}% target`
      detail =
        over <= 0
          ? `Food cost is ${percent}%, within the ${targetText}.`
          : `Food cost is ${percent}%, ${Math.round(over * 10) / 10} points over the ${targetText}.`
    }
    push('foodCost', score, detail)
  }

  // Waste — share of the ingredient cost of what was sold.
  {
    const { value, cogs } = input.waste
    let score: number | null
    let detail: string
    if (cogs <= 0 && value <= 0) {
      score = null
      detail = 'Nothing sold and nothing wasted in this period.'
    } else if (cogs <= 0) {
      score = 25
      detail = 'Stock was wasted in a period with no costed sales.'
    } else {
      const share = (value / cogs) * 100
      score = share <= 2 ? 100 : share <= 5 ? 75 : share <= 10 ? 45 : 20
      detail = `Waste is ${Math.round(share * 10) / 10}% of the ingredient cost of what was sold.`
    }
    push('waste', score, detail)
  }

  // Inventory — share of items low or out, live.
  {
    const { totalItems, outOfStock, lowStock, negativeStockCount } = input.inventory
    let score: number | null = null
    let detail = 'No stock items to judge.'
    if (totalItems > 0) {
      const problems = outOfStock + lowStock
      const share = (problems / totalItems) * 100
      score = problems === 0 ? 100 : share <= 10 ? 80 : share <= 25 ? 55 : 25
      detail =
        problems === 0
          ? `All ${totalItems} items are above their reorder level.`
          : `${lowStock} item(s) low and ${outOfStock} out of stock, of ${totalItems}.`
      if (negativeStockCount > 0) {
        score = Math.min(score, 55)
        detail += ` ${negativeStockCount} item(s) show negative stock — a missing purchase or a wrong recipe.`
      }
    }
    push('inventory', score, detail)
  }

  // Reconciliation — the checker and the money identities, as one status.
  {
    const status = input.reconciliationStatus
    const score = status === 'OK' ? 100 : status === 'WARNING' ? 60 : 20
    const detail =
      status === 'OK'
        ? 'Every integrity check and money identity passes.'
        : status === 'WARNING'
          ? 'Some checks want a look — nothing is arithmetically broken.'
          : 'A check found money or stock that no longer explains itself.'
    push('reconciliation', score, detail)
  }

  const scored = components.filter((c): c is HealthComponent & { score: number } => c.score !== null)
  const weightSum = scored.reduce((sum, c) => sum + c.weight, 0)
  const score = weightSum > 0 ? Math.round(scored.reduce((sum, c) => sum + c.score * c.weight, 0) / weightSum) : null
  const band: HealthBand | null = score === null ? null : score >= 80 ? 'HEALTHY' : score >= 60 ? 'ATTENTION' : 'AT_RISK'

  const issues = scored
    .filter((c) => c.score < 100)
    .sort((a, b) => b.weight * (100 - b.score) - a.weight * (100 - a.score) || a.key.localeCompare(b.key))
    .slice(0, 3)

  return {
    score,
    band,
    components,
    issues,
    excluded: components.filter((c) => c.score === null).map((c) => c.key),
    signalsUsed: scored.length,
  }
}

export const BAND_META: Record<HealthBand, { label: string; tone: 'success' | 'warning' | 'destructive' }> = {
  HEALTHY: { label: 'Healthy', tone: 'success' },
  ATTENTION: { label: 'Needs attention', tone: 'warning' },
  AT_RISK: { label: 'At risk', tone: 'destructive' },
}
