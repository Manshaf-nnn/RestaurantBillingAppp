'use client'

import * as React from 'react'
import { useRouter, useSearchParams } from 'next/navigation'

import { Input } from '@/components/ui/input'
import { SectionCard } from '@/features/dashboard/components/page-header'
import { projectImpact, type WhatIfInput } from '@/features/reports/what-if-math'
import { formatMoney, parseMoney, type CurrencyCode } from '@/lib/money'

/**
 * What-if (acCal.md §12). Picking an ingredient reloads the page with real
 * figures; typing a new price recomputes in the browser. Nothing here is
 * ever saved — the banner says so, and the service has no writes to make.
 */
export function WhatIf({
  items,
  selected,
  currency,
}: {
  items: Array<{ id: string; name: string; unit: string }>
  selected: WhatIfInput | null
  currency: CurrencyCode
}) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [priceText, setPriceText] = React.useState('')

  const money = (minor: number) => formatMoney(minor, currency)
  const newCost = priceText.trim() === '' ? null : parseMoney(priceText, currency)
  const impact = selected && newCost !== null ? projectImpact(selected, newCost) : null

  const pick = (itemId: string) => {
    const query = new URLSearchParams(searchParams?.toString() ?? '')
    if (itemId) query.set('item', itemId)
    else query.delete('item')
    query.set('tab', 'whatif')
    setPriceText('')
    router.push(`/dashboard/accounting/tools?${query.toString()}`)
  }

  return (
    <SectionCard
      title="What if a price changes?"
      description="See what an ingredient price would do to your profit, at the sales you actually had."
    >
      <p className="mb-3 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs">
        Simulation only — nothing on this screen is saved, and no figure in your books changes.
      </p>

      <div className="flex flex-wrap items-end gap-4">
        <label className="grid gap-1 text-sm">
          <span className="text-muted-foreground">Ingredient</span>
          <select
            value={selected?.itemId ?? ''}
            onChange={(event) => pick(event.target.value)}
            className="h-9 min-w-[14rem] rounded-lg border bg-background px-3 text-sm"
          >
            <option value="">Choose an ingredient…</option>
            {items.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name} ({item.unit})
              </option>
            ))}
          </select>
        </label>

        {selected ? (
          <>
            <div className="text-sm">
              <p className="text-muted-foreground">Costs now</p>
              <p className="font-semibold tabular-nums">
                {money(selected.currentUnitCost)} / {selected.unit}
              </p>
            </div>
            <label className="grid gap-1 text-sm">
              <span className="text-muted-foreground">New price per {selected.unit}</span>
              <Input
                inputMode="decimal"
                value={priceText}
                placeholder={String(selected.currentUnitCost / 100)}
                onChange={(event) => setPriceText(event.target.value)}
                className="w-36 tabular-nums"
              />
            </label>
          </>
        ) : null}
      </div>

      {selected && selected.dishes.length === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground">
          No menu recipe uses {selected.itemName} yet, so a price change here does not touch any dish&apos;s
          cost. Add it to a recipe first.
        </p>
      ) : null}

      {impact && selected ? (
        <div className="mt-4 space-y-4">
          <div className="rounded-lg border bg-muted/30 p-4 text-sm">
            <p>
              {impact.delta === 0 ? (
                'That is the same price you pay now.'
              ) : (
                <>
                  {impact.delta > 0 ? 'Paying' : 'Saving'}{' '}
                  <strong>{money(Math.abs(impact.delta))}</strong> more per {selected.unit} would have{' '}
                  {impact.delta > 0 ? 'cost' : 'saved'} you{' '}
                  <strong>{money(Math.abs(impact.totalExtra))}</strong> over {selected.rangeLabel.toLowerCase()},
                  on {selected.totalUnitsUsed.toFixed(2)} {selected.unit} used.
                </>
              )}
            </p>
            <dl className="mt-2 grid gap-1">
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">Profit on these dishes now</dt>
                <dd className="font-medium tabular-nums">{money(impact.currentProfit)}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">Profit at the new price</dt>
                <dd className="font-bold tabular-nums">{money(impact.newProfit)}</dd>
              </div>
              {impact.newMarginPercent !== null ? (
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">Margin on these dishes</dt>
                  <dd className="font-medium tabular-nums">{impact.newMarginPercent}%</dd>
                </div>
              ) : null}
            </dl>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="pb-2 pr-3 font-medium">Dish</th>
                  <th className="pb-2 pr-3 text-right font-medium">Sold</th>
                  <th className="pb-2 pr-3 text-right font-medium">Extra per dish</th>
                  <th className="pb-2 pr-3 text-right font-medium">Extra in total</th>
                  <th className="pb-2 text-right font-medium">Margin then → now</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {impact.dishes.map((dish) => (
                  <tr key={dish.foodId}>
                    <td className="py-2 pr-3">{dish.name}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{dish.unitsSold}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{money(dish.extraPerDish)}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{money(dish.extraTotal)}</td>
                    <td className="py-2 text-right tabular-nums">
                      {dish.currentMarginPercent ?? '—'}% → {dish.newMarginPercent ?? '—'}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </SectionCard>
  )
}
