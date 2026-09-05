import Link from 'next/link'
import type { Metadata } from 'next'
import { AlertTriangle, Factory } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { EmptyState } from '@/components/ui/feedback'
import { LocalDateTime } from '@/components/local-time'
import { PageHeader, SectionCard, StatCard } from '@/features/dashboard/components/page-header'
import { getProductionConsoleData, getProductionDashboard } from '@/features/production/queries'
import { ProductionConsole } from '@/features/production/components/production-console'
import { formatMoney } from '@/lib/money'
import { PERMISSIONS, can} from '@/lib/rbac'
import { selectedBranch } from '@/features/dashboard/selected-branch'
import { requirePagePermission } from '@/server/auth/guard'
import { requireRestaurant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Kitchen jobs' }

export default async function ProductionPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const user = await requirePagePermission(PERMISSIONS.PRODUCTION_VIEW, '/dashboard/production')
  const restaurant = await requireRestaurant(user.restaurantId)

  /*
   * The switcher can name any location, but production only ever happens at a
   * production house. Passing a shop through would match no house and blank the
   * page, so a selection is honoured only when it IS a house; otherwise the
   * default house is shown. Someone standing in Kandy asking about production
   * wants to see the kitchen that supplies them, not an empty screen.
   */
  const selection = await selectedBranch(user, await searchParams)

  const [data, console_] = await Promise.all([
    getProductionDashboard({ restaurantId: user.restaurantId, branchId: selection.branchId }),
    getProductionConsoleData({
      restaurantId: user.restaurantId,
      currency: restaurant.currency,
      branchId: selection.branchId,
    }),
  ])
  const money = (m: number) => formatMoney(m, restaurant.currency)

  if (!data.house) {
    return (
      <>
        <PageHeader title="Kitchen jobs" description="Things you make rather than buy." />
        <SectionCard title="No production kitchen">
          <EmptyState
            title="No production house set up"
            description="Add a location of type Production house, and kitchen jobs will appear here."
          />
        </SectionCard>
      </>
    )
  }

  return (
    <>
      <PageHeader
        actions={
          can(user, PERMISSIONS.PRODUCTION_MANAGE) ? (
            <Link
              href="/dashboard/production/recipes"
              className="text-sm text-muted-foreground transition hover:text-foreground"
            >
              Make-ahead recipes
            </Link>
          ) : null
        }
        title="Kitchen jobs"
        description={`${data.house.name} — ingredients in, a finished item out. Every job posts to the same stock ledger.`}
      />

      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Jobs done today" value={String(data.today.runs)} />
        <StatCard label="Made today" value={String(Math.round(data.today.produced * 100) / 100)} />
        <StatCard label="Cost today" value={money(data.today.cost)} />
        <StatCard label="Cost this week" value={money(data.week.cost)} />
      </div>

      {data.pending.length > 0 && (
        <SectionCard
          title="Not finished yet"
          description="Nothing here has taken anything from stock — that happens when a job is marked done."
          actions={<Badge variant="warning">{data.pending.length}</Badge>}
        >
          <ul className="divide-y divide-border">
            {data.pending.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center gap-3 py-2.5 text-sm">
                <Factory className="h-4 w-4 shrink-0 text-muted-foreground" />
                <Link href={`/dashboard/production/${p.id}`} className="font-medium tabular-nums hover:underline">
                  {p.number}
                </Link>
                <span>{p.recipeName ?? 'Job'}</span>
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

      {can(user, PERMISSIONS.PRODUCTION_MANAGE) && (
        <div className="mb-5">
          {/*
            No `canApprove` any more: approval left the flow (kitchenjobs.md).
            It gated the one step that moved no stock, while completion — which
            moves all of it — needed only `production.manage`, which is the
            permission guarding this whole block.
          */}
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
                      <Link
                        href={`/dashboard/production/${r.id}`}
                        className="font-medium tabular-nums hover:underline"
                      >
                        {r.number}
                      </Link>
                      {r.batchNumber && (
                        <span className="block font-mono text-xs text-muted-foreground">{r.batchNumber}</span>
                      )}
                    </td>
                    <td className="py-2.5 pr-3">{r.recipeName ?? '—'}</td>
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
