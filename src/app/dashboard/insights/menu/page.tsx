import type { Metadata } from 'next'
import Link from 'next/link'

import { Badge } from '@/components/ui/badge'
import { Alert, EmptyState } from '@/components/ui/feedback'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { InfoTip } from '@/features/accounting/components/info-tip'
import { PageHeader, SectionCard, StatCard } from '@/features/dashboard/components/page-header'
import { PeriodPicker } from '@/features/dashboard/components/period-picker'
import { scopeToOne, selectedBranch } from '@/features/dashboard/selected-branch'
import { CLASS_META, type MenuClass } from '@/features/insights/menu-matrix'
import { getMenuIntelligence } from '@/features/insights/queries'
import { describeRange, resolveRange } from '@/features/reports/range'
import { formatMoney } from '@/lib/money'
import { PERMISSIONS } from '@/lib/rbac'
import { requirePagePermission } from '@/server/auth/guard'
import { requireRestaurant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Menu & profit' }

const MATRIX: MenuClass[] = ['STAR', 'WORKHORSE', 'HIDDEN_GEM', 'PROBLEM']

/**
 * Profit Intelligence and Menu Intelligence (smart.md §2, §6): every dish
 * from list price to margin, classed by how it sells and what it earns. The
 * numbers are the profit report's per-dish rows; the recipe cost is today's
 * from the same resolver the kitchen depletes against.
 */
export default async function MenuInsightsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const user = await requirePagePermission(PERMISSIONS.ACCOUNTING_VIEW, '/dashboard/insights/menu')
  const restaurant = await requireRestaurant(user.restaurantId)
  const money = (value: number) => formatMoney(value, restaurant.currency)
  const percent = (value: number | null) => (value === null ? '—' : `${value}%`)

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
  const periodLabel = describeRange(range)

  if (selection.confinedWithNoBranch) {
    return (
      <>
        <PageHeader title="Menu & profit" description={restaurant.name} />
        <EmptyState title="No location assigned" description="Ask an owner to assign your account to a location." />
      </>
    )
  }

  const data = await getMenuIntelligence({
    restaurantId: user.restaurantId,
    range,
    branchIds,
    timeZone: restaurant.timezone,
  })
  const sold = data.rows.filter((row) => row.class !== 'NOT_SOLD')

  return (
    <>
      <PageHeader
        title="Menu & profit"
        description={`${periodLabel} · ${restaurant.name} — what each dish sold for, what it cost, and what that makes it.`}
        actions={
          <Link href="/dashboard/insights" className="text-sm font-medium text-primary underline-offset-2 hover:underline">
            ← Command Center
          </Link>
        }
      />
      <div className="mb-5">
        <PeriodPicker preset={range.preset} from={str('from')} to={str('to')} label={periodLabel} />
      </div>

      {data.coverage.percentCovered < 100 ? (
        <Alert variant="warning" title="Some sales have no cost behind them" className="mb-5">
          {data.coverage.linesWithoutRecipe} of {data.coverage.linesWithRecipe + data.coverage.linesWithoutRecipe} sold
          lines ({money(data.coverage.revenueWithoutRecipe)} of revenue) carry no recipe cost. Those dishes are shown as
          “cost unknown” rather than as pure profit. Add recipes to close the gap.
        </Alert>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {MATRIX.map((cls) => (
          <StatCard
            key={cls}
            label={`${CLASS_META[cls].emoji} ${CLASS_META[cls].label}s`}
            value={data.counts[cls]}
            hint={CLASS_META[cls].advice}
            tone={cls === 'STAR' ? 'success' : cls === 'PROBLEM' ? 'destructive' : cls === 'WORKHORSE' ? 'warning' : 'primary'}
          />
        ))}
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        <InfoTip term="menuClass" className="mr-1 align-middle" />
        Popular means at least <strong>{data.thresholds.popularity}</strong> sold; profitable means at least{' '}
        <strong>{money(data.thresholds.profitPerUnit)}</strong> gross profit per plate — the menu’s own weighted
        average over {data.thresholds.itemsSold} costed dish{data.thresholds.itemsSold === 1 ? '' : 'es'}.
        {data.counts.UNCOSTED > 0 ? ` ${data.counts.UNCOSTED} dish(es) sold without a known cost and are left out of the averages.` : ''}
      </p>

      <div className="mt-6">
        <SectionCard
          title="Every dish sold"
          description="List price is the menu; avg sold price is what guests actually paid after options and discounts. Recipe cost is today’s ingredients; unit COGS is what the sold plates cost when they went out."
          bodyClassName="p-0"
        >
          {sold.length === 0 ? (
            <div className="p-5">
              <EmptyState title="Nothing sold in this period" description="Pick a longer period, or wait for service." />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Dish</TableHead>
                    <TableHead>Class</TableHead>
                    <TableHead className="text-right">Sold</TableHead>
                    <TableHead className="text-right">List price</TableHead>
                    <TableHead className="text-right">Avg sold price</TableHead>
                    <TableHead className="text-right">
                      Recipe cost <InfoTip term="recipeCost" className="align-middle" />
                    </TableHead>
                    <TableHead className="text-right">Unit COGS</TableHead>
                    <TableHead className="text-right">Gross profit</TableHead>
                    <TableHead className="text-right">Margin</TableHead>
                    <TableHead className="text-right">Food cost</TableHead>
                    <TableHead>Changes</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sold.map((row) => {
                    const meta = CLASS_META[row.class]
                    return (
                      <TableRow key={row.key}>
                        <TableCell className="font-medium">
                          {row.foodId ? (
                            <Link href={`/dashboard/recipes/${row.foodId}`} className="hover:underline">
                              {row.name}
                            </Link>
                          ) : (
                            <span>{row.name} <span className="text-xs text-muted-foreground">(deleted)</span></span>
                          )}
                          {row.categoryName ? (
                            <span className="block text-xs text-muted-foreground">{row.categoryName}</span>
                          ) : null}
                        </TableCell>
                        <TableCell>
                          <Badge variant={meta.tone}>
                            {meta.emoji} {meta.label}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{row.quantity}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {row.menuPrice !== null ? money(row.menuPrice) : '—'}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {row.avgSoldPrice !== null ? money(row.avgSoldPrice) : '—'}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {row.recipeCost !== null ? money(row.recipeCost) : <span className="text-muted-foreground">no recipe</span>}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {row.unitCogs !== null ? money(Math.round(row.unitCogs)) : <span className="text-muted-foreground">unknown</span>}
                        </TableCell>
                        <TableCell className={`text-right font-semibold tabular-nums ${row.grossProfit < 0 ? 'text-destructive' : ''}`}>
                          {row.class === 'UNCOSTED' ? '—' : money(row.grossProfit)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {row.class === 'UNCOSTED' ? '—' : percent(row.grossMarginPercent)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {row.class === 'UNCOSTED' ? '—' : percent(row.foodCostPercent)}
                        </TableCell>
                        <TableCell>
                          {row.changes.length > 0 ? (
                            <span className="flex flex-wrap gap-1">
                              {row.changes.map((change) => (
                                <span key={change} className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium">
                                  {change}
                                </span>
                              ))}
                            </span>
                          ) : (
                            <span className="text-xs text-muted-foreground">steady</span>
                          )}
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </SectionCard>
      </div>

      {data.notSold.length > 0 ? (
        <details className="mt-4 rounded-xl border bg-card px-5 py-4 text-sm">
          <summary className="cursor-pointer font-medium">
            {CLASS_META.NOT_SOLD.emoji} {data.notSold.length} dish{data.notSold.length === 1 ? '' : 'es'} on the menu did not sell in this period
          </summary>
          <ul className="mt-3 grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
            {data.notSold.map((dish) => (
              <li key={dish.foodId} className="flex justify-between gap-3 rounded-lg border px-3 py-1.5">
                <span>
                  {dish.name}
                  {dish.categoryName ? <span className="ml-1 text-xs text-muted-foreground">{dish.categoryName}</span> : null}
                </span>
                <span className="tabular-nums text-muted-foreground">{money(dish.menuPrice)}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      <p className="mt-4 text-xs text-muted-foreground">
        {data.disclaimer} Changes compare with {data.range.previousLabel}: unit cost moved 10% or more, margin moved 5
        points or more, or today’s recipe cost differs 10% or more from what the sold plates cost.
      </p>
    </>
  )
}
