'use client'

import * as React from 'react'
import { AlertCircle, ArrowRight, X } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { LocalDateTime } from '@/components/local-time'
import { formatMoney, type CurrencyCode } from '@/lib/money'
import { callAction } from '@/lib/use-action'
import { cn } from '@/lib/utils'
import { itemPriceInsightAction } from '../actions'
import type { ItemPriceInsight } from '../queries'
import { formatPercent, priceChange, timeAgo } from '../status'

/** Dearer than this against the last price and the panel says so in red. */
export const PRICE_ALERT_ABOVE = 0.05

/**
 * Item price information — the right-hand panel a request line opens.
 *
 * Answers the four questions a buyer has at the moment of ordering: what did
 * we pay last time and to whom, what before that, what has it averaged, and
 * what is the least we have paid lately. All per BASE unit, which is how the
 * history is kept so a kilo price and a box price sit on one scale.
 *
 * Read on demand, not shipped with the form: the form carries every item's
 * last price already, and the history behind it is only wanted for the line
 * somebody is looking at.
 */
export function ItemPricePanel({
  itemId,
  currency,
  enteredPerBaseUnit,
  onUseLastPrice,
  onClose,
}: {
  /** Null closes the panel. */
  itemId: string | null
  currency: CurrencyCode
  /** What the buyer has typed on the line, converted to the base unit. */
  enteredPerBaseUnit: number | null
  /** Fill the line's price from the last purchase, per base unit. */
  onUseLastPrice?: (unitCostPerBase: number) => void
  onClose: () => void
}) {
  const [insight, setInsight] = React.useState<ItemPriceInsight | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [showHistory, setShowHistory] = React.useState(false)

  const open = itemId !== null
  const money = (minor: number) => formatMoney(minor, currency)

  React.useEffect(() => {
    if (!itemId) return
    let cancelled = false
    setLoading(true)
    setError(null)
    setShowHistory(false)
    callAction(() => itemPriceInsightAction({ itemId })).then((result) => {
      if (cancelled) return
      setLoading(false)
      if (result.ok) setInsight(result.data)
      else setError(result.error)
    })
    return () => {
      cancelled = true
    }
  }, [itemId])

  React.useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const last = insight?.last ?? null
  const change = last && enteredPerBaseUnit !== null ? priceChange(last.unitCost, enteredPerBaseUnit) : 0
  const alert = last !== null && enteredPerBaseUnit !== null && change > PRICE_ALERT_ABOVE
  const unit = insight?.unit.toLowerCase() ?? ''

  return (
    <>
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className={cn(
          'fixed inset-0 z-40 bg-foreground/20 backdrop-blur-[1px] transition-opacity',
          open ? 'opacity-100' : 'pointer-events-none opacity-0',
        )}
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="Item price information"
        className={cn(
          'fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col overflow-y-auto border-l bg-background p-5 shadow-xl transition-transform',
          open ? 'translate-x-0' : 'pointer-events-none translate-x-full',
        )}
      >
        <header className="mb-4 flex items-start justify-between gap-3">
          <h2 className="text-lg font-semibold">Item price information</h2>
          <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close">
            <X />
          </Button>
        </header>

        {loading ? (
          <p className="py-10 text-center text-sm text-muted-foreground">Loading…</p>
        ) : error ? (
          <p className="py-10 text-center text-sm text-destructive">{error}</p>
        ) : insight ? (
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <ItemAvatar name={insight.name} size="lg" />
              <div className="min-w-0">
                <p className="truncate font-semibold">{insight.name}</p>
                <p className="text-xs text-muted-foreground">
                  {insight.category ?? 'Uncategorised'} · per {unit}
                </p>
              </div>
            </div>

            <section className="rounded-xl border border-success/30 bg-success/5 p-4">
              <p className="text-xs font-medium text-success">Last purchase</p>
              {last ? (
                <>
                  <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
                    <p className="text-2xl font-bold text-success">
                      {money(last.unitCost)} <span className="text-base font-medium">/ {unit}</span>
                    </p>
                    <Badge variant="success">{timeAgo(last.at)}</Badge>
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">
                    <LocalDateTime value={last.at} />
                    {last.supplierName ? ` · ${last.supplierName}` : ''}
                    {last.receiptNumber ? ` · ${last.receiptNumber}` : ''}
                  </p>
                </>
              ) : (
                <p className="mt-1 text-sm text-muted-foreground">
                  Never bought before — there is nothing to compare against yet.
                </p>
              )}
            </section>

            <dl className="grid grid-cols-3 divide-x rounded-xl border text-sm">
              <Stat label="Previous price" value={insight.previous ? money(insight.previous.unitCost) : '—'} />
              <Stat label="30-day avg" value={insight.average30 !== null ? money(insight.average30) : '—'} />
              <Stat label="Lowest (30 days)" value={insight.lowest30 !== null ? money(insight.lowest30) : '—'} />
            </dl>

            {insight.history.length > 0 ? (
              <div>
                <button
                  type="button"
                  onClick={() => setShowHistory((v) => !v)}
                  className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
                >
                  {showHistory ? 'Hide purchase history' : 'View purchase history'}
                  <ArrowRight className="size-4" />
                </button>
                {showHistory ? (
                  <ul className="mt-2 divide-y rounded-xl border text-sm">
                    {insight.history.map((row, index) => (
                      <li key={`${row.at}-${index}`} className="flex flex-wrap items-center gap-2 px-3 py-2">
                        <span className="text-muted-foreground">
                          <LocalDateTime value={row.at} />
                        </span>
                        <span className="min-w-0 flex-1 truncate">{row.supplierName ?? 'No supplier'}</span>
                        <span className="text-xs text-muted-foreground">
                          {row.quantity} {row.unit?.toLowerCase() ?? unit}
                        </span>
                        <span className="font-medium tabular-nums">{money(row.unitCost)}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}

            {alert && last ? (
              <section className="rounded-xl border border-destructive/40 bg-destructive/5 p-4">
                <p className="flex items-center gap-2 font-semibold text-destructive">
                  <AlertCircle className="size-4" /> Price alert
                </p>
                <p className="mt-1 text-sm">
                  You entered <strong>{money(enteredPerBaseUnit!)}</strong>, which is{' '}
                  <strong>{formatPercent(change).replace('+', '')} higher</strong> than the last purchase
                  price ({money(last.unitCost)}).
                </p>
                {onUseLastPrice ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-3 border-destructive/40 text-destructive hover:bg-destructive/10"
                    onClick={() => onUseLastPrice(last.unitCost)}
                  >
                    Use last price
                  </Button>
                ) : null}
              </section>
            ) : null}
          </div>
        ) : null}
      </aside>
    </>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="px-3 py-2.5">
      <dt className="text-[11px] text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 font-semibold tabular-nums">{value}</dd>
    </div>
  )
}

/**
 * A tinted square with the item's initials. Items carry no photo, and an
 * empty image slot is worse than none — this gives every row the same shape.
 */
export function ItemAvatar({ name, size = 'md' }: { name: string; size?: 'md' | 'lg' }) {
  const initials = name
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? '')
    .join('')
  // A stable tint per name, from the theme's chart palette.
  const tint = (name.charCodeAt(0) + name.length) % 5
  const tints = ['bg-chart-1/15 text-chart-1', 'bg-chart-2/15 text-chart-2', 'bg-chart-3/15 text-chart-3', 'bg-chart-4/15 text-chart-4', 'bg-chart-5/15 text-chart-5']
  return (
    <span
      aria-hidden
      className={cn(
        'flex shrink-0 items-center justify-center rounded-lg font-semibold',
        size === 'lg' ? 'size-14 text-lg' : 'size-9 text-xs',
        tints[tint],
      )}
    >
      {initials}
    </span>
  )
}
