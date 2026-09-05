import 'server-only'

import { Prisma, type StockAlertLevel, type StockUnit } from '@prisma/client'

import {
  buildExplanations,
  compareMetric,
  explainLowStock,
  type Explanation,
  type MetricComparison,
  type MetricKey,
} from '@/features/accounting/explain'
import { getFinancialReconciliation } from '@/features/accounting/financial-reconciliation'
import { getAccountingHub, type AccountingHub } from '@/features/accounting/hub'
import type { IntegrityStatus } from '@/features/accounting/integrity'
import { issueAdvice, issueExampleHref } from '@/features/accounting/issue-links'
import { getInventorySummary, type InventorySummary } from '@/features/inventory/alerts'
import { costRecipesDetailed } from '@/features/inventory/recipe-resolver'
import { levelFor } from '@/features/inventory/stock-level'
import { getWastageReport, type WastageReport } from '@/features/inventory/wastage'
import { getReorderSuggestions } from '@/features/purchasing/suggestions'
import { getProfitReport, type ProfitReport } from '@/features/reports/profit'
import { comparisonLabel, customRange, previousRange, startOfDay, type DateRange } from '@/features/reports/range'
import { roundPercent } from '@/lib/quantity'
import { prisma } from '@/server/db/prisma'
import { utc } from '@/server/db/sql-time'

import { scoreHealth, type HealthScore } from './health'
import { classifyMenu, flagProfitChanges, type ClassifiedFood, type MenuClass, type MenuThresholds } from './menu-matrix'
import { carryPeriod, isAnomalyKey, withPeriod, type PeriodQuery } from './money-trace'
import {
  computeUsage,
  DAY_MS,
  outlookFor,
  outlookSentence,
  recommendReorder,
  USAGE_WINDOW_DAYS,
  type Recommendation,
  type StockOutlook,
} from './usage'

/**
 * The Command Center and its three sub-screens (smart.md), composed from the
 * engines that own each number: the accounting hub for money, the financial
 * reconciliation for checks and identities, the inventory summary for stock
 * levels, the profit report's per-dish rows for the menu, the stock ledger for
 * usage, the wastage report for waste.
 *
 * This file computes no financial figure of its own. Where it has to divide
 * (a share, a per-unit figure) it does so for a sentence or a badge, never for
 * a number that is then summed or reported as money.
 */

// ── Command Center ───────────────────────────────────────────────────────────

export interface Anomaly {
  key: string
  label: string
  status: IntegrityStatus
  count: number
  detail: string
  advice: string
  href: string
}

export interface CommandCenter {
  range: { from: string; to: string; label: string; comparisonLabel: string }
  hub: AccountingHub
  previous: AccountingHub
  /** Every explanation, links carrying the period. */
  explanations: Record<MetricKey, Explanation>
  lowStock: Explanation
  summary: InventorySummary
  health: HealthScore
  anomalies: Anomaly[]
  checksRun: number
  comparison: Record<'sales' | 'netSales' | 'cogs' | 'grossProfit', MetricComparison>
  /** Percent, already rounded; null without revenue. */
  foodCostPercent: number | null
  targetFoodCostPercent: number | null
}

const STATUS_RANK: Record<IntegrityStatus, number> = { ERROR: 0, WARNING: 1, OK: 2 }

