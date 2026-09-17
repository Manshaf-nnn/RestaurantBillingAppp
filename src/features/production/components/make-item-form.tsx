'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { MapPin, Plus, Trash2 } from 'lucide-react'
import type { StockUnit } from '@prisma/client'
import { toast } from 'sonner'

import { Alert } from '@/components/ui/feedback'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { ItemPicker } from '@/components/ui/item-picker'
import { UNIT_LABELS, formatQuantity, toBaseUnits } from '@/features/inventory/units'
import { formatMoney, minorUnitFactor } from '@/lib/money'
import { roundQty } from '@/lib/quantity'
import { newRequestKey } from '@/lib/request-key'
import { useAction } from '@/lib/use-action'
import { startBatchAction } from '../actions'
import type { PrepRecipe, WorkspaceItem } from '../types'

/**
 * Make an Item (recorrection.md §3, aO.md §5): one flow.
 *
 *   pick or name the prepared item → output → ingredients → Create
 *     → the prepared item's page: "How much did you make?" → Make Done
 *
 * Create writes the item and its recipe and starts the batch; it moves no
 * stock. Make Done, on the item's own page, runs the one atomic transaction
 * with the quantity that actually came out. There is no "make it now" any
 * more, no location select — the location is the one the switcher chose,
 * named at the top — and this form asks nothing twice: it asks how much is
 * being aimed for, and the item's page asks what came out.
 *
 * The cost preview is computed here from the figures the page loaded — each
 * item's exact average cost and what this branch holds — using the same unit
 * conversion the ledger uses. It is a preview: the transaction re-reads the
 * ledger and its answer is the one that gets recorded.
 *
 * One request key per attempt at a batch. It is minted when the form is
 * shown and again after each success, never on retry, so a double tap or a
 * retried request creates the batch once.
 */

type Row = { key: string; itemId: string; quantity: string; unit: StockUnit | '' }
type WasteRow = Row & { note: string }

const ALL_UNITS = Object.keys(UNIT_LABELS) as StockUnit[]
const SELECT = 'h-10 w-full rounded-lg border border-input bg-background px-2 text-sm'
/** The picker's "none of these" row. Not an id anything could collide with. */
const NEW_ITEM = '__new__'

let rowSeq = 0
const newRow = (): Row => ({ key: `r${++rowSeq}`, itemId: '', quantity: '', unit: '' })
const newWasteRow = (): WasteRow => ({ ...newRow(), note: '' })

