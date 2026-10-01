'use client'

import { useState } from 'react'
import { AlertTriangle, Info } from 'lucide-react'

import { cn } from '@/lib/utils'

import { Card, Field } from './ui'

/*
 * Accounting → Tools, as the real page lays it out: a Calculator with six
 * modes that computes as you type, and a "What if" price simulation on last
 * month's sales. Nothing here is saved, in the demo or in the product.
 */

const MODES = ['Tax', 'Discount', 'Margin & markup', 'Food cost %', 'Percentage', 'Convert currency'] as const
type Mode = (typeof MODES)[number]

const num = (v: string) => (v.trim() === '' ? null : Number(v))
const money = (v: number) => `Rs ${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const pct = (v: number) => `${v.toFixed(1)}%`

const INGREDIENTS: { name: string; unit: string; cost: number; used: number; dishes: [string, number, number, number][] }[] = [
  { name: 'Chicken (whole)', unit: 'kg', cost: 1250, used: 318.4, dishes: [['Chicken Kottu', 412, 0.3, 1250], ['Chicken Biryani', 356, 0.35, 1650], ['Butter Chicken', 142, 0.3, 1750], ['Chicken Satay', 142, 0.2, 950]] },
  { name: 'Prawns', unit: 'kg', cost: 2800, used: 61.5, dishes: [['Devilled Prawns', 118, 0.25, 1450], ['Seafood Fried Rice', 134, 0.15, 1550]] },
  { name: 'Mozzarella', unit: 'kg', cost: 3900, used: 27.6, dishes: [['Margherita Pizza', 168, 0.12, 1890], ['Cheese Kottu', 298, 0.03, 1450]] },
  { name: 'Lagoon Crab', unit: 'kg', cost: 4200, used: 48.4, dishes: [['Jaffna Crab Curry', 121, 0.4, 2900]] },
  { name: 'Basmati Rice', unit: 'kg', cost: 420, used: 235, dishes: [['Chicken Biryani', 356, 0.25, 1650], ['Mutton Biryani', 96, 0.25, 2100], ['Seafood Fried Rice', 134, 0.2, 1550], ['Rice & Curry', 188, 0.25, 950]] },
]

export function Tools() {
  const [tab, setTab] = useState<'Calculator' | 'What if'>('Calculator')
  return (
    <div className="space-y-4">
      <div>
        <h4 className="text-xl font-bold tracking-tight">Tools</h4>
        <p className="tfd-muted mt-0.5 text-sm">Quick sums in the same math the bills use, and a way to test a price change safely. Nothing here is saved.</p>
      </div>
      <div className="tfd-track inline-flex rounded-full p-1 text-xs font-semibold" role="tablist">
        {(['Calculator', 'What if'] as const).map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className="tfd-tab rounded-full px-4 py-1.5">
            {t}
          </button>
        ))}
      </div>
      {tab === 'Calculator' ? <Calculator /> : <WhatIf />}
    </div>
  )
}

function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div className={cn('flex justify-between gap-3 text-sm', bold && 'text-base font-bold')}>
      <span className={bold ? '' : 'tfd-muted'}>{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  )
}

function Money({ label, value, onChange, placeholder = '0' }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <Field label={label}>
      <span className="relative block">
        <input value={value} onChange={(e) => onChange(e.target.value.replace(/[^\d.]/g, ''))} inputMode="decimal" placeholder={placeholder} className="tfd-input w-full py-2 pl-3 pr-12 text-sm" />
        <span className="tfd-muted absolute right-3 top-1/2 -translate-y-1/2 text-xs">LKR</span>
      </span>
    </Field>
  )
}

function Percent({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <Field label={label}>
      <span className="relative block">
        <input value={value} onChange={(e) => onChange(e.target.value.replace(/[^\d.]/g, ''))} inputMode="decimal" placeholder="0" className="tfd-input w-full py-2 pl-3 pr-8 text-sm" />
        <span className="tfd-muted absolute right-3 top-1/2 -translate-y-1/2 text-xs">%</span>
      </span>
    </Field>
  )
}

function Calculator() {
  const [mode, setMode] = useState<Mode>('Tax')
  const [amount, setAmount] = useState('')
  const [rate, setRate] = useState('')
  const [inclusive, setInclusive] = useState(false)
  const [discount, setDiscount] = useState('')
  const [cost, setCost] = useState('')
  const [price, setPrice] = useState('')
  const [target, setTarget] = useState('')
  const [targetKind, setTargetKind] = useState<'margin' | 'markup'>('margin')
  const [percentage, setPercentage] = useState('')
  const [fx, setFx] = useState('')

  const a = num(amount)
  const r = num(rate)
  const c = num(cost)
  const p = num(price)

  let result: React.ReactNode = null
  let note: React.ReactNode = null

  if (mode === 'Tax' && a != null && r != null) {
    result = inclusive ? (
      <>
        <Row label="Price with tax inside" value={money(a)} />
        <Row label="Net (before tax)" value={money(a / (1 + r / 100))} />
        <Row label={`Tax (${r}%)`} value={money(a - a / (1 + r / 100))} bold />
      </>
    ) : (
      <>
        <Row label="Net amount" value={money(a)} />
        <Row label={`Tax (${r}%)`} value={money((a * r) / 100)} />
        <Row label="Total with tax" value={money(a * (1 + r / 100))} bold />
      </>
    )
    note = 'Tax-inclusive means the tax already sits inside the price you typed.'
  }
  if (mode === 'Discount' && a != null && num(discount) != null) {
    const d = num(discount)!
    result = (
      <>
        <Row label="Before discount" value={money(a)} />
        <Row label={`Discount (${d}%)`} value={`− ${money((a * d) / 100)}`} />
        <Row label="After discount" value={money(a - (a * d) / 100)} bold />
      </>
    )
  }
  if (mode === 'Margin & markup') {
    const t = num(target)
    if (c != null && p != null && p > 0) {
      result = (
        <>
          <Row label="Profit" value={money(p - c)} bold />
          <Row label="Margin (of price)" value={pct(((p - c) / p) * 100)} />
          <Row label="Markup (on cost)" value={c > 0 ? pct(((p - c) / c) * 100) : '—'} />
        </>
      )
    } else if (c != null && t != null) {
      if (targetKind === 'margin' && t >= 100) result = <Row label="Price" value="A margin must be under 100%" />
      else {
        const suggested = targetKind === 'margin' ? c / (1 - t / 100) : c * (1 + t / 100)
        result = (
          <>
            <Row label="Cost" value={money(c)} />
            <Row label={`Price for ${t}% ${targetKind}`} value={money(suggested)} bold />
            <Row label="Profit" value={money(suggested - c)} />
          </>
        )
      }
    }
    note = (
      <>
        Margin is profit as a share of the <i>price</i>; markup is profit as a share of the <i>cost</i>. A 40% margin equals a 66.7% markup — they are different numbers.
      </>
    )
  }
  if (mode === 'Food cost %' && c != null && p != null && p > 0) {
    result = (
      <>
        <Row label="Ingredient cost" value={money(c)} />
        <Row label="Selling price" value={money(p)} />
        <Row label="Food cost" value={pct((c / p) * 100)} bold />
        <Row label="Kept as gross profit" value={pct((1 - c / p) * 100)} />
      </>
    )
    note = 'Out of every 100 you sell, food cost is what the ingredients took.'
  }
  if (mode === 'Percentage' && a != null && num(percentage) != null) {
    const q = num(percentage)!
    result = (
      <>
        <Row label={`${q}% of ${money(a)}`} value={money((a * q) / 100)} bold />
        {c != null && p != null && p > 0 ? <Row label={`${money(c)} as a share of ${money(p)}`} value={pct((c / p) * 100)} /> : null}
      </>
    )
  }
  if (mode === 'Convert currency' && a != null && num(fx) != null && num(fx)! > 0) {
    const x = num(fx)!
    result = (
      <>
        <Row label={`Amount × rate ${x}`} value={(a * x).toLocaleString('en-US', { maximumFractionDigits: 2 })} bold />
        <Row label={`Amount ÷ rate ${x}`} value={(a / x).toLocaleString('en-US', { maximumFractionDigits: 4 })} />
      </>
    )
    note = 'You enter the rate — TableFlow never fetches exchange rates. Both directions are shown; pick the one that matches your rate.'
  }

  return (
    <Card>
      <h5 className="text-sm font-semibold">Calculator</h5>
      <p className="tfd-muted mt-0.5 text-xs">Computes as you type, with the same rounding the billing engine uses. Nothing is saved.</p>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {MODES.map((m) => (
          <button key={m} type="button" aria-pressed={mode === m} onClick={() => setMode(m)} className={cn('tfd-line rounded-lg border px-3 py-1.5 text-xs font-semibold', mode === m && 'tfd-btn-primary border-transparent')}>
            {m}
          </button>
        ))}
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {mode === 'Tax' ? (
          <>
            <Money label="Amount" value={amount} onChange={setAmount} />
            <Percent label="Tax rate" value={rate} onChange={setRate} />
            <label className="flex items-center gap-2 text-xs sm:col-span-2">
              <input type="checkbox" checked={inclusive} onChange={(e) => setInclusive(e.target.checked)} /> Price includes tax
            </label>
          </>
        ) : null}
        {mode === 'Discount' ? (
          <>
            <Money label="Amount" value={amount} onChange={setAmount} />
            <Percent label="Discount" value={discount} onChange={setDiscount} />
          </>
        ) : null}
        {mode === 'Margin & markup' ? (
          <>
            <Money label="Cost" value={cost} onChange={setCost} />
            <Money label="Selling price" value={price} onChange={setPrice} placeholder="leave empty to suggest one" />
            {price.trim() === '' ? (
              <div className="flex items-end gap-2 sm:col-span-2">
                <div className="flex-1">
                  <Percent label={targetKind === 'margin' ? 'Target margin' : 'Target markup'} value={target} onChange={setTarget} />
                </div>
                <button type="button" className="tfd-btn tfd-btn-glass px-3 py-2 text-xs" onClick={() => setTargetKind((k) => (k === 'margin' ? 'markup' : 'margin'))}>
                  {targetKind === 'margin' ? 'Switch to markup' : 'Switch to margin'}
                </button>
              </div>
            ) : null}
          </>
        ) : null}
        {mode === 'Food cost %' ? (
          <>
            <Money label="Ingredient cost" value={cost} onChange={setCost} />
            <Money label="Selling price" value={price} onChange={setPrice} />
          </>
        ) : null}
        {mode === 'Percentage' ? (
          <>
            <Money label="Amount" value={amount} onChange={setAmount} />
            <Percent label="Percentage" value={percentage} onChange={setPercentage} />
            <Money label="Selling price" value={price} onChange={setPrice} />
            <Money label="Of amount" value={cost} onChange={setCost} />
          </>
        ) : null}
        {mode === 'Convert currency' ? (
          <>
            <Money label="Amount" value={amount} onChange={setAmount} />
            <Field label="Rate">
              <input value={fx} onChange={(e) => setFx(e.target.value.replace(/[^\d.]/g, ''))} inputMode="decimal" placeholder="e.g. 291.735" className="tfd-input w-full px-3 py-2 text-sm" />
            </Field>
          </>
        ) : null}
      </div>

      <div className="tfd-track mt-4 space-y-1.5 rounded-xl p-4">
        {result ?? <p className="tfd-muted text-sm">Fill the fields above and the answer appears here.</p>}
      </div>
      {note ? (
        <p className="tfd-muted mt-3 flex items-start gap-2 text-xs">
          <Info className="tfd-brand mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>{note}</span>
        </p>
      ) : null}
    </Card>
  )
}

function WhatIf() {
  const [pick, setPick] = useState('')
  const [newPrice, setNewPrice] = useState('')
  const ing = INGREDIENTS.find((i) => i.name === pick)
  const next = num(newPrice)

  const revenueNow = ing ? ing.dishes.reduce((s, [, sold, , price]) => s + sold * price, 0) : 0
  const ingredientNow = ing ? ing.used * ing.cost : 0
  const otherCost = revenueNow * 0.25
  const profitNow = revenueNow - ingredientNow - otherCost
  const diff = ing && next != null ? (next - ing.cost) * ing.used : 0
  const profitNext = profitNow - diff

  return (
    <Card>
      <h5 className="text-sm font-semibold">What if a price changes?</h5>
      <p className="tfd-muted mt-0.5 text-xs">See what an ingredient price would do to your profit, at the sales you actually had.</p>
      <p className="tfd-pill tfd-pill-warn mt-3 !flex !items-start !gap-2 !whitespace-normal !rounded-xl !px-3 !py-2 !text-xs">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden /> Simulation only — nothing on this screen is saved, and no figure in your books changes.
      </p>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <Field label="Ingredient">
          <select value={pick} onChange={(e) => { setPick(e.target.value); setNewPrice('') }} className="tfd-input w-full px-3 py-2 text-sm">
            <option value="">Choose an ingredient…</option>
            {INGREDIENTS.map((i) => (
              <option key={i.name} value={i.name}>
                {i.name} ({i.unit})
              </option>
            ))}
          </select>
        </Field>
        {ing ? (
          <>
            <div className="text-xs">
              <span className="mb-1 block font-semibold">Costs now</span>
              <span className="tfd-input block px-3 py-2 text-sm">{money(ing.cost)} / {ing.unit}</span>
            </div>
            <div className="sm:col-span-2">
              <Money label={`New price per ${ing.unit}`} value={newPrice} onChange={setNewPrice} placeholder={String(ing.cost)} />
            </div>
          </>
        ) : null}
      </div>

      {ing && next != null ? (
        <div className="tfd-fade mt-4 space-y-3">
          {next === ing.cost ? (
            <p className="text-sm">That is the same price you pay now.</p>
          ) : (
            <p className="text-sm">
              {next > ing.cost ? 'Paying' : 'Saving'} <b>{money(Math.abs(next - ing.cost))}</b> more per {ing.unit} would have {next > ing.cost ? 'cost' : 'saved'} you <b>{money(Math.abs(diff))}</b> over last 30 days, on {ing.used.toFixed(2)} {ing.unit} used.
            </p>
          )}
          <div className="tfd-track space-y-1.5 rounded-xl p-4">
            <Row label="Profit on these dishes now" value={money(profitNow)} />
            <Row label="Profit at the new price" value={money(profitNext)} bold />
            <Row label="Margin on these dishes" value={pct((profitNext / revenueNow) * 100)} />
          </div>
          <div className="tfd-thin-scroll overflow-x-auto">
            <table className="w-full min-w-[32rem] text-left text-sm">
              <thead>
                <tr className="tfd-muted text-xs uppercase tracking-wide">
                  {['Dish', 'Sold', 'Extra per dish', 'Extra in total', 'Margin then → now'].map((h, i) => (
                    <th key={h} className={cn('tfd-line border-b py-2 pr-3 font-medium', i > 0 && 'text-right')}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {ing.dishes.map(([dish, sold, perDish, price]) => {
                  const extra = (next - ing.cost) * perDish
                  const costNow = price * 0.32
                  const marginThen = ((price - costNow) / price) * 100
                  const marginNow = ((price - costNow - extra) / price) * 100
                  return (
                    <tr key={dish}>
                      <td className="tfd-line border-b py-2 pr-3 font-medium">{dish}</td>
                      <td className="tfd-line border-b py-2 pr-3 text-right tabular-nums">{sold}</td>
                      <td className="tfd-line border-b py-2 pr-3 text-right tabular-nums">{money(extra)}</td>
                      <td className="tfd-line border-b py-2 pr-3 text-right tabular-nums">{money(extra * sold)}</td>
                      <td className="tfd-line border-b py-2 pr-3 text-right tabular-nums">{marginThen.toFixed(1)}% → {marginNow.toFixed(1)}%</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </Card>
  )
}
