'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { SectionCard } from '@/features/dashboard/components/page-header'
import { callAction } from '@/lib/use-action'
import { saveMakeAheadRecipeAction, setMakeAheadRecipeActiveAction } from '../actions'
import type { MakeAheadRecipeView } from './production-console'

const UNITS = ['KG', 'GRAM', 'LITRE', 'ML', 'PIECE', 'PACK', 'BOTTLE', 'DOZEN', 'BOX'] as const

/**
 * Make-ahead recipes — what the kitchen makes in advance.
 *
 * ── Why this is its own screen ──────────────────────────────────────────────
 *
 * It used to sit underneath the job board on one 574-line page, so "make
 * something" and "describe how something is made" were the same screen. They
 * are different jobs done by different people at different times: a recipe is
 * written once and then rarely; a job is created every day. Mixing them meant
 * whoever came to make a batch scrolled past a recipe editor to find the
 * button, and whoever came to fix a recipe scrolled past today's work.
 *
 * Nothing here touches stock. Writing a recipe changes no balance; only
 * completing a job does.
 */
export function RecipeManager({
  recipes,
  items,
}: {
  recipes: MakeAheadRecipeView[]
  items: Array<{ id: string; name: string; unit: string }>
}) {
  const router = useRouter()
  const [busy, setBusy] = React.useState(false)

  // Non-null while editing an existing recipe; the same form does both jobs,
  // because "add" and "edit" of the same thing diverging is how two screens end
  // up validating differently.
  const [editingRecipe, setEditingRecipe] = React.useState<string | null>(null)
  const [recipeName, setRecipeName] = React.useState('')
  /*
   * The "what it makes" PICKER is gone. It asked owners to choose a stock item
   * that duplicated the name they had just typed, and it was the single
   * most-asked-about control on this screen. The server now finds or creates
   * the shelf item from the recipe's name; all the form needs is the unit a
   * batch is measured in — and when editing, even that is fixed.
   */
  const [makesUnit, setMakesUnit] = React.useState('KG')
  const [editingUnit, setEditingUnit] = React.useState<string | null>(null)
  const [makesQty, setMakesQty] = React.useState('1')
  const [shelfLife, setShelfLife] = React.useState('')
  const [lines, setLines] = React.useState<
    Array<{ key: string; itemId: string; quantity: string; unit: string }>
  >([])

  const clearRecipeForm = () => {
    setEditingRecipe(null)
    setRecipeName(''); setMakesUnit('KG'); setEditingUnit(null)
    setMakesQty('1'); setShelfLife(''); setLines([])
  }

  const loadRecipe = (recipe: MakeAheadRecipeView) => {
    setEditingRecipe(recipe.id)
    setRecipeName(recipe.name)
    setEditingUnit(recipe.outputUnit)
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
    const chosen = lines
      .filter((line) => line.itemId && Number(line.quantity) > 0)
      .map((line) => ({ itemId: line.itemId, quantity: Number(line.quantity), unit: line.unit }))
    if (!recipeName.trim() || !(Number(makesQty) > 0) || chosen.length === 0) {
      toast.error('Name it and add at least one ingredient')
      return
    }
    setBusy(true)
    const result = await callAction(() =>
      saveMakeAheadRecipeAction({
        recipeId: editingRecipe ?? undefined,
        name: recipeName,
        yieldUnit: makesUnit,
        yieldQty: Number(makesQty),
        shelfLifeDays: shelfLife ? Number(shelfLife) : undefined,
        items: chosen,
      }),
    )
    setBusy(false)
    if (!result.ok) { toast.error(result.error); return }
    toast.success(editingRecipe ? 'Recipe updated' : 'Recipe saved')
    clearRecipeForm()
    router.refresh()
  }

  const retireRecipe = async (recipeId: string, isActive: boolean) => {
    setBusy(true)
    const result = await callAction(() => setMakeAheadRecipeActiveAction({ recipeId, isActive }))
    setBusy(false)
    if (!result.ok) { toast.error(result.error); return }
    toast.success(isActive ? 'Recipe is back in use' : 'Recipe retired')
    router.refresh()
  }

  return (
    <div className="space-y-6">
      {recipes.length > 0 ? (
        <SectionCard
          title="Make-ahead recipes"
          description="Edit one and future jobs use the new version. Jobs already done keep the costs they were done with."
        >
          <ul className="divide-y divide-border">
            {recipes.map((recipe) => (
              <li key={recipe.id} className="flex flex-wrap items-center gap-2 py-2.5 text-sm">
                <span className="font-medium">{recipe.name}</span>
                <span className="text-muted-foreground">
                  makes {recipe.yieldQty} {recipe.outputUnit.toLowerCase()} of {recipe.outputName}
                  {recipe.items.length > 0
                    ? ` · ${recipe.items.length} ingredient${recipe.items.length === 1 ? '' : 's'}`
                    : ''}
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
        {/*
          The walkthrough, on the form itself. This screen used to open with
          four unlabelled decisions — including a "what it makes" picker that
          asked for the name a second time — and owners told us so. The
          numbered steps ARE the form now, and the shelf item is handled for
          them: naming the recipe names the stock it produces.
        */}
        <ol className="mb-4 space-y-1.5 rounded-lg border border-border bg-muted/30 p-3 text-sm text-muted-foreground">
          <li><strong className="text-foreground">Step 1 —</strong> Name what you make ahead: “Chicken patties”, “Brown stock”. That name goes on your stock list automatically.</li>
          <li><strong className="text-foreground">Step 2 —</strong> Say how a batch is measured. Easiest: leave the amount at <strong className="text-foreground">1</strong> and write the ingredients for one.</li>
          <li><strong className="text-foreground">Step 3 —</strong> Add the ingredients that go <em>into</em> it, with amounts.</li>
          <li><strong className="text-foreground">Step 4 —</strong> Save. When the kitchen actually cooks a batch, start a <strong className="text-foreground">New Production</strong> on the Kitchen jobs screen — the ingredients leave stock and the made item goes on the shelf.</li>
        </ol>

        <div className="grid gap-4 sm:grid-cols-4">
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="mr-name">Step 1 · Name</Label>
            <Input id="mr-name" placeholder="e.g. Chicken patties" value={recipeName} onChange={(e) => setRecipeName(e.target.value)} />
            <p className="text-xs text-muted-foreground">
              {editingRecipe ? 'Renaming the recipe does not rename the shelf item.' : 'No need to pick a stock item — we create one with this name.'}
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="mr-qty">Step 2 · One batch makes</Label>
            <div className="flex gap-2">
              <Input id="mr-qty" inputMode="decimal" className="flex-1" value={makesQty} onChange={(e) => setMakesQty(e.target.value)} />
              {editingUnit ? (
                <span className="flex h-10 items-center rounded-lg border border-border px-3 text-sm text-muted-foreground">
                  {editingUnit.toLowerCase()}
                </span>
              ) : (
                <select
                  aria-label="Unit a batch is measured in"
                  className="h-10 rounded-lg border border-input bg-background px-2 text-sm"
                  value={makesUnit}
                  onChange={(e) => setMakesUnit(e.target.value)}
                >
                  {UNITS.map((unit) => <option key={unit} value={unit}>{unit.toLowerCase()}</option>)}
                </select>
              )}
            </div>
            {/*
              Defaulted to 1 on purpose: then "make 100" means 100 and there is
              no batch size for anyone to multiply in their head. Leave it at 1
              and write the ingredients for one.
            */}
            <p className="text-xs text-muted-foreground">Leave at 1 unless you always make a fixed batch</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="mr-life">Keeps for (days)</Label>
            <Input id="mr-life" inputMode="numeric" placeholder="optional" value={shelfLife} onChange={(e) => setShelfLife(e.target.value)} />
          </div>
        </div>

        <p className="mb-2 mt-4 text-sm font-medium">
          Step 3 · Ingredients for {Number(makesQty) > 0 ? Number(makesQty) : 1}{' '}
          {(editingUnit ?? makesUnit).toLowerCase()}
        </p>
        <ul className="space-y-2">
          {lines.map((line) => (
            <li key={line.key} className="grid grid-cols-12 items-end gap-2">
              <div className="col-span-12 sm:col-span-6">
                <select
                  aria-label="Ingredient"
                  className="h-10 w-full rounded-lg border border-input bg-background px-2 text-sm"
                  value={line.itemId}
                  onChange={(e) => setLines((c) => c.map((x) => x.key === line.key ? { ...x, itemId: e.target.value } : x))}
                >
                  <option value="">Choose an ingredient…</option>
                  {items.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                </select>
              </div>
              <div className="col-span-5 sm:col-span-3">
                <Input
                  inputMode="decimal"
                  aria-label="How much"
                  placeholder="How much"
                  value={line.quantity}
                  onChange={(e) => setLines((c) => c.map((x) => x.key === line.key ? { ...x, quantity: e.target.value } : x))}
                />
              </div>
              <div className="col-span-5 sm:col-span-2">
                <select
                  aria-label="Unit"
                  className="h-10 w-full rounded-lg border border-input bg-background px-2 text-sm"
                  value={line.unit}
                  onChange={(e) => setLines((c) => c.map((x) => x.key === line.key ? { ...x, unit: e.target.value } : x))}
                >
                  {UNITS.map((unit) => <option key={unit} value={unit}>{unit.toLowerCase()}</option>)}
                </select>
              </div>
              <button
                type="button"
                aria-label="Remove"
                onClick={() => setLines((c) => c.filter((x) => x.key !== line.key))}
                className="col-span-2 flex h-10 items-center justify-center rounded-lg border border-border text-muted-foreground hover:bg-muted sm:col-span-1"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>

        <div className="mt-3 flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setLines((c) => [...c, { key: `${Date.now()}-${c.length}`, itemId: '', quantity: '', unit: 'KG' }])}
          >
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
