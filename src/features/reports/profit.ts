import 'server-only'

import { prisma } from '@/server/db/prisma'
import type { DateRange } from './range'

/**
 * Profitability.
 *
 * ── This is GROSS profit, and only gross profit ─────────────────────────────
 *
 *   revenue − cost of goods sold = gross profit
 *
 * It excludes rent, wages, electricity, gas, licences, delivery commission and
 * every other operating cost. A restaurant showing 45% gross profit can still
 * be losing money, and an owner who reads this figure as take-home will make
 * bad decisions with it. Nothing in this module is ever labelled "net profit",
 * and the type names say `gross` so a caller cannot accidentally present it as
 * something it is not.
 *
 * ── Where COGS comes from ───────────────────────────────────────────────────
 *
 * Cost is taken from the recipe pinned to each order line at the time it was
 * sold, priced at what the ingredients cost then — not today. A line with no
 * recipe contributes revenue but no cost, which would flatter the margin, so
 * those are counted and reported separately rather than silently averaged in.
 */

export interface GrossProfitRow {
  key: string
  label: string
  revenue: number
  cogs: number
  grossProfit: number
  /** COGS as a percentage of revenue. */
  foodCostPercent: number | null
  /** Gross profit as a percentage of revenue. */
  grossMarginPercent: number | null
  quantity: number
}

export interface ProfitReport {
  range: { from: string; to: string; label: string }
  totals: {
    revenue: number
    cogs: number
    grossProfit: number
    foodCostPercent: number | null
    grossMarginPercent: number | null
  }
  /** How much revenue had no recipe behind it — the margin's blind spot. */
  coverage: {
    linesWithRecipe: number
    linesWithoutRecipe: number
    revenueWithoutRecipe: number
    percentCovered: number
  }
  byItem: GrossProfitRow[]
  byCategory: GrossProfitRow[]
  byBranch: GrossProfitRow[]
  /** Stated on every response so no caller can present this as net profit. */
  disclaimer: string
}

const DISCLAIMER =
  'Gross profit only — revenue less the cost of ingredients. It does not include rent, wages, utilities or any other operating cost.'

export async function getProfitReport(params: {
  restaurantId: string
  range: DateRange
  branchIds?: string[] | null
}): Promise<ProfitReport> {
  const lines = await prisma.orderItem.findMany({
    where: {
      status: { not: 'CANCELLED' },
      order: {
        restaurantId: params.restaurantId,
        status: { not: 'CANCELLED' },
        placedAt: { gte: params.range.from, lte: params.range.to },
        ...(params.branchIds ? { branchId: { in: params.branchIds } } : {}),
      },
    },
    select: {
      name: true, quantity: true, lineTotal: true, costPrice: true, recipeId: true,
      food: { select: { id: true, category: { select: { id: true, name: true } } } },
      order: {
        select: {
          id: true,
          subtotal: true,
          discountTotal: true,
          loyaltyDiscount: true,
          branch: { select: { id: true, name: true } },
          payments: { where: { status: 'REFUNDED' }, select: { amount: true } },
        },
      },
    },
  })

  /*
   * Revenue here must mean the same thing it means on the sales report.
   *
   * This summed `lineTotal`, which is what was charged before any discount and
   * before any refund. The sales report defines net as gross − discounts −
   * refunds, so the two screens reported different revenue for the same period
   * and the profit figure was overstated by every discount ever given.
   *
   * Order-level reductions are apportioned across the lines in proportion to
   * what each contributed, which is the only division that keeps the parts
   * summing to the whole.
   */
  const reductionShare = new Map<string, number>()
  for (const line of lines) {
    const order = line.order
    if (!order || reductionShare.has(order.id)) continue
    const refunded = order.payments.reduce((sum, p) => sum + p.amount, 0)
    const reduction = order.discountTotal + order.loyaltyDiscount + refunded
    reductionShare.set(order.id, order.subtotal > 0 ? reduction / order.subtotal : 0)
  }

  // Recipe costs are resolved once per recipe rather than per line — a busy
  // day is thousands of lines across a few dozen recipes.
  const recipeIds = [...new Set(lines.map((l) => l.recipeId).filter((id): id is string => Boolean(id)))]
  const costByRecipe = new Map<string, number>()

  if (recipeIds.length > 0) {
    const ingredients = await prisma.recipeIngredient.findMany({
      where: { recipeId: { in: recipeIds } },
      include: { inventoryItem: { select: { costPerUnit: true } } },
    })
    for (const ing of ingredients) {
      if (!ing.inventoryItem) continue
      const withWastage = ing.quantity * (1 + Math.max(0, ing.wastagePercent) / 100)
      costByRecipe.set(
        ing.recipeId,
        (costByRecipe.get(ing.recipeId) ?? 0) + withWastage * ing.inventoryItem.costPerUnit,
      )
    }
  }

  let revenue = 0, cogs = 0
  let withRecipe = 0, withoutRecipe = 0, revenueWithout = 0

  const item = new Map<string, GrossProfitRow>()
  const category = new Map<string, GrossProfitRow>()
  const branch = new Map<string, GrossProfitRow>()

  const blank = (key: string, label: string): GrossProfitRow => ({
    key, label, revenue: 0, cogs: 0, grossProfit: 0,
    foodCostPercent: null, grossMarginPercent: null, quantity: 0,
  })

  for (const line of lines) {
    /*
     * `costPrice` is the cost snapshot taken when the kitchen accepted the line,
     * priced from the pinned recipe at the weighted average then in force. The
     * recipe is the fallback for lines sold before snapshots existed.
     *
     * This was written `costPrice ?? recipeCost`, which never reached the
     * fallback: the column is `Int @default(0)`, not nullable, so `??` only fires
     * on null and a zero passed straight through. Any restaurant that had not
     * typed cost prices into its menu reported cost of nil and a margin of 100%.
     * The zero check is the whole fix.
     */
    const unitCost =
      line.costPrice > 0
        ? line.costPrice
        : line.recipeId
          ? costByRecipe.get(line.recipeId) ?? 0
          : 0
    const lineCost = Math.round(unitCost * line.quantity)
    const known = unitCost > 0

    // What this line actually earned, after its share of any discount or refund.
    const share = reductionShare.get(line.order.id) ?? 0
    const netLine = Math.max(0, Math.round(line.lineTotal * (1 - share)))

    revenue += netLine
    cogs += lineCost
    if (known) withRecipe += 1
    else { withoutRecipe += 1; revenueWithout += netLine }

    for (const [map, key, label] of [
      [item, line.name, line.name],
      [category, line.food?.category?.id ?? 'none', line.food?.category?.name ?? 'Uncategorised'],
      [branch, line.order.branch?.id ?? 'none', line.order.branch?.name ?? 'Unassigned'],
    ] as Array<[Map<string, GrossProfitRow>, string, string]>) {
      const row = map.get(key) ?? blank(key, label)
      row.revenue += netLine
      row.cogs += lineCost
      row.quantity += line.quantity
      map.set(key, row)
    }
  }

  const finish = (m: Map<string, GrossProfitRow>) =>
    [...m.values()]
      .map((r) => ({
        ...r,
        grossProfit: r.revenue - r.cogs,
        foodCostPercent: r.revenue > 0 ? round2((r.cogs / r.revenue) * 100) : null,
        grossMarginPercent: r.revenue > 0 ? round2(((r.revenue - r.cogs) / r.revenue) * 100) : null,
      }))
      .sort((a, b) => b.grossProfit - a.grossProfit)

  const total = lines.length || 1

  return {
    range: {
      from: params.range.from.toISOString(),
      to: params.range.to.toISOString(),
      label: params.range.label,
    },
    totals: {
      revenue,
      cogs,
      grossProfit: revenue - cogs,
      foodCostPercent: revenue > 0 ? round2((cogs / revenue) * 100) : null,
      grossMarginPercent: revenue > 0 ? round2(((revenue - cogs) / revenue) * 100) : null,
    },
    coverage: {
      linesWithRecipe: withRecipe,
      linesWithoutRecipe: withoutRecipe,
      revenueWithoutRecipe: revenueWithout,
      percentCovered: round2((withRecipe / total) * 100),
    },
    byItem: finish(item).slice(0, 50),
    byCategory: finish(category),
    byBranch: finish(branch),
    disclaimer: DISCLAIMER,
  }
}

