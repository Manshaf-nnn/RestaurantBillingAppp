'use client'

import * as React from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ArrowLeft, MapPin, Plus, Trash2 } from 'lucide-react'
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
 * Make an Item / Production.
 *
 * ── Two things, not three steps ─────────────────────────────────────────────
 *
 * This was a 1-2-3 stepper: Recipe Setup → Check Available Stock → Create
 * Production Order. The flow pro.b.md describes is unchanged — a recipe is
 * still set, stock is still checked before an order, an order still moves
 * nothing until the ingredients are issued — but walking it as three screens
 * every single time was wrong, because a recipe is written ONCE and produced
 * from MANY times. Steps 2 and 3 were a toll gate on the common case.
 *
 * So the tab holds two things:
 *
 *   1. the recipe editor — write or change how something is made, and save it
 *   2. the saved recipes — pick one to produce
 *
 * Picking one opens the production order panel, and the stock check lives
 * inside it rather than before it. That is the better place for it: "is there
 * enough?" is not a question about a recipe, it is a question about a
 * PLANNED QUANTITY, and the old step 2 could only ever check the recipe's own
 * yield. Now the required column scales with what is actually being made.
 *
 * Screens 4–6 — Issue ingredients, Complete, Finished item in stock — are the
 * order's own page, which Create Order lands on. The order is the thing the
 * kitchen carries from that point, so it has its own address.
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
  /**
   * Opened to make a particular item again ("Make more"): its recipe loads and
   * the order panel opens on it. `order: false` means only load it for editing.
   */
  prefill: { itemId: string; name: string; order?: boolean } | null
}) {
  const router = useRouter()
  const { busy, run } = useAction()
  const requestKey = React.useRef(newRequestKey('prod'))

  /*
   * ── Opened from a link, on the very first render ──────────────────────────
   *
   * "Make more" arrives as `?tab=make&make=<itemId>` and has to land on the
   * order panel. Doing that in an effect would render the recipe editor first
   * and swap it a frame later, which on a slow tablet is a visible flash of the
   * wrong screen — and it means the server sends HTML that is about to be
   * replaced. Computed here instead, so the first render is already right.
   */
  const opened = React.useMemo(() => {
    const item = prefill ? items.find((row) => row.id === prefill.itemId) ?? null : null
    const recipe = prefill ? recipes[prefill.itemId] ?? null : null
    if (!item || !recipe) return null
    return {
      item,
      recipe,
      /** Only `?make=` opens the order; `?recipe=` just loads it for editing. */
      order: Boolean(prefill?.order),
    }
    // Deliberately keyed on the prefill alone: a later refresh of `items` must
    // not reopen a panel the cook has closed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill?.itemId, prefill?.order])

  // ── the recipe editor ──
  const [choice, setChoice] = React.useState<string>(prefill?.itemId ?? '')
  const [newName, setNewName] = React.useState('')
  const [category, setCategory] = React.useState(() => opened?.item.category ?? '')
  const [yieldQty, setYieldQty] = React.useState(() => (opened ? String(opened.recipe.yieldQty) : ''))
  const [yieldUnit, setYieldUnit] = React.useState<StockUnit>(
    () => opened?.recipe.yieldUnit ?? opened?.item.unit ?? 'KG',
  )
  const [instructions, setInstructions] = React.useState(() => opened?.recipe.instructions ?? '')
  const [rows, setRows] = React.useState<Row[]>(() =>
    opened && opened.recipe.ingredients.length > 0
      ? opened.recipe.ingredients.map((line) => ({
          key: `r${++rowSeq}`,
          itemId: line.itemId,
          quantity: String(line.quantity),
          unit: line.unit,
        }))
      : [newRow()],
  )

  /**
   * The saved recipe the order panel is open on, or null when nothing is being
   * ordered. Set by clicking one in the list below, or by `?make=` from the
   * Prepared Items tab's "Make more".
   */
  const [ordering, setOrdering] = React.useState<{
    itemId: string
    name: string
    unit: StockUnit
    recipeId: string | null
  } | null>(() =>
    opened?.order
      ? {
          itemId: opened.item.id,
          name: opened.item.name,
          unit: opened.item.unit,
          recipeId: opened.recipe.recipeId,
        }
      : null,
  )

  /** The recipe just saved, so the list below can point at which one it was. */
  const [justSaved, setJustSaved] = React.useState<string | null>(null)

  // ── the order panel ──
  const [planned, setPlanned] = React.useState(() =>
    opened?.order ? String(opened.recipe.yieldQty) : '',
  )
  const [plannedUnit, setPlannedUnit] = React.useState<StockUnit>(
    () => (opened?.order ? opened.recipe.yieldUnit ?? opened.item.unit : 'KG'),
  )
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
    setOrdering(null)
    if (next && next !== NEW_ITEM) fill(next)
  }

  /**
   * Open the order panel on a saved recipe.
   *
   * The editor is filled from the same recipe, because the order's scaled
   * ingredient lines are derived from the editor's rows — one source of truth
   * for "what this recipe is made of", whether you are editing it or producing
   * from it. Planned quantity starts at the recipe's own yield, which is the
   * batch size somebody already decided was sensible.
   */
  const openOrder = React.useCallback(
    (itemId: string) => {
      const item = byId.get(itemId)
      const recipe = recipes[itemId]
      if (!item || !recipe) return
      setChoice(itemId)
      setNewName('')
      fill(itemId)
      setOrdering({ itemId: item.id, name: item.name, unit: item.unit, recipeId: recipe.recipeId })
      setPlanned(String(recipe.yieldQty))
      setPlannedUnit(recipe.yieldUnit ?? item.unit)
    },
    [byId, recipes, fill],
  )

  /*
   * A LATER link to a different item, without a full reload.
   *
   * The first render is already set up from `opened` above, so this only has to
   * catch the case where the URL changes while the form is mounted — clicking
   * "Make more" for a second item, say. Keyed on the id so it does not fire
   * again on every refresh of the item list.
   */
  const openedId = React.useRef(prefill?.itemId ?? null)
  React.useEffect(() => {
    const next = prefill?.itemId ?? null
    if (next === openedId.current) return
    openedId.current = next
    if (!next) return
    if (prefill?.order && recipes[next]) {
      openOrder(next)
      return
    }
    setChoice(next)
    setOrdering(null)
    fill(next)
  }, [prefill?.itemId, prefill?.order, fill, openOrder, recipes])

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
        const draw = walkFifo({ lots: item.lots, quantity: base })
        /*
         * What the layers hold, and nothing for what they do not. Stock that
         * is not on the shelf has no cost — FIFO.md: "do not invent a fake
         * FIFO cost". The short badge beside the line is what says so.
         */
        const value = draw.totalValue
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
          toast.success(
            data.item.isNew
              ? `${data.item.name} created — it is in Saved recipes below`
              : `${data.item.name} saved`,
          )
          /*
           * Refresh and stop. The saved recipe joins the list below, which is
           * what the cook then clicks to produce from it — the form does not
           * march them onward into an order they may not want to create yet.
           * Writing a recipe and making a batch are different acts.
           */
          setJustSaved(data.item.id)
          router.refresh()
        },
      },
    )
  }

  /* ── The order ────────────────────────────────────────────────────────── */

  /*
   * Planned quantity scales the recipe: the ratio of what is being made to
   * what the recipe yields, both in the item's base unit so kilos and grams
   * compare. A new item has no row in `items` yet, so it converts within the
   * unit family alone.
   */
  const scaling = React.useMemo(() => {
    const item = ordering ? byId.get(ordering.itemId) : null
    const like = item ?? { name: ordering?.name ?? outputName, unit: ordering?.unit ?? yieldUnit, purchaseUnit: null, unitsPerPurchaseUnit: null }
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
  }, [ordering, byId, planned, plannedUnit, yieldQty, yieldUnit, outputName])

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
        const draw = walkFifo({ lots: item.lots, quantity: base })
        total += draw.totalValue
      } catch { /* refused at the form already */ }
    }
    return total
  }, [scaledLines, byId])

  const orderReady = Boolean(ordering && branchId) && scaling.ratio > 0 && !scaling.error && scaledLines.length > 0

  const createOrder = async () => {
    if (!orderReady || !ordering || !branchId) return
    await run(
      () =>
        startBatchAction({
          clientRequestId: requestKey.current,
          branchId,
          output: { itemId: ordering.itemId, name: ordering.name, quantity: Number(planned), unit: plannedUnit },
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

  /*
   * Every recipe that has been saved, with what a batch of it costs today.
   *
   * The same `walkFifo` the editor and the issue use, so the figure on the card
   * is the figure the order panel will show and the issue will draw.
   */
  const savedRecipes = React.useMemo(() => {
    const list = Object.entries(recipes)
      .map(([itemId, recipe]) => {
        const item = byId.get(itemId)
        if (!item) return null
        let total = 0
        let short = false
        for (const line of recipe.ingredients) {
          const ing = byId.get(line.itemId)
          if (!ing) continue
          try {
            const base = roundQty(toBaseUnits(line.quantity, line.unit, ing))
            const draw = walkFifo({ lots: ing.lots, quantity: base })
            total += draw.totalValue
            if (base > ing.available) short = true
          } catch {
            /* a unit the ingredient cannot be measured in — the editor says so */
          }
        }
        let yieldBase = 0
        try {
          yieldBase = roundQty(toBaseUnits(recipe.yieldQty, recipe.yieldUnit ?? item.unit, item))
        } catch {
          yieldBase = 0
        }
        return { item, recipe, total, perBase: yieldBase > 0 ? total / yieldBase : 0, short }
      })
      .filter((row): row is NonNullable<typeof row> => row !== null)
    return list.sort((a, b) => a.item.name.localeCompare(b.item.name))
  }, [recipes, byId])

  /*
   * What the order will draw, checked against the shelf.
   *
   * This is pro.b.md §2 — "before production, the user must be able to check
   * current ingredient stock" — moved inside the order panel, where Required
   * is the SCALED quantity rather than the recipe's own yield. Checking a
   * recipe's base quantities before choosing how much to make answered a
   * question nobody had asked.
   */
  const orderStock = React.useMemo(
    () =>
      scaledLines
        .map((line) => {
          const item = byId.get(line.itemId)
          if (!item) return null
          let base = 0
          try {
            base = roundQty(toBaseUnits(line.quantity, line.unit, item))
          } catch {
            return null
          }
          const draw = walkFifo({ lots: item.lots, quantity: base })
          return {
            item,
            required: base,
            short: base > item.available,
            cost: draw.totalValue,
          }
        })
        .filter((row): row is NonNullable<typeof row> => row !== null),
    [scaledLines, byId],
  )
  const anyShort = orderStock.some((row) => row.short)

  /* ── The screen ───────────────────────────────────────────────────────── */

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
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

      {/* ── The recipe ───────────────────────────────────────────────────── */}
      {!ordering ? (
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
                  Save recipe
                </Button>
                <p className="text-xs text-muted-foreground">
                  Saves the item and its recipe and nothing else. Nothing leaves the shelf until a
                  production order&rsquo;s ingredients are issued.
                </p>
              </CardContent>
            </Card>
          </div>
        </div>
      ) : null}

      {/* ── Saved recipes: pick one to produce ───────────────────────────── */}
      {!ordering ? (
        <Card>
          <CardHeader>
            <CardTitle>Saved recipes</CardTitle>
            <CardDescription>
              Everything that can be made here. Pick one to start a production order &mdash; choosing
              how much comes next, and nothing moves until the ingredients are issued.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {savedRecipes.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                No recipes yet. Write one above and save it, and it appears here to produce from.
              </p>
            ) : (
              <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" data-testid="saved-recipes">
                {savedRecipes.map(({ item, recipe, total, perBase, short }) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      onClick={() => openOrder(item.id)}
                      className={`w-full rounded-xl border p-3 text-left transition hover:border-primary/50 hover:bg-muted/40 ${
                        justSaved === item.id ? 'border-primary ring-1 ring-primary' : 'border-border'
                      }`}
                    >
                      <p className="flex items-center gap-2 font-medium">
                        <span className="truncate">{item.name}</span>
                        {justSaved === item.id ? <Badge variant="success" size="sm">saved</Badge> : null}
                        {short ? <Badge variant="destructive" size="sm">short</Badge> : null}
                      </p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        Makes {formatQuantity(recipe.yieldQty, recipe.yieldUnit ?? item.unit)} &middot;{' '}
                        {recipe.ingredients.length} ingredient{recipe.ingredients.length === 1 ? '' : 's'}
                      </p>
                      <p className="mt-1.5 text-xs">
                        <span className="text-muted-foreground">Batch costs</span>{' '}
                        <strong className="tabular-nums">{money(total)}</strong>
                        {perBase > 0 ? (
                          <span className="text-muted-foreground">
                            {' '}&middot; {perUnit(perBase)}/{UNIT_LABELS[item.unit]}
                          </span>
                        ) : null}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {formatQuantity(item.available, item.unit)} in stock here
                      </p>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      ) : null}

      {/* ── Create Production Order, with the stock check inside it ──────── */}
      {ordering ? (
        <div className="grid gap-5 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            <CardHeader>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <CardTitle>Create Production Order</CardTitle>
                  <CardDescription>
                    Making <strong>{ordering.name}</strong>. Creating the order deducts nothing &mdash;
                    stock leaves when the ingredients are issued.
                  </CardDescription>
                </div>
                <Button variant="ghost" size="sm" onClick={() => setOrdering(null)}>
                  <ArrowLeft /> Back to recipes
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block text-sm sm:col-span-2">
                  <span className="mb-1 block text-muted-foreground">Recipe</span>
                  <Input value={ordering.name} readOnly />
                </label>
                {/*
                  How much to make. The whole point of "make more": the recipe
                  says what a batch is, this says how many batches&rsquo; worth,
                  and every ingredient line below scales with it.
                */}
                <label className="block text-sm">
                  <span className="mb-1 block text-muted-foreground">Quantity to make</span>
                  <div className="grid grid-cols-[1fr_7rem] gap-2">
                    <Input type="number" inputMode="decimal" min={0} step="any" value={planned} onChange={(e) => setPlanned(e.target.value)} placeholder="10" />
                    <select className={SELECT} value={plannedUnit} onChange={(e) => setPlannedUnit(e.target.value as StockUnit)}>
                      {(byId.get(ordering.itemId)?.units ?? ALL_UNITS).map((u) => <option key={u} value={u}>{UNIT_LABELS[u]}</option>)}
                    </select>
                  </div>
                  {scaling.error ? (
                    <span className="mt-1 block text-xs text-destructive">{scaling.error}</span>
                  ) : scaling.ratio > 0 && Math.abs(scaling.ratio - 1) > 0.001 ? (
                    <span className="mt-1 block text-xs text-muted-foreground">
                      {scaling.ratio.toLocaleString(locale, { maximumFractionDigits: 2 })}&times; the saved recipe
                    </span>
                  ) : null}
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

              {/* pro.b.md §2, against the quantity actually being made. */}
              <div>
                <p className="mb-2 text-sm font-medium">Check Available Stock</p>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border text-left text-muted-foreground">
                        <th className="pb-2 font-medium">Item</th>
                        <th className="pb-2 text-right font-medium">Required</th>
                        <th className="pb-2 text-right font-medium">Available</th>
                        <th className="pb-2 font-medium">Unit</th>
                        <th className="pb-2 text-right font-medium">FIFO Cost</th>
                        <th className="pb-2 font-medium" />
                      </tr>
                    </thead>
                    <tbody>
                      {orderStock.map(({ item, required, short, cost }) => (
                        <tr key={item.id} className="border-b border-border/50 last:border-0">
                          <td className="py-2">
                            <Link href={`/dashboard/inventory/${item.id}`} className="hover:underline">{item.name}</Link>
                          </td>
                          <td className="py-2 text-right tabular-nums">{formatQuantity(required, item.unit)}</td>
                          <td className={`py-2 text-right tabular-nums ${short ? 'text-destructive' : 'text-muted-foreground'}`}>
                            {formatQuantity(item.available, item.unit)}
                          </td>
                          <td className="py-2">{UNIT_LABELS[item.unit]}</td>
                          <td className="py-2 text-right tabular-nums">{money(cost)}</td>
                          <td className="py-2 text-right">
                            {short ? <Badge variant="destructive" size="sm">short</Badge> : <Badge variant="success" size="sm">enough</Badge>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {anyShort ? (
                <Alert variant="warning" title="Not enough of something here">
                  The order can still be created, but the ingredients cannot be issued until the shelf
                  holds them — production never draws stock below zero.
                </Alert>
              ) : null}

              <div className="flex flex-wrap gap-2">
                <Button size="lg" onClick={createOrder} disabled={!orderReady} loading={busy}>
                  Create Order
                </Button>
              </div>
              {openBatches.length > 0 ? (
                <p className="text-xs text-muted-foreground">
                  {openBatches.length} order{openBatches.length === 1 ? '' : 's'} already in progress at this location — see the list below.
                </p>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>What this order will take</CardTitle>
              <CardDescription>The recipe scaled to the quantity above, costed FIFO. Issued at the real lots when the kitchen starts.</CardDescription>
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
