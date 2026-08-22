import type { Metadata } from 'next'
import Link from 'next/link'

import { Badge } from '@/components/ui/badge'
import { EmptyState } from '@/components/ui/feedback'
import { PageHeader, SectionCard, StatCard } from '@/features/dashboard/components/page-header'
import { getExpirySummary, listExpiringStock, type ExpiryBucket } from '@/features/inventory/batches'
import { formatMoney } from '@/lib/money'
import { scopeToOne, selectedBranch } from '@/features/dashboard/selected-branch'
import { PERMISSIONS } from '@/lib/rbac'
import { requirePagePermission } from '@/server/auth/guard'
import { requireRestaurant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Expiry' }

const BUCKETS: Array<{ key: ExpiryBucket; label: string; variant: 'destructive' | 'warning' | 'secondary' }> = [
  { key: 'EXPIRED', label: 'Expired', variant: 'destructive' },
  { key: 'TODAY', label: 'Expires today', variant: 'destructive' },
  { key: 'WITHIN_3', label: 'Within 3 days', variant: 'warning' },
  { key: 'WITHIN_7', label: 'Within 7 days', variant: 'warning' },
  { key: 'WITHIN_PERIOD', label: 'Later', variant: 'secondary' },
]

export default async function ExpiryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const user = await requirePagePermission(PERMISSIONS.INVENTORY_EXPIRY_VIEW, '/dashboard/inventory/expiry')
  const restaurant = await requireRestaurant(user.restaurantId)
  const money = (m: number) => formatMoney(m, restaurant.currency)

  const params = await searchParams
  const raw = Number(typeof params.days === 'string' ? params.days : '')
  const periodDays = Number.isFinite(raw) && raw > 0 && raw <= 365 ? raw : 30


  // Stock sits at a location, so this list belongs to one. Without it a branch
  // manager was reading the whole group's shelves.
  const selection = await selectedBranch(user, params)
  const branchId = scopeToOne(selection)

  const [rows, summary] = await Promise.all([
    listExpiringStock({ restaurantId: user.restaurantId, periodDays, branchId }),
    getExpirySummary({ restaurantId: user.restaurantId, periodDays, branchId }),
  ])

  const atRisk =
    summary.EXPIRED.value + summary.TODAY.value + summary.WITHIN_3.value + summary.WITHIN_7.value

  return (
    <>
      <PageHeader
        title="Expiry"
        description={`Batches dated within the next ${periodDays} days, soonest first. Only items with batch tracking on appear here.`}
      />

      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Already expired" value={String(summary.EXPIRED.count)} />
        <StatCard label="Expires today" value={String(summary.TODAY.count)} />
        <StatCard label="Within 7 days" value={String(summary.WITHIN_3.count + summary.WITHIN_7.count)} />
        <StatCard label="Value at risk" value={money(atRisk)} />
      </div>

      <SectionCard
        title="Batches"
        description="Use the soonest first — that is what FEFO does automatically for items configured for it."
      >
        {rows.length === 0 ? (
          <EmptyState
            title="Nothing expiring"
            description="Turn on batch tracking for an item and record expiry dates when receiving, and dated stock appears here."
          />
        ) : (
          <div className="-mx-2 overflow-x-auto px-2">
            <table className="w-full min-w-[40rem] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="pb-2 pr-3 font-medium">Item</th>
                  <th className="pb-2 pr-3 font-medium">Batch</th>
                  <th className="pb-2 pr-3 text-right font-medium">Remaining</th>
                  <th className="pb-2 pr-3 font-medium">Expires</th>
                  <th className="pb-2 pr-3 font-medium">Status</th>
                  <th className="pb-2 text-right font-medium">At risk</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((row) => {
                  const bucket = BUCKETS.find((b) => b.key === row.bucket)
                  return (
                    <tr key={row.batchId}>
                      <td className="py-2.5 pr-3">
                        <Link
                          href={`/dashboard/inventory/${row.itemId}`}
                          className="font-medium text-primary underline-offset-2 hover:underline"
                        >
                          {row.itemName}
                        </Link>
                        {row.locationName && (
                          <span className="block text-xs text-muted-foreground">{row.locationName}</span>
                        )}
                      </td>
                      <td className="py-2.5 pr-3 font-mono text-xs">{row.batchNo}</td>
                      <td className="py-2.5 pr-3 text-right tabular-nums">
                        {row.remainingQty} {row.unit.toLowerCase()}
                      </td>
                      <td className="py-2.5 pr-3 tabular-nums text-muted-foreground">
                        {row.daysLeft === null
                          ? '—'
                          : row.daysLeft < 0
                            ? `${Math.abs(row.daysLeft)} days ago`
                            : row.daysLeft === 0
                              ? 'today'
                              : `in ${row.daysLeft} days`}
                      </td>
                      <td className="py-2.5 pr-3">
                        {bucket && <Badge variant={bucket.variant}>{bucket.label}</Badge>}
                      </td>
                      <td className="py-2.5 text-right tabular-nums">{money(row.valueAtRisk)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>
    </>
  )
}
