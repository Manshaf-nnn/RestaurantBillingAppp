'use client'

import * as React from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SectionCard } from '@/features/dashboard/components/page-header'
import {
  convertAtRate,
  discountOf,
  foodCostBps,
  marginBps,
  markupBps,
  priceForMargin,
  priceForMarkup,
  shareBps,
  taxInGross,
  taxOnNet,
  toRateMicro,
} from '@/lib/accounting-math'
import { formatMoney, parseMoney, type CurrencyCode } from '@/lib/money'
import { InfoTip } from './info-tip'

/**
 * The accounting calculator (acCal.md §2): the sums an accountant does on a
 * phone calculator all day, in the exact math the billing engine uses —
 * integer minor units, basis points — so nothing here ever disagrees with a
 * real bill. Everything computes as you type; nothing is saved.
 */

type Mode = 'tax' | 'discount' | 'margin' | 'foodcost' | 'percent' | 'convert'

const MODES: Array<{ key: Mode; label: string }> = [
  { key: 'tax', label: 'Tax' },
  { key: 'discount', label: 'Discount' },
  { key: 'margin', label: 'Margin & markup' },
  { key: 'foodcost', label: 'Food cost %' },
  { key: 'percent', label: 'Percentage' },
  { key: 'convert', label: 'Convert currency' },
]

function toBps(percentText: string): number | null {
  const value = Number.parseFloat(percentText)
  if (!Number.isFinite(value) || value < 0) return null
  return Math.round(value * 100)
}

function Field({
  label,
  value,
  onChange,
  suffix,
  placeholder,
}: {
  label: string
  value: string
  onChange: (next: string) => void
  suffix?: string
  placeholder?: string
}) {
  return (
    <label className="grid gap-1 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="flex items-center gap-2">
        <Input
          inputMode="decimal"
          value={value}
          placeholder={placeholder ?? '0'}
          onChange={(event) => onChange(event.target.value)}
          className="max-w-[12rem] tabular-nums"
        />
        {suffix ? <span className="text-xs text-muted-foreground">{suffix}</span> : null}
      </span>
    </label>
  )
}

function Result({ rows }: { rows: Array<{ label: string; value: string; strong?: boolean }> }) {
  return (
    <dl className="mt-4 grid gap-1.5 rounded-lg border bg-muted/30 p-4 text-sm">
      {rows.map((row) => (
        <div key={row.label} className="flex items-baseline justify-between gap-4">
          <dt className="text-muted-foreground">{row.label}</dt>
          <dd className={row.strong ? 'text-base font-bold tabular-nums' : 'font-medium tabular-nums'}>
            {row.value}
          </dd>
        </div>
      ))}
    </dl>
  )
}

const DASH = '—'

