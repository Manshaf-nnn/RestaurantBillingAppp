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

const STATUS: Record<string, { label: string; variant: 'secondary' | 'warning' | 'success' | 'destructive' }> = {
  DRAFT: { label: 'Draft', variant: 'secondary' },
  PLANNED: { label: 'Planned', variant: 'secondary' },
  APPROVED: { label: 'Approved', variant: 'warning' },
  IN_PROGRESS: { label: 'In progress', variant: 'warning' },
  COMPLETED: { label: 'Completed', variant: 'success' },
  PARTIALLY_COMPLETED: { label: 'Partly completed', variant: 'warning' },
  CANCELLED: { label: 'Cancelled', variant: 'destructive' },
}

const VARIANCE_REASON: Record<string, string> = {
  PRODUCTION_LOSS: 'Production loss',
  DAMAGED: 'Damaged',
  INGREDIENT_SHORTAGE: 'Ingredient shortage',
  QUALITY_ISSUE: 'Quality issue',
  OTHER: 'Other',
}

/**
 * One production run, in full.
 *
 * This route was linked to from the traceability panel and did not exist, so
 * every "where did this stock come from" trail that ended at a production run
 * ended at a 404 instead. The link was right all along.
 *
 * The page is arranged around the one thing a run has to explain: materials
 * were issued against the PLAN, output is what actually came off the line, and
 * the gap between them is what each finished unit really cost.
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

  // A run at a production house this person has nothing to do with is not
  // theirs to read, id in the address bar or not.
  if (!canAccessBranch(user, run.branchId)) notFound()

  const restaurant = await requireRestaurant(user.restaurantId)
  const money = (m: number) => formatMoney(m, restaurant.currency)
  const status = STATUS[run.status] ?? { label: run.status, variant: 'secondary' as const }

  const finished = run.status === 'COMPLETED' || run.status === 'PARTIALLY_COMPLETED'
  const plannedOutput = run.outputQtyPerBatch ? run.plannedQty * run.outputQtyPerBatch : null
  const actualOutput =
    run.actualQty !== null && run.outputQtyPerBatch ? run.actualQty * run.outputQtyPerBatch : null

  return (
    <>
      <Link
        href="/dashboard/production"
        className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        Production
      </Link>

      <PageHeader
        title={run.number}
        description={`${run.specName ?? 'No recipe'} · ${run.branchName}`}
        actions={<Badge variant={status.variant}>{status.label}</Badge>}
      />

      {finished ? (
        <div className="mb-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard
            label="Produced"
            value={
              actualOutput !== null
                ? `${actualOutput} ${run.outputUnit ?? ''}`.trim()
                : `${run.actualQty ?? 0} batches`
            }
          />
          <StatCard label="Materials" value={money(run.materialCost)} />
          <StatCard label="Overheads" value={money(run.overheadCost)} />
          <StatCard label="Cost each" value={money(run.unitCost)} tone="primary" />
        </div>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="lg:col-span-2 space-y-5">
          <SectionCard
            title="What went in"
            description="Issued against the plan, not against what came out. That is deliberate — see below."
          >
            {run.consumption.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Nothing has been consumed yet. Materials leave the shelves when the run is
                completed, not when it is planned or approved.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-muted-foreground">
                      <th className="pb-2 font-medium">Item</th>
                      <th className="pb-2 text-right font-medium">Quantity</th>
                      <th className="pb-2 text-right font-medium">Unit cost</th>
                      <th className="pb-2 text-right font-medium">Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {run.consumption.map((line) => (
                      <tr key={line.id} className="border-b border-border/50 last:border-0">
                        <td className="py-2">
                          <Link
                            href={`/dashboard/inventory/${line.itemId}`}
                            className="hover:underline"
                          >
                            {line.name}
                          </Link>
                        </td>
                        <td className="py-2 text-right tabular-nums">
                          {line.quantity} {line.unit}
                        </td>
                        <td className="py-2 text-right tabular-nums text-muted-foreground">
                          {money(line.unitCost)}
                        </td>
                        <td className="py-2 text-right tabular-nums">{money(line.lineCost)}</td>
                      </tr>
                    ))}
                    <tr className="font-medium">
                      <td className="pt-2" colSpan={3}>
                        Materials
                      </td>
                      <td className="pt-2 text-right tabular-nums">{money(run.materialCost)}</td>
                    </tr>
                    {run.overheadCost > 0 ? (
                      <>
                        <tr className="text-muted-foreground">
                          <td colSpan={3}>Overheads — labour, power, anything not an ingredient</td>
                          <td className="text-right tabular-nums">{money(run.overheadCost)}</td>
                        </tr>
                        <tr className="font-medium">
                          <td className="pt-1" colSpan={3}>
                            Run total
                          </td>
                          <td className="pt-1 text-right tabular-nums">
                            {money(run.materialCost + run.overheadCost)}
                          </td>
                        </tr>
                      </>
                    ) : null}
                  </tbody>
                </table>
              </div>
            )}
          </SectionCard>

          <SectionCard title="What came out">
            {run.outputs.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Nothing yet. Finished goods appear when the run is completed.
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {run.outputs.map((out) => (
                  <li key={out.id} className="flex items-center justify-between py-2 text-sm">
                    <Link href={`/dashboard/inventory/${out.itemId}`} className="hover:underline">
                      {out.name}
                    </Link>
                    <span className="tabular-nums">
                      {out.quantity} {out.unit}
                    </span>
                  </li>
                ))}
              </ul>
            )}

            {finished && run.variance !== null && run.variance < 0 ? (
              <div className="mt-3 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
                <p className="font-medium">
                  {Math.abs(run.variance)} batch{Math.abs(run.variance) === 1 ? '' : 'es'} short of
                  plan
                </p>
                <p className="mt-1 text-muted-foreground">
                  {run.varianceReason ? VARIANCE_REASON[run.varianceReason] ?? run.varianceReason : 'No reason given'}
                  {run.varianceNote ? ` — ${run.varianceNote}` : ''}
                </p>
                <p className="mt-2 text-muted-foreground">
                  All {run.plannedQty} batches&apos; worth of materials was consumed, because it
                  was — the cost is spread over the {run.actualQty ?? 0} that came out, so each one
                  cost more than it would on a good day. A system that consumed only what it
                  produced would report this run as perfectly efficient.
                </p>
              </div>
            ) : null}
          </SectionCard>
        </div>

        <div className="space-y-5">
          <SectionCard title="The run">
            <dl className="space-y-2.5 text-sm">
              <Row label="Plan">
                {run.plannedQty} batch{run.plannedQty === 1 ? '' : 'es'}
                {plannedOutput !== null ? (
                  <span className="text-muted-foreground">
                    {' '}
                    = {plannedOutput} {run.outputUnit ?? ''} of {run.outputName}
                  </span>
                ) : null}
              </Row>
              {run.actualQty !== null ? (
                <Row label="Actual">
                  {run.actualQty} batch{run.actualQty === 1 ? '' : 'es'}
                  {actualOutput !== null ? (
                    <span className="text-muted-foreground">
                      {' '}
                      = {actualOutput} {run.outputUnit ?? ''}
                    </span>
                  ) : null}
                </Row>
              ) : null}
              {run.batchNumber ? <Row label="Batch">{run.batchNumber}</Row> : null}
              {run.expiryDate ? (
                <Row label="Expires">
                  <LocalDateTime value={run.expiryDate} />
                </Row>
              ) : null}
              {run.notes ? <Row label="Notes">{run.notes}</Row> : null}
            </dl>
          </SectionCard>

          <SectionCard title="Who and when">
            <dl className="space-y-2.5 text-sm">
              <Row label="Planned">
                {run.requestedByName ?? 'Someone'} · <LocalDateTime value={run.createdAt} />
              </Row>
              {run.approvedAt ? (
                <Row label="Approved">
                  {run.approvedByName ?? 'Someone'} · <LocalDateTime value={run.approvedAt} />
                </Row>
              ) : null}
              {run.startedAt ? (
                <Row label="Started">
                  <LocalDateTime value={run.startedAt} />
                </Row>
              ) : null}
              {run.completedAt ? (
                <Row label="Completed">
                  <LocalDateTime value={run.completedAt} />
                </Row>
              ) : null}
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