export async function getCommandCenter(params: {
  restaurantId: string
  range: DateRange
  /** Money engines: null unrestricted, [] sees nothing. */
  branchIds: string[] | null
  /** Stock engines: one location or the whole restaurant. */
  branchId: string | null
  timeZone: string
  targetFoodCostBps: number | null
  money: (minor: number) => string
  query: PeriodQuery
}): Promise<CommandCenter> {
  const { restaurantId, range, branchIds, branchId, timeZone, money, query } = params
  const prev = previousRange(range)
  const prevRange = customRange(prev.from, prev.to, timeZone)

  const [hub, previous, finrec, summary] = await Promise.all([
    getAccountingHub({ restaurantId, range, branchIds }),
    getAccountingHub({ restaurantId, range: prevRange, branchIds }),
    getFinancialReconciliation({ restaurantId, range, branchIds }),
    getInventorySummary({ restaurantId, branchId }),
  ])

  const raw = buildExplanations(hub, money)
  const explanations = Object.fromEntries(
    Object.entries(raw).map(([key, explanation]) => [key, carryPeriod(explanation, query)]),
  ) as Record<MetricKey, Explanation>
  const lowStock = carryPeriod(explainLowStock(summary), query)

  const foodCostPercent = hub.profit.revenue > 0 ? raw.foodCostPercent.value : null
  const negativeStockCount = finrec.integrity.checks.find((check) => check.key === 'negative-stock')?.count ?? 0

  const health = scoreHealth({
    sales: { current: hub.sales.netSales, previous: previous.sales.netSales },
    profit: {
      current: hub.profit.grossProfit,
      previous: previous.profit.grossProfit,
      revenue: hub.profit.revenue,
      coveragePercent: hub.profit.coveragePercent,
    },
    foodCost: { percent: foodCostPercent, targetBps: params.targetFoodCostBps },
    waste: { value: hub.inventory.wasteValue, cogs: hub.profit.cogs },
    inventory: {
      totalItems: summary.totalItems,
      outOfStock: summary.outOfStock,
      lowStock: summary.lowStock,
      negativeStockCount,
    },
    reconciliationStatus: finrec.status,
    hrefs: {
      sales: withPeriod('/dashboard/reports/sales', query),
      profitability: withPeriod('/dashboard/reports/profit', query),
      foodCost: withPeriod('/dashboard/insights/menu', query),
      waste: withPeriod('/dashboard/insights/waste', query),
      inventory: withPeriod('/dashboard/insights/inventory', query),
      reconciliation: '/dashboard/accounting/reconciliation',
    },
  })

  const anomalies: Anomaly[] = [
    ...finrec.integrity.checks
      .filter((check) => isAnomalyKey(check.key) && check.status !== 'OK' && check.count > 0)
      .map((check) => ({
        key: check.key,
        label: check.label,
        status: check.status,
        count: check.count,
        detail: check.detail,
        advice: issueAdvice(check.key),
        href: check.examples[0]
          ? issueExampleHref(check.key, check.examples[0])
          : '/dashboard/accounting/reconciliation',
      })),
    ...finrec.identities
      .filter((row) => row.status !== 'OK')
      .map((row) => ({
        key: `identity:${row.key}`,
        label: row.label,
        status: row.status,
        count: 1,
        detail: row.working,
        advice: 'Both sides of this identity come from the engines that own them. Open the report and compare them line by line.',
        href: withPeriod(row.href, query),
      })),
  ].sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || b.count - a.count)

  const label = comparisonLabel(range)
  return {
    range: { from: range.from.toISOString(), to: range.to.toISOString(), label: range.label, comparisonLabel: label },
    hub,
    previous,
    explanations,
    lowStock,
    summary,
    health,
    anomalies,
    checksRun: finrec.integrity.checks.length,
    comparison: {
      sales: compareMetric('grossSales', 'Sales', hub.sales.grossSales, previous.sales.grossSales, money, label),
      netSales: compareMetric('netSales', 'Net revenue', hub.sales.netSales, previous.sales.netSales, money, label),
      cogs: compareMetric('cogs', 'COGS', hub.profit.cogs, previous.profit.cogs, money, label),
      grossProfit: compareMetric('grossProfit', 'Gross profit', hub.profit.grossProfit, previous.profit.grossProfit, money, label),
    },
    foodCostPercent,
    targetFoodCostPercent: params.targetFoodCostBps === null ? null : params.targetFoodCostBps / 100,
  }
}

// ── Menu & profit intelligence ───────────────────────────────────────────────

