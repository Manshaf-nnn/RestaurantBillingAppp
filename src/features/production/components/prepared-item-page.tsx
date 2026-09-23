'use client'

import * as React from 'react'
import Link from 'next/link'
import { Plus, Timer } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { LocalDateTime } from '@/components/local-time'
import { SectionCard, StatCard } from '@/features/dashboard/components/page-header'
import { UNIT_LABELS, formatQuantity } from '@/features/inventory/units'
import { formatMoney, minorUnitFactor } from '@/lib/money'
import { Button } from '@/components/ui/button'
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
 *   what is in progress                    — each order, one click to it
 *   make more                              — a new production order from the recipe
 *   what happened before                   — this item's full history
 *
 * Issuing and completing happen on the order's own page (pro.b.md §4–§8),
 * because the order is what the kitchen carries from step 3 onwards.
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
        description="How this item is made, costed FIFO from the lots on this shelf today. The issue re-reads them and is the figure of record."
        actions={recipe ? <Badge variant="secondary">Recipe v{recipe.version}</Badge> : null}
      >
        {recipe ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-muted-foreground">
                  <th className="pb-2 font-medium">Ingredient</th>
                  <th className="pb-2 text-right font-medium">Quantity</th>
                  <th className="pb-2 text-right font-medium">Current cost (FIFO)</th>
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
          title={data.openBatches.length === 1 ? 'A production order is in progress' : `${data.openBatches.length} production orders are in progress`}
          description="Issue the ingredients and complete production on the order’s own page."
          actions={<Badge variant="warning"><Timer /> in progress</Badge>}
        >
          <ul className="divide-y divide-border">
            {data.openBatches.map((batch) => (
              <li key={batch.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                <span>
                  <span className="font-mono text-xs text-muted-foreground">{batch.number}</span>{' '}
                  <span className="text-muted-foreground">
                    planned {batch.plannedQty} {batch.unit ? UNIT_LABELS[batch.unit].toLowerCase() : ''} · <LocalDateTime value={batch.startedAt} />
                    {batch.branchName ? ` · ${batch.branchName}` : ''}
                  </span>
                  {batch.issued ? <Badge variant="warning" size="sm" className="ml-2">issued</Badge> : null}
                </span>
                <Button size="sm" asChild>
                  <Link href={`/dashboard/production/${batch.id}`}>{batch.issued ? 'Complete production' : 'Issue ingredients'}</Link>
                </Button>
              </li>
            ))}
          </ul>
        </SectionCard>
      ) : null}

      {canManage ? (
        <SectionCard
          id="make-more"
          title="Add Production — Make More"
          description="Another batch of this item, from its recipe: planned quantity, type and date on the next screen, then issue and complete on the order. Never a duplicate item."
        >
          {recipe && recipe.lines.length > 0 ? (
            <Button asChild>
              <Link href={`/dashboard/production?make=${item.id}`}><Plus /> New production order</Link>
            </Button>
          ) : (
            <p className="text-sm text-muted-foreground">
              There is no recipe on file for {item.name} yet —{' '}
              <Link href={`/dashboard/production?recipe=${item.id}`} className="underline">set it up on Recipe Setup</Link>{' '}
              and Make More can repeat it.
            </p>
          )}
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
