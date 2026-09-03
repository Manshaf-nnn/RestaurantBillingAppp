import 'server-only'

import { comparisonLabel, customRange, previousRange, type DateRange } from '@/features/reports/range'
import { BPS_DENOMINATOR } from '@/lib/money'
import { compareMetric, type MetricComparison } from './explain'
import { getAccountingHub } from './hub'

/**
 * Variance analysis (acCal.md §8): this period against the one before it,
 * every row through the same engines the hub uses — so the "actual" here is
 * the same actual everywhere else.
 *
 * Only ONE expected figure is stored anywhere: the owner's target food-cost
 * percentage. Everything else compares against the previous period, because
 * a target nobody set is not a fact.
 */

export interface VarianceRow extends MetricComparison {
  /** Money rows format as money; the food-cost row is a percentage. */
  kind: 'money' | 'percent'
  /** Set only on the food-cost row, and only when a target exists. */
  target?: { expected: number; actual: number; variance: number }
}

export interface VarianceReport {
  comparisonLabel: string
  rows: VarianceRow[]
  previousLabel: string
}

export async function getVarianceReport(params: {
  restaurantId: string
  range: DateRange
  branchIds?: string[] | null
  targetFoodCostBps: number | null
  money: (minor: number) => string
}): Promise<VarianceReport> {
  const { restaurantId, range, branchIds, targetFoodCostBps, money } = params

  const prev = previousRange(range)
  const prevRange = customRange(prev.from, prev.to, range.timeZone)
  const [hub, prevHub] = await Promise.all([
    getAccountingHub({ restaurantId, range, branchIds }),
    getAccountingHub({ restaurantId, range: prevRange, branchIds }),
  ])

  const label = comparisonLabel(range)
  const money1 = (value: number) => money(value)
  const row = (
    key: Parameters<typeof compareMetric>[0],
    title: string,
    current: number,
    previous: number,
  ): VarianceRow => ({ ...compareMetric(key, title, current, previous, money1, label), kind: 'money' })

  const foodCostNow = hub.profit.revenue > 0 ? Math.round((hub.profit.cogs / hub.profit.revenue) * BPS_DENOMINATOR) : 0
  const foodCostThen = prevHub.profit.revenue > 0
    ? Math.round((prevHub.profit.cogs / prevHub.profit.revenue) * BPS_DENOMINATOR)
    : 0

  const foodCostRow: VarianceRow = {
    key: 'foodCostPercent',
    title: 'Food cost',
    kind: 'percent',
    current: foodCostNow,
    previous: foodCostThen,
    delta: foodCostNow - foodCostThen,
    changePercent: null,
    sentence:
      hub.profit.revenue === 0
        ? 'No sales in this period, so there is no food cost to compare.'
        : `Ingredients took ${(foodCostNow / 100).toFixed(1)}% of sales${
            foodCostThen > 0 ? `, against ${(foodCostThen / 100).toFixed(1)}% ${label}` : ''
          }. ${
            foodCostNow > foodCostThen && foodCostThen > 0
              ? 'It rose: prices up, portions drifting, or heavier discounting selling the same food for less.'
              : foodCostNow < foodCostThen && foodCostThen > 0
                ? 'It fell: cheaper buying, tighter portions, or better prices.'
                : 'It held steady.'
          }`,
    ...(targetFoodCostBps !== null
      ? {
          target: {
            expected: targetFoodCostBps,
            actual: foodCostNow,
            variance: foodCostNow - targetFoodCostBps,
          },
        }
      : {}),
  }

  return {
    comparisonLabel: label,
    previousLabel: prevRange.label,
    rows: [
      row('netSales', 'Net sales', hub.sales.netSales, prevHub.sales.netSales),
      row('cogs', 'Ingredient cost (COGS)', hub.profit.cogs, prevHub.profit.cogs),
      foodCostRow,
      row('grossProfit', 'Gross profit', hub.profit.grossProfit, prevHub.profit.grossProfit),
      row('inventoryValue', 'Waste', hub.inventory.wasteValue, prevHub.inventory.wasteValue),
      row('netSales', 'Discounts given', hub.sales.discounts, prevHub.sales.discounts),
      row('payables', 'Purchases received', hub.purchasing.receivedValue, prevHub.purchasing.receivedValue),
      row('expensesPaid', 'Expenses paid', hub.expenses.paid, prevHub.expenses.paid),
    ],
  }
}
