'use client'

import * as React from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Timer } from 'lucide-react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { LocalDateTime } from '@/components/local-time'
import { SectionCard, StatCard } from '@/features/dashboard/components/page-header'
import { UNIT_LABELS, formatQuantity } from '@/features/inventory/units'
import { formatMoney, minorUnitFactor } from '@/lib/money'
import { MakeMoreForm } from './make-more-form'
import { MarkDoneForm } from './mark-done-form'
import { ProductionHistory } from './production-history'
import type { PreparedItemPageData } from '../types'

/**
 * One prepared item, in full (aO.md §5).
 *
 * The page the cook lands on after Create, and the page they come back to
 * every later time they make the thing. It answers, in this order, the
 * questions somebody standing in the kitchen actually has:
 *
 *   what is this and how much is here      — the name and Current Stock
 *   what goes into it and what does it cost — Ingredients, with Production Cost
 *   how much did you make                  — one card per batch waiting
 *   make more                              — quantity, unit, one step
 *   what happened before                   — this item's full history
 *
 * There is no second "what did you make?" anywhere: Create asks how much is
 * being aimed for, this page asks what came out, and those are different
 * questions asked at different moments.
 */
export function PreparedItemPage({
  data,
  branchId,
  currency,
  locale,
  canManage,
}: {
  data: PreparedItemPageData
  branchId: string | null
  currency: string
  locale: string
  canManage: boolean
}) {
  const router = useRouter()
  const { item, stock, recipe } = data

  const money = (minor: number) => formatMoney(Math.round(minor), currency, locale)
  const factor = minorUnitFactor(currency)
  /** A per-unit cost, often a fraction of a minor unit for gram/ml items. */
  const perUnit = (minor: number) => {
    const major = minor / factor
    const digits = major !== 0 && Math.abs(major) < 1 ? 4 : 2
    return `${formatMoney(0, currency, locale).replace(/[\d.,\s]/g, '')}${major.toLocaleString(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits })}`
  }

  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label={data.branch ? `On hand at ${data.branch.name}` : 'On hand'}
          value={formatQuantity(stock.here, item.unit)}
          tone="primary"
        />
        <StatCard label={`Avg cost / ${UNIT_LABELS[item.unit]}`} value={perUnit(stock.costPerUnit)} />
        <StatCard label="Stock value" value={money(stock.value)} hint="Here, at the running average" />
        <StatCard
          label="Runs"
          value={String(stock.runs)}
          hint={stock.lastProducedAt ? undefined : 'Not made yet'}
        />
      </div>

      <SectionCard
        title="Ingredients"
        description="How this item is made, costed at today’s running averages. The run itself re-reads the ledger and is the figure of record."
        actions={recipe ? <Badge variant="secondary">Recipe v{recipe.version}</Badge> : null}
      >
        {recipe ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-muted-foreground">
                  <th className="pb-2 font-medium">Ingredient</th>
                  <th className="pb-2 text-right font-medium">Quantity</th>
                  <th className="pb-2 text-right font-medium">Unit cost</th>
                  <th className="pb-2 text-right font-medium">Cost</th>
                  <th className="pb-2 text-right font-medium">On hand</th>
                </tr>
              </thead>
              <tbody>
                {recipe.lines.map((line) => (
                  <tr key={line.itemId} className="border-b border-border/50 last:border-0">
                    <td className="py-2">
                      <Link href={`/dashboard/inventory/${line.itemId}`} className="hover:underline">
                        {line.name}
                      </Link>
                    </td>
                    <td className="py-2 text-right tabular-nums">
                      {line.quantity} {UNIT_LABELS[line.unit].toLowerCase()}
                    </td>
                    <td className="py-2 text-right tabular-nums text-muted-foreground">
                      {line.itemUnit ? `${perUnit(line.unitCost)}/${UNIT_LABELS[line.itemUnit]}` : '—'}
                    </td>
                    <td className="py-2 text-right tabular-nums">{money(line.lineCost)}</td>
                    <td className="py-2 text-right tabular-nums text-muted-foreground">
                      {line.itemUnit ? formatQuantity(line.available, line.itemUnit) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-border font-medium">
                  <td className="pt-2" colSpan={3}>
                    Production Cost — makes {recipe.yieldQty}{' '}
                    {recipe.yieldUnit ? UNIT_LABELS[recipe.yieldUnit].toLowerCase() : ''}, {perUnit(recipe.costPerUnit)} per {UNIT_LABELS[item.unit]}
                  </td>
                  <td className="pt-2 text-right tabular-nums">{money(recipe.productionCost)}</td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            No recipe on file yet — this item was made before recipes were kept. Making it on the Make
            an Item tab records how it is made, and it can be repeated from here afterwards.
          </p>
        )}
      </SectionCard>

      {data.openBatches.length > 0 ? (
        <SectionCard
          title={data.openBatches.length === 1 ? 'A batch is waiting' : `${data.openBatches.length} batches are waiting`}
          description="Nothing has left stock for these yet. That happens when you say what came out."
          actions={<Badge variant="warning"><Timer /> in progress</Badge>}
        >
          <div className="space-y-3">
            {data.openBatches.map((batch) => (
              <div key={batch.id} className="rounded-lg border border-border p-3">
                <p className="mb-2 flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-medium">{batch.number}</span>
                  <span className="text-muted-foreground">
                    aiming {batch.plannedQty} {batch.unit ? UNIT_LABELS[batch.unit] : ''} · started{' '}
                    <LocalDateTime value={batch.startedAt} />
                    {batch.branchName ? ` · ${batch.branchName}` : ''}
                  </span>
                </p>
                {batch.ingredients.length > 0 ? (
                  <p className="mb-2 text-xs text-muted-foreground">
                    Will consume:{' '}
                    {batch.ingredients
                      .map((line) => `${line.name ?? 'an item'} ${line.quantity} ${UNIT_LABELS[line.unit].toLowerCase()}`)
                      .join(', ')}
                  </p>
                ) : null}
                {canManage ? (
                  <MarkDoneForm
                    batch={{ id: batch.id, number: batch.number, plannedQty: batch.plannedQty, unit: batch.unit }}
                    units={item.units}
                    compact
                    onDone={(result) => {
                      toast.success(
                        `${result.number} done — ${formatQuantity(result.producedQty, result.item.unit)} into stock`,
                      )
                      router.refresh()
                    }}
                    onCancelled={() => {
                      toast.success('Batch abandoned — nothing had moved')
                      router.refresh()
                    }}
                  />
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Somebody who manages production says how much came out.
                  </p>
                )}
              </div>
            ))}
          </div>
        </SectionCard>
      ) : null}

      {canManage ? (
        <SectionCard
          id="make-more"
          title="Add Production — Make More"
          description="Making it again the same way. The ingredients above are scaled to the amount you enter and the production completes in one step."
        >
          <MakeMoreForm
            itemId={item.id}
            itemName={item.name}
            branchId={branchId}
            units={item.units}
            defaultUnit={recipe?.yieldUnit ?? item.unit}
            hasRecipe={recipe !== null && recipe.lines.length > 0}
          />
        </SectionCard>
      ) : null}

      <SectionCard
        title="Production History"
        description="Every run of this item here — in progress, done or abandoned — with what it consumed, what it cost and who made it."
      >
        <ProductionHistory rows={data.history} currency={currency} locale={locale} />
      </SectionCard>
    </div>
  )
}
