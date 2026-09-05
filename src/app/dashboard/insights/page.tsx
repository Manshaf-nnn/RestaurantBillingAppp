import type { Metadata } from 'next'
import Link from 'next/link'
import { ArrowRight, Package, Trash2, UtensilsCrossed } from 'lucide-react'

import { EmptyState } from '@/components/ui/feedback'
import { ExplainPopover } from '@/features/accounting/components/explain-popover'
import { InfoTip } from '@/features/accounting/components/info-tip'
import { PageHeader, StatCard } from '@/features/dashboard/components/page-header'
import { PeriodPicker } from '@/features/dashboard/components/period-picker'
import { scopeToOne, selectedBranch } from '@/features/dashboard/selected-branch'
import { AnomalyList } from '@/features/insights/components/anomaly-list'
import { HealthCard } from '@/features/insights/components/health-card'
import { MoneyTrace } from '@/features/insights/components/money-trace'
import { withPeriod, type PeriodQuery } from '@/features/insights/money-trace'
import { getCommandCenter } from '@/features/insights/queries'
import { describeRange, resolveRange } from '@/features/reports/range'
import { formatMoney, type CurrencyCode } from '@/lib/money'
import { PERMISSIONS } from '@/lib/rbac'
import { requirePagePermission } from '@/server/auth/guard'
import { requireRestaurant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Command Center' }

/**
 * The owner's Command Center (smart.md §1, §3, §7, §8): one health score, what
 * needs review, the nine numbers — each with "Why is this number?" — and the
 * money trace. Every figure is the accounting hub's, the reconciliation's or
 * the inventory summary's; this page composes and labels, it never computes.
 */
export default async function InsightsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const user = await requirePagePermission(PERMISSIONS.ACCOUNTING_VIEW, '/dashboard/insights')
  const restaurant = await requireRestaurant(user.restaurantId)
  const currency = restaurant.currency as CurrencyCode
  const money = (value: number) => formatMoney(value, restaurant.currency)

  const params = await searchParams
  const str = (key: string) => (typeof params[key] === 'string' ? (params[key] as string) : '')
  const range = resolveRange({
    preset: str('preset') || 'LAST_30',
    from: str('from'),
    to: str('to'),
    timeZone: restaurant.timezone,
  })
  const selection = await selectedBranch(user, params)
  const branchId = scopeToOne(selection)
  const branchIds = branchId ? [branchId] : selection.branchIds
  const query: PeriodQuery = { preset: range.preset, from: str('from'), to: str('to'), branch: selection.branchId }
  const periodLabel = describeRange(range)

  if (selection.confinedWithNoBranch) {
    return (
      <>
        <PageHeader title="Command Center" description={restaurant.name} />
        <EmptyState
          title="No location assigned"
          description="Your account is confined to a location that has not been set yet. Ask an owner to assign one."
        />
      </>
    )
  }

  const data = await getCommandCenter({
    restaurantId: user.restaurantId,
    range,
    branchIds,
    branchId,
    timeZone: restaurant.timezone,
    targetFoodCostBps: restaurant.targetFoodCostBps ?? null,
    money,
    query,
  })
  const { hub, explanations, comparison } = data
  const stockScope = branchId ? 'at the selected location' : 'across all locations'
  const wasteShare = hub.profit.cogs > 0 ? Math.round((hub.inventory.wasteValue / hub.profit.cogs) * 1000) / 10 : null
  const overTarget =
    data.foodCostPercent !== null &&
    data.targetFoodCostPercent !== null &&
    data.foodCostPercent > data.targetFoodCostPercent
  const lowStockCount = data.summary.lowStock + data.summary.outOfStock
  const revenueGap =
    hub.sales.netSales !== hub.profit.revenue
      ? { netSales: hub.sales.netSales, profitRevenue: hub.profit.revenue }
      : null

  return (
    <>
      <PageHeader
        title="Command Center"
        description={`${periodLabel} · ${restaurant.name} — every number here opens to the records behind it.`}
      />
      <div className="mb-5">
        <PeriodPicker preset={range.preset} from={str('from')} to={str('to')} label={periodLabel} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <HealthCard health={data.health} />
        <AnomalyList anomalies={data.anomalies} checksRun={data.checksRun} />
      </div>

      <h2 className="mb-2 mt-6 text-sm font-semibold text-muted-foreground">
        The nine numbers · {range.label} · stock figures {stockScope}
      </h2>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <StatCard
          label="Sales"
          info={<InfoTip term="grossSales" />}
          value={money(hub.sales.grossSales)}
          change={comparison.sales.changePercent ?? undefined}
          hint="before discounts and refunds"
          href={withPeriod('/dashboard/reports/sales', query)}
          explain={<ExplainPopover explanation={explanations.grossSales} currency={currency} />}
        />
        <StatCard
          label="Net revenue"
          info={<InfoTip term="netSales" />}
          value={money(hub.sales.netSales)}
          tone="primary"
          change={comparison.netSales.changePercent ?? undefined}
          hint={`after ${money(hub.sales.discounts)} discounts · ${money(hub.sales.refunds)} refunds`}
          href={withPeriod('/dashboard/reports/sales', query)}
          explain={<ExplainPopover explanation={explanations.netSales} currency={currency} />}
        />
        <StatCard
          label="COGS"
          info={<InfoTip term="cogs" />}
          value={money(hub.profit.cogs)}
          change={comparison.cogs.changePercent ?? undefined}
          hint="ingredients inside what was sold"
          href={withPeriod('/dashboard/reports/profit', query)}
          explain={<ExplainPopover explanation={explanations.cogs} currency={currency} />}
        />
        <StatCard
          label="Gross profit"
          info={<InfoTip term="grossProfit" />}
          value={money(hub.profit.grossProfit)}
          tone="success"
          change={comparison.grossProfit.changePercent ?? undefined}
          hint={hub.profit.grossMarginPercent !== null ? `${hub.profit.grossMarginPercent}% margin` : 'no revenue yet'}
          href={withPeriod('/dashboard/reports/profit', query)}
          explain={<ExplainPopover explanation={explanations.grossProfit} currency={currency} />}
        />
        <StatCard
          label="Food cost %"
          info={<InfoTip term="foodCostPercent" />}
          value={data.foodCostPercent !== null ? `${data.foodCostPercent}%` : '—'}
          tone={overTarget ? 'warning' : 'default'}
          hint={
            data.targetFoodCostPercent !== null
              ? `target ${data.targetFoodCostPercent}%`
              : 'no target set — 35% is used for the health score'
          }
          href={withPeriod('/dashboard/insights/menu', query)}
          explain={<ExplainPopover explanation={explanations.foodCostPercent} currency={currency} />}
        />
        <StatCard
          label="Cash collected"
          info={<InfoTip term="cashCollected" />}
          value={money(explanations.cashCollected.value)}
          tone={hub.cash.drawerVariance === 0 ? 'default' : 'warning'}
          hint={`${hub.cash.drawersClosed} drawer(s) closed · counted difference ${money(hub.cash.drawerVariance)}`}
          href={withPeriod('/dashboard/reports/cash-drawer', query)}
          explain={<ExplainPopover explanation={explanations.cashCollected} currency={currency} />}
        />
        <StatCard
          label="Waste"
          info={<InfoTip term="wastage" />}
          value={money(hub.inventory.wasteValue)}
          tone={wasteShare !== null && wasteShare > 5 ? 'warning' : 'default'}
          hint={wasteShare !== null ? `${wasteShare}% of COGS` : 'no costed sales to compare against'}
          href={withPeriod('/dashboard/insights/waste', query)}
          explain={<ExplainPopover explanation={explanations.waste} currency={currency} />}
        />
        <StatCard
          label="Outstanding"
          info={<InfoTip term="receivables" />}
          value={money(hub.collections.outstanding)}
          tone={hub.collections.outstanding > 0 ? 'warning' : 'default'}
          hint="bills placed in this period, still unpaid"
          href={withPeriod('/dashboard/invoices', query)}
          explain={<ExplainPopover explanation={explanations.receivables} currency={currency} />}
        />
        <StatCard
          label="Low stock"
          info={<InfoTip term="lowStock" />}
          value={lowStockCount}
          tone={data.summary.outOfStock > 0 ? 'destructive' : lowStockCount > 0 ? 'warning' : 'default'}
          hint={`${data.summary.outOfStock} out of stock · live, ${stockScope}`}
          href={withPeriod('/dashboard/insights/inventory', query)}
          explain={<ExplainPopover explanation={data.lowStock} currency={currency} />}
        />
      </div>

      <div className="mt-6">
        <MoneyTrace
          explanations={explanations}
          lowStock={data.lowStock}
          currency={currency}
          revenueGap={revenueGap}
        />
      </div>

      <h2 className="mb-2 mt-6 text-sm font-semibold text-muted-foreground">Go deeper</h2>
      <div className="grid gap-3 sm:grid-cols-3">
        <Link
          href={withPeriod('/dashboard/insights/menu', query)}
          className="flex items-center gap-3 rounded-xl border bg-card px-4 py-3 shadow-soft transition-shadow hover:shadow-elevated"
        >
          <UtensilsCrossed className="size-5 shrink-0 text-primary" />
          <span className="min-w-0 flex-1 text-sm">
            <strong>Menu &amp; profit</strong>
            <span className="block text-xs text-muted-foreground">
              Every dish: price, cost, margin — and whether it is a star or a problem.
            </span>
          </span>
          <ArrowRight className="size-4 shrink-0 text-muted-foreground" />
        </Link>
        <Link
          href={withPeriod('/dashboard/insights/inventory', query)}
          className="flex items-center gap-3 rounded-xl border bg-card px-4 py-3 shadow-soft transition-shadow hover:shadow-elevated"
        >
          <Package className="size-5 shrink-0 text-primary" />
          <span className="min-w-0 flex-1 text-sm">
            <strong>Stock outlook</strong>
            <span className="block text-xs text-muted-foreground">
              {lowStockCount} item{lowStockCount === 1 ? '' : 's'} low or out · days remaining and what to order.
            </span>
          </span>
          <ArrowRight className="size-4 shrink-0 text-muted-foreground" />
        </Link>
        <Link
          href={withPeriod('/dashboard/insights/waste', query)}
          className="flex items-center gap-3 rounded-xl border bg-card px-4 py-3 shadow-soft transition-shadow hover:shadow-elevated"
        >
          <Trash2 className="size-5 shrink-0 text-primary" />
          <span className="min-w-0 flex-1 text-sm">
            <strong>Waste</strong>
            <span className="block text-xs text-muted-foreground">
              {money(hub.inventory.wasteValue)} this period, by item, category and reason.
            </span>
          </span>
          <ArrowRight className="size-4 shrink-0 text-muted-foreground" />
        </Link>
      </div>

      <p className="mt-4 text-xs text-muted-foreground">
        Gross profit only — revenue less the cost of ingredients. Rent, wages, utilities and other operating
        costs are not in these figures. Sales and profit compare {data.range.comparisonLabel}.
      </p>
    </>
  )
}
