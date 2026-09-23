'use client'

import * as React from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ArrowLeft, ArrowRight, Check, MapPin, Plus, Search, Trash2 } from 'lucide-react'
import type { StockUnit } from '@prisma/client'
import { toast } from 'sonner'

import { Alert } from '@/components/ui/feedback'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input, Textarea } from '@/components/ui/input'
import { ItemPicker } from '@/components/ui/item-picker'
import { walkFifo } from '@/features/inventory/fifo-walk'
import { UNIT_LABELS, formatQuantity, toBaseUnits } from '@/features/inventory/units'
import { formatMoney, minorUnitFactor } from '@/lib/money'
import { roundQty } from '@/lib/quantity'
import { newRequestKey } from '@/lib/request-key'
import { useAction } from '@/lib/use-action'
import { saveProductionRecipeAction, startBatchAction } from '../actions'
import type { OpenBatch, PrepRecipe, WorkspaceItem } from '../types'

/**
 * Make an Item / Production — the first three of the six screens (pro.b.md).
 *
 *   1. Recipe Setup           what it is and how it is made, costed FIFO
 *   2. Check Available Stock  what this branch holds of each ingredient
 *   3. Create Production Order how much, what kind, when — nothing moves
 *
 * Screens 4–6 — Issue ingredients, Complete, Finished item in stock — are the
 * order's own page, which step 3 lands on. The order is the thing the kitchen
 * carries from that point, so it has its own address.
 *
 * ── Costs are a dry run of the draw ─────────────────────────────────────────
 *
 * Every figure here comes from `walkFifo` over the lots the page loaded — the
 * same walk the issue runs on the same lots — so "Current cost (FIFO)" on
 * step 1 is what issuing that line would cost right now, delivery by delivery.
 * It is a preview: the issue re-reads the shelf and its answer is recorded.
 *
 * ── One request key per order ───────────────────────────────────────────────
 *
 * Minted when the form is shown and again after each success, never on retry,
 * so a double tap or a retried request creates the order once.
 */

type Row = { key: string; itemId: string; quantity: string; unit: StockUnit | '' }
type Step = 1 | 2 | 3

const ALL_UNITS = Object.keys(UNIT_LABELS) as StockUnit[]
const SELECT = 'h-10 w-full rounded-lg border border-input bg-background px-2 text-sm'
/** The picker's "none of these" row. Not an id anything could collide with. */
const NEW_ITEM = '__new__'

let rowSeq = 0
const newRow = (): Row => ({ key: `r${++rowSeq}`, itemId: '', quantity: '', unit: '' })