export function AccountingCalculator({
  currency,
  taxRateBps,
}: {
  currency: CurrencyCode
  taxRateBps: number
}) {
  const [mode, setMode] = React.useState<Mode>('tax')

  // One shared bag of inputs; each mode reads the fields it needs, so
  // switching modes keeps the amount you already typed.
  const [amount, setAmount] = React.useState('')
  const [rate, setRate] = React.useState(taxRateBps > 0 ? String(taxRateBps / 100) : '')
  const [inclusive, setInclusive] = React.useState(false)
  const [cost, setCost] = React.useState('')
  const [price, setPrice] = React.useState('')
  const [target, setTarget] = React.useState('')
  const [targetKind, setTargetKind] = React.useState<'margin' | 'markup'>('margin')
  const [fxRate, setFxRate] = React.useState('')

  const money = (minor: number) => formatMoney(minor, currency)
  const pct = (bps: number | null) => (bps === null ? DASH : `${(bps / 100).toFixed(1)}%`)
  const amountMinor = amount.trim() === '' ? null : parseMoney(amount, currency)
  const costMinor = cost.trim() === '' ? null : parseMoney(cost, currency)
  const priceMinor = price.trim() === '' ? null : parseMoney(price, currency)
  const rateBps = toBps(rate)

  let rows: Array<{ label: string; value: string; strong?: boolean }> = []
  let note: React.ReactNode = null

  if (mode === 'tax') {
    if (amountMinor !== null && rateBps !== null) {
      if (inclusive) {
        const { net, tax } = taxInGross(amountMinor, rateBps)
        rows = [
          { label: 'Price with tax inside', value: money(amountMinor) },
          { label: 'Net (before tax)', value: money(net) },
          { label: `Tax (${pct(rateBps)})`, value: money(tax), strong: true },
        ]
      } else {
        const { tax, gross } = taxOnNet(amountMinor, rateBps)
        rows = [
          { label: 'Net amount', value: money(amountMinor) },
          { label: `Tax (${pct(rateBps)})`, value: money(tax) },
          { label: 'Total with tax', value: money(gross), strong: true },
        ]
      }
    }
    note = 'Tax-inclusive means the tax already sits inside the price you typed.'
  }

  if (mode === 'discount') {
    if (amountMinor !== null && rateBps !== null) {
      const { off, after } = discountOf(amountMinor, rateBps)
      rows = [
        { label: 'Before discount', value: money(amountMinor) },
        { label: `Discount (${pct(rateBps)})`, value: `− ${money(off)}` },
        { label: 'After discount', value: money(after), strong: true },
      ]
    }
  }

  if (mode === 'margin') {
    if (costMinor !== null && priceMinor !== null) {
      rows = [
        { label: 'Profit', value: money(priceMinor - costMinor), strong: true },
        { label: 'Margin (of price)', value: pct(marginBps(priceMinor, costMinor)) },
        { label: 'Markup (on cost)', value: pct(markupBps(priceMinor, costMinor)) },
      ]
    } else if (costMinor !== null && target.trim() !== '') {
      const targetBps = toBps(target)
      if (targetBps !== null) {
        const suggested =
          targetKind === 'margin' ? priceForMargin(costMinor, targetBps) : priceForMarkup(costMinor, targetBps)
        rows =
          suggested === null
            ? [{ label: 'Price', value: 'A margin must be under 100%' }]
            : [
                { label: 'Cost', value: money(costMinor) },
                { label: `Price for ${pct(targetBps)} ${targetKind}`, value: money(suggested), strong: true },
                { label: 'Profit', value: money(suggested - costMinor) },
              ]
      }
    }
    note = (
      <>
        Margin is profit as a share of the <em>price</em>; markup is profit as a share of the{' '}
        <em>cost</em>. A 40% margin equals a 66.7% markup — they are different numbers.{' '}
        <InfoTip term="margin" />
      </>
    )
  }

  if (mode === 'foodcost') {
    if (costMinor !== null && priceMinor !== null) {
      const fc = foodCostBps(costMinor, priceMinor)
      rows = [
        { label: 'Ingredient cost', value: money(costMinor) },
        { label: 'Selling price', value: money(priceMinor) },
        { label: 'Food cost', value: pct(fc), strong: true },
        { label: 'Kept as gross profit', value: fc === null ? DASH : pct(10_000 - fc) },
      ]
    }
    note = (
      <>
        Out of every 100 you sell, food cost is what the ingredients took. <InfoTip term="foodCostPercent" />
      </>
    )
  }

  if (mode === 'percent') {
    if (amountMinor !== null && rateBps !== null) {
      rows = [{ label: `${pct(rateBps)} of ${money(amountMinor)}`, value: money(discountOf(amountMinor, rateBps).off), strong: true }]
    }
    if (costMinor !== null && priceMinor !== null) {
      rows.push({
        label: `${money(costMinor)} as a share of ${money(priceMinor)}`,
        value: pct(shareBps(costMinor, priceMinor)),
      })
    }
  }

  if (mode === 'convert') {
    const rateNumber = Number.parseFloat(fxRate)
    if (amountMinor !== null && Number.isFinite(rateNumber) && rateNumber > 0) {
      const converted = convertAtRate(amountMinor, toRateMicro(rateNumber))
      rows = [
        { label: `Amount × rate ${rateNumber}`, value: money(converted), strong: true },
        { label: `Amount ÷ rate ${rateNumber}`, value: money(convertAtRate(amountMinor, toRateMicro(1 / rateNumber))) },
      ]
    }
    note = 'You enter the rate — TableFlow never fetches exchange rates. Both directions are shown; pick the one that matches your rate.'
  }

  return (
    <SectionCard
      title="Calculator"
      description="Computes as you type, with the same rounding the billing engine uses. Nothing is saved."
    >
      <div className="mb-4 flex flex-wrap gap-2">
        {MODES.map((entry) => (
          <Button
            key={entry.key}
            size="sm"
            variant={mode === entry.key ? 'default' : 'outline'}
            onClick={() => setMode(entry.key)}
          >
            {entry.label}
          </Button>
        ))}
      </div>

      <div className="flex flex-wrap items-end gap-4">
        {mode === 'tax' || mode === 'discount' || mode === 'percent' || mode === 'convert' ? (
          <Field label="Amount" value={amount} onChange={setAmount} suffix={currency} />
        ) : null}
        {mode === 'tax' ? (
          <>
            <Field label="Tax rate" value={rate} onChange={setRate} suffix="%" />
            <label className="flex items-center gap-2 pb-2 text-sm">
              <input
                type="checkbox"
                checked={inclusive}
                onChange={(event) => setInclusive(event.target.checked)}
                className="size-4 accent-primary"
              />
              Price includes tax
            </label>
          </>
        ) : null}
        {mode === 'discount' || mode === 'percent' ? (
          <Field label={mode === 'discount' ? 'Discount' : 'Percentage'} value={rate} onChange={setRate} suffix="%" />
        ) : null}
        {mode === 'margin' || mode === 'foodcost' ? (
          <Field label={mode === 'foodcost' ? 'Ingredient cost' : 'Cost'} value={cost} onChange={setCost} suffix={currency} />
        ) : null}
        {mode === 'margin' || mode === 'foodcost' || mode === 'percent' ? (
          <Field
            label={mode === 'percent' ? 'Of amount' : 'Selling price'}
            value={price}
            onChange={setPrice}
            suffix={currency}
            placeholder={mode === 'margin' ? 'leave empty to suggest one' : '0'}
          />
        ) : null}
        {mode === 'margin' && priceMinor === null ? (
          <>
            <Field label={`Target ${targetKind}`} value={target} onChange={setTarget} suffix="%" />
            <Button
              size="sm"
              variant="outline"
              className="mb-0.5"
              onClick={() => setTargetKind(targetKind === 'margin' ? 'markup' : 'margin')}
            >
              Switch to {targetKind === 'margin' ? 'markup' : 'margin'}
            </Button>
          </>
        ) : null}
        {mode === 'convert' ? <Field label="Rate" value={fxRate} onChange={setFxRate} placeholder="e.g. 291.735" /> : null}
      </div>

      {rows.length > 0 ? <Result rows={rows} /> : (
        <p className="mt-4 text-sm text-muted-foreground">Fill the fields above and the answer appears here.</p>
      )}
      {note ? <p className="mt-3 text-xs text-muted-foreground">{note}</p> : null}
    </SectionCard>
  )
}