export interface MenuRow extends ClassifiedFood {
  /** Current dish name and category, when the dish still exists. */
  name: string
  categoryName: string | null
  /** What one portion costs at today's ingredient prices, from the active recipe; null without one. */
  recipeCost: number | null
  problems: string[]
  changes: string[]
}

export interface MenuIntelligence {
  range: { from: string; to: string; label: string; previousLabel: string }
  thresholds: MenuThresholds
  rows: MenuRow[]
  counts: Record<MenuClass, number>
  notSold: Array<{ foodId: string; name: string; menuPrice: number; categoryName: string | null }>
  coverage: ProfitReport['coverage']
  disclaimer: string
}

export async function getMenuIntelligence(params: {
  restaurantId: string
  range: DateRange
  branchIds: string[] | null
  timeZone: string
}): Promise<MenuIntelligence> {
  const { restaurantId, range, branchIds, timeZone } = params
  const prev = previousRange(range)
  const prevRange = customRange(prev.from, prev.to, timeZone)

  const [current, before, foods] = await Promise.all([
    getProfitReport({ restaurantId, range, branchIds }),
    getProfitReport({ restaurantId, range: prevRange, branchIds }),
    prisma.food.findMany({
      where: { restaurantId, deletedAt: null },
      select: { id: true, name: true, price: true, isAvailable: true, category: { select: { name: true } } },
      orderBy: { name: 'asc' },
    }),
  ])

  const foodIds = current.byFood.map((row) => row.foodId).filter((id): id is string => Boolean(id))
  const recipes = foodIds.length
    ? await prisma.recipe.findMany({
        where: { restaurantId, foodId: { in: foodIds }, isActive: true, archivedAt: null },
        orderBy: [{ foodId: 'asc' }, { version: 'desc' }],
        distinct: ['foodId'],
        select: { id: true, foodId: true },
      })
    : []
  const recipeByFood = new Map(recipes.map((recipe) => [recipe.foodId as string, recipe.id]))
  const costs = await costRecipesDetailed(prisma, restaurantId, recipes.map((recipe) => recipe.id))

  const foodById = new Map(foods.map((food) => [food.id, food]))
  const previousByKey = new Map(before.byFood.map((row) => [row.key, row]))
  const { thresholds, rows: classified } = classifyMenu(current.byFood)

  const rows: MenuRow[] = classified.map((row) => {
    const food = row.foodId ? foodById.get(row.foodId) : undefined
    const recipeId = row.foodId ? recipeByFood.get(row.foodId) : undefined
    const costed = recipeId ? costs.get(recipeId) : undefined
    const recipeCost = costed && costed.cost > 0 ? costed.cost : null
    const problems = [...(costed?.problems ?? [])]
    if (!recipeId) problems.push('No active recipe.')
    return {
      ...row,
      name: food?.name ?? row.label,
      categoryName: food?.category.name ?? null,
      recipeCost,
      problems,
      changes: flagProfitChanges(row, previousByKey.get(row.key), recipeCost),
    }
  })

  const counts: Record<MenuClass, number> = {
    STAR: 0, WORKHORSE: 0, HIDDEN_GEM: 0, PROBLEM: 0, UNCOSTED: 0, NOT_SOLD: 0,
  }
  for (const row of rows) counts[row.class] += 1

  const sold = new Set(foodIds)
  const notSold = foods
    .filter((food) => food.isAvailable && !sold.has(food.id))
    .map((food) => ({ foodId: food.id, name: food.name, menuPrice: food.price, categoryName: food.category.name }))
  counts.NOT_SOLD += notSold.length

  return {
    range: { from: current.range.from, to: current.range.to, label: range.label, previousLabel: prevRange.label },
    thresholds,
    rows,
    counts,
    notSold,
    coverage: current.coverage,
    disclaimer: current.disclaimer,
  }
}

// ── Smart inventory ──────────────────────────────────────────────────────────

export interface UsageRow {
  firstMovementAt: Date
  used: number
}

