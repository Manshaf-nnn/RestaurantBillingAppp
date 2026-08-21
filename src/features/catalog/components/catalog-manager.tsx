'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { Pencil, Plus } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { EmptyState } from '@/components/ui/feedback'
import { Input, Textarea } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { SectionCard } from '@/features/dashboard/components/page-header'
import { useAction } from '@/lib/use-action'
import {
  saveStockCategoryAction,
  setStockCategoryActiveAction,
  setUnitActiveAction,
  updateUnitAction,
} from '../actions'
import type { CategoryView, UnitView } from '../service'

/**
 * Units and stock categories, on one screen because they are the same job:
 * the two lists every stock item is built out of.
 *
 * A unit cannot be created here and that is on purpose, not an omission. The
 * nine are the ones the conversion engine knows how to convert between, and a
 * tenth with no defined relationship to the others could not be converted
 * without guessing — which the engine refuses to do, because silently treating
 * 500 g as 500 kg corrupts a ledger in a way nobody notices until a stock take.
 * What you can do is name them, label them, order them and switch off the ones
 * you never use, which is what actually makes the dropdowns bearable.
 *
 * Categories are fully yours: create, rename, retire, restore.
 */
export function CatalogManager({
  units,
  categories,
  canManage,
}: {
  units: UnitView[]
  categories: CategoryView[]
  canManage: boolean
}) {
  const [tab, setTab] = React.useState<'UNITS' | 'CATEGORIES'>('UNITS')

  return (
    <>
      <div className="mb-5 inline-flex rounded-lg border border-border bg-muted/40 p-1">
        {(
          [
            ['UNITS', `Units (${units.filter((u) => u.isActive).length})`],
            ['CATEGORIES', `Categories (${categories.filter((c) => c.isActive).length})`],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => setTab(value)}
            className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
              tab === value
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'UNITS' ? (
        <UnitsPanel units={units} canManage={canManage} />
      ) : (
        <CategoriesPanel categories={categories} canManage={canManage} />
      )}
    </>
  )
}

function UnitsPanel({ units, canManage }: { units: UnitView[]; canManage: boolean }) {
  const { busy, run } = useAction()
  const router = useRouter()
  const [editing, setEditing] = React.useState<UnitView | null>(null)
  const [form, setForm] = React.useState({ name: '', symbol: '', sortOrder: '0' })

  const open = (unit: UnitView) => {
    setEditing(unit)
    setForm({ name: unit.name, symbol: unit.symbol, sortOrder: String(unit.sortOrder) })
  }

  const save = () => {
    if (!editing) return
    const unitId = editing.id
    return run(
      () =>
        updateUnitAction({
          unitId,
          name: form.name,
          symbol: form.symbol,
          sortOrder: Number(form.sortOrder) || 0,
        }),
      {
        success: 'Unit saved.',
        onDone: () => {
          setEditing(null)
          router.refresh()
        },
      },
    )
  }

  const toggle = (unit: UnitView) =>
    run(() => setUnitActiveAction({ unitId: unit.id, isActive: !unit.isActive }), {
      success: unit.isActive ? 'Unit switched off.' : 'Unit switched on.',
      onDone: () => router.refresh(),
    })

  return (
    <>
      <SectionCard
        title="Units"
        description="What each unit is called and whether it is offered. Switching one off never changes any stock — it only stops appearing in dropdowns."
      >
        <ul className="divide-y divide-border">
          {units.map((unit) => (
            <li key={unit.id} className="flex flex-wrap items-center gap-2 py-2.5 text-sm">
              <span className="font-medium">{unit.name}</span>
              <span className="text-muted-foreground">{unit.symbol}</span>
              <code className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                {unit.code}
              </code>
              {unit.itemCount > 0 ? (
                <Badge variant="secondary">
                  {unit.itemCount} item{unit.itemCount === 1 ? '' : 's'}
                </Badge>
              ) : null}
              {!unit.isActive ? <Badge variant="secondary">Off</Badge> : null}
              {canManage ? (
                <div className="ml-auto flex gap-1">
                  <Button size="sm" variant="ghost" onClick={() => open(unit)} disabled={busy}>
                    <Pencil className="mr-1.5 h-4 w-4" />
                    Edit
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => toggle(unit)} disabled={busy}>
                    {unit.isActive ? 'Switch off' : 'Switch on'}
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
        <p className="mt-4 border-l-2 border-border pl-3 text-sm leading-relaxed text-muted-foreground">
          These nine are the units the system knows how to convert between — a kilo is a thousand
          grams, a dozen is twelve. Box, packet and bottle have no fixed size, so each item declares
          its own on the item itself: &ldquo;bought as a box of 24&rdquo;. That is how you add a
          pack size the system has never seen.
        </p>
      </SectionCard>

      <Dialog open={Boolean(editing)} onOpenChange={(value) => !value && setEditing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit {editing?.name}</DialogTitle>
            <DialogDescription>
              Changes the label everywhere it is shown. What the unit means, and what it converts
              to, does not change.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Name</Label>
              <Input
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="Kilogram"
              />
            </div>
            <div>
              <Label>Symbol</Label>
              <Input
                value={form.symbol}
                onChange={(e) => setForm((f) => ({ ...f, symbol: e.target.value }))}
                placeholder="kg"
              />
            </div>
            <div>
              <Label>Sort order</Label>
              <Input
                type="number"
                value={form.sortOrder}
                onChange={(e) => setForm((f) => ({ ...f, sortOrder: e.target.value }))}
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Lower numbers come first. Put the ones you use most at the top.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={save} disabled={busy || !form.name.trim() || !form.symbol.trim()}>
              {busy ? 'Saving…' : 'Save'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

function CategoriesPanel({
  categories,
  canManage,
}: {
  categories: CategoryView[]
  canManage: boolean
}) {
  const { busy, run } = useAction()
  const router = useRouter()
  const [open, setOpen] = React.useState(false)
  const [editing, setEditing] = React.useState<CategoryView | null>(null)
  const [form, setForm] = React.useState({ name: '', description: '', sortOrder: '0' })

  const start = (category: CategoryView | null) => {
    setEditing(category)
    setForm({
      name: category?.name ?? '',
      description: category?.description ?? '',
      sortOrder: String(category?.sortOrder ?? 0),
    })
    setOpen(true)
  }

  const save = () =>
    run(
      () =>
        saveStockCategoryAction({
          id: editing?.id,
          name: form.name,
          description: form.description,
          sortOrder: Number(form.sortOrder) || 0,
        }),
      {
        success: 'Category saved.',
        onDone: () => {
          setOpen(false)
          setEditing(null)
          router.refresh()
        },
      },
    )

  const toggle = (category: CategoryView) =>
    run(() => setStockCategoryActiveAction({ id: category.id, isActive: !category.isActive }), {
      success: category.isActive ? 'Category retired.' : 'Category restored.',
      onDone: () => router.refresh(),
    })

  return (
    <>
      <SectionCard
        title="Stock categories"
        description="Rice, Meat, Cleaning, Packaging — whatever you group by. Retiring one keeps every item that has it; it just stops being offered for new ones."
        actions={
          canManage ? (
            <Button size="sm" onClick={() => start(null)}>
              <Plus className="mr-1.5 h-4 w-4" />
              New category
            </Button>
          ) : null
        }
      >
        {categories.length === 0 ? (
          <EmptyState
            title="No categories yet"
            description="Add a few — Rice, Meat, Vegetables, Cleaning — and they become a dropdown on every stock item instead of a box people spell differently."
          />
        ) : (
          <ul className="divide-y divide-border">
            {categories.map((category) => (
              <li key={category.id} className="flex flex-wrap items-center gap-2 py-2.5 text-sm">
                <span className="font-medium">{category.name}</span>
                {category.description ? (
                  <span className="text-muted-foreground">{category.description}</span>
                ) : null}
                <Badge variant="secondary">
                  {category.itemCount} item{category.itemCount === 1 ? '' : 's'}
                </Badge>
                {!category.isActive ? <Badge variant="secondary">Retired</Badge> : null}
                {canManage ? (
                  <div className="ml-auto flex gap-1">
                    <Button size="sm" variant="ghost" onClick={() => start(category)} disabled={busy}>
                      <Pencil className="mr-1.5 h-4 w-4" />
                      Edit
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => toggle(category)} disabled={busy}>
                      {category.isActive ? 'Retire' : 'Restore'}
                    </Button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? `Edit ${editing.name}` : 'New category'}</DialogTitle>
            <DialogDescription>
              Renaming updates every item in it, so nothing is left pointing at the old name.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Name</Label>
              <Input
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value.slice(0, 40) }))}
                placeholder="Vegetables"
              />
            </div>
            <div>
              <Label>Description (optional)</Label>
              <Textarea
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value.slice(0, 160) }))}
                rows={2}
                placeholder="Fresh produce bought daily from the market."
              />
            </div>
            <div>
              <Label>Sort order</Label>
              <Input
                type="number"
                value={form.sortOrder}
                onChange={(e) => setForm((f) => ({ ...f, sortOrder: e.target.value }))}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={save} disabled={busy || form.name.trim().length < 2}>
              {busy ? 'Saving…' : 'Save'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
