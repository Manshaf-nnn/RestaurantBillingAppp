import type { Metadata } from 'next'
import { AlertTriangle, Factory } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { EmptyState } from '@/components/ui/feedback'
import { LocalDateTime } from '@/components/local-time'
import { PageHeader, SectionCard, StatCard } from '@/features/dashboard/components/page-header'
import { getProductionConsoleData, getProductionDashboard } from '@/features/production/queries'
import { ProductionConsole } from '@/features/production/components/production-console'
import { formatMoney } from '@/lib/money'
import { PERMISSIONS } from '@/lib/rbac'
import { requirePagePermission } from '@/server/auth/guard'
import { requireRestaurant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Production' }

export default async function ProductionPage() {
  const user = await requirePagePermission(PERMISSIONS.PRODUCTION_VIEW, '/dashboard/production')
  const restaurant = await requireRestaurant(user.restaurantId)
  const [data, console_] = await Promise.all([
    getProductionDashboard({ restaurantId: user.restaurantId }),
    getProductionConsoleData({ restaurantId: user.restaurantId, currency: restaurant.currency }),
  ])
  const money = (m: number) => formatMoney(m, restaurant.currency)

  if (!data.house) {
    return (
      <>
        <PageHeader title="Production" description="Making stock from other stock." />
        <SectionCard title="No production house">
          <EmptyState
            title="No production house set up"
            description="Add a location of type Production house, and runs will appear here."
          />
        </SectionCard>
      </>
    )
  }

  return (
    <>
      <PageHeader
        title="Production"
        description={`${data.house.name} — raw materials in, finished goods out. Every run posts to the same stock ledger.`}
      />

      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Runs today" value={String(data.today.runs)} />
        <StatCard label="Produced today" value={String(Math.round(data.today.produced * 100) / 100)} />
        <StatCard label="Cost today" value={money(data.today.cost)} />
        <StatCard label="Cost this week" value={money(data.week.cost)} />
      </div>

      {data.pending.length > 0 && (
        <SectionCard
          title="Not finished yet"
          description="Nothing here has consumed anything — stock only moves when a run is completed."
          actions={<Badge variant="warning">{data.pending.length}</Badge>}
        >
          <ul className="divide-y divide-border">
            {data.pending.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center gap-3 py-2.5 text-sm">
                <Factory className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="font-medium tabular-nums">{p.number}</span>
                <span>{p.specName ?? 'Run'}</span>
                <Badge variant="secondary">{p.status.replace(/_/g, ' ').toLowerCase()}</Badge>
                <span className="text-muted-foreground">{p.plannedQty} planned</span>
                <span className="ml-auto text-xs text-muted-foreground">{p.requestedByName ?? ''}</span>
              </li>
            ))}
          </ul>
        </SectionCard>
      )}

      {data.expiringBatches.length > 0 && (
        <SectionCard
          title="Finished goods going off"
          description="Batches made here with less than a week left. Send or use them first."
        >
          <ul className="divide-y divide-border">
            {data.expiringBatches.map((b) => (
              <li key={b.batchNo} className="flex flex-wrap items-center gap-3 py-2.5 text-sm">
                <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
                <span className="font-medium">{b.itemName}</span>
                <span className="font-mono text-xs text-muted-foreground">{b.batchNo}</span>
                <span className="tabular-nums">{b.remainingQty} {b.unit.toLowerCase()}</span>
                <span className="ml-auto text-xs text-amber-600 dark:text-amber-400">
                  {b.daysLeft === null ? '' : b.daysLeft < 0 ? `${Math.abs(b.daysLeft)} days ago` : b.daysLeft === 0 ? 'today' : `in ${b.daysLeft} days`}
                </span>
              </li>
            ))}
          </ul>
        </SectionCard>
      )}

      {user.permissions.includes(PERMISSIONS.PRODUCTION_MANAGE) && (
        <div className="mb-5">
          <ProductionConsole data={console_} />
        </div>
      )}

      <SectionCard title="Completed runs" description="What was planned, what was made, and what it cost.">
        {data.recent.length === 0 ? (
          <EmptyState title="No completed runs" description="Finished production appears here with its cost and variance." />
        ) : (
          <div className="-mx-2 overflow-x-auto px-2">
            <table className="w-full min-w-[44rem] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="pb-2 pr-3 font-medium">Run</th>
                  <th className="pb-2 pr-3 font-medium">Product</th>
                  <th className="pb-2 pr-3 text-right font-medium">Planned</th>
                  <th className="pb-2 pr-3 text-right font-medium">Made</th>
                  <th className="pb-2 pr-3 text-right font-medium">Variance</th>
                  <th className="pb-2 pr-3 text-right font-medium">Cost</th>
                  <th className="pb-2 text-right font-medium">Per unit</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {data.recent.map((r) => (
                  <tr key={r.id}>
                    <td className="py-2.5 pr-3">
                      <span className="font-medium tabular-nums">{r.number}</span>
                      {r.batchNumber && (
                        <span className="block font-mono text-xs text-muted-foreground">{r.batchNumber}</span>
                      )}
                    </td>
                    <td className="py-2.5 pr-3">{r.specName ?? '—'}</td>
                    <td className="py-2.5 pr-3 text-right tabular-nums text-muted-foreground">{r.plannedQty}</td>
                    <td className="py-2.5 pr-3 text-right tabular-nums">{r.actualQty ?? '—'}</td>
                    <td className="py-2.5 pr-3 text-right tabular-nums">
                      {!r.variance ? (
                        <span className="text-emerald-600 dark:text-emerald-400">0</span>
                      ) : (
                        <span className="text-amber-600 dark:text-amber-400" title={r.varianceReason ?? ''}>
                          {r.variance}
                        </span>
                      )}
                    </td>
                    <td className="py-2.5 pr-3 text-right tabular-nums">{money(r.totalCost)}</td>
                    <td className="py-2.5 text-right tabular-nums">{money(r.unitCost)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>
    </>
  )
}