/** First day of the usage window: 28 restaurant-local days ending today. */
export function usageWindowStart(now: Date, timeZone: string): Date {
  return startOfDay(new Date(now.getTime() - (USAGE_WINDOW_DAYS - 1) * DAY_MS), timeZone)
}

/**
 * Per item: when it first moved (any type, so a new item's average is taken
 * over its own life) and how much left through trade inside the window.
 * `branchId` narrows both to one location's shelves.
 */
export async function getUsageStats(params: {
  restaurantId: string
  branchId: string | null
  windowStart: Date
  now: Date
}): Promise<Map<string, UsageRow>> {
  const branchScope = params.branchId ? Prisma.sql`AND "branchId" = ${params.branchId}` : Prisma.empty
  const rows = await prisma.$queryRaw<Array<{ itemId: string; first_at: Date; used: number | null }>>`
    WITH first_seen AS (
      SELECT "itemId", MIN("createdAt") AS first_at
      FROM stock_movements
      WHERE "restaurantId" = ${params.restaurantId} ${branchScope}
      GROUP BY "itemId"
    ),
    used AS (
      SELECT "itemId", -SUM(quantity) AS used
      FROM stock_movements
      WHERE "restaurantId" = ${params.restaurantId} ${branchScope}
        AND type IN ('SALE', 'CONSUMPTION', 'PRODUCTION_CONSUMPTION', 'SALE_REVERSAL')
        AND "createdAt" >= ${utc(params.windowStart)} AND "createdAt" <= ${utc(params.now)}
      GROUP BY "itemId"
    )
    SELECT f."itemId", f.first_at, COALESCE(u.used, 0)::float8 AS used
    FROM first_seen f
    LEFT JOIN used u ON u."itemId" = f."itemId"
  `
  return new Map(
    rows.map((row) => [row.itemId, { firstMovementAt: new Date(row.first_at), used: Number(row.used ?? 0) }]),
  )
}

export interface InventoryOutlookRow {
  itemId: string
  name: string
  unit: StockUnit
  available: number
  avgDailyUsage: number
  observedDays: number
  daysRemaining: number | null
  recommendedQty: number
  usageBasedQty: number
  purchaseUnits: number | null
  basis: Recommendation['basis']
  leadTimeDays: number | null
  supplierName: string | null
  /** Display estimate: recommended quantity at the supplier's price or the average cost. */
  estimatedCost: number
  outlook: StockOutlook
  level: StockAlertLevel | null
  sentence: string
}

export interface SmartInventory {
  asOf: string
  windowDays: number
  branchId: string | null
  rows: InventoryOutlookRow[]
  totals: {
    items: number
    needOrder: number
    urgent: number
    noUsage: number
    /** Stock with no usage in the window, at average cost — a display figure. */
    noUsageValue: number
  }
}

const OUTLOOK_ORDER: Record<StockOutlook, number> = { OUT: 0, URGENT: 1, SOON: 2, OK: 3, NO_USAGE: 4 }

