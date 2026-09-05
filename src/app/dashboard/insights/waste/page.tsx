import type { Metadata } from 'next'
import Link from 'next/link'

import { EmptyState } from '@/components/ui/feedback'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { InfoTip } from '@/features/accounting/components/info-tip'
import { PageHeader, SectionCard, StatCard } from '@/features/dashboard/components/page-header'
import { PeriodPicker } from '@/features/dashboard/components/period-picker'
import { scopeToOne, selectedBranch } from '@/features/dashboard/selected-branch'
import { getWasteIntelligence } from '@/features/insights/queries'
import { formatQuantity } from '@/features/inventory/units'
import { describeRange, resolveRange } from '@/features/reports/range'
import { formatMoney } from '@/lib/money'
import { PERMISSIONS } from '@/lib/rbac'
import type { StockUnit } from '@prisma/client'
import { requirePagePermission } from '@/server/auth/guard'
import { requireRestaurant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Waste' }

/**
 * Waste Intelligence (smart.md §5): where the money went in the bin — by
 * item, category and reason — valued at what the stock cost when it was
 * thrown away, and set against the ingredient cost of what sold. The wastage
 * report owns every figure here.
 */
export default async function WasteInsightsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const user = await requirePagePermission(PERMISSIONS.ACCOUNTING_VIEW, '/dashboard/insights/waste')
  const restaurant = await requireRestaurant(user.restaurantId)
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
  const periodLabel = describeRange(range)

  if (selection.confinedWithNoBranch) {
    return (
      <>
        <PageHeader title="Waste" description={restaurant.name} />
        <EmptyState title="No location assigned" description="Ask an owner to assign your account to a location." />
      </>
    )
  }

  const data = await getWasteIntelligence({ restaurantId: user.restaurantId, range, branchIds })
  const { report } = data

  return (
    <>
      <PageHeader
        title="Waste"
        description={`${periodLabel} · ${restaurant.name} — every figure is the recorded cost at the moment the stock was thrown away.`}
        actions={
          <>
            <Link href="/dashboard/insights" className="text-sm font-medium text-primary underline-offset-2 hover:underline">
              ← Command Center
            </Link>
            <Link href="/dashboard/inventory/wastage" className="text-sm font-medium text-primary underline-offset-2 hover:underline">
              Wastage board
            </Link>
          </>
        }
      />
      <div className="mb-5">
        <PeriodPicker preset={range.preset} from={str('from')} to={str('to')} label={periodLabel} />
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Total waste"
          info={<InfoTip term="wastage" />}
          value={money(report.totalValue)}
          tone={report.totalValue > 0 ? 'warning' : 'success'}
          hint={`${report.totalRecords} record${report.totalRecords === 1 ? '' : 's'}`}
          href="/dashboard/inventory/wastage"
        />
        <StatCard
          label="Share of COGS"
          info={<InfoTip term="wasteShare" />}
          value={data.shareOfCogsPercent !== null ? `${data.shareOfCogsPercent}%` : '—'}
          tone={data.shareOfCogsPercent !== null && data.shareOfCogsPercent > 5 ? 'destructive' : 'default'}
          hint={data.cogs > 0 ? `against ${money(data.cogs)} of ingredients sold` : 'no costed sales in this period'}
          href="/dashboard/reports/profit"
        />
        <StatCard
          label="Biggest single loss"
          value={data.biggest ? data.biggest.name : '—'}
          hint={data.biggest ? `${money(data.biggest.value)} · ${formatQuantity(data.biggest.quantity, data.biggest.unit as StockUnit)}` : 'nothing wasted'}
          href={data.biggest ? `/dashboard/inventory/${data.biggest.itemId}` : undefined}
        />
        <StatCard
          label="Top reason"
          value={report.byReason[0]?.label ?? '—'}
          hint={report.byReason[0] ? `${money(report.byReason[0].value)} · ${report.byReason[0].share}% of waste` : 'nothing wasted'}
        />
      </div>

      {report.totalRecords === 0 ? (
        <div className="mt-6">
          <EmptyState title="No waste recorded in this period" description="Good — or nobody is recording it. The wastage board is where the kitchen writes it down." />
        </div>
      ) : (
        <>
          <div className="mt-6 grid gap-4 lg:grid-cols-2">
            <SectionCard title="By category" description="The item’s stock category." bodyClassName="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Category</TableHead>
                    <TableHead className="text-right">Records</TableHead>
                    <TableHead className="text-right">Value</TableHead>
                    <TableHead className="text-right">Share</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {report.byCategory.map((row) => (
                    <TableRow key={row.key}>
                      <TableCell className="font-medium">{row.name}</TableCell>
                      <TableCell className="text-right tabular-nums">{row.count}</TableCell>
                      <TableCell className="text-right font-semibold tabular-nums">{money(row.value)}</TableCell>
                      <TableCell className="text-right tabular-nums">{row.share}%</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </SectionCard>

            <SectionCard title="By reason" description="Why it was thrown away." bodyClassName="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Reason</TableHead>
                    <TableHead className="text-right">Records</TableHead>
                    <TableHead className="text-right">Value</TableHead>
                    <TableHead className="text-right">Share</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {report.byReason.map((row) => (
                    <TableRow key={row.reason}>
                      <TableCell className="font-medium">{row.label}</TableCell>
                      <TableCell className="text-right tabular-nums">{row.count}</TableCell>
                      <TableCell className="text-right font-semibold tabular-nums">{money(row.value)}</TableCell>
                      <TableCell className="text-right tabular-nums">{row.share}%</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </SectionCard>
          </div>

          <div className="mt-4">
            <SectionCard title="Biggest sources of loss" description="Items, largest value first. Click through to the item’s history." bodyClassName="p-0">
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Item</TableHead>
                      <TableHead className="text-right">Quantity</TableHead>
                      <TableHead className="text-right">Value</TableHead>
                      <TableHead className="text-right">Share</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {report.topItems.map((row) => (
                      <TableRow key={row.itemId}>
                        <TableCell className="font-medium">
                          <Link href={`/dashboard/inventory/${row.itemId}`} className="hover:underline">
                            {row.name}
                          </Link>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{formatQuantity(row.quantity, row.unit as StockUnit)}</TableCell>
                        <TableCell className="text-right font-semibold tabular-nums">{money(row.value)}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {report.totalValue > 0 ? `${Math.round((row.value / report.totalValue) * 1000) / 10}%` : '—'}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </SectionCard>
          </div>

          {report.byBranch.length > 1 ? (
            <div className="mt-4">
              <SectionCard title="By location" bodyClassName="p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Location</TableHead>
                      <TableHead className="text-right">Records</TableHead>
                      <TableHead className="text-right">Value</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {report.byBranch.map((row) => (
                      <TableRow key={row.branchId ?? 'none'}>
                        <TableCell className="font-medium">{row.name}</TableCell>
                        <TableCell className="text-right tabular-nums">{row.count}</TableCell>
                        <TableCell className="text-right font-semibold tabular-nums">{money(row.value)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </SectionCard>
            </div>
          ) : null}
        </>
      )}

      <p className="mt-4 text-xs text-muted-foreground">
        Waste is an expense on its own line and never enters COGS. Preparation waste recorded during kitchen
        production is included under its own reason.
      </p>
    </>
  )
}
