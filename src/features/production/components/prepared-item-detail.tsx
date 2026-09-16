'use client'

import * as React from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Timer } from 'lucide-react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { LocalDateTime } from '@/components/local-time'
import { UNIT_LABELS, formatQuantity, toBaseUnits } from '@/features/inventory/units'
import { formatMoney, minorUnitFactor } from '@/lib/money'
import { roundQty } from '@/lib/quantity'
import { MarkDoneForm } from './mark-done-form'
import type { ProductionWorkspaceData } from '../types'

/**
 * One prepared item, in full (recorrection.md §3): what is on the shelf, how
 * it is made and what that costs today, the batches waiting to be marked
 * done — with Mark Done right there — and the last few runs.
 *
 * Built from the data the page already loaded. Nothing here needs another
 * query: the recipe, the open batches and the history are all on the
 * workspace, and a dialog that fetched would show a spinner for facts the
 * table behind it is already displaying.
 */
export function PreparedItemDetail({
  itemId,
  data,
  currency,
  locale,
  canManage,
  onClose,
  onMakeMore,
  onHistory,
}: {
  itemId: string | null
  data: ProductionWorkspaceData
  currency: string
  locale: string
  canManage: boolean
  onClose: () => void
  onMakeMore: (itemId: string, name: string) => void
  onHistory: (itemId: string) => void
}) {
  const router = useRouter()

  const row = itemId ? data.prepared.find((r) => r.id === itemId) ?? null : null
  const stockItem = itemId ? data.items.find((i) => i.id === itemId) ?? null : null
  const recipe = itemId ? data.recipes[itemId] ?? null : null
  const batches = itemId ? data.openBatches.filter((b) => b.itemId === itemId) : []
  const runs = itemId ? data.history.filter((h) => h.itemId === itemId).slice(0, 5) : []
  const byId = React.useMemo(() => new Map(data.items.map((i) => [i.id, i])), [data.items])

  const money = (minor: number) => formatMoney(Math.round(minor), currency, locale)
  const factor = minorUnitFactor(currency)
  const perUnit = (minor: number) => {
    const major = minor / factor
    const digits = major !== 0 && Math.abs(major) < 1 ? 4 : 2
    return `${formatMoney(0, currency, locale).replace(/[\d.,\s]/g, '')}${major.toLocaleString(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits })}`
  }

  /*
   * The recipe costed at today's averages — the same arithmetic the form's
   * preview uses, so the two never disagree about what a batch should cost.
   */
  const costed = React.useMemo(() => {
    if (!recipe) return null
    const lines = recipe.ingredients.map((line) => {
      const item = byId.get(line.itemId)
      if (!item) return { line, item: null, base: 0, value: 0 }
      try {
        const base = roundQty(toBaseUnits(line.quantity, line.unit, item))
        return { line, item, base, value: base * item.unitCost }
      } catch {
        return { line, item, base: 0, value: 0 }
      }
    })
    const total = lines.reduce((sum, l) => sum + l.value, 0)
    let yieldBase = recipe.yieldQty
    if (stockItem && recipe.yieldUnit) {
      try { yieldBase = roundQty(toBaseUnits(recipe.yieldQty, recipe.yieldUnit, stockItem)) } catch { /* shown per recipe unit instead */ }
    }
    return { lines, total, perBase: yieldBase > 0 ? total / yieldBase : 0 }
  }, [recipe, byId, stockItem])

  return (
    <Dialog open={itemId !== null} onOpenChange={(next) => (next ? null : onClose())}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        {row ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex flex-wrap items-center gap-2">
                {row.name}
                {batches.length > 0 ? (
                  <Badge variant="warning"><Timer /> {batches.length} in progress</Badge>
                ) : (
                  <Badge variant="secondary">stocked</Badge>
                )}
              </DialogTitle>
              <DialogDescription>
                Stocked in {UNIT_LABELS[row.unit]} · {row.runs} run{row.runs === 1 ? '' : 's'}
                {row.lastProducedAt ? <> · last made <LocalDateTime value={row.lastProducedAt} /></> : null}
              </DialogDescription>
            </DialogHeader>

            <div className="grid gap-3 sm:grid-cols-3">
              <Stat label="On hand here" value={formatQuantity(row.available, row.unit)} />
              <Stat label={`Avg cost / ${UNIT_LABELS[row.unit]}`} value={perUnit(row.costPerUnit)} />
              <Stat label="Stock value" value={money(row.stockValue)} />
            </div>

            {batches.length > 0 ? (
              <section className="space-y-3">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  In progress — enter what came out
                </h3>
                {batches.map((batch) => (
                  <div key={batch.id} className="rounded-lg border p-3">
                    <p className="mb-2 flex flex-wrap items-center gap-2 text-sm">
                      <span className="font-medium">{batch.number}</span>
                      <span className="text-muted-foreground">
                        aiming {batch.plannedQty} {batch.unit ? UNIT_LABELS[batch.unit] : ''} · started <LocalDateTime value={batch.startedAt} />
                        {batch.branchName ? ` · ${batch.branchName}` : ''}
                      </span>
                    </p>
                    {batch.ingredients.length > 0 ? (
                      <p className="mb-2 text-xs text-muted-foreground">
                        Will consume:{' '}
                        {batch.ingredients
                          .map((line) => `${byId.get(line.itemId)?.name ?? 'an item'} ${line.quantity} ${UNIT_LABELS[line.unit].toLowerCase()}`)
                          .join(', ')}
                      </p>
                    ) : null}
                    {canManage ? (
                      <MarkDoneForm
                        batch={{ id: batch.id, number: batch.number, plannedQty: batch.plannedQty, unit: batch.unit }}
                        compact
                        onDone={(result) => {
                          toast.success(`${result.number} done — ${formatQuantity(result.producedQty, result.item.unit)} into stock`)
                          router.refresh()
                        }}
                        onCancelled={() => {
                          toast.success('Batch abandoned — nothing had moved')
                          router.refresh()
                        }}
                      />
                    ) : (
                      <p className="text-xs text-muted-foreground">Somebody who manages production marks it done.</p>
                    )}
                  </div>
                ))}
              </section>
            ) : null}

            <section>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                How it is made
              </h3>
              {recipe && costed ? (
                <div className="rounded-lg border">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-left text-xs text-muted-foreground">
                        <th className="px-3 py-1.5 font-medium">Ingredient</th>
                        <th className="px-3 py-1.5 text-right font-medium">Qty</th>
                        <th className="px-3 py-1.5 text-right font-medium">Cost / unit</th>
                        <th className="px-3 py-1.5 text-right font-medium">Cost</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {costed.lines.map(({ line, item, value }) => (
                        <tr key={line.itemId}>
                          <td className="px-3 py-1.5">{item?.name ?? 'Retired item'}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums">{line.quantity} {UNIT_LABELS[line.unit].toLowerCase()}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">
                            {item ? `${perUnit(item.unitCost)}/${UNIT_LABELS[item.unit]}` : '—'}
                          </td>
                          <td className="px-3 py-1.5 text-right tabular-nums">{money(value)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="border-t font-medium">
                        <td className="px-3 py-1.5" colSpan={3}>
                          Makes {recipe.yieldQty} {recipe.yieldUnit ? UNIT_LABELS[recipe.yieldUnit].toLowerCase() : ''} · {perUnit(costed.perBase)} per {UNIT_LABELS[row.unit]} at today’s costs
                        </td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{money(costed.total)}</td>
                      </tr>
                    </tfoot>
                  </table>
                  <p className="px-3 py-1.5 text-xs text-muted-foreground">
                    Recipe v{recipe.version} — how it was last made. Making it again pre-fills these lines.
                  </p>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  No recipe on file yet — it was made before recipes were kept. Making it again saves one.
                </p>
              )}
            </section>

            <section>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Recent runs
              </h3>
              {runs.length === 0 ? (
                <p className="text-sm text-muted-foreground">Not made yet.</p>
              ) : (
                <ul className="divide-y rounded-lg border text-sm">
                  {runs.map((run) => (
                    <li key={run.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
                      <Link href={`/dashboard/production/${run.id}`} className="font-medium hover:underline">{run.number}</Link>
                      <span className="tabular-nums">{run.quantity} {run.unit ? UNIT_LABELS[run.unit as keyof typeof UNIT_LABELS]?.toLowerCase() ?? run.unit : ''}</span>
                      <span className="text-muted-foreground">{money(run.totalCost)}</span>
                      {run.madeBy ? <span className="text-muted-foreground">· {run.madeBy}</span> : null}
                      <span className="ml-auto text-xs text-muted-foreground">
                        {run.completedAt ? <LocalDateTime value={run.completedAt} /> : null}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <div className="flex flex-wrap gap-2 border-t pt-3">
              {canManage ? (
                <Button onClick={() => onMakeMore(row.id, row.name)}>Make more</Button>
              ) : null}
              <Button variant="outline" onClick={() => onHistory(row.id)}>Full history</Button>
              <Button variant="ghost" asChild>
                <Link href={`/dashboard/inventory/${row.id}`}>Open in Inventory</Link>
              </Button>
            </div>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-muted/30 px-3 py-2">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-lg font-semibold tabular-nums">{value}</p>
    </div>
  )
}