export async function getSmartInventory(params: {
  restaurantId: string
  branchId: string | null
  timeZone: string
  now?: Date
}): Promise<SmartInventory> {
  const { restaurantId, branchId, timeZone } = params
  const now = params.now ?? new Date()
  const windowStart = usageWindowStart(now, timeZone)

  const [items, suggestions, usage] = await Promise.all([
    // `branchId` scopes the QUANTITY, never the item list (no-item-branch-filter).
    prisma.inventoryItem.findMany({
      where: { restaurantId, isActive: true },
      select: {
        id: true, name: true, unit: true, quantity: true, reorderLevel: true, minStock: true,
        maxStock: true, costPerUnit: true, unitsPerPurchaseUnit: true,
        ...(branchId
          ? { locationStock: { where: { branchId }, select: { available: true } } }
          : {}),
      },
      orderBy: { name: 'asc' },
    }),
    getReorderSuggestions({ restaurantId, branchId }),
    getUsageStats({ restaurantId, branchId, windowStart, now }),
  ])
  const suggestionByItem = new Map(suggestions.map((row) => [row.itemId, row]))

  const rows: InventoryOutlookRow[] = items.map((item) => {
    const available = branchId
      ? ('locationStock' in item ? item.locationStock : []).reduce((sum, row) => sum + row.available, 0)
      : item.quantity
    const used = usage.get(item.id)
    const stats = computeUsage({
      used: used?.used ?? 0,
      windowStart,
      now,
      firstMovementAt: used?.firstMovementAt ?? null,
      available,
    })
    const suggestion = suggestionByItem.get(item.id)
    const recommendation = recommendReorder({
      available,
      avgDailyUsage: stats.avgDailyUsage,
      leadTimeDays: suggestion?.leadTimeDays ?? null,
      thresholdSuggestedQty: suggestion?.suggestedQty ?? null,
      unitsPerPurchaseUnit: item.unitsPerPurchaseUnit,
    })
    const unitPrice =
      suggestion && suggestion.suggestedQty > 0
        ? suggestion.estimatedCost / suggestion.suggestedQty
        : item.costPerUnit
    return {
      itemId: item.id,
      name: item.name,
      unit: item.unit,
      available,
      avgDailyUsage: stats.avgDailyUsage,
      observedDays: Math.round(stats.observedDays * 10) / 10,
      daysRemaining: stats.daysRemaining,
      recommendedQty: recommendation.recommendedQty,
      usageBasedQty: recommendation.usageBasedQty,
      purchaseUnits: recommendation.purchaseUnits,
      basis: recommendation.basis,
      leadTimeDays: suggestion?.leadTimeDays ?? null,
      supplierName: suggestion?.supplierName ?? null,
      estimatedCost: Math.round(recommendation.recommendedQty * unitPrice),
      outlook: outlookFor(stats, suggestion?.leadTimeDays ?? null),
      level: levelFor({ quantity: available, reorderLevel: item.reorderLevel, minStock: item.minStock, maxStock: item.maxStock }),
      sentence: outlookSentence(item.name, item.unit, stats, recommendation),
    }
  })

  rows.sort(
    (a, b) =>
      OUTLOOK_ORDER[a.outlook] - OUTLOOK_ORDER[b.outlook] ||
      (a.daysRemaining ?? Infinity) - (b.daysRemaining ?? Infinity) ||
      a.name.localeCompare(b.name),
  )

  const idle = rows.filter((row) => row.outlook === 'NO_USAGE' && row.available > 0)
  const costById = new Map(items.map((item) => [item.id, item.costPerUnit]))
  return {
    asOf: now.toISOString(),
    windowDays: USAGE_WINDOW_DAYS,
    branchId,
    rows,
    totals: {
      items: rows.length,
      needOrder: rows.filter((row) => row.recommendedQty > 0).length,
      urgent: rows.filter((row) => row.outlook === 'OUT' || row.outlook === 'URGENT').length,
      noUsage: idle.length,
      noUsageValue: Math.round(idle.reduce((sum, row) => sum + row.available * (costById.get(row.itemId) ?? 0), 0)),
    },
  }
}

// ── Waste intelligence ───────────────────────────────────────────────────────

export interface WasteIntelligence {
  report: WastageReport
  cogs: number
  /** Waste as a share of the ingredient cost of what was sold; null without COGS. */
  shareOfCogsPercent: number | null
  biggest: WastageReport['topItems'][number] | null
}

export async function getWasteIntelligence(params: {
  restaurantId: string
  range: DateRange
  branchIds: string[] | null
}): Promise<WasteIntelligence> {
  const { restaurantId, range, branchIds } = params
  const [report, profit] = await Promise.all([
    getWastageReport({ restaurantId, range, branchIds, includeEmployees: false }),
    getProfitReport({ restaurantId, range, branchIds }),
  ])
  const cogs = profit.totals.cogs
  return {
    report,
    cogs,
    shareOfCogsPercent: cogs > 0 ? roundPercent((report.totalValue / cogs) * 100) : null,
    biggest: report.topItems[0] ?? null,
  }
}