export function MakeItemForm({
  items,
  recipes,
  branchId,
  branchName,
  branchIsFallback,
  currency,
  locale,
  prefill,
}: {
  items: WorkspaceItem[]
  recipes: Record<string, PrepRecipe>
  branchId: string | null
  branchName: string | null
  /** The location was not chosen on the switcher; the form says so. */
  branchIsFallback: boolean
  currency: string
  locale: string
  /** Set when the Make tab was opened to remake a particular item. */
  prefill: { itemId: string; name: string } | null
}) {
  const router = useRouter()
  const { busy, run } = useAction()
  const requestKey = React.useRef(newRequestKey('prod'))

  const [choice, setChoice] = React.useState<string>(prefill?.itemId ?? '')
  const [newName, setNewName] = React.useState('')
  const [quantity, setQuantity] = React.useState('')
  const [unit, setUnit] = React.useState<StockUnit>('KG')
  const [rows, setRows] = React.useState<Row[]>([newRow()])
  const [waste, setWaste] = React.useState<WasteRow[]>([])
  const [notes, setNotes] = React.useState('')

  const byId = React.useMemo(() => new Map(items.map((item) => [item.id, item])), [items])
  const money = (minor: number) => formatMoney(Math.round(minor), currency, locale)
  const factor = minorUnitFactor(currency)
  /** A per-unit cost, which is often a fraction of a minor unit for gram/ml items. */
  const perUnit = (minor: number) => {
    const major = minor / factor
    const digits = major !== 0 && Math.abs(major) < 1 ? 4 : 2
    return `${formatMoney(0, currency, locale).replace(/[\d.,\s]/g, '')}${major.toLocaleString(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits })}`
  }

  /* ── Which prepared item ──────────────────────────────────────────────── */

  const preparedOptions = React.useMemo(
    () => [
      { value: NEW_ITEM, label: 'New prepared item…', hint: 'Give it a name below' },
      ...items
        .filter((item) => item.isPrepared)
        .map((item) => ({
          value: item.id,
          label: item.name,
          hint: `${formatQuantity(item.available, item.unit)} here · avg ${perUnit(item.unitCost)}/${UNIT_LABELS[item.unit]}${recipes[item.id] ? ' · has a recipe' : ''}`,
        })),
    ],
    // perUnit closes over currency/locale, which are stable for the page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, recipes, currency, locale],
  )

  const trimmedNewName = newName.trim().replace(/\s+/g, ' ')
  /** The item being made: picked, or matched by the new name, or nothing yet. */
  const matched = React.useMemo(() => {
    if (choice && choice !== NEW_ITEM) return byId.get(choice) ?? null
    if (choice === NEW_ITEM && trimmedNewName) {
      return items.find((item) => item.name.toLowerCase() === trimmedNewName.toLowerCase()) ?? null
    }
    return null
  }, [choice, byId, items, trimmedNewName])
  const nameIsRaw = matched !== null && !matched.isPrepared
  const outputName = matched?.name ?? trimmedNewName
  const hasName = choice !== '' && (choice !== NEW_ITEM || trimmedNewName.length >= 2)

  /*
   * Pre-fill from the recipe (recorrection.md §3). Choosing an item that has
   * been made before brings back how it was made — yield and lines — for the
   * cook to adjust. A first-time item starts blank.
   */
  const fill = React.useCallback(
    (itemId: string) => {
      const item = byId.get(itemId)
      const recipe = recipes[itemId]
      if (!item) return
      if (recipe) {
        setQuantity(String(recipe.yieldQty))
        setUnit(recipe.yieldUnit ?? item.unit)
        setRows(
          recipe.ingredients.length > 0
            ? recipe.ingredients.map((line) => ({ key: `r${++rowSeq}`, itemId: line.itemId, quantity: String(line.quantity), unit: line.unit }))
            : [newRow()],
        )
      } else {
        setUnit(item.unit)
      }
    },
    [byId, recipes],
  )

  const choose = (next: string) => {
    setChoice(next)
    setNewName('')
    if (next && next !== NEW_ITEM) fill(next)
  }

  React.useEffect(() => {
    if (prefill) {
      setChoice(prefill.itemId)
      fill(prefill.itemId)
    }
  }, [prefill, fill])

  /*
   * The ingredient list (correctionA.md §8). The item being made is disabled
   * rather than hidden: seeing it greyed out says "not this one, you are
   * making it", where hiding it just looks like the search is broken.
   */
  const ingredientOptions = React.useMemo(
    () =>
      items.map((i) => ({
        value: i.id,
        label: i.isPrepared ? `${i.name} (prepared)` : i.name,
        disabled: matched?.id === i.id,
      })),
    [items, matched],
  )
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
    hasName &&
    !nameIsRaw &&
    Number(quantity) > 0 &&
    !preview.unitError &&
    preview.lines.some((l) => l.item && l.base > 0) &&
    preview.errors.length === 0 &&
    preview.shortages.length === 0 &&
    Boolean(branchId) &&
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
    setChoice('')
    setNewName('')
    setQuantity('')
    setUnit('KG')
    setRows([newRow()])
    setWaste([])
    setNotes('')
    requestKey.current = newRequestKey('prod')
  }

  /*
   * Create, then the item's page (aO.md §5).
   *
   * The form used to answer itself, asking for the yield on the very screen
   * that had just asked how much was being aimed for — two questions about
   * one pot, a step apart. The cook now lands on the prepared item, where
   * the yield is asked for once, beside what is on the shelf and what the
   * batch will consume.
   */
  const create = async () => {
    if (!ready || !branchId) return
    await run(
      () =>
        startBatchAction({
          clientRequestId: requestKey.current,
          branchId,
          output: { itemId: matched?.id ?? null, name: outputName, quantity: Number(quantity), unit },
          ingredients: rows
            .filter((r) => r.itemId && Number(r.quantity) > 0 && r.unit)
            .map((r) => ({ itemId: r.itemId, quantity: Number(r.quantity), unit: r.unit as StockUnit })),
          waste: waste
            .filter((r) => r.itemId && Number(r.quantity) > 0 && r.unit)
            .map((r) => ({ itemId: r.itemId, quantity: Number(r.quantity), unit: r.unit as StockUnit, note: r.note || undefined })),
          notes: notes || undefined,
        }),
      {
        onDone: (data) => {
          reset()
          toast.success(
            data.replayed
              ? `${data.number} was already created`
              : `${data.number} created — say how much you made when it is out of the pot`,
          )
          router.push(`/dashboard/production/items/${data.item.id}`)
        },
      },
    )
  }

  /* ── The form ─────────────────────────────────────────────────────────── */

  return (
    <div className="grid gap-5 lg:grid-cols-3">
      <div className="space-y-5 lg:col-span-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex flex-wrap items-center gap-2 text-base">
              <MapPin className="size-4 text-muted-foreground" />
              Making at <strong>{branchName ?? 'no location'}</strong>
              {branchIsFallback ? (
                <span className="text-xs font-normal text-muted-foreground">
                  — not chosen on the switcher; change it there
                </span>
              ) : null}
            </CardTitle>
            <CardDescription>
              Pick a prepared item to make it again, or name a new one. Create writes the item and its recipe and starts the batch — nothing leaves stock until you say how much you made.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {!branchId ? (
              <Alert variant="destructive" title="No location">
                Your account is not attached to a location, so there is nowhere for the prepared item to be stocked. Ask a manager to set one.
              </Alert>
            ) : null}

            <label className="block text-sm">
              <span className="mb-1 block text-muted-foreground">Prepared item</span>
              <ItemPicker
                options={preparedOptions}
                value={choice}
                onChange={choose}
                placeholder="Choose a prepared item, or create a new one…"
                searchPlaceholder="Search prepared items…"
                emptyMessage="Nothing prepared matches — choose “New prepared item…” to create it."
              />
              {matched && !nameIsRaw ? (
                <span className="mt-1 block text-xs text-muted-foreground">
                  Adds to <strong>{matched.name}</strong> — stocked in {UNIT_LABELS[matched.unit]}, {formatQuantity(matched.available, matched.unit)} here, avg {perUnit(matched.unitCost)}/{UNIT_LABELS[matched.unit]}.
                  {recipes[matched.id] ? ' Ingredients filled in from how it was last made.' : ''}
                </span>
              ) : null}
            </label>

            {choice === NEW_ITEM ? (
              <label className="block text-sm">
                <span className="mb-1 block text-muted-foreground">Name the new prepared item</span>
                <Input
                  autoFocus
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="Mayonnaise, curry paste, dough…"
                  aria-invalid={nameIsRaw}
                  autoComplete="off"
                />
                {nameIsRaw ? (
                  <span className="mt-1 block text-xs text-destructive">
                    “{matched!.name}” is a raw stock item. Give the prepared item its own name — “Prepared {matched!.name.toLowerCase()}”, say.
                  </span>
                ) : matched ? (
                  <span className="mt-1 block text-xs text-muted-foreground">
                    That prepared item already exists — this batch will add to it.
                  </span>
                ) : null}
              </label>
            ) : null}

            <div className="grid grid-cols-[1fr_8rem] gap-3">
              <label className="block text-sm">
                <span className="mb-1 block text-muted-foreground">Output — how much you are making</span>
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
            <CardDescription>Stock items only. Costs are today’s average from the ledger. Saved as the item’s recipe for next time.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="hidden grid-cols-[1fr_6rem_6rem_7rem_7rem_2.5rem] gap-2 text-xs uppercase tracking-wide text-muted-foreground sm:grid">
              <span>Stock item</span><span>Qty</span><span>Unit</span><span className="text-right">Cost/unit</span><span className="text-right">Cost</span><span />
            </div>
            {preview.lines.map(({ row, item, base, value, error, short }) => (
              <div key={row.key} className="grid grid-cols-2 gap-2 sm:grid-cols-[1fr_6rem_6rem_7rem_7rem_2.5rem]">
                <div className="col-span-2 sm:col-span-1">
                  <ItemPicker
                    options={ingredientOptions}
                    value={row.itemId}
                    onChange={(next) => pickItem(row.key, next)}
                    placeholder="Choose a stock item…"
                    searchPlaceholder="Search stock items…"
                  />
                </div>
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
                Trimmings, a spoiled part-batch — anything thrown away while making this. Deducted as waste and expensed on Mark Done; it does not raise the item’s cost.
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
            <CardDescription>From today’s average costs. The record uses the ledger at the moment you mark it done.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <Stat label="Ingredients" value={money(preview.total)} />
            <Stat
              label={preview.producedBase > 0 ? `Cost per ${UNIT_LABELS[matched ? matched.unit : unit]}` : 'Cost per unit'}
              value={preview.producedBase > 0 ? perUnit(preview.perBase) : '—'}
              hint={preview.producedBase > 0 ? `at ${formatQuantity(preview.producedBase, matched ? matched.unit : unit)} — the real figure follows the actual yield` : 'Enter how much you are making'}
            />
            {preview.unpriced.length > 0 ? (
              <Alert variant="warning" title="No recorded cost yet">
                {preview.unpriced.map((l) => l.item!.name).join(', ')} {preview.unpriced.length === 1 ? 'has' : 'have'} never been received with a price, so {preview.unpriced.length === 1 ? 'it adds' : 'they add'} nothing to the cost.
              </Alert>
            ) : null}
            {preview.shortages.length > 0 ? (
              <Alert variant="destructive" title="Not enough stock here">
                Mark Done never takes a shelf below zero, so this could not be finished as planned.
              </Alert>
            ) : null}
            <Button className="w-full" size="lg" onClick={create} disabled={!ready} loading={busy}>
              Create prepared item
            </Button>
            <p className="text-xs text-muted-foreground">
              Creates the item and its recipe and starts the batch, and takes you to the item’s page. Nothing leaves stock until you say how much you made there.
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
