'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { CheckCircle2, ChefHat, Pencil, Play, Plus, Trash2, X } from 'lucide-react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { SectionCard } from '@/features/dashboard/components/page-header'
import { formatMoney, parseMoney } from '@/lib/money'
import { callAction } from '@/lib/use-action'
import {
  completeProductionAction, createProductionOrderAction,
  saveMakeAheadRecipeAction, setMakeAheadRecipeActiveAction, setProductionStatusAction,
} from '../actions'

const UNITS = ['KG', 'GRAM', 'LITRE', 'ML', 'PIECE', 'PACK', 'BOTTLE', 'DOZEN', 'BOX'] as const
const REASONS = [
  { value: 'PRODUCTION_LOSS', label: 'Some was lost making it' },
  { value: 'DAMAGED', label: 'Damaged' },
  { value: 'INGREDIENT_SHORTAGE', label: 'Ran short of an ingredient' },
  { value: 'QUALITY_ISSUE', label: 'Not good enough to use' },
  { value: 'OTHER', label: 'Something else' },
] as const

export interface MakeAheadRecipeView {
  id: string
  name: string
  isActive: boolean
  producesItemId: string
  outputName: string
  outputUnit: string
  /** How much one run of the recipe makes. New recipes are created at 1. */
  yieldQty: number
  shelfLifeDays: number | null
  notes: string | null
  items: Array<{ itemId: string; name: string; quantity: number; unit: string }>
}

export interface ProductionConsoleData {
  houses: Array<{ id: string; name: string }>
  items: Array<{ id: string; name: string; unit: string; quantity: number }>
  recipes: MakeAheadRecipeView[]
  pending: Array<{
    id: string
    number: string
    status: string
    recipeName: string | null
    plannedQty: number
    outputName: string | null
    outputUnit: string | null
  }>
  currency: string
}

/** Plain words for a status. The enum has more; only these are reachable. */
const STATUS_LABEL: Record<string, string> = {
  DRAFT: 'to make',
  PLANNED: 'to make',
  APPROVED: 'approved',
  IN_PROGRESS: 'approved',
  COMPLETED: 'done',
  PARTIALLY_COMPLETED: 'done',
  CANCELLED: 'cancelled',
}

/**
 * Kitchen jobs — making something ahead so it is on the shelf when you need it.
 *
 * Two things happen here and only one of them touches stock. Writing a recipe
 * and planning a job change nothing; finishing a job takes the ingredients out
 * and puts the finished item in, in a single transaction. The screen says so at
 * each step rather than leaving someone to find out.
 *
 * ── What this screen used to be ─────────────────────────────────────────────
 *
 * It asked for a number of BATCHES against a recipe that made ten of something,
 * so "10" quietly meant a hundred loaves and the screen had to print the
 * multiplication underneath every field. It also called its recipes something
 * different from the Recipes screen while being the same idea, and apologised
 * for it in a caption. Both are gone: a job says how many you want, in the
 * finished item's own unit.
 */