export function MakeItemForm({
  items,
  recipes,
  openBatches,
  branchId,
  branchName,
  branchIsFallback,
  currency,
  locale,
  prefill,
}: {
  items: WorkspaceItem[]
  recipes: Record<string, PrepRecipe>
  openBatches: OpenBatch[]
  branchId: string | null
  branchName: string | null
  /** The location was not chosen on the switcher; the form says so. */
  branchIsFallback: boolean
  currency: string
  locale: string
  /** Opened to make a particular item again: its recipe loads, and `step` says where to land. */
  prefill: { itemId: string; name: string; step?: Step } | null
}) {
  const router = useRouter()
  const { busy, run } = useAction()
  const requestKey = React.useRef(newRequestKey('prod'))

  const [step, setStep] = React.useState<Step>(1)

  // ── step 1 state ──
  const [choice, setChoice] = React.useState<string>(prefill?.itemId ?? '')
  const [newName, setNewName] = React.useState('')
  const [category, setCategory] = React.useState('')
  const [yieldQty, setYieldQty] = React.useState('')
  const [yieldUnit, setYieldUnit] = React.useState<StockUnit>('KG')
  const [instructions, setInstructions] = React.useState('')
  const [rows, setRows] = React.useState<Row[]>([newRow()])
  /** What step 1 saved — the recipe steps 2 and 3 are about. */
  const [saved, setSaved] = React.useState<{ itemId: string; name: string; unit: StockUnit; recipeId: string | null } | null>(null)

  // ── step 2 state ──
  const [stockSearch, setStockSearch] = React.useState('')

  // ── step 3 state ──
  const [planned, setPlanned] = React.useState('')
  const [plannedUnit, setPlannedUnit] = React.useState<StockUnit>('KG')
  const [productionType, setProductionType] = React.useState<'SEMI_FINISHED' | 'FINISHED'>('SEMI_FINISHED')
  const [requiredDate, setRequiredDate] = React.useState('')
  const [remarks, setRemarks] = React.useState('')

  const byId = React.useMemo(() => new Map(items.map((item) => [item.id, item])), [items])
  const money = (minor: number) => formatMoney(Math.round(minor), currency, locale)
  const factor = minorUnitFactor(currency)
  /** A per-unit cost, which is often a fraction of a minor unit for gram/ml items. */
  const perUnit = (minor: number) => {
    const major = minor / factor
    const digits = major !== 0 && Math.abs(major) < 1 ? 4 : 2
    return `${formatMoney(0, currency, locale).replace(/[\d.,\s]/g, '')}${major.toLocaleString(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits })}`
  }

  /* ── Which item is being made ─────────────────────────────────────────── */

  /*
   * Everything in stock, not only what has been made before (aO.md §5).
   * Items already made here come first, because that is what the cook is
   * usually reaching for; everything else follows, marked.
   */
  const preparedOptions = React.useMemo(
    () => {
      const line = (item: WorkspaceItem) =>
        `${formatQuantity(item.available, item.unit)} here · FIFO ${perUnit(item.nextUnitCost)}/${UNIT_LABELS[item.unit]}`
      const prepared = items.filter((item) => item.isPrepared)
      const rest = items.filter((item) => !item.isPrepared)
      return [
        { value: NEW_ITEM, label: 'New item…', hint: 'Give it a name below' },
        ...prepared.map((item) => ({
          value: item.id,
          label: item.name,
          hint: `${line(item)}${recipes[item.id] ? ' · has a recipe' : ''}`,
        })),
        ...rest.map((item) => ({
          value: item.id,
          label: item.name,
          hint: `${line(item)} · stock item — making it adds to this`,
        })),
      ]
    },
    // perUnit closes over currency/locale, which are stable for the page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, recipes, currency, locale],
  )

  const trimmedNewName = newName.trim().replace(/\s+/g, ' ')
  const matched = React.useMemo(() => {
    if (choice && choice !== NEW_ITEM) return byId.get(choice) ?? null
    if (choice === NEW_ITEM && trimmedNewName) {
      return items.find((item) => item.name.toLowerCase() === trimmedNewName.toLowerCase()) ?? null
    }
    return null
  }, [choice, byId, items, trimmedNewName])
  const nameIsRaw = choice === NEW_ITEM && matched !== null && !matched.isPrepared
  const outputName = matched?.name ?? trimmedNewName
  const hasName = choice !== '' && (choice !== NEW_ITEM || trimmedNewName.length >= 2)

  /* Pre-fill from the recipe: choosing an item made before brings back how. */
  const fill = React.useCallback(
    (itemId: string) => {
      const item = byId.get(itemId)
      const recipe = recipes[itemId]
      if (!item) return
      if (recipe) {
        setYieldQty(String(recipe.yieldQty))
        setYieldUnit(recipe.yieldUnit ?? item.unit)
        setRows(
          recipe.ingredients.length > 0
            ? recipe.ingredients.map((line) => ({ key: `r${++rowSeq}`, itemId: line.itemId, quantity: String(line.quantity), unit: line.unit }))
            : [newRow()],
        )
        setInstructions(recipe.instructions ?? '')
      } else {
        setYieldUnit(item.unit)
      }
      setCategory(item.category ?? '')
    },
    [byId, recipes],
  )

  const choose = (next: string) => {
    setChoice(next)
    setNewName('')
    setSaved(null)
    if (next && next !== NEW_ITEM) fill(next)
  }

  /*
   * "Make more" lands on step 3 with the recipe already saved — there is
   * nothing to decide about how it is made, only how much and when.
   */
  React.useEffect(() => {
    if (!prefill) return
    setChoice(prefill.itemId)
    fill(prefill.itemId)
    const item = byId.get(prefill.itemId)
    const recipe = recipes[prefill.itemId]
    if (prefill.step === 3 && item && recipe) {
      setSaved({ itemId: item.id, name: item.name, unit: item.unit, recipeId: recipe.recipeId })
      setPlanned(String(recipe.yieldQty))
      setPlannedUnit(recipe.yieldUnit ?? item.unit)
      setStep(3)
    }
  }, [prefill, fill, byId, recipes])

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
    if (matched && !matched.units.includes(yieldUnit)) setYieldUnit(matched.unit)
  }, [matched, yieldUnit])

  /* ── Step 1: the recipe, costed FIFO ──────────────────────────────────── */

  const recipeCost = React.useMemo(() => {
    const lines = rows.map((row) => {
      const item = row.itemId ? byId.get(row.itemId) : undefined
      const qty = Number(row.quantity)
      if (!item || !(qty > 0) || !row.unit) {
        return { row, item, base: 0, unitCost: 0, value: 0, error: null as string | null, short: false }
      }
      try {
        const base = roundQty(toBaseUnits(qty, row.unit, item))
        // The same walk the issue runs, on the same lots.
        const draw = walkFifo({ lots: item.lots, quantity: base, unlotted: item.unlotted, averageCost: item.unitCost })
        const value = draw.totalValue + draw.shortfall * item.unitCost
        return { row, item, base, unitCost: draw.unitCost, value, error: null, short: base > item.available }
      } catch {
        return { row, item, base: 0, unitCost: 0, value: 0, error: `Enter ${item.name} in ${item.units.map((u) => UNIT_LABELS[u]).join(', ')}`, short: false }
      }
    })
    const active = lines.filter((l) => l.item && l.base > 0)
    const total = active.reduce((sum, l) => sum + l.value, 0)
    const qty = Number(yieldQty)
    let yieldBase = 0
    let unitError: string | null = null
    if (qty > 0) {
      if (matched) {
        try { yieldBase = roundQty(toBaseUnits(qty, yieldUnit, matched)) } catch { unitError = `${matched.name} is stocked in ${UNIT_LABELS[matched.unit]}` }
      } else {
        yieldBase = qty
      }
    }
    return {
      lines,
      total,
      yieldBase,
      unitError,
      perBase: yieldBase > 0 ? total / yieldBase : 0,
      errors: lines.filter((l) => l.error),
      unpriced: active.filter((l) => l.item!.unitCost === 0 && l.item!.lots.length === 0),
    }
  }, [rows, byId, yieldQty, yieldUnit, matched])

  const chosenIngredients = React.useMemo(
    () => rows.map((r) => byId.get(r.itemId)).filter((i): i is WorkspaceItem => Boolean(i)),
    [rows, byId],
  )

  const recipeReady =
    hasName &&
    !nameIsRaw &&
    Number(yieldQty) > 0 &&
    !recipeCost.unitError &&
    recipeCost.lines.some((l) => l.item && l.base > 0) &&
    recipeCost.errors.length === 0 &&
    Boolean(branchId) &&
    !chosenIngredients.some((i) => matched && i.id === matched.id)

  const setRow = (key: string, patch: Partial<Row>) =>
    setRows((current) => current.map((r) => (r.key === key ? { ...r, ...patch } : r)))
  const pickItem = (key: string, itemId: string) => {
    const item = byId.get(itemId)
    setRow(key, { itemId, unit: item ? (item.consumptionUnit ?? item.unit) : '' })
  }

  const ingredientLines = () =>
    rows
      .filter((r) => r.itemId && Number(r.quantity) > 0 && r.unit)
      .map((r) => ({ itemId: r.itemId, quantity: Number(r.quantity), unit: r.unit as StockUnit }))

  const saveRecipe = async () => {
    if (!recipeReady) return
    await run(
      () =>
        saveProductionRecipeAction({
          output: {
            itemId: matched?.id ?? null,
            name: outputName,
            category: category || undefined,
            quantity: Number(yieldQty),
            unit: yieldUnit,
          },
          ingredients: ingredientLines(),
          instructions: instructions || undefined,
        }),
      {
        onDone: (data) => {
          setSaved({ itemId: data.item.id, name: data.item.name, unit: data.item.unit as StockUnit, recipeId: data.recipeId })
          setPlanned(yieldQty)
          setPlannedUnit(yieldUnit)
          toast.success(data.item.isNew ? `${data.item.name} created with its recipe` : 'Recipe saved')
          // The item list and its lots are the page's; a new item joins it.
          router.refresh()
          setStep(2)
        },
      },
    )
  }

  /* ── Step 2: what this branch holds ───────────────────────────────────── */

  const stockRows = React.useMemo(() => {
    const needle = stockSearch.trim().toLowerCase()
    return recipeCost.lines
      .filter((l) => l.item && l.base > 0)
      .map((l) => ({
        item: l.item!,
        required: l.base,
        short: l.base > l.item!.available,
      }))
      .filter((r) => !needle || r.item.name.toLowerCase().includes(needle))
  }, [recipeCost.lines, stockSearch])
  const anyShort = recipeCost.lines.some((l) => l.item && l.base > 0 && l.base > l.item.available)

  /* ── Step 3: the order ────────────────────────────────────────────────── */

  /*
   * Planned quantity scales the recipe: the ratio of what is being made to
   * what the recipe yields, both in the item's base unit so kilos and grams
   * compare. A new item has no row in `items` yet, so it converts within the
   * unit family alone.
   */
  const scaling = React.useMemo(() => {
    const item = saved ? byId.get(saved.itemId) : null
    const like = item ?? { name: saved?.name ?? outputName, unit: saved?.unit ?? yieldUnit, purchaseUnit: null, unitsPerPurchaseUnit: null }
    const wanted = Number(planned)
    const yieldQ = Number(yieldQty)
    if (!(wanted > 0) || !(yieldQ > 0)) return { ratio: 0, error: null as string | null }
    try {
      const wantedBase = roundQty(toBaseUnits(wanted, plannedUnit, like))
      const yieldBase = roundQty(toBaseUnits(yieldQ, yieldUnit, like))
      return { ratio: yieldBase > 0 ? wantedBase / yieldBase : 0, error: null }
    } catch {
      return { ratio: 0, error: `${like.name} cannot be measured in ${UNIT_LABELS[plannedUnit]}` }
    }
  }, [saved, byId, planned, plannedUnit, yieldQty, yieldUnit, outputName])

  const scaledLines = React.useMemo(
    () =>
      ingredientLines().map((line) => ({ ...line, quantity: roundQty(line.quantity * scaling.ratio) })),
    // ingredientLines reads rows; listing rows is the honest dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, scaling.ratio],
  )
  const orderCost = React.useMemo(() => {
    let total = 0
    for (const line of scaledLines) {
      const item = byId.get(line.itemId)
      if (!item) continue
      try {
        const base = roundQty(toBaseUnits(line.quantity, line.unit, item))
        const draw = walkFifo({ lots: item.lots, quantity: base, unlotted: item.unlotted, averageCost: item.unitCost })
        total += draw.totalValue + draw.shortfall * item.unitCost
      } catch { /* refused at the form already */ }
    }
    return total
  }, [scaledLines, byId])

  const orderReady = Boolean(saved && branchId) && scaling.ratio > 0 && !scaling.error && scaledLines.length > 0

  const createOrder = async () => {
    if (!orderReady || !saved || !branchId) return
    await run(
      () =>
        startBatchAction({
          clientRequestId: requestKey.current,
          branchId,
          output: { itemId: saved.itemId, name: saved.name, quantity: Number(planned), unit: plannedUnit },
          ingredients: scaledLines,
          waste: [],
          productionType,
          requiredDate: requiredDate || undefined,
          notes: remarks || undefined,
        }),
      {
        onDone: (data) => {
          requestKey.current = newRequestKey('prod')
          toast.success(data.replayed ? `${data.number} was already created` : `${data.number} created — issue the ingredients when the kitchen starts`)
          router.push(`/dashboard/production/${data.id}`)
        },
      },
    )
  }

  /* ── The screens ──────────────────────────────────────────────────────── */

  const stepLabel = (n: Step, label: string) => (
    <button
      type="button"
      onClick={() => { if (n < step || (n === 2 && saved) || (n === 3 && saved)) setStep(n) }}
      className={`flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm ${
        step === n ? 'bg-primary text-primary-foreground' : n < step || saved ? 'bg-muted hover:bg-muted/80' : 'text-muted-foreground'
      }`}
      aria-current={step === n ? 'step' : undefined}
    >
      <span className={`flex size-5 items-center justify-center rounded-full text-xs font-semibold ${step === n ? 'bg-primary-foreground/20' : 'bg-background'}`}>
        {n < step || (saved && n <= 2 && step > n) ? <Check className="size-3" /> : n}
      </span>
      {label}
    </button>
  )

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2" data-testid="production-steps">
        {stepLabel(1, 'Recipe Setup')}
        <ArrowRight className="size-4 text-muted-foreground" />
        {stepLabel(2, 'Check Available Stock')}
        <ArrowRight className="size-4 text-muted-foreground" />
        {stepLabel(3, 'Create Production Order')}
        <span className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
          <MapPin className="size-3.5" />
          Making at <strong>{branchName ?? 'no location'}</strong>
          {branchIsFallback ? ' — not chosen on the switcher' : ''}
        </span>
      </div>

      {!branchId ? (
        <Alert variant="destructive" title="No location">
          Your account is not attached to a location, so there is nowhere for the prepared item to be stocked. Ask a manager to set one.
        </Alert>
      ) : null}

      {/* ── 1. Recipe Setup ──────────────────────────────────────────────── */}
      {step === 1 ? (
        <div className="grid gap-5 lg:grid-cols-3">
          <div className="space-y-5 lg:col-span-2">
            <Card>
              <CardHeader>
                <CardTitle>Recipe Master</CardTitle>
                <CardDescription>What this makes and how. Saved as the item’s recipe; nothing leaves stock here.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <label className="block text-sm">
                  <span className="mb-1 block text-muted-foreground">Make an item</span>
                  <ItemPicker
                    options={preparedOptions}
                    value={choice}
                    onChange={choose}
                    placeholder="Choose any item from stock, or name a new one…"
                    searchPlaceholder="Search all stock items…"
                    emptyMessage="Nothing in stock matches — choose “New item…” to create it."
                  />
                  {matched && !nameIsRaw ? (
                    <span className="mt-1 block text-xs text-muted-foreground">
                      Adds to <strong>{matched.name}</strong> — stocked in {UNIT_LABELS[matched.unit]}, {formatQuantity(matched.available, matched.unit)} here.
                      {recipes[matched.id] ? ' Ingredients filled in from its recipe.' : ''}
                    </span>
                  ) : null}
                </label>

                {choice === NEW_ITEM ? (
                  <label className="block text-sm">
                    <span className="mb-1 block text-muted-foreground">Recipe name</span>
                    <Input
                      autoFocus
                      value={newName}
                      onChange={(e) => setNewName(e.target.value)}
                      placeholder="Chicken Shawarma Filling, mayonnaise, dough…"
                      aria-invalid={nameIsRaw}
                      autoComplete="off"
                    />
                    {nameIsRaw ? (
                      <span className="mt-1 block text-xs text-destructive">
                        “{matched!.name}” is a raw stock item. Give the prepared item its own name — “Prepared {matched!.name.toLowerCase()}”, say.
                      </span>
                    ) : matched ? (
                      <span className="mt-1 block text-xs text-muted-foreground">That prepared item already exists — this saves its recipe.</span>
                    ) : null}
                  </label>
                ) : null}

                <div className="grid gap-3 sm:grid-cols-[1fr_1fr_8rem]">
                  <label className="block text-sm">
                    <span className="mb-1 block text-muted-foreground">Category</span>
                    <Input value={category} onChange={(e) => setCategory(e.target.value)} placeholder="Semi-finished, sauce, dough…" maxLength={60} />
                  </label>
                  <label className="block text-sm">
                    <span className="mb-1 block text-muted-foreground">Expected yield</span>
                    <Input type="number" inputMode="decimal" min={0} step="any" value={yieldQty} onChange={(e) => setYieldQty(e.target.value)} placeholder="10" />
                  </label>
                  <label className="block text-sm">
                    <span className="mb-1 block text-muted-foreground">Unit</span>
                    <select className={SELECT} value={yieldUnit} onChange={(e) => setYieldUnit(e.target.value as StockUnit)}>
                      {outputUnits.map((u) => <option key={u} value={u}>{UNIT_LABELS[u]}</option>)}
                    </select>
                  </label>
                </div>
                {recipeCost.unitError ? <p className="text-xs text-destructive">{recipeCost.unitError}</p> : null}

                <label className="block text-sm">
                  <span className="mb-1 block text-muted-foreground">Instructions</span>
                  <Textarea rows={2} value={instructions} onChange={(e) => setInstructions(e.target.value)} placeholder="Marinate and cook chicken with spices…" maxLength={2000} />
                </label>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Ingredients</CardTitle>
                <CardDescription>Stock items only. Current cost is FIFO — what issuing this line would draw, oldest lot first.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="hidden grid-cols-[1fr_6rem_6rem_8rem_7rem_2.5rem] gap-2 text-xs uppercase tracking-wide text-muted-foreground sm:grid">
                  <span>Ingredient</span><span>Qty</span><span>Unit</span><span className="text-right">Current cost (FIFO)</span><span className="text-right">Total cost</span><span />
                </div>
                {recipeCost.lines.map(({ row, item, base, unitCost, value, error, short }) => (
                  <div key={row.key} className="grid grid-cols-2 gap-2 sm:grid-cols-[1fr_6rem_6rem_8rem_7rem_2.5rem]">
                    <div className="col-span-2 sm:col-span-1">
                      <ItemPicker
                        options={ingredientOptions}
                        value={row.itemId}
                        onChange={(next) => pickItem(row.key, next)}
                        placeholder="Choose a stock item…"
                        searchPlaceholder="Search stock items…"
                      />
                    </div>
                    <Input type="number" inputMode="decimal" min={0} step="any" value={row.quantity} onChange={(e) => setRow(row.key, { quantity: e.target.value })} placeholder="0" aria-invalid={Boolean(error)} />
                    <select className={SELECT} value={row.unit} onChange={(e) => setRow(row.key, { unit: e.target.value as StockUnit })} disabled={!item}>
                      {(item ? item.units : ALL_UNITS).map((u) => <option key={u} value={u}>{UNIT_LABELS[u]}</option>)}
                    </select>
                    <span className="self-center text-right text-sm tabular-nums text-muted-foreground">
                      {item ? `${perUnit(base > 0 ? unitCost : item.nextUnitCost)}/${UNIT_LABELS[item.unit]}` : ''}
                    </span>
                    <span className="self-center text-right text-sm tabular-nums">{base > 0 ? money(value) : ''}</span>
                    <Button type="button" variant="ghost" size="icon" aria-label="Remove ingredient" onClick={() => setRows((c) => (c.length > 1 ? c.filter((r) => r.key !== row.key) : [newRow()]))}>
                      <Trash2 />
                    </Button>
                    {error ? <p className="col-span-full text-xs text-destructive">{error}</p> : null}
                    {short && item ? (
                      <p className="col-span-full text-xs text-amber-700 dark:text-amber-400">
                        Only {formatQuantity(item.available, item.unit)} of {item.name} here — the stock check will say so.
                      </p>
                    ) : null}
                  </div>
                ))}
                <Button type="button" variant="outline" size="sm" onClick={() => setRows((c) => [...c, newRow()])}>
                  <Plus /> Add ingredient
                </Button>
              </CardContent>
            </Card>
          </div>

          <div className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>Recipe cost</CardTitle>
                <CardDescription>FIFO, from the lots on this shelf today. The issue re-reads them and is the figure of record.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <Stat label="Total Recipe Cost" value={money(recipeCost.total)} />
                <Stat
                  label={recipeCost.yieldBase > 0 ? `Standard Cost per ${UNIT_LABELS[matched ? matched.unit : yieldUnit]}` : 'Standard cost per unit'}
                  value={recipeCost.yieldBase > 0 ? perUnit(recipeCost.perBase) : '—'}
                  hint={recipeCost.yieldBase > 0 ? `for a yield of ${formatQuantity(recipeCost.yieldBase, matched ? matched.unit : yieldUnit)}` : 'Enter the expected yield'}
                />
                {recipeCost.unpriced.length > 0 ? (
                  <Alert variant="warning" title="No recorded cost yet">
                    {recipeCost.unpriced.map((l) => l.item!.name).join(', ')} {recipeCost.unpriced.length === 1 ? 'has' : 'have'} never been received with a price.
                  </Alert>
                ) : null}
                <Button className="w-full" size="lg" onClick={saveRecipe} disabled={!recipeReady} loading={busy}>
                  Save recipe <ArrowRight />
                </Button>
                <p className="text-xs text-muted-foreground">Saves the item and its recipe, then checks the stock. Nothing leaves the shelf.</p>
              </CardContent>
            </Card>
          </div>
        </div>
      ) : null}

      {/* ── 2. Check Available Stock ─────────────────────────────────────── */}
      {step === 2 && saved ? (
        <Card>
          <CardHeader>
            <CardTitle>Stock Balance</CardTitle>
            <CardDescription>
              What {branchName ?? 'this location'} holds of each ingredient in <strong>{saved.name}</strong>, and what the next unit of each costs (FIFO — the oldest lot).
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <Input
              value={stockSearch}
              onChange={(e) => setStockSearch(e.target.value)}
              placeholder="Search item…"
              startIcon={<Search className="size-4" />}
              className="max-w-sm"
            />
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-muted-foreground">
                    <th className="pb-2 font-medium">Item</th>
                    <th className="pb-2 text-right font-medium">Available Qty</th>
                    <th className="pb-2 text-right font-medium">Required</th>
                    <th className="pb-2 font-medium">Unit</th>
                    <th className="pb-2 text-right font-medium">FIFO Cost</th>
                    <th className="pb-2 font-medium" />
                  </tr>
                </thead>
                <tbody>
                  {stockRows.map(({ item, required, short }) => (
                    <tr key={item.id} className="border-b border-border/50 last:border-0">
                      <td className="py-2">
                        <Link href={`/dashboard/inventory/${item.id}`} className="hover:underline">{item.name}</Link>
                      </td>
                      <td className={`py-2 text-right tabular-nums ${short ? 'text-destructive' : ''}`}>{formatQuantity(item.available, item.unit)}</td>
                      <td className="py-2 text-right tabular-nums text-muted-foreground">{formatQuantity(required, item.unit)}</td>
                      <td className="py-2">{UNIT_LABELS[item.unit]}</td>
                      <td className="py-2 text-right tabular-nums">{perUnit(item.nextUnitCost)}</td>
                      <td className="py-2 text-right">
                        {short ? <Badge variant="destructive" size="sm">short</Badge> : <Badge variant="success" size="sm">enough</Badge>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {anyShort ? (
              <Alert variant="warning" title="Not enough of something here">
                An order can still be created, but the ingredients cannot be issued until the shelf holds them — production never draws stock below zero.
              </Alert>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => setStep(1)}><ArrowLeft /> Back</Button>
              <Button onClick={() => setStep(3)}>Create Production Order <ArrowRight /></Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {/* ── 3. Create Production Order ───────────────────────────────────── */}
      {step === 3 && saved ? (
        <div className="grid gap-5 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            <CardHeader>
              <CardTitle>New Production Order</CardTitle>
              <CardDescription>Plan or start production in the kitchen. Creating the order deducts nothing — stock leaves when the ingredients are issued.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block text-sm sm:col-span-2">
                  <span className="mb-1 block text-muted-foreground">Recipe</span>
                  <Input value={saved.name} readOnly />
                </label>
                <label className="block text-sm">
                  <span className="mb-1 block text-muted-foreground">Planned Quantity</span>
                  <div className="grid grid-cols-[1fr_7rem] gap-2">
                    <Input type="number" inputMode="decimal" min={0} step="any" value={planned} onChange={(e) => setPlanned(e.target.value)} placeholder="10" />
                    <select className={SELECT} value={plannedUnit} onChange={(e) => setPlannedUnit(e.target.value as StockUnit)}>
                      {(byId.get(saved.itemId)?.units ?? ALL_UNITS).map((u) => <option key={u} value={u}>{UNIT_LABELS[u]}</option>)}
                    </select>
                  </div>
                  {scaling.error ? <span className="mt-1 block text-xs text-destructive">{scaling.error}</span> : null}
                </label>
                <label className="block text-sm">
                  <span className="mb-1 block text-muted-foreground">Production Type</span>
                  <select className={SELECT} value={productionType} onChange={(e) => setProductionType(e.target.value as 'SEMI_FINISHED' | 'FINISHED')}>
                    <option value="SEMI_FINISHED">Kitchen production — semi-finished</option>
                    <option value="FINISHED">Kitchen production — finished</option>
                  </select>
                </label>
                <label className="block text-sm">
                  <span className="mb-1 block text-muted-foreground">Required Date</span>
                  <Input type="date" value={requiredDate} onChange={(e) => setRequiredDate(e.target.value)} />
                </label>
                <label className="block text-sm">
                  <span className="mb-1 block text-muted-foreground">Remarks</span>
                  <Input value={remarks} onChange={(e) => setRemarks(e.target.value)} placeholder="Morning production" maxLength={500} />
                </label>
              </div>

              <div className="flex flex-wrap gap-2">
                <Button variant="outline" onClick={() => setStep(2)}><ArrowLeft /> Back</Button>
                <Button size="lg" onClick={createOrder} disabled={!orderReady} loading={busy}>
                  Create Order
                </Button>
              </div>
              {openBatches.length > 0 ? (
                <p className="text-xs text-muted-foreground">
                  {openBatches.length} order{openBatches.length === 1 ? '' : 's'} already in progress at this location — see the list below the steps.
                </p>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>What this order will take</CardTitle>
              <CardDescription>The recipe scaled to the planned quantity, costed FIFO. Issued at the real lots when the kitchen starts.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <ul className="divide-y divide-border">
                {scaledLines.map((line) => {
                  const item = byId.get(line.itemId)
                  return (
                    <li key={line.itemId} className="flex items-center justify-between py-1.5">
                      <span>{item?.name ?? 'Item'}</span>
                      <span className="tabular-nums text-muted-foreground">{line.quantity} {UNIT_LABELS[line.unit].toLowerCase()}</span>
                    </li>
                  )
                })}
              </ul>
              <Stat label="Estimated ingredient cost (FIFO)" value={money(orderCost)} />
            </CardContent>
          </Card>
        </div>
      ) : null}
      {step === 3 && !saved ? (
        <Alert variant="warning" title="Save the recipe first">Step 3 creates an order from a saved recipe.</Alert>
      ) : null}
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
