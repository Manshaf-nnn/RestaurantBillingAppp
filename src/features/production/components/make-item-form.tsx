'use client'

import * as React from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { AlertTriangle, ChefHat, Plus, Trash2 } from 'lucide-react'
import type { StockUnit } from '@prisma/client'

import { Alert } from '@/components/ui/feedback'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { UNIT_LABELS, formatQuantity, toBaseUnits } from '@/features/inventory/units'
import { formatMoney, minorUnitFactor } from '@/lib/money'
import { roundQty } from '@/lib/quantity'
import { newRequestKey } from '@/lib/request-key'
import { useAction } from '@/lib/use-action'
import { produceItemAction } from '../actions'
import type { ProduceItemResult, WorkspaceItem } from '../types'

/**
 * Make Item (redesignkitchenjob.md): name → quantity → ingredients → cost → done.
 *
 * The cost preview is computed here from the figures the page loaded — each
 * item's exact average cost and what this branch holds — using the same unit
 * conversion the ledger uses. It is a preview: the transaction re-reads the
 * ledger and its answer is the one that gets recorded. The two agree unless
 * stock moved between the page loading and the button being pressed.
 *
 * One request key per attempt at a batch. It is minted when the form is
 * shown and again after each success, never on retry, so a double tap or a
 * retried request records the batch once.
 */

type Row = { key: string; itemId: string; quantity: string; unit: StockUnit | '' }
type WasteRow = Row & { note: string }

const ALL_UNITS = Object.keys(UNIT_LABELS) as StockUnit[]
const SELECT = 'h-10 w-full rounded-lg border border-input bg-background px-2 text-sm'

let rowSeq = 0
const newRow = (): Row => ({ key: `r${++rowSeq}`, itemId: '', quantity: '', unit: '' })
const newWasteRow = (): WasteRow => ({ ...newRow(), note: '' })

