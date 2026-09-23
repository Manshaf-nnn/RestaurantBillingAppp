'use client'

import * as React from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { PackageCheck } from 'lucide-react'
import type { StockUnit } from '@prisma/client'
import { toast } from 'sonner'

import { Alert } from '@/components/ui/feedback'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/primitives'
import { LocalDateTime } from '@/components/local-time'
import { SectionCard } from '@/features/dashboard/components/page-header'
import { UNIT_LABELS, formatQuantity } from '@/features/inventory/units'
import { formatMoney, minorUnitFactor } from '@/lib/money'
import { useAction } from '@/lib/use-action'
import { issueIngredientsAction } from '../actions'
import type { ProductionRun } from '../queries'
import { CompleteProductionForm } from './mark-done-form'

/**
 * A production order, screens 4 to 6 (pro.b.md §4–§8).
 *
 *   Ingredients — Required, Issue qty, Unit, FIFO cost, Total; Issue All (FIFO).
 *                 After issue: what was actually drawn, lot by lot.
 *   Production  — Complete Production, with the live cost figures.
 *                 After completion: the finished item in stock, at this branch.
 *   Notes       — the order's own fields, and its trace.
 *
 * Issue quantities are editable per line, and only downwards from the plan
 * is honest — a cook who used more added an ingredient the recipe did not
 * have. The server refuses an ingredient the plan lacks; it accepts any
 * positive quantity for one it has.
 */
