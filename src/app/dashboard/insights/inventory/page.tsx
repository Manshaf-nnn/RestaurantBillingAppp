import type { Metadata } from 'next'
import Link from 'next/link'
import { AlertTriangle, ArrowRight } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/feedback'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { InfoTip } from '@/features/accounting/components/info-tip'
import { PageHeader, SectionCard, StatCard } from '@/features/dashboard/components/page-header'
import { scopeToOne, selectedBranch } from '@/features/dashboard/selected-branch'
import { getSmartInventory, type InventoryOutlookRow } from '@/features/insights/queries'
import { OUTLOOK_META } from '@/features/insights/usage'
import { formatQuantity } from '@/features/inventory/units'
import { formatMoney } from '@/lib/money'
import { PERMISSIONS } from '@/lib/rbac'
import { requirePagePermission } from '@/server/auth/guard'
import { requireRestaurant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Stock outlook' }

/**
 * Smart Inventory (smart.md §4): for every item, how fast it is being used,
 * how long the shelf will last, and how much to order. Usage comes from the
 * stock ledger; the threshold rule is the purchasing module's own; this page
 * only reads.
 */
export default async function InventoryInsightsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const user = await requirePagePermission(PERMISSIONS.ACCOUNTING_VIEW, '/dashboard/insights/inventory')
  const restaurant = await requireRestaurant(user.restaurantId)
  const money = (value: number) => formatMoney(value, restaurant.currency)

  const params = await searchParams
  const selection = await selectedBranch(user, params)
  const branchId = scopeToOne(selection)

  if (selection.confinedWithNoBranch) {
    return (
      <>
        <PageHeader title="Stock outlook" description={restaurant.name} />
        <EmptyState title="No location assigned" description="Ask an owner to assign your account to a location." />
      </>
    )
  }

  const data = await getSmartInventory({
    restaurantId: user.restaurantId,
    branchId,
    timeZone: restaurant.timezone,
  })
  const urgent = data.rows.filter((row) => row.outlook === 'OUT' || row.outlook === 'URGENT')
  const attention = data.rows.filter((row) => row.recommendedQty > 0 || row.outlook !== 'OK')
  const fine = data.rows.filter((row) => !attention.includes(row))
  const scope = branchId ? 'at the selected location' : 'across all locations'

  return (
    <>
      <PageHeader
        title="Stock outlook"
        description={`Usage averaged over the last ${data.windowDays} days · stock as of now · ${scope}.`}
        actions={
          <>
            <Link href="/dashboard/insights" className="text-sm font-medium text-primary underline-offset-2 hover:underline">
              ← Command Center
            </Link>
            <Button asChild variant="outline" size="sm">
              <Link href="/dashboard/purchases/new">New purchase order</Link>
            </Button>
          </>
        }
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard
          label="Need ordering"
          info={<InfoTip term="recommendedOrder" />}
          value={data.totals.needOrder}
          tone={data.totals.needOrder > 0 ? 'warning' : 'success'}
          hint="usage-based or below the reorder rule"
          href="/dashboard/purchases/new"
        />
        <StatCard
          label="Order now"
          info={<InfoTip term="daysRemaining" />}
          value={data.totals.urgent}
          tone={data.totals.urgent > 0 ? 'destructive' : 'success'}
          hint="out, or gone before the next delivery could land"
        />
        <StatCard
          label={`No usage in ${data.windowDays} days`}
          info={<InfoTip term="averageUsage" />}
          value={data.totals.noUsage}
          hint={`${money(data.totals.noUsageValue)} sitting on the shelf at average cost`}
        />
      </div>

      {urgent.length > 0 ? (
        <div className="mt-5 grid gap-2 sm:grid-cols-2">
          {urgent.slice(0, 6).map((row) => (
            <Link
              key={row.itemId}
              href={`/dashboard/inventory/${row.itemId}`}
              className="flex items-center gap-3 rounded-xl border border-destructive/40 bg-destructive/5 px-4 py-3 transition-colors hover:bg-destructive/10"
            >
              <AlertTriangle className="size-5 shrink-0 text-destructive" />
              <span className="min-w-0 flex-1 text-sm">{row.sentence}</span>
              <ArrowRight className="size-4 shrink-0 text-muted-foreground" />
            </Link>
          ))}
        </div>
      ) : null}

      <div className="mt-6">
        <SectionCard
          title="What to order, and when"
          description="Usage = sold + kitchen use + used in production, averaged over the window (or since the item first moved). Waste is counted separately. The recommendation covers the supplier’s lead time plus a week, never less than the reorder rule, rounded up to whole packs."
          bodyClassName="p-0"
        >
          {attention.length === 0 ? (
            <div className="p-5">
              <EmptyState title="Every item is fine" description="Nothing is low, nothing runs out inside its lead time, and everything is moving." />
            </div>
          ) : (
            <OutlookTable rows={attention} money={money} />
          )}
        </SectionCard>
      </div>

      {fine.length > 0 ? (
        <details className="mt-4 rounded-xl border bg-card">
          <summary className="cursor-pointer px-5 py-4 text-sm font-medium">
            Everything else — {fine.length} item{fine.length === 1 ? '' : 's'} with enough stock and steady usage
          </summary>
          <div className="border-t">
            <OutlookTable rows={fine} money={money} />
          </div>
        </details>
      ) : null}
    </>
  )
}

function OutlookTable({ rows, money }: { rows: InventoryOutlookRow[]; money: (value: number) => string }) {
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Item</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="text-right">On hand</TableHead>
            <TableHead className="text-right">Avg daily usage</TableHead>
            <TableHead className="text-right">Days remaining</TableHead>
            <TableHead className="text-right">Recommend ordering</TableHead>
            <TableHead>Basis</TableHead>
            <TableHead className="text-right">Lead time</TableHead>
            <TableHead>Supplier</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => {
            const meta = OUTLOOK_META[row.outlook]
            return (
              <TableRow key={row.itemId}>
                <TableCell className="font-medium">
                  <Link href={`/dashboard/inventory/${row.itemId}`} className="hover:underline">
                    {row.name}
                  </Link>
                </TableCell>
                <TableCell>
                  <Badge variant={meta.tone}>{meta.label}</Badge>
                </TableCell>
                <TableCell className="text-right tabular-nums">{formatQuantity(row.available, row.unit)}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {row.avgDailyUsage > 0 ? `${formatQuantity(row.avgDailyUsage, row.unit)}/day` : '—'}
                  {row.observedDays < 27 && row.avgDailyUsage > 0 ? (
                    <span className="block text-[11px] text-muted-foreground">over {Math.round(row.observedDays)} days</span>
                  ) : null}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {row.daysRemaining === null ? '—' : row.daysRemaining === 0 ? 'out' : `${row.daysRemaining} d`}
                </TableCell>
                <TableCell className="text-right font-semibold tabular-nums">
                  {row.recommendedQty > 0 ? (
                    <>
                      {formatQuantity(row.recommendedQty, row.unit)}
                      <span className="block text-[11px] font-normal text-muted-foreground">
                        {row.purchaseUnits !== null ? `${row.purchaseUnits} pack${row.purchaseUnits === 1 ? '' : 's'} · ` : ''}
                        ≈ {money(row.estimatedCost)}
                      </span>
                    </>
                  ) : (
                    <span className="font-normal text-muted-foreground">nothing</span>
                  )}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {row.basis === 'usage' ? 'usage rate' : row.basis === 'threshold' ? 'reorder rule' : '—'}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {row.leadTimeDays !== null ? `${row.leadTimeDays} d` : '—'}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">{row.supplierName ?? '—'}</TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </div>
  )
}