export function MakeItemForm({
  items,
  branches,
  branchId,
  currency,
  locale,
  prefillName,
}: {
  items: WorkspaceItem[]
  branches: Array<{ id: string; name: string }>
  branchId: string | null
  currency: string
  locale: string
  /** Set by "Make more" on the Prepared Items tab. */
  prefillName: string | null
}) {
  const router = useRouter()
  const { busy, run } = useAction()
  const requestKey = React.useRef(newRequestKey('prod'))

  const [branch, setBranch] = React.useState(branchId ?? branches[0]?.id ?? '')
  const [name, setName] = React.useState(prefillName ?? '')
  const [quantity, setQuantity] = React.useState('')
  const [unit, setUnit] = React.useState<StockUnit>('KG')
  const [rows, setRows] = React.useState<Row[]>([newRow()])
  const [waste, setWaste] = React.useState<WasteRow[]>([])
  const [notes, setNotes] = React.useState('')
  const [result, setResult] = React.useState<ProduceItemResult | null>(null)

  React.useEffect(() => {
    if (prefillName) {
      setName(prefillName)
      setResult(null)
    }
  }, [prefillName])

  const byId = React.useMemo(() => new Map(items.map((item) => [item.id, item])), [items])
  const money = (minor: number) => formatMoney(Math.round(minor), currency, locale)
  const factor = minorUnitFactor(currency)
  /** A per-unit cost, which is often a fraction of a minor unit for gram/ml items. */
  const perUnit = (minor: number) => {
    const major = minor / factor
    const digits = major !== 0 && Math.abs(major) < 1 ? 4 : 2
    return `${formatMoney(0, currency, locale).replace(/[\d.,\s]/g, '')}${major.toLocaleString(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits })}`
  }

  /* ── What the typed name means ────────────────────────────────────────── */

  const trimmed = name.trim().replace(/\s+/g, ' ')
  const matched = React.useMemo(
    () => items.find((item) => item.name.toLowerCase() === trimmed.toLowerCase()) ?? null,
    [items, trimmed],
  )
  const nameIsRaw = matched !== null && !matched.isPrepared
  const outputUnits: StockUnit[] = matched ? matched.units : ALL_UNITS
  React.useEffect(() => {
    if (matched && !matched.units.includes(unit)) setUnit(matched.unit)
  }, [matched, unit])

  /* ── The preview ──────────────────────────────────────────────────────── */

  const preview = React.useMemo(() => {
    const lines = rows.map((row) => {
      const item = row.itemId ? byId.get(row.itemId) : undefined
      const qty = Number(row.quantity)
      if (!item || !(qty > 0) || !row.unit) return { row, item, base: 0, value: 0, error: null as string | null, short: false }
      try {
        const base = roundQty(toBaseUnits(qty, row.unit, item))
        return { row, item, base, value: base * item.unitCost, error: null, short: base > item.available }
      } catch {
        return { row, item, base: 0, value: 0, error: `Enter ${item.name} in ${item.units.map((u) => UNIT_LABELS[u]).join(', ')}`, short: false }
      }
    })
    const active = lines.filter((l) => l.item && l.base > 0)
    const total = active.reduce((sum, l) => sum + l.value, 0)
    const qty = Number(quantity)
    let producedBase = 0
    let unitError: string | null = null
    if (qty > 0) {
      if (matched) {
        try { producedBase = roundQty(toBaseUnits(qty, unit, matched)) } catch { unitError = `${matched.name} is stocked in ${UNIT_LABELS[matched.unit]}` }
      } else {
        producedBase = qty
      }
    }
    return {
      lines,
      total,
      producedBase,
      unitError,
      perBase: producedBase > 0 ? total / producedBase : 0,
      shortages: active.filter((l) => l.short),
      unpriced: active.filter((l) => l.item!.unitCost === 0),
      errors: lines.filter((l) => l.error),
    }
  }, [rows, byId, quantity, unit, matched])

  const chosenIngredients = React.useMemo(
    () => rows.map((r) => byId.get(r.itemId)).filter((i): i is WorkspaceItem => Boolean(i)),
    [rows, byId],
  )

  const ready =
    trimmed.length >= 2 &&
    !nameIsRaw &&
    Number(quantity) > 0 &&
    !preview.unitError &&
    preview.lines.some((l) => l.item && l.base > 0) &&
    preview.errors.length === 0 &&
    preview.shortages.length === 0 &&
    Boolean(branch) &&
    !chosenIngredients.some((i) => matched && i.id === matched.id)

  /* ── Row editing ──────────────────────────────────────────────────────── */

  const setRow = (key: string, patch: Partial<Row>) =>
    setRows((current) => current.map((r) => (r.key === key ? { ...r, ...patch } : r)))
  const pickItem = (key: string, itemId: string) => {
    const item = byId.get(itemId)
    setRow(key, { itemId, unit: item ? (item.consumptionUnit ?? item.unit) : '' })
  }
  const setWasteRow = (key: string, patch: Partial<WasteRow>) =>
    setWaste((current) => current.map((r) => (r.key === key ? { ...r, ...patch } : r)))

  const reset = () => {
    setName('')
    setQuantity('')
    setUnit('KG')
    setRows([newRow()])
    setWaste([])
    setNotes('')
    requestKey.current = newRequestKey('prod')
  }

  const submit = async () => {
    if (!ready) return
    const payload = {
      clientRequestId: requestKey.current,
      branchId: branch,
      output: { itemId: matched?.id ?? null, name: trimmed, quantity: Number(quantity), unit },
      ingredients: rows
        .filter((r) => r.itemId && Number(r.quantity) > 0 && r.unit)
        .map((r) => ({ itemId: r.itemId, quantity: Number(r.quantity), unit: r.unit as StockUnit })),
      waste: waste
        .filter((r) => r.itemId && Number(r.quantity) > 0 && r.unit)
        .map((r) => ({ itemId: r.itemId, quantity: Number(r.quantity), unit: r.unit as StockUnit, note: r.note || undefined })),
      notes: notes || undefined,
    }
    await run(() => produceItemAction(payload), {
      onDone: (data) => {
        setResult(data)
        reset()
        router.refresh()
      },
    })
  }

  /* ── After a run: what happened to stock ──────────────────────────────── */

  if (result) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ChefHat className="size-5 text-emerald-600" />
            {result.replayed ? 'Already recorded' : 'Made'} — {formatQuantity(result.producedQty, result.item.unit)} {result.item.name}
          </CardTitle>
          <CardDescription>
            {result.replayed
              ? 'This batch had already been recorded; nothing moved a second time.'
              : `Inventory impact — record ${result.number}.`}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <div className="grid gap-3 sm:grid-cols-3">
            <Stat label="Value moved into it" value={money(result.totalValue)} />
            <Stat label={`Cost per ${UNIT_LABELS[result.item.unit]}`} value={perUnit(result.unitCost)} />
            <Stat label="Now on hand" value={formatQuantity(result.item.quantity, result.item.unit)} hint={`avg ${perUnit(result.item.costPerUnit)} / ${UNIT_LABELS[result.item.unit]}`} />
          </div>
          <div>
            <p className="mb-1 font-medium">Left stock</p>
            <ul className="divide-y divide-border rounded-lg border border-border">
              {result.consumed.map((line) => (
                <li key={line.itemId} className="flex items-center justify-between px-3 py-2">
                  <span>{line.name}</span>
                  <span className="tabular-nums text-muted-foreground">−{formatQuantity(line.quantity, line.unit)} · {money(line.value)}</span>
                </li>
              ))}
              {result.wasted.map((line) => (
                <li key={`w-${line.itemId}`} className="flex items-center justify-between px-3 py-2">
                  <span>{line.name} <Badge variant="warning" size="sm">waste</Badge></span>
                  <span className="tabular-nums text-muted-foreground">−{formatQuantity(line.quantity, line.unit)} · {money(line.value)} expensed</span>
                </li>
              ))}
            </ul>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => setResult(null)}>Make another</Button>
            <Button variant="outline" asChild>
              <Link href={`/dashboard/production/${result.orderId}`}>View record</Link>
            </Button>
            <Button variant="ghost" asChild>
              <Link href={`/dashboard/inventory/${result.item.id}`}>Open {result.item.name}</Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    )
  }

  /* ── The form ─────────────────────────────────────────────────────────── */

  return (
    <div className="grid gap-5 lg:grid-cols-3">
      <div className="space-y-5 lg:col-span-2">
        <Card>
          <CardHeader>
            <CardTitle>What did you make?</CardTitle>
            <CardDescription>
              Type a name. An existing prepared item is topped up; a new name creates one.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {branches.length > 1 ? (
              <label className="block text-sm">
                <span className="mb-1 block text-muted-foreground">Made at</span>
                <select className={SELECT} value={branch} onChange={(e) => setBranch(e.target.value)}>
                  {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
              </label>
            ) : null}

            <label className="block text-sm">
              <span className="mb-1 block text-muted-foreground">Prepared item</span>
              <Input
                list="prepared-item-names"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Mayonnaise, curry paste, dough…"
                aria-invalid={nameIsRaw}
                autoComplete="off"
              />
              <datalist id="prepared-item-names">
                {items.filter((i) => i.isPrepared).map((i) => <option key={i.id} value={i.name} />)}
              </datalist>
              {matched && !nameIsRaw ? (
                <span className="mt-1 block text-xs text-muted-foreground">
                  Adds to <strong>{matched.name}</strong> — stocked in {UNIT_LABELS[matched.unit]}, {formatQuantity(matched.available, matched.unit)} here, avg {perUnit(matched.unitCost)}/{UNIT_LABELS[matched.unit]}.
                </span>
              ) : null}
              {nameIsRaw ? (
                <span className="mt-1 block text-xs text-destructive">
                  “{matched!.name}” is a raw stock item. Give the prepared item its own name — “Prepared {matched!.name.toLowerCase()}”, say.
                </span>
              ) : null}
            </label>

            <div className="grid grid-cols-[1fr_8rem] gap-3">
              <label className="block text-sm">
                <span className="mb-1 block text-muted-foreground">Quantity produced</span>
                <Input type="number" inputMode="decimal" min={0} step="any" value={quantity} onChange={(e) => setQuantity(e.target.value)} placeholder="0" />
              </label>
              <label className="block text-sm">
                <span className="mb-1 block text-muted-foreground">Unit</span>
                <select className={SELECT} value={unit} onChange={(e) => setUnit(e.target.value as StockUnit)}>
                  {outputUnits.map((u) => <option key={u} value={u}>{UNIT_LABELS[u]}</option>)}
                </select>
              </label>
            </div>
            {preview.unitError ? <p className="text-xs text-destructive">{preview.unitError}</p> : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Ingredients</CardTitle>
            <CardDescription>Stock items only. Costs are today’s average from the ledger.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="hidden grid-cols-[1fr_6rem_6rem_7rem_7rem_2.5rem] gap-2 text-xs uppercase tracking-wide text-muted-foreground sm:grid">
              <span>Stock item</span><span>Qty</span><span>Unit</span><span className="text-right">Cost/unit</span><span className="text-right">Cost</span><span />
            </div>
            {preview.lines.map(({ row, item, base, value, error, short }) => (
              <div key={row.key} className="grid grid-cols-2 gap-2 sm:grid-cols-[1fr_6rem_6rem_7rem_7rem_2.5rem]">
                <select className={`${SELECT} col-span-2 sm:col-span-1`} value={row.itemId} onChange={(e) => pickItem(row.key, e.target.value)}>
                  <option value="">Choose a stock item…</option>
                  {items.map((i) => (
                    <option key={i.id} value={i.id} disabled={matched?.id === i.id}>
                      {i.name}{i.isPrepared ? ' (prepared)' : ''}
                    </option>
                  ))}
                </select>
                <Input type="number" inputMode="decimal" min={0} step="any" value={row.quantity} onChange={(e) => setRow(row.key, { quantity: e.target.value })} placeholder="0" aria-invalid={Boolean(error) || short} />
                <select className={SELECT} value={row.unit} onChange={(e) => setRow(row.key, { unit: e.target.value as StockUnit })} disabled={!item}>
                  {(item ? item.units : ALL_UNITS).map((u) => <option key={u} value={u}>{UNIT_LABELS[u]}</option>)}
                </select>
                <span className="self-center text-right text-sm tabular-nums text-muted-foreground">
                  {item ? `${perUnit(item.unitCost)}/${UNIT_LABELS[item.unit]}` : ''}
                </span>
                <span className="self-center text-right text-sm tabular-nums">{base > 0 ? money(value) : ''}</span>
                <Button type="button" variant="ghost" size="icon" aria-label="Remove ingredient" onClick={() => setRows((c) => (c.length > 1 ? c.filter((r) => r.key !== row.key) : [newRow()]))}>
                  <Trash2 />
                </Button>
                {error ? <p className="col-span-full text-xs text-destructive">{error}</p> : null}
                {short && item ? (
                  <p className="col-span-full text-xs text-amber-700 dark:text-amber-400">
                    Only {formatQuantity(item.available, item.unit)} of {item.name} here — receive stock or reduce the amount.
                  </p>
                ) : null}
              </div>
            ))}
            <Button type="button" variant="outline" size="sm" onClick={() => setRows((c) => [...c, newRow()])}>
              <Plus /> Add ingredient
            </Button>

            <details className="rounded-lg border border-dashed border-border p-3" open={waste.length > 0}>
              <summary className="cursor-pointer text-sm font-medium">Production waste (optional)</summary>
              <p className="mt-1 text-xs text-muted-foreground">
                Trimmings, a spoiled part-batch — anything thrown away while making this. Deducted as waste and expensed; it does not raise the item’s cost.
              </p>
              <div className="mt-3 space-y-2">
                {waste.map((row) => (
                  <div key={row.key} className="grid grid-cols-2 gap-2 sm:grid-cols-[1fr_6rem_6rem_1fr_2.5rem]">
                    <select className={`${SELECT} col-span-2 sm:col-span-1`} value={row.itemId} onChange={(e) => { const i = byId.get(e.target.value); setWasteRow(row.key, { itemId: e.target.value, unit: i ? i.unit : '' }) }}>
                      <option value="">Which ingredient…</option>
                      {chosenIngredients.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
                    </select>
                    <Input type="number" inputMode="decimal" min={0} step="any" value={row.quantity} onChange={(e) => setWasteRow(row.key, { quantity: e.target.value })} placeholder="0" />
                    <select className={SELECT} value={row.unit} onChange={(e) => setWasteRow(row.key, { unit: e.target.value as StockUnit })} disabled={!row.itemId}>
                      {(byId.get(row.itemId)?.units ?? ALL_UNITS).map((u) => <option key={u} value={u}>{UNIT_LABELS[u]}</option>)}
                    </select>
                    <Input value={row.note} onChange={(e) => setWasteRow(row.key, { note: e.target.value })} placeholder="Why (optional)" className="col-span-2 sm:col-span-1" />
                    <Button type="button" variant="ghost" size="icon" aria-label="Remove waste line" onClick={() => setWaste((c) => c.filter((r) => r.key !== row.key))}>
                      <Trash2 />
                    </Button>
                  </div>
                ))}
                <Button type="button" variant="ghost" size="sm" disabled={chosenIngredients.length === 0} onClick={() => setWaste((c) => [...c, newWasteRow()])}>
                  <Plus /> Add waste
                </Button>
              </div>
            </details>

            <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Notes (optional)" maxLength={500} />
          </CardContent>
        </Card>
      </div>

      <div className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle>Cost preview</CardTitle>
            <CardDescription>From today’s average costs. The record uses the ledger at the moment you complete.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <Stat label="Ingredients" value={money(preview.total)} />
            <Stat
              label={preview.producedBase > 0 ? `Cost per ${UNIT_LABELS[matched ? matched.unit : unit]}` : 'Cost per unit'}
              value={preview.producedBase > 0 ? perUnit(preview.perBase) : '—'}
              hint={preview.producedBase > 0 ? `${formatQuantity(preview.producedBase, matched ? matched.unit : unit)} produced` : 'Enter the quantity produced'}
            />
            {preview.unpriced.length > 0 ? (
              <Alert variant="warning" title="No recorded cost yet">
                {preview.unpriced.map((l) => l.item!.name).join(', ')} {preview.unpriced.length === 1 ? 'has' : 'have'} never been received with a price, so {preview.unpriced.length === 1 ? 'it adds' : 'they add'} nothing to the cost.
              </Alert>
            ) : null}
            {preview.shortages.length > 0 ? (
              <Alert variant="destructive" title="Not enough stock here">
                Production never takes a shelf below zero.
              </Alert>
            ) : null}
            <Button className="w-full" size="lg" onClick={submit} disabled={!ready} loading={busy}>
              Complete production
            </Button>
            <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              One step, one transaction: ingredients leave stock and the prepared item arrives carrying exactly their value. Nothing is expensed until a dish is sold.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-border bg-muted/30 px-3 py-2">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-lg font-semibold tabular-nums">{value}</p>
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  )
}