export function ProductionOrderPanel({
  run,
  units,
  currency,
  locale,
  canManage,
}: {
  run: ProductionRun
  units: StockUnit[]
  currency: string
  locale: string
  canManage: boolean
}) {
  const router = useRouter()
  const { busy, run: act } = useAction()
  const money = (minor: number) => formatMoney(Math.round(minor), currency, locale)
  const factor = minorUnitFactor(currency)
  const perUnit = (minor: number) => {
    const major = minor / factor
    const digits = major !== 0 && Math.abs(major) < 1 ? 4 : 2
    return `${formatMoney(0, currency, locale).replace(/[\d.,\s]/g, '')}${major.toLocaleString(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits })}`
  }

  const inProgress = run.status === 'IN_PROGRESS'
  const completed = run.status === 'COMPLETED' || run.status === 'PARTIALLY_COMPLETED'
  const cancelled = run.status === 'CANCELLED'

  // ── issue quantities, editable until issued ──
  const [issueQty, setIssueQty] = React.useState<Record<string, string>>({})
  const qtyFor = (itemId: string, planned: number) => {
    const typed = issueQty[itemId]
    return typed === undefined || typed === '' ? planned : Number(typed)
  }
  const issueLines = run.plan.map((line) => ({ itemId: line.itemId, quantity: qtyFor(line.itemId, line.quantity), unit: line.unit as StockUnit }))
  const issueValid = issueLines.every((line) => Number.isFinite(line.quantity) && line.quantity > 0)
  const anyShort = run.plan.some((line) => line.shortfall > 0 || qtyFor(line.itemId, line.quantity) > line.available + 1e-9)
  const plannedCost = run.plan.reduce((sum, line) => {
    const ratio = line.quantity > 0 ? qtyFor(line.itemId, line.quantity) / line.quantity : 0
    return sum + line.lineCost * ratio
  }, 0)

  const [tab, setTab] = React.useState<'ingredients' | 'production' | 'notes'>(
    completed ? 'production' : 'ingredients',
  )

  const issueAll = () =>
    void act(
      () => issueIngredientsAction({ batchId: run.id, lines: issueLines }),
      {
        onDone: (result) => {
          toast.success(`${result.number}: ingredients issued — ${money(result.totalValue)} left stock`)
          setTab('production')
          router.refresh()
        },
      },
    )

  const unit = (run.unit ?? '').toLowerCase()
  const ingredientCost = run.issued ? run.materialCost : plannedCost

  return (
    <Tabs value={tab} onValueChange={(value) => setTab(value as typeof tab)}>
      <TabsList>
        <TabsTrigger value="ingredients">Ingredients</TabsTrigger>
        <TabsTrigger value="production">Production</TabsTrigger>
        <TabsTrigger value="notes">Notes</TabsTrigger>
      </TabsList>

      {/* ── Ingredients ─────────────────────────────────────────────────── */}
      <TabsContent value="ingredients">
        <SectionCard
          title={run.issued ? 'Ingredients issued' : 'Issue ingredients'}
          description={
            run.issued
              ? 'What actually left stock, from the oldest lots first at each lot’s own price. This is the cost of the batch.'
              : 'What the plan needs, costed FIFO for the quantity to issue. Stock leaves when you issue — not before.'
          }
          actions={
            run.issued ? (
              <Badge variant="success">
                issued <LocalDateTime value={run.startedAt ?? run.createdAt} />
              </Badge>
            ) : canManage && inProgress ? (
              <Button onClick={issueAll} disabled={busy || !issueValid || run.plan.length === 0} loading={busy}>
                Issue All (FIFO)
              </Button>
            ) : null
          }
        >
          {!run.issued && run.plan.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {cancelled ? 'Nothing — this order was cancelled before anything moved.' : 'Nothing was consumed.'}
            </p>
          ) : !run.issued ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-muted-foreground">
                    <th className="pb-2 font-medium">Ingredient</th>
                    <th className="pb-2 text-right font-medium">Required Qty</th>
                    <th className="pb-2 text-right font-medium">Issue Qty</th>
                    <th className="pb-2 font-medium">Unit</th>
                    <th className="pb-2 text-right font-medium">FIFO Cost</th>
                    <th className="pb-2 text-right font-medium">Total Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {run.plan.map((line) => {
                    const issuing = qtyFor(line.itemId, line.quantity)
                    const ratio = line.quantity > 0 ? issuing / line.quantity : 0
                    const short = issuing > line.available + 1e-9
                    return (
                      <tr key={line.itemId} className="border-b border-border/50 last:border-0">
                        <td className="py-2">
                          <Link href={`/dashboard/inventory/${line.itemId}`} className="hover:underline">{line.name}</Link>
                          <span className="block text-xs text-muted-foreground">
                            {line.itemUnit ? formatQuantity(line.available, line.itemUnit as StockUnit) : line.available} available here
                          </span>
                        </td>
                        <td className="py-2 text-right tabular-nums text-muted-foreground">{line.quantity}</td>
                        <td className="py-2 text-right">
                          {canManage && inProgress ? (
                            <Input
                              inputMode="decimal"
                              className="ml-auto h-9 w-24 text-right"
                              value={issueQty[line.itemId] ?? ''}
                              placeholder={String(line.quantity)}
                              aria-invalid={short}
                              aria-label={`Issue quantity for ${line.name}`}
                              onChange={(event) => setIssueQty((current) => ({ ...current, [line.itemId]: event.target.value }))}
                            />
                          ) : (
                            <span className="tabular-nums">{issuing}</span>
                          )}
                        </td>
                        <td className="py-2">{UNIT_LABELS[line.unit as StockUnit] ?? line.unit}</td>
                        <td className="py-2 text-right tabular-nums text-muted-foreground">
                          {line.itemUnit ? `${perUnit(line.unitCost)}/${UNIT_LABELS[line.itemUnit as StockUnit]}` : perUnit(line.unitCost)}
                        </td>
                        <td className={`py-2 text-right tabular-nums ${short ? 'text-destructive' : ''}`}>{money(line.lineCost * ratio)}</td>
                      </tr>
                    )
                  })}
                </tbody>
                <tfoot>
                  <tr className="border-t border-border font-medium">
                    <td className="pt-2" colSpan={5}>Total Issue Cost (FIFO)</td>
                    <td className="pt-2 text-right tabular-nums">{money(plannedCost)}</td>
                  </tr>
                </tfoot>
              </table>
              {anyShort ? (
                <Alert variant="destructive" title="Not enough stock here" className="mt-3">
                  Production never draws a shelf below zero. Receive stock, or reduce the issue quantity.
                </Alert>
              ) : null}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-muted-foreground">
                    <th className="pb-2 font-medium">Ingredient</th>
                    <th className="pb-2 text-right font-medium">Issued</th>
                    <th className="pb-2 font-medium">Lot</th>
                    <th className="pb-2 text-right font-medium">FIFO Cost</th>
                    <th className="pb-2 text-right font-medium">Total Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {run.consumption.map((line) => (
                    <React.Fragment key={line.id}>
                      <tr className="border-b border-border/50">
                        <td className="py-2 font-medium">
                          <Link href={`/dashboard/inventory/${line.itemId}`} className="hover:underline">{line.name}</Link>
                        </td>
                        <td className="py-2 text-right tabular-nums">{line.quantity} {line.unit.toLowerCase()}</td>
                        <td className="py-2 text-xs text-muted-foreground">{line.lots.length} lot{line.lots.length === 1 ? '' : 's'}</td>
                        <td className="py-2 text-right tabular-nums text-muted-foreground">{perUnit(line.unitCost)}</td>
                        <td className="py-2 text-right tabular-nums">{money(line.lineCost)}</td>
                      </tr>
                      {line.lots.map((lot) => (
                        <tr key={lot.id} className="border-b border-border/30 text-xs text-muted-foreground last:border-0">
                          <td className="py-1 pl-4">↳</td>
                          <td className="py-1 text-right tabular-nums">{lot.quantity} {line.unit.toLowerCase()}</td>
                          <td className="py-1 font-mono">{lot.batchNo ?? 'stock before lots (average)'}</td>
                          <td className="py-1 text-right tabular-nums">{perUnit(lot.unitCost)}</td>
                          <td className="py-1 text-right tabular-nums">{money(lot.lineCost)}</td>
                        </tr>
                      ))}
                    </React.Fragment>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t border-border font-medium">
                    <td className="pt-2" colSpan={4}>Total Issued Cost (FIFO)</td>
                    <td className="pt-2 text-right tabular-nums">{money(run.materialCost)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </SectionCard>
      </TabsContent>

      {/* ── Production ──────────────────────────────────────────────────── */}
      <TabsContent value="production">
        {inProgress ? (
          <SectionCard
            title={`Complete Production ${run.number}`}
            description="Enter what actually came out, and any wastage. Cost per unit is the ingredient cost divided by the actual output — never the plan."
          >
            {!run.issued ? (
              <Alert variant="warning" title="Ingredients not issued yet" className="mb-4">
                Completing now issues them in the same step, from the real lots. Issue them first on the Ingredients tab if the kitchen has already started.
              </Alert>
            ) : null}
            {canManage ? (
              <CompleteProductionForm
                batch={{ id: run.id, number: run.number, plannedQty: run.plannedQty, unit: (run.unit ?? null) as StockUnit | null }}
                units={units}
                ingredientCost={ingredientCost}
                ingredientCostIsEstimate={!run.issued}
                currency={currency}
                locale={locale}
                onBack={() => setTab('ingredients')}
                onDone={(result) => {
                  toast.success(`${result.number} completed — ${formatQuantity(result.producedQty, result.item.unit)} into stock at ${perUnit(result.unitCost)}/${UNIT_LABELS[result.item.unit]}`)
                  setTab('production')
                  router.refresh()
                }}
                onCancelled={
                  run.issued
                    ? undefined
                    : () => {
                        toast.success('Order abandoned — nothing had moved')
                        router.push('/dashboard/production')
                      }
                }
              />
            ) : (
              <p className="text-sm text-muted-foreground">Somebody who manages production records what came out.</p>
            )}
          </SectionCard>
        ) : completed ? (
          <SectionCard
            title="Finished Item in Stock"
            description="Produced item added to inventory with its actual cost. Ingredients are down by what was issued."
            actions={<Badge variant="success"><PackageCheck /> completed</Badge>}
          >
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-muted-foreground">
                    <th className="pb-2 font-medium">Item</th>
                    <th className="pb-2 text-right font-medium">Available Qty</th>
                    <th className="pb-2 font-medium">Unit</th>
                    <th className="pb-2 text-right font-medium">FIFO Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {run.itemId ? (
                    <tr className="border-b border-border/50 bg-emerald-50/60 dark:bg-emerald-950/20">
                      <td className="py-2 font-medium">
                        <Link href={`/dashboard/production/items/${run.itemId}`} className="hover:underline">{run.itemName}</Link>
                        <span className="ml-2 text-xs text-muted-foreground">this run: +{run.producedQty ?? 0} {unit}</span>
                      </td>
                      <td className="py-2 text-right tabular-nums">{run.stockNow[run.itemId] ?? 0}</td>
                      <td className="py-2">{unit}</td>
                      <td className="py-2 text-right tabular-nums">{perUnit(run.unitCost)}</td>
                    </tr>
                  ) : null}
                  {run.consumption.map((line) => (
                    <tr key={line.id} className="border-b border-border/50 last:border-0">
                      <td className="py-2">
                        <Link href={`/dashboard/inventory/${line.itemId}`} className="hover:underline">{line.name}</Link>
                        <span className="ml-2 text-xs text-muted-foreground">−{line.quantity} {line.unit.toLowerCase()}</span>
                      </td>
                      <td className="py-2 text-right tabular-nums">{run.stockNow[line.itemId] ?? 0}</td>
                      <td className="py-2">{line.unit.toLowerCase()}</td>
                      <td className="py-2 text-right tabular-nums text-muted-foreground">{perUnit(line.unitCost)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <dl className="mt-4 grid gap-2 text-sm sm:grid-cols-3">
              <div className="rounded-lg border border-border bg-muted/30 px-3 py-2">
                <dt className="text-xs text-muted-foreground">Total Ingredient Cost (FIFO)</dt>
                <dd className="text-lg font-semibold tabular-nums">{money(run.totalCost)}</dd>
              </div>
              <div className="rounded-lg border border-border bg-muted/30 px-3 py-2">
                <dt className="text-xs text-muted-foreground">Actual Output</dt>
                <dd className="text-lg font-semibold tabular-nums">{run.producedQty ?? 0} {unit}</dd>
                {run.wastageQty ? <dd className="text-xs text-muted-foreground">wastage {run.wastageQty} {unit}</dd> : null}
              </div>
              <div className="rounded-lg border border-primary/40 bg-primary/5 px-3 py-2">
                <dt className="text-xs text-muted-foreground">Actual Cost per {unit || 'unit'}</dt>
                <dd className="text-lg font-semibold tabular-nums">{perUnit(run.unitCost)}</dd>
              </div>
            </dl>
          </SectionCard>
        ) : (
          <SectionCard title="Cancelled">
            <p className="text-sm text-muted-foreground">This order was abandoned before anything moved.</p>
          </SectionCard>
        )}
      </TabsContent>

      {/* ── Notes ───────────────────────────────────────────────────────── */}
      <TabsContent value="notes">
        <SectionCard title="The order">
          <dl className="space-y-2.5 text-sm">
            <Row label="Reference">{run.number}</Row>
            {run.batchNumber ? <Row label="Batch">{run.batchNumber}</Row> : null}
            <Row label="Type">{run.productionType === 'FINISHED' ? 'Finished' : 'Semi-finished'}</Row>
            <Row label="Where">{run.branchName}</Row>
            <Row label="Requested by">{run.madeBy ?? 'Someone'}</Row>
            <Row label="Created"><LocalDateTime value={run.createdAt} /></Row>
            {run.requiredDate ? <Row label="Required"><LocalDateTime value={run.requiredDate} /></Row> : null}
            {run.startedAt ? <Row label="Issued"><LocalDateTime value={run.startedAt} /></Row> : null}
            {run.completedAt ? <Row label="Completed"><LocalDateTime value={run.completedAt} /></Row> : null}
            {run.varianceReason ? <Row label="Shortfall">{run.varianceReason.replace(/_/g, ' ').toLowerCase()}{run.varianceNote ? ` — ${run.varianceNote}` : ''}</Row> : null}
            {run.notes ? <Row label="Remarks">{run.notes}</Row> : null}
          </dl>
        </SectionCard>
      </TabsContent>
    </Tabs>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[7rem_1fr] gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd>{children}</dd>
    </div>
  )
}