export interface BranchComparisonRow {
  branchId: string
  name: string
  type: string
  sales: number
  orders: number
  averageOrderValue: number
  cogs: number
  grossProfit: number
  grossMarginPercent: number | null
  inventoryValue: number
  wastage: number
}

/** Every location side by side, best gross profit first. */
export async function getBranchComparison(params: {
  restaurantId: string
  range: DateRange
  branchIds?: string[] | null
}): Promise<{ rows: BranchComparisonRow[]; disclaimer: string }> {
  const [branches, profit, wastage, stock] = await Promise.all([
    prisma.branch.findMany({
      where: {
        restaurantId: params.restaurantId,
        deletedAt: null,
        ...(params.branchIds ? { id: { in: params.branchIds } } : {}),
      },
      select: { id: true, name: true, type: true },
    }),
    getProfitReport(params),
    prisma.wastageRecord.groupBy({
      by: ['branchId'],
      where: {
        restaurantId: params.restaurantId,
        createdAt: { gte: params.range.from, lte: params.range.to },
      },
      _sum: { costValue: true },
    }),
    prisma.inventoryStock.findMany({
      where: { restaurantId: params.restaurantId },
      include: { item: { select: { costPerUnit: true } } },
    }),
  ])

  const orderCounts = await prisma.order.groupBy({
    by: ['branchId'],
    where: {
      restaurantId: params.restaurantId,
      status: { not: 'CANCELLED' },
      placedAt: { gte: params.range.from, lte: params.range.to },
    },
    _count: true,
  })

  const profitByBranch = new Map(profit.byBranch.map((b) => [b.key, b]))
  const wastageByBranch = new Map(wastage.map((w) => [w.branchId ?? 'none', w._sum?.costValue ?? 0]))
  const ordersByBranch = new Map(orderCounts.map((o) => [o.branchId ?? 'none', o._count]))

  const stockValue = new Map<string, number>()
  for (const s of stock) {
    if (s.available <= 0) continue
    stockValue.set(s.branchId, (stockValue.get(s.branchId) ?? 0) + s.available * s.item.costPerUnit)
  }

  const rows = branches.map((b) => {
    const p = profitByBranch.get(b.id)
    const orders = ordersByBranch.get(b.id) ?? 0
    const sales = p?.revenue ?? 0
    return {
      branchId: b.id,
      name: b.name,
      type: b.type as string,
      sales,
      orders,
      averageOrderValue: orders > 0 ? Math.round(sales / orders) : 0,
      cogs: p?.cogs ?? 0,
      grossProfit: p?.grossProfit ?? 0,
      grossMarginPercent: p?.grossMarginPercent ?? null,
      inventoryValue: Math.round(stockValue.get(b.id) ?? 0),
      wastage: wastageByBranch.get(b.id) ?? 0,
    }
  })

  return {
    rows: rows.sort((a, b) => b.grossProfit - a.grossProfit),
    disclaimer: DISCLAIMER,
  }
}

function round2(v: number): number {
  return Math.round(v * 100) / 100
}