export function ProductionConsole({
  data,
  canApprove = true,
}: {
  data: ProductionConsoleData
  /**
   * Approving commits ingredients, so it is a separate permission from
   * planning. Showing the button to someone who does not hold it and answering
   * the click with a refusal teaches people the app is broken; the honest
   * version is not to offer it.
   */
  canApprove?: boolean
}) {
  const router = useRouter()
  const money = (m: number) => formatMoney(m, data.currency)
  const [busy, setBusy] = React.useState(false)

  // ── recipe ────────────────────────────────────────────────────────────────
  // Non-null while editing an existing recipe; the same form does both jobs,
  // because "add" and "edit" of the same thing diverging is how two screens end
  // up validating differently.
  const [editingRecipe, setEditingRecipe] = React.useState<string | null>(null)
  const [recipeName, setRecipeName] = React.useState('')
  const [makesItemId, setMakesItemId] = React.useState('')
  const [makesQty, setMakesQty] = React.useState('1')
  const [shelfLife, setShelfLife] = React.useState('')
  const [lines, setLines] = React.useState<Array<{ key: string; itemId: string; quantity: string; unit: string }>>([])

  const makesItem = data.items.find((i) => i.id === makesItemId) ?? null

  const clearRecipeForm = () => {
    setEditingRecipe(null)
    setRecipeName(''); setMakesItemId(''); setMakesQty('1'); setShelfLife(''); setLines([])
  }

  const loadRecipe = (recipe: MakeAheadRecipeView) => {
    setEditingRecipe(recipe.id)
    setRecipeName(recipe.name)
    setMakesItemId(recipe.producesItemId)
    setMakesQty(String(recipe.yieldQty))
    setShelfLife(recipe.shelfLifeDays === null ? '' : String(recipe.shelfLifeDays))
    setLines(
      recipe.items.map((line, index) => ({
        key: `${recipe.id}-${index}`,
        itemId: line.itemId,
        quantity: String(line.quantity),
        unit: line.unit,
      })),
    )
    if (typeof window !== 'undefined') {
      document.getElementById('mr-name')?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }

  const saveRecipe = async () => {
    const items = lines.filter((l) => l.itemId && Number(l.quantity) > 0)
      .map((l) => ({ itemId: l.itemId, quantity: Number(l.quantity), unit: l.unit }))
    if (!recipeName.trim() || !makesItemId || !(Number(makesQty) > 0) || items.length === 0) {
      toast.error('Name it, say what it makes, and add ingredients')
      return
    }
    setBusy(true)
    const r = await callAction(() =>
      saveMakeAheadRecipeAction({
        recipeId: editingRecipe ?? undefined,
        name: recipeName,
        producesItemId: makesItemId,
        yieldQty: Number(makesQty),
        shelfLifeDays: shelfLife ? Number(shelfLife) : undefined,
        items,
      }),
    )
    setBusy(false)
    if (!r.ok) { toast.error(r.error); return }
    toast.success(editingRecipe ? 'Recipe updated' : 'Recipe saved')
    clearRecipeForm()
    router.refresh()
  }

  const retireRecipe = async (recipeId: string, isActive: boolean) => {
    setBusy(true)
    const r = await callAction(() => setMakeAheadRecipeActiveAction({ recipeId, isActive }))
    setBusy(false)
    if (!r.ok) { toast.error(r.error); return }
    toast.success(isActive ? 'Recipe is back in use' : 'Recipe retired')
    router.refresh()
  }

  // ── job ───────────────────────────────────────────────────────────────────
  const [houseId, setHouseId] = React.useState(data.houses[0]?.id ?? '')
  const [jobRecipeId, setJobRecipeId] = React.useState('')
  const [howMany, setHowMany] = React.useState('')
  const chosenRecipe = data.recipes.find((r) => r.id === jobRecipeId) ?? null

  const startJob = async () => {
    setBusy(true)
    const r = await callAction(() => createProductionOrderAction({
      branchId: houseId, recipeId: jobRecipeId, plannedQty: Number(howMany),
    }))
    setBusy(false)
    if (!r.ok) { toast.error(r.error); return }
    toast.success(`${r.data.number} added — nothing taken from stock yet`)
    setJobRecipeId(''); setHowMany('')
    router.refresh()
  }

  const move = async (orderId: string, status: string) => {
    setBusy(true)
    const r = await callAction(() => setProductionStatusAction({ orderId, status }))
    setBusy(false)
    if (!r.ok) { toast.error(r.error); return }
    toast.success('Updated')
    router.refresh()
  }

  // ── finishing ─────────────────────────────────────────────────────────────
  const [made, setMade] = React.useState<Record<string, string>>({})
  const [reason, setReason] = React.useState<Record<string, string>>({})
  const [overhead, setOverhead] = React.useState<Record<string, string>>({})

  const finish = async (orderId: string, planned: number) => {
    const raw = made[orderId]
    const actual = raw === undefined || raw === '' ? planned : Number(raw)
    /*
     * Zero is refused rather than treated as "all of it". A blank box gives
     * `Number('')` === 0, which passes every finite/negative check — and used to
     * consume every ingredient, produce nothing, and record a cost of zero
     * without a word.
     */
    if (!Number.isFinite(actual) || actual <= 0) {
      toast.error('Enter how many came out. If none did, cancel the job instead.')
      return
    }
    if (actual < planned && !reason[orderId]) {
      toast.error('Fewer came out than planned — say why')
      return
    }
    /*
     * Overheads are typed in whole currency and stored in minor units, through
     * the same helper every other money field uses. This multiplied by 100 by
     * hand, which is 100× too much in yen, won and dong.
     */
    const typed = overhead[orderId]
    const overheadMinor =
      typed && Number.isFinite(Number(typed)) && Number(typed) >= 0
        ? parseMoney(typed, data.currency)
        : undefined

    setBusy(true)
    const r = await callAction(() => completeProductionAction({
      orderId, actualQty: actual, overheadCost: overheadMinor,
      varianceReason: actual < planned ? reason[orderId] : undefined,
    }))
    setBusy(false)
    if (!r.ok) { toast.error(r.error); return }
    toast.success(`${r.data.produced} made, at ${money(r.data.unitCost)} each`)
    router.refresh()
  }

  if (data.houses.length === 0) {
    return (
      <SectionCard title="No production kitchen yet">
        <p className="py-6 text-center text-sm text-muted-foreground">
          Add a location of type <strong>Production house</strong> first, then kitchen jobs appear here.
        </p>
      </SectionCard>
    )
  }

  const activeRecipes = data.recipes.filter((r) => r.isActive)

  return (
    <div className="space-y-5">
      {data.pending.length > 0 && (
        <SectionCard
          title="Jobs to do"
          description="Nothing here has taken anything from stock. That happens when you mark a job done."
        >
          <ul className="divide-y divide-border">
            {data.pending.map((p) => {
              const actual = made[p.id] === undefined ? String(p.plannedQty) : made[p.id]
              const short = Number(actual) < p.plannedQty
              const awaitingApproval = p.status === 'DRAFT' || p.status === 'PLANNED'
              const readyToRun = p.status === 'APPROVED' || p.status === 'IN_PROGRESS'
              const unit = p.outputUnit?.toLowerCase() ?? ''

              return (
                <li key={p.id} className="py-3">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <ChefHat className="h-4 w-4 text-muted-foreground" />
                    <Link href={`/dashboard/production/${p.id}`} className="font-medium tabular-nums hover:underline">
                      {p.number}
                    </Link>
                    {/*
                      One quantity, in the finished item's own unit. This used to
                      print "10 batches planned = 100 PIECE of Bread" because the
                      number on file meant something nobody had asked for.
                    */}
                    <span>
                      Make <strong className="tabular-nums">{p.plannedQty}</strong> {unit}{' '}
                      {p.outputName ?? p.recipeName ?? ''}
                    </span>
                    <Badge variant="secondary">{STATUS_LABEL[p.status] ?? p.status.toLowerCase()}</Badge>
                  </div>

                  <div className="mt-2 flex flex-wrap items-end gap-2">
                    {awaitingApproval && canApprove && (
                      <Button size="sm" onClick={() => move(p.id, 'APPROVED')} disabled={busy}>
                        <CheckCircle2 className="mr-1.5 h-4 w-4" />
                        Approve
                      </Button>
                    )}
                    {awaitingApproval && !canApprove && (
                      <p className="text-xs text-muted-foreground">
                        Waiting for approval — you do not have permission to approve jobs.
                      </p>
                    )}
                    {readyToRun && (
                      <>
                        <div className="space-y-1">
                          <Label className="text-xs">How many came out</Label>
                          <Input
                            className="w-32"
                            inputMode="decimal"
                            value={actual}
                            onChange={(e) => setMade((c) => ({ ...c, [p.id]: e.target.value }))}
                          />
                          <p className="text-xs text-muted-foreground">{unit || 'units'}</p>
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs">Other costs (optional)</Label>
                          <Input
                            className="w-32"
                            inputMode="decimal"
                            placeholder="0"
                            value={overhead[p.id] ?? ''}
                            onChange={(e) => setOverhead((c) => ({ ...c, [p.id]: e.target.value }))}
                          />
                          <p className="text-xs text-muted-foreground">Labour, power, gas</p>
                        </div>
                        {short && (
                          <div className="space-y-1">
                            <Label className="text-xs">Why fewer?</Label>
                            <select
                              className="h-10 rounded-lg border border-input bg-background px-2 text-sm"
                              value={reason[p.id] ?? ''}
                              onChange={(e) => setReason((c) => ({ ...c, [p.id]: e.target.value }))}
                            >
                              <option value="">Choose…</option>
                              {REASONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                            </select>
                          </div>
                        )}
                        <Button size="sm" onClick={() => finish(p.id, p.plannedQty)} disabled={busy}>
                          <Play className="mr-1.5 h-4 w-4" />
                          Mark done
                        </Button>
                      </>
                    )}
                    {/*
                      A job with no way out of it is a row that sits on this list
                      for ever. Cancelling takes nothing from stock — nothing has
                      moved yet — so it is always safe before the job is done.
                    */}
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => move(p.id, 'CANCELLED')}
                      disabled={busy}
                    >
                      <X className="mr-1.5 h-4 w-4" />
                      Cancel
                    </Button>
                  </div>

                  {short && readyToRun ? (
                    <p className="mt-2 border-l-2 border-warning/60 pl-3 text-xs text-muted-foreground">
                      Ingredients for {p.plannedQty} come out of stock even though only {actual}{' '}
                      came out of the kitchen — they were used either way. The cost is spread over
                      the {actual}, so each one costs more than on a good day.
                    </p>
                  ) : null}
                </li>
              )
            })}
          </ul>
        </SectionCard>
      )}

      <SectionCard
        title="Make something"
        description="Adding a job takes nothing from stock. Approve it, then mark it done when the food is actually made."
      >
        <div className="grid gap-4 sm:grid-cols-3">
          {data.houses.length > 1 && (
            <div className="space-y-1.5">
              <Label htmlFor="house">Kitchen</Label>
              <select id="house" className="h-10 w-full rounded-lg border border-input bg-background px-2 text-sm"
                value={houseId} onChange={(e) => setHouseId(e.target.value)}>
                {data.houses.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
              </select>
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="job-recipe">What are you making?</Label>
            <select id="job-recipe" className="h-10 w-full rounded-lg border border-input bg-background px-2 text-sm"
              value={jobRecipeId} onChange={(e) => setJobRecipeId(e.target.value)}>
              <option value="">Choose a recipe…</option>
              {activeRecipes.map((r) => (
                <option key={r.id} value={r.id}>{r.name}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="how-many">How many?</Label>
            <Input id="how-many" inputMode="decimal" value={howMany} onChange={(e) => setHowMany(e.target.value)} />
            {chosenRecipe ? (
              <p className="text-xs text-muted-foreground">
                {chosenRecipe.outputUnit.toLowerCase()} of {chosenRecipe.outputName}
              </p>
            ) : null}
          </div>
        </div>
        <Button className="mt-4" onClick={startJob} disabled={busy || !jobRecipeId || !(Number(howMany) > 0)}>
          <Plus className="mr-2 h-4 w-4" />
          Add job
        </Button>
        {activeRecipes.length === 0 && (
          <p className="mt-2 text-xs text-warning">
            No make-ahead recipes yet — write one below first.
          </p>
        )}
      </SectionCard>

      {data.recipes.length > 0 ? (
        <SectionCard
          title="Make-ahead recipes"
          description="Edit one and future jobs use the new version. Jobs already done keep the costs they were done with."
        >
          <ul className="divide-y divide-border">
            {data.recipes.map((recipe) => (
              <li key={recipe.id} className="flex flex-wrap items-center gap-2 py-2.5 text-sm">
                <span className="font-medium">{recipe.name}</span>
                <span className="text-muted-foreground">
                  makes {recipe.yieldQty} {recipe.outputUnit.toLowerCase()} of {recipe.outputName}
                  {recipe.items.length > 0 ? ` · ${recipe.items.length} ingredient${recipe.items.length === 1 ? '' : 's'}` : ''}
                  {recipe.shelfLifeDays ? ` · keeps ${recipe.shelfLifeDays} days` : ''}
                </span>
                {!recipe.isActive ? <Badge variant="secondary">Retired</Badge> : null}
                <div className="ml-auto flex gap-1">
                  <Button size="sm" variant="ghost" onClick={() => loadRecipe(recipe)} disabled={busy}>
                    <Pencil className="mr-1.5 h-4 w-4" />
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => retireRecipe(recipe.id, !recipe.isActive)}
                    disabled={busy}
                  >
                    {recipe.isActive ? 'Retire' : 'Restore'}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </SectionCard>
      ) : null}

      <SectionCard
        title={editingRecipe ? 'Edit recipe' : 'New make-ahead recipe'}
        description="Something the kitchen makes in advance and puts on the shelf — sauce, stock, patties, dough."
      >
        <div className="grid gap-4 sm:grid-cols-4">
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="mr-name">Name</Label>
            <Input id="mr-name" placeholder="e.g. Chicken patties" value={recipeName} onChange={(e) => setRecipeName(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="mr-out">What it makes</Label>
            <select id="mr-out" className="h-10 w-full rounded-lg border border-input bg-background px-2 text-sm"
              value={makesItemId} onChange={(e) => setMakesItemId(e.target.value)}>
              <option value="">Choose…</option>
              {data.items.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="mr-qty">How much it makes</Label>
            <Input id="mr-qty" inputMode="decimal" value={makesQty} onChange={(e) => setMakesQty(e.target.value)} />
            {/*
              Defaulted to 1 on purpose: then "make 100" means 100 and there is
              no batch size for anyone to multiply in their head. Leave it at 1
              and write the ingredients for one.
            */}
            <p className="text-xs text-muted-foreground">
              {makesItem ? `${makesItem.unit.toLowerCase()} — leave at 1 and write the ingredients for one` : 'Leave at 1 unless you always make a fixed batch'}
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="mr-life">Keeps for (days)</Label>
            <Input id="mr-life" inputMode="numeric" placeholder="optional" value={shelfLife} onChange={(e) => setShelfLife(e.target.value)} />
          </div>
        </div>

        <p className="mt-4 mb-2 text-sm font-medium">
          Ingredients for {Number(makesQty) > 0 ? Number(makesQty) : 1}{' '}
          {makesItem ? makesItem.unit.toLowerCase() : ''}
        </p>
        <ul className="space-y-2">
          {lines.map((l) => (
            <li key={l.key} className="grid grid-cols-12 items-end gap-2">
              <div className="col-span-12 sm:col-span-6">
                <select className="h-10 w-full rounded-lg border border-input bg-background px-2 text-sm"
                  value={l.itemId}
                  onChange={(e) => setLines((c) => c.map((x) => x.key === l.key ? { ...x, itemId: e.target.value } : x))}>
                  <option value="">Choose an ingredient…</option>
                  {data.items.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
                </select>
              </div>
              <div className="col-span-5 sm:col-span-3">
                <Input inputMode="decimal" placeholder="How much" value={l.quantity}
                  onChange={(e) => setLines((c) => c.map((x) => x.key === l.key ? { ...x, quantity: e.target.value } : x))} />
              </div>
              <div className="col-span-5 sm:col-span-2">
                <select className="h-10 w-full rounded-lg border border-input bg-background px-2 text-sm"
                  value={l.unit}
                  onChange={(e) => setLines((c) => c.map((x) => x.key === l.key ? { ...x, unit: e.target.value } : x))}>
                  {UNITS.map((u) => <option key={u} value={u}>{u.toLowerCase()}</option>)}
                </select>
              </div>
              <button type="button" aria-label="Remove"
                onClick={() => setLines((c) => c.filter((x) => x.key !== l.key))}
                className="col-span-2 flex h-10 items-center justify-center rounded-lg border border-border text-muted-foreground hover:bg-muted sm:col-span-1">
                <Trash2 className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>

        <div className="mt-3 flex gap-2">
          <Button variant="outline" size="sm"
            onClick={() => setLines((c) => [...c, { key: `${Date.now()}-${c.length}`, itemId: '', quantity: '', unit: 'KG' }])}>
            <Plus className="mr-1.5 h-4 w-4" />
            Add ingredient
          </Button>
          <Button size="sm" onClick={saveRecipe} disabled={busy}>
            {editingRecipe ? 'Save changes' : 'Save recipe'}
          </Button>
          {editingRecipe ? (
            <Button size="sm" variant="ghost" onClick={clearRecipeForm} disabled={busy}>
              Cancel
            </Button>
          ) : null}
        </div>
      </SectionCard>
    </div>
  )
}
