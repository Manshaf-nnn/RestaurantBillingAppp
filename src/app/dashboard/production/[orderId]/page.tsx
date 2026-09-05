import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { LocalDateTime } from '@/components/local-time'
import { PageHeader, SectionCard, StatCard } from '@/features/dashboard/components/page-header'
import { getProductionRun } from '@/features/production/queries'
import { formatMoney } from '@/lib/money'
import { PERMISSIONS, canAccessBranch } from '@/lib/rbac'
import { requirePagePermission } from '@/server/auth/guard'
import { requireRestaurant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Production run' }

/**
 * One production run, in full.
 *
 * The traceability panel links here for every "where did this stock come
 * from" trail that ends at a production run, so the route outlives the flow
 * above it. It reads runs from the recipe era as well as Make Item runs.
 *
 * Arranged around the one thing a run has to explain: what left stock, what
 * was thrown away, and what arrived — carrying exactly the value that left.
 */
export default async function ProductionRunPage({
  params,
}: {
  params: Promise<{ orderId: string }>
}) {
  const { orderId } = await params
  const user = await requirePagePermission(
    PERMISSIONS.PRODUCTION_VIEW,
    `/dashboard/production/${orderId}`,
  )

  const run = await getProductionRun({ restaurantId: user.restaurantId, orderId })
  if (!run) notFound()

  // A run at a branch this person has nothing to do with is not theirs to
  // read, id in the address bar or not.
  if (!canAccessBranch(user, run.branchId)) notFound()

  const restaurant = await requireRestaurant(user.restaurantId)
  const money = (m: number) => formatMoney(m, restaurant.currency)
  const unit = (run.unit ?? '').toLowerCase()
  const cancelled = run.status === 'CANCELLED'

  return (
    <>
      <Link
        href="/dashboard/production"
        className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        Kitchen Production
      </Link>

      <PageHeader
        title={run.itemName}
        description={`${run.producedQty ?? run.plannedQty} ${unit} · ${run.branchName}${run.madeBy ? ` · ${run.madeBy}` : ''}`}
        actions={
          <span className="flex items-center gap-2">
            {cancelled ? <Badge variant="destructive">Cancelled</Badge> : null}
            <span className="font-mono text-xs text-muted-foreground">{run.number}</span>
          </span>
        }
      />

      {!cancelled ? (
        <div className="mb-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard label="Produced" value={`${run.producedQty ?? 0} ${unit}`.trim()} />
          <StatCard label="Ingredients" value={money(run.materialCost)} />
          <StatCard label={`Cost per ${unit || 'unit'}`} value={money(run.unitCost)} tone="primary" />
          <StatCard
            label="Waste"
            value={money(run.wasteCost)}
            tone={run.wasteCost > 0 ? 'warning' : 'default'}
            hint={run.wasteCost > 0 ? 'Expensed — not in the item’s cost' : 'None recorded'}
          />
        </div>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <SectionCard title="What went in" description="Left stock at its average cost at the time. The exact value moved into the prepared item.">
            {run.consumption.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {cancelled ? 'Nothing — this run was cancelled before anything moved.' : 'Nothing was consumed.'}
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-muted-foreground">
                      <th className="pb-2 font-medium">Item</th>
                      <th className="pb-2 text-right font-medium">Quantity</th>
                      <th className="pb-2 text-right font-medium">Unit cost</th>
                      <th className="pb-2 text-right font-medium">Value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {run.consumption.map((line) => (
                      <tr key={line.id} className="border-b border-border/50 last:border-0">
                        <td className="py-2">
                          <Link href={`/dashboard/inventory/${line.itemId}`} className="hover:underline">
                            {line.name}
                          </Link>
                        </td>
                        <td className="py-2 text-right tabular-nums">{line.quantity} {line.unit.toLowerCase()}</td>
                        <td className="py-2 text-right tabular-nums text-muted-foreground">{money(line.unitCost)}</td>
                        <td className="py-2 text-right tabular-nums">{money(line.lineCost)}</td>
                      </tr>
                    ))}
                    <tr className="font-medium">
                      <td className="pt-2" colSpan={3}>Moved into the prepared item</td>
                      <td className="pt-2 text-right tabular-nums">{money(run.materialCost)}</td>
                    </tr>
                    {run.overheadCost > 0 ? (
                      <tr className="text-muted-foreground">
                        <td colSpan={3}>Overheads (recorded under the previous flow)</td>
                        <td className="text-right tabular-nums">{money(run.overheadCost)}</td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
            )}
          </SectionCard>

          {run.wastage.length > 0 ? (
            <SectionCard title="Thrown away" description="Recorded as waste in the same transaction. Expensed, and kept out of the item’s cost.">
              <ul className="divide-y divide-border">
                {run.wastage.map((record) => (
                  <li key={record.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                    <span>
                      <Link href={`/dashboard/inventory/${record.itemId}`} className="hover:underline">{record.name}</Link>
                      {record.note ? <span className="text-muted-foreground"> — {record.note}</span> : null}
                    </span>
                    <span className="tabular-nums text-muted-foreground">
                      {record.quantity} {record.unit.toLowerCase()} · {money(record.costValue)}
                    </span>
                  </li>
                ))}
              </ul>
            </SectionCard>
          ) : null}

          <SectionCard title="What came out">
            {run.outputs.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing was produced.</p>
            ) : (
              <ul className="divide-y divide-border">
                {run.outputs.map((out) => (
                  <li key={out.id} className="flex items-center justify-between py-2 text-sm">
                    <Link href={`/dashboard/inventory/${out.itemId}`} className="font-medium hover:underline">
                      {out.name}
                    </Link>
                    <span className="tabular-nums">
                      {out.quantity} {out.unit.toLowerCase()} · {money(out.unitCost)} each
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {run.variance !== null && run.variance < 0 ? (
              <p className="mt-3 text-xs text-muted-foreground">
                Recorded under the previous flow: {Math.abs(run.variance)} {unit} short of the {run.plannedQty} planned
                {run.varianceReason ? ` (${run.varianceReason.replace(/_/g, ' ').toLowerCase()})` : ''}.
              </p>
            ) : null}
          </SectionCard>
        </div>

        <div className="space-y-5">
          <SectionCard title="The run">
            <dl className="space-y-2.5 text-sm">
              <Row label="Reference">{run.number}</Row>
              <Row label="Where">{run.branchName}</Row>
              <Row label="Made by">{run.madeBy ?? 'Someone'}</Row>
              <Row label="When">
                <LocalDateTime value={run.completedAt ?? run.createdAt} />
              </Row>
              {run.batchNumber ? <Row label="Batch">{run.batchNumber}</Row> : null}
              {run.notes ? <Row label="Notes">{run.notes}</Row> : null}
            </dl>
          </SectionCard>
        </div>
      </div>
    </>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[6.5rem_1fr] gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd>{children}</dd>
    </div>
  )
}
