'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { Copy, Plus, Power, Save, Trash2 } from 'lucide-react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input, Textarea } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { SectionCard } from '@/features/dashboard/components/page-header'
import { formatMoney } from '@/lib/money'
import { duplicateRecipeAction, saveRecipeAction, setRecipeActiveAction } from '../actions'
import { costRecipeLines } from '../actions-fetch'
import type { RecipeEditorData } from '../queries'
import { callAction } from '@/lib/use-action'

const UNITS = ['KG', 'GRAM', 'LITRE', 'ML', 'PIECE', 'PACK', 'BOTTLE', 'DOZEN', 'BOX'] as const

interface Line {
  key: string
  kind: 'ITEM' | 'PREP'
  refId: string
  quantity: string
  unit: string
  wastagePercent: string
}

/**
 * Recipe editor.
 *
 * Cost is shown per line and in total as the owner types, because the decision
 * this screen exists to support — "is this dish worth selling at this price?" —
 * is impossible to make if the number only appears after saving. The figures
 * update from the ingredients on screen, not from the last saved version.
 */
export function RecipeEditor({ data }: { data: RecipeEditorData }) {
  const router = useRouter()
  const money = (m: number) => formatMoney(m, data.currency)

  const [lines, setLines] = React.useState<Line[]>(() =>
    data.lines.length > 0
      ? data.lines.map((line, i) => ({
          key: `${i}`,
          kind: line.subRecipeId ? 'PREP' : 'ITEM',
          refId: line.subRecipeId ?? line.inventoryItemId ?? '',
          quantity: String(line.quantity),
          unit: line.unit,
          wastagePercent: String(line.wastagePercent),
        }))
      : [],
  )
  const [notes, setNotes] = React.useState(data.prepNotes ?? '')
  const [busy, setBusy] = React.useState(false)
  const [copyTo, setCopyTo] = React.useState('')

  const itemById = React.useMemo(() => new Map(data.items.map((i) => [i.id, i])), [data.items])

  const addLine = (kind: 'ITEM' | 'PREP') =>
    setLines((current) => [
      ...current,
      { key: `${Date.now()}-${current.length}`, kind, refId: '', quantity: '', unit: 'GRAM', wastagePercent: '0' },
    ])

  const update = (key: string, patch: Partial<Line>) =>
    setLines((current) => current.map((l) => (l.key === key ? { ...l, ...patch } : l)))

  const remove = (key: string) => setLines((current) => current.filter((l) => l.key !== key))

  /*
   * Costing happens on the server, by the same code that decides what leaves
   * stock — so the number on this screen cannot drift from the ledger's.
   *
   * It used to be worked out here as `quantity × costPerUnit × wastage`, with
   * no unit conversion and no yield division: 200 g of a LKR 250/kg item read
   * as LKR 50,000 rather than LKR 50, on the one screen whose entire job is to
   * answer "is this dish worth selling at this price?". Make-ahead lines showed
   * a dash and counted as free.
   */
  const [cost, setCost] = React.useState<{ total: number; byItem: Record<string, number> }>({
    // Seeded from the saved costing so the figure is right on first paint,
    // before the first keystroke triggers a re-cost.
    total: data.cost.ingredientCost,
    byItem: Object.fromEntries(data.cost.ingredients.map((i) => [i.itemId, i.lineCost])),
  })
  const [costing, setCosting] = React.useState(false)

  const priced = React.useMemo(
    () =>
      lines
        .filter((l) => l.refId && Number(l.quantity) > 0)
        .map((l) => ({
          inventoryItemId: l.kind === 'ITEM' ? l.refId : null,
          subRecipeId: l.kind === 'PREP' ? l.refId : null,
          quantity: Number(l.quantity),
          unit: l.unit,
          wastagePercent: Number(l.wastagePercent) || 0,
        })),
    [lines],
  )

  React.useEffect(() => {
    if (priced.length === 0) {
      setCost({ total: 0, byItem: {} })
      return
    }
    // Debounced, and guarded so the slower of two requests cannot land last.
    let stale = false
    setCosting(true)
    const timer = setTimeout(() => {
      void callAction(() => costRecipeLines({ yieldQty: 1, lines: priced })).then((result) => {
        if (stale) return
        setCosting(false)
        if (result.ok) setCost({ total: result.data.totalCost, byItem: result.data.byItem })
      })
    }, 350)
    return () => {
      stale = true
      clearTimeout(timer)
    }
  }, [priced])

  const liveCost = cost.total
  const percent = data.food.price > 0 ? (liveCost / data.food.price) * 100 : null

  const save = async () => {
    const payload = lines
      .filter((l) => l.refId && Number(l.quantity) > 0)
      .map((l) => ({
        inventoryItemId: l.kind === 'ITEM' ? l.refId : '',
        subRecipeId: l.kind === 'PREP' ? l.refId : '',
        quantity: Number(l.quantity),
        unit: l.unit,
        wastagePercent: Number(l.wastagePercent) || 0,
      }))

    if (payload.length === 0) {
      toast.error('Add at least one ingredient')
      return
    }

    setBusy(true)
    const result = await callAction(() => saveRecipeAction({
      foodId: data.food.id,
      yieldQty: 1,
      prepNotes: notes,
      ingredients: payload,
    }))
    setBusy(false)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    toast.success(`Saved as version ${result.data.version}`)
    router.refresh()
  }

  const duplicate = async () => {
    if (!data.recipeId || !copyTo) return
    setBusy(true)
    const result = await callAction(() => duplicateRecipeAction({ recipeId: data.recipeId, toFoodId: copyTo }))
    setBusy(false)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    const target = data.otherFoods.find((f) => f.id === copyTo)
    toast.success(`Copied to ${target?.name ?? 'the dish'}`)
    setCopyTo('')
  }

  const toggleActive = async () => {
    if (!data.recipeId) return
    setBusy(true)
    const result = await callAction(() => setRecipeActiveAction({ recipeId: data.recipeId, isActive: !data.isActive }))
    setBusy(false)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    toast.success(result.data.isActive ? 'Recipe active' : 'Recipe deactivated')
    router.refresh()
  }

  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-4">
        <Figure label="Selling price" value={money(data.food.price)} />
        <Figure label="What it costs you" value={costing ? '\u2026' : money(Math.round(liveCost))} />
        <Figure label="Gross profit" value={money(Math.round(data.food.price - liveCost))} />
        <Figure
          label="Food cost %"
          value={percent === null ? '—' : `${percent.toFixed(1)}%`}
          tone={percent === null ? undefined : percent > 40 ? 'bad' : percent > 30 ? 'warn' : 'good'}
        />
      </div>

      <SectionCard
        title="Ingredients"
        description="What one portion uses. Wastage covers trim and spillage — 5% on 100 g removes 105 g from stock."
        actions={data.version > 0 ? <Badge variant="secondary">v{data.version}</Badge> : null}
      >
        {lines.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No ingredients yet. Without a recipe this dish will not deplete stock when sold.
          </p>
        ) : (
          <ul className="space-y-2">
            {lines.map((line) => {
              const item = line.kind === 'ITEM' ? itemById.get(line.refId) : null
              const lineCost = line.refId ? cost.byItem[line.refId] ?? null : null

              return (
                <li key={line.key} className="grid grid-cols-12 items-center gap-2">
                  <select
                    className="col-span-12 h-10 rounded-lg border border-input bg-background px-2 text-sm sm:col-span-4"
                    value={line.refId}
                    onChange={(e) => update(line.key, { refId: e.target.value })}
                  >
                    <option value="">
                      {line.kind === 'PREP' ? 'Choose a prep recipe…' : 'Choose an ingredient…'}
                    </option>
                    {line.kind === 'ITEM'
                      ? data.items.map((i) => (
                          <option key={i.id} value={i.id}>{i.name}</option>
                        ))
                      : data.prepRecipes.map((r) => (
                          <option key={r.id} value={r.id}>
                            {r.name ?? 'Prep recipe'} (makes {r.yieldQty} {r.yieldUnit ?? ''})
                          </option>
                        ))}
                  </select>

                  <Input
                    className="col-span-4 sm:col-span-2"
                    inputMode="decimal"
                    placeholder="Qty"
                    value={line.quantity}
                    onChange={(e) => update(line.key, { quantity: e.target.value })}
                  />

                  <select
                    className="col-span-4 h-10 rounded-lg border border-input bg-background px-2 text-sm sm:col-span-2"
                    value={line.unit}
                    onChange={(e) => update(line.key, { unit: e.target.value })}
                  >
                    {UNITS.map((u) => <option key={u} value={u}>{u.toLowerCase()}</option>)}
                  </select>

                  <div className="col-span-4 flex items-center gap-1 sm:col-span-2">
                    <Input
                      inputMode="decimal"
                      placeholder="0"
                      value={line.wastagePercent}
                      onChange={(e) => update(line.key, { wastagePercent: e.target.value })}
                    />
                    <span className="text-sm text-muted-foreground">%</span>
                  </div>

                  <div className="col-span-10 text-right text-sm tabular-nums text-muted-foreground sm:col-span-1">
                    {lineCost === null ? '—' : money(Math.round(lineCost))}
                  </div>

                  <button
                    type="button"
                    onClick={() => remove(line.key)}
                    aria-label="Remove ingredient"
                    className="col-span-2 flex h-10 items-center justify-center rounded-lg border border-border text-muted-foreground hover:bg-muted sm:col-span-1"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>

                  {item && (
                    <p className="col-span-12 -mt-1 pl-1 text-xs text-muted-foreground">
                      {item.quantity} {item.unit.toLowerCase()} in stock
                    </p>
                  )}
                </li>
              )
            })}
          </ul>
        )}

        <div className="mt-4 flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => addLine('ITEM')}>
            <Plus className="mr-1.5 h-4 w-4" />
            Add ingredient
          </Button>
          {data.prepRecipes.length > 0 && (
            <Button variant="outline" size="sm" onClick={() => addLine('PREP')}>
              <Plus className="mr-1.5 h-4 w-4" />
              Add prep recipe
            </Button>
          )}
        </div>
      </SectionCard>

      <SectionCard title="Preparation notes" description="Shown to the kitchen, not to guests.">
        <Textarea
          rows={3}
          placeholder="e.g. grill the patty 4 minutes each side"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </SectionCard>

      {data.cost.problems.length > 0 && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-300">
          <ul className="list-inside list-disc space-y-1">
            {data.cost.problems.map((p, i) => <li key={i}>{p}</li>)}
          </ul>
        </div>
      )}

      {data.recipeId && (
        <SectionCard
          title="Manage this recipe"
          description="Deactivating stops new orders depleting against it. Nothing is ever deleted — past orders still point at it."
        >
          <div className="flex flex-wrap items-end gap-2">
            {data.otherFoods.length > 0 && (
              <>
                <div className="min-w-[14rem] flex-1 space-y-1">
                  <Label htmlFor="copy-to" className="text-xs">Copy these ingredients to</Label>
                  <select
                    id="copy-to"
                    className="h-10 w-full rounded-lg border border-input bg-background px-2 text-sm"
                    value={copyTo}
                    onChange={(e) => setCopyTo(e.target.value)}
                  >
                    <option value="">Choose a dish…</option>
                    {data.otherFoods.map((f) => (
                      <option key={f.id} value={f.id}>{f.name}</option>
                    ))}
                  </select>
                </div>
                <Button variant="outline" onClick={duplicate} disabled={busy || !copyTo}>
                  <Copy className="mr-2 h-4 w-4" />
                  Duplicate
                </Button>
              </>
            )}

            <Button
              variant={data.isActive ? 'destructive' : 'outline'}
              onClick={toggleActive}
              disabled={busy}
            >
              <Power className="mr-2 h-4 w-4" />
              {data.isActive ? 'Deactivate' : 'Activate'}
            </Button>
          </div>
          {!data.isActive && (
            <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">
              This recipe is inactive, so selling this dish will not deplete stock.
            </p>
          )}
        </SectionCard>
      )}

      <Button onClick={save} disabled={busy} size="lg">
        <Save className="mr-2 h-4 w-4" />
        {busy ? 'Saving…' : 'Save recipe'}
      </Button>
      <p className="text-xs text-muted-foreground">
        Saving creates a new version if this recipe has already been sold against, so past orders keep
        their original costing.
      </p>
    </div>
  )
}

function Figure({
  label,
  value,
  tone,
}: {
  label: string
  value: string
  tone?: 'good' | 'warn' | 'bad'
}) {
  const toneClass =
    tone === 'bad'
      ? 'text-red-600 dark:text-red-400'
      : tone === 'warn'
        ? 'text-amber-600 dark:text-amber-400'
        : tone === 'good'
          ? 'text-emerald-600 dark:text-emerald-400'
          : ''
  return (
    <div className="rounded-lg border border-border p-3">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={`mt-1 text-lg font-semibold tabular-nums ${toneClass}`}>{value}</p>
    </div>
  )
}
