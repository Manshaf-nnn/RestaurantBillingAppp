'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, Plus, Trash2, ChevronDown, ChevronUp } from 'lucide-react'
import { toast } from 'sonner'

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
import { Field } from '@/components/ui/label'
import { Input, Textarea } from '@/components/ui/input'
import { ImageUpload } from '@/components/image-upload'
import {
  Checkbox,
  Separator,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui/primitives'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { parseMoney } from '@/lib/money'
import { cn } from '@/lib/utils'
import { saveFood } from '../actions'
import { fetchFoodForEdit } from '../actions-fetch'
import type { CategoryOption } from './menu-manager'
import { callAction } from '@/lib/use-action'
import { roundPercent } from '@/lib/quantity'

export interface FoodFormData {
  id?: string
}

interface OptionRow {
  id?: string
  name: string
  priceDelta: number
  isDefault: boolean
  isAvailable: boolean
  /** Recipe this option consumes — how "extra chicken" reaches the ledger. */
  recipeId?: string | null
}

interface GroupRow {
  id?: string
  name: string
  kind: 'VARIANT' | 'ADDON'
  isRequired: boolean
  minSelect: number
  maxSelect: number
  options: OptionRow[]
}

interface FormState {
  categoryId: string
  name: string
  description: string
  imageUrl: string
  price: string
  discountPrice: string
  costPrice: string
  prepTimeMinutes: string
  calories: string
  isVeg: boolean
  spiceLevel: 'NONE' | 'MILD' | 'MEDIUM' | 'HOT' | 'EXTRA_HOT'
  isAvailable: boolean
  isRecommended: boolean
  isPopular: boolean
  tags: string
  allergens: string
  happyHourPrice: string
  happyHourStart: string
  happyHourEnd: string
  happyHourDays: number[]
  variantGroups: GroupRow[]
  /** Which locations sell this dish, and what each charges. */
  branches: BranchRow[]
}

export interface BranchRow {
  branchId: string
  /** Blank means "same as the price above" — nothing is copied. */
  price: string
  isAvailable: boolean
  /** Which kitchen section cooks it here. Blank = not decided yet. */
  stationId: string
  /** Bottled water and the like: never enters the kitchen at all. */
  noKitchenRequired: boolean
}

export interface StationOption {
  id: string
  name: string
  branchId: string
}

export interface BranchOption {
  id: string
  name: string
  type: string
}

const EMPTY: FormState = {
  categoryId: '',
  name: '',
  description: '',
  imageUrl: '',
  price: '',
  discountPrice: '',
  costPrice: '',
  prepTimeMinutes: '15',
  calories: '',
  isVeg: false,
  spiceLevel: 'NONE',
  isAvailable: true,
  isRecommended: false,
  isPopular: false,
  tags: '',
  allergens: '',
  happyHourPrice: '',
  happyHourStart: '',
  happyHourEnd: '',
  happyHourDays: [],
  variantGroups: [],
  branches: [],
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function timeToMinutes(value: string): number | null {
  if (!value) return null
  const [h, m] = value.split(':').map(Number)
  return h * 60 + (m || 0)
}

function minutesToTime(value: number | null): string {
  if (value === null) return ''
  return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`
}

export function FoodDialog({
  open,
  onOpenChange,
  foodId,
  categories,
  stations = [],
  recipes = [],
  currency,
  branches = [],
  activeBranchId = null,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  foodId?: string
  categories: CategoryOption[]
  /** Kitchen sections, across every branch. Empty when nobody uses them. */
  stations?: StationOption[]
  /** Recipes an option may consume. Empty hides the picker entirely. */
  recipes?: Array<{ id: string; name: string }>
  currency: string
  /** Locations this dish may be sold at. Empty for a single-site restaurant. */
  branches?: BranchOption[]
  /**
   * The location being worked in. A NEW dish starts ticked here and nowhere
   * else — nothing spreads by itself, which is the whole point.
   */
  activeBranchId?: string | null
}) {
  const [form, setForm] = React.useState<FormState>(EMPTY)
  const [loading, setLoading] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [errors, setErrors] = React.useState<Record<string, string>>({})
  const router = useRouter()

  React.useEffect(() => {
    if (!open) return
    setErrors({})

    if (!foodId) {
      /*
       * A new dish starts at the location being worked in, and nowhere else.
       * With no location chosen — an owner on "All locations" — nothing is
       * ticked and they choose deliberately, which is the behaviour that stops
       * a Main Branch dish appearing at Kandy on its own.
       */
      /*
       * A new dish starts at the location being worked in, and nowhere else.
       * With no location chosen — an owner on "All locations" — nothing is
       * ticked and they choose deliberately, which is the behaviour that stops
       * a Main Branch dish appearing at Kandy on its own.
       *
       * The exception is a restaurant with ONE location: there is no choice to
       * make, saving already falls back to the default branch, and leaving the
       * list empty meant the form had nowhere to put a kitchen section.
       */
      const startsAt = activeBranchId ?? (branches.length === 1 ? branches[0].id : null)
      setForm({
        ...EMPTY,
        categoryId: categories[0]?.id ?? '',
        branches: startsAt
          ? [
              {
                branchId: startsAt,
                price: '',
                isAvailable: true,
                stationId: '',
                noKitchenRequired: false,
              },
            ]
          : [],
      })
      return
    }

    setLoading(true)
    fetchFoodForEdit(foodId)
      .then((result) => {
        if (!result.ok) {
          toast.error(result.error)
          onOpenChange(false)
          return
        }
        const data = result.data
        setForm({
          categoryId: data.categoryId,
          name: data.name,
          description: data.description,
          imageUrl: data.imageUrl,
          price: String(data.price),
          discountPrice: data.discountPrice !== null ? String(data.discountPrice) : '',
          costPrice: String(data.costPrice),
          prepTimeMinutes: String(data.prepTimeMinutes),
          calories: data.calories !== null ? String(data.calories) : '',
          isVeg: data.isVeg,
          spiceLevel: data.spiceLevel,
          isAvailable: data.isAvailable,
          isRecommended: data.isRecommended,
          isPopular: data.isPopular,
          tags: data.tags.join(', '),
          allergens: data.allergens.join(', '),
          branches: data.branches.map((row) => ({
            branchId: row.branchId,
            price: row.price !== null ? String(row.price) : '',
            isAvailable: row.isAvailable,
            stationId: row.stationId ?? '',
            noKitchenRequired: row.noKitchenRequired,
          })),
          happyHourPrice: data.happyHourPrice !== null ? String(data.happyHourPrice) : '',
          happyHourStart: minutesToTime(data.happyHourStartMin),
          happyHourEnd: minutesToTime(data.happyHourEndMin),
          happyHourDays: data.happyHourDays,
          variantGroups: data.variantGroups.map((group) => ({
            id: group.id,
            name: group.name,
            kind: group.kind,
            isRequired: group.isRequired,
            minSelect: group.minSelect,
            maxSelect: group.maxSelect,
            options: group.options.map((option) => ({
              id: option.id,
              name: option.name,
              priceDelta: option.priceDelta,
              isDefault: option.isDefault,
              isAvailable: option.isAvailable,
              recipeId: option.recipeId ?? null,
            })),
          })),
        })
      })
      .finally(() => setLoading(false))
  }, [open, foodId, categories, branches, activeBranchId, onOpenChange])

  /** Sections at one branch. Empty when that branch does not use them. */
  const stationsAt = React.useCallback(
    (branchId: string) => stations.filter((station) => station.branchId === branchId),
    [stations],
  )

  /*
   * The one location this dish is sold at, when there is exactly one.
   *
   * That covers both the single-location restaurant and the common "this dish
   * is only at Main" case, and it is what lets the Details tab hold a single
   * kitchen-section field instead of sending everybody to a per-location grid
   * to answer one question.
   */
  const soleBranch = form.branches.length === 1 ? form.branches[0].branchId : null
  const soleRow = soleBranch ? form.branches[0] : null
  const soleStationId = soleRow?.stationId ?? ''
  const soleNoKitchen = soleRow?.noKitchenRequired ?? false

  const setSoleStation = (value: string) =>
    setForm((current) => ({
      ...current,
      branches: current.branches.map((row) =>
        row.branchId === soleBranch
          ? {
              ...row,
              noKitchenRequired: value === 'none',
              stationId: value === 'none' || value === 'unset' ? '' : value,
            }
          : row,
      ),
    }))

  /** What is set where, for a dish sold at more than one location. */
  const sectionSummary = React.useMemo(() => {
    const parts = form.branches.map((row) => {
      const branchName = branches.find((b) => b.id === row.branchId)?.name ?? 'a location'
      if (row.noKitchenRequired) return `no kitchen at ${branchName}`
      const station = stations.find((s) => s.id === row.stationId)
      return station ? `${station.name} at ${branchName}` : `nothing set at ${branchName}`
    })
    return parts.join(' · ')
  }, [form.branches, branches, stations])

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((current) => ({ ...current, [key]: value }))

  const addGroup = (kind: 'VARIANT' | 'ADDON') =>
    set('variantGroups', [
      ...form.variantGroups,
      {
        name: kind === 'VARIANT' ? 'Size' : 'Add-ons',
        kind,
        isRequired: kind === 'VARIANT',
        minSelect: kind === 'VARIANT' ? 1 : 0,
        maxSelect: kind === 'VARIANT' ? 1 : 5,
        options: [{ name: '', priceDelta: 0, isDefault: kind === 'VARIANT', isAvailable: true, recipeId: null }],
      },
    ])

  const updateGroup = (index: number, patch: Partial<GroupRow>) =>
    set(
      'variantGroups',
      form.variantGroups.map((group, i) => (i === index ? { ...group, ...patch } : group)),
    )

  const removeGroup = (index: number) =>
    set('variantGroups', form.variantGroups.filter((_, i) => i !== index))

  /**
   * The dish's own price, as a number, for converting sizes to real prices.
   *
   * Read live from the Pricing tab rather than captured once: raising the base
   * has to move every size in front of the owner, not silently behind them.
   */
  const basePrice = Number(form.price) || 0

  /**
   * Move a row up or down.
   *
   * `sortOrder` is derived from array position at save, so reordering is
   * reordering the array and nothing else. Buttons rather than drag: no new
   * dependency, and it works from a keyboard, which drag does not.
   */
  const moveGroup = (index: number, by: -1 | 1) =>
    set('variantGroups', swap(form.variantGroups, index, index + by))

  const moveOption = (groupIndex: number, index: number, by: -1 | 1) =>
    updateGroup(groupIndex, {
      options: swap(form.variantGroups[groupIndex].options, index, index + by),
    })

  /**
   * Which option is pre-selected for the guest.
   *
   * Exactly one per single-choice group, so picking a new default clears the
   * old one — two defaults on a radio group is a state the guest sheet cannot
   * render. `isDefault` used to be set only on the first option of a brand-new
   * group and hard-coded false for every one added after, so "Normal" could not
   * be made the default once the dish had been saved.
   */
  const setDefaultOption = (groupIndex: number, optionIndex: number) =>
    updateGroup(groupIndex, {
      options: form.variantGroups[groupIndex].options.map((option, i) => ({
        ...option,
        isDefault: i === optionIndex,
      })),
    })

  const setOptionField = (groupIndex: number, optionIndex: number, patch: Partial<OptionRow>) =>
    updateGroup(groupIndex, {
      options: form.variantGroups[groupIndex].options.map((option, i) =>
        i === optionIndex ? { ...option, ...patch } : option,
      ),
    })

  const save = async () => {
    setErrors({})
    const nextErrors: Record<string, string> = {}
    if (!form.name.trim()) nextErrors.name = 'Name is required'
    if (!form.categoryId) nextErrors.categoryId = 'Choose a category'
    if (!form.price || Number(form.price) <= 0) nextErrors.price = 'Enter a price'
    if (Object.keys(nextErrors).length) {
      setErrors(nextErrors)
      return
    }

    setSaving(true)
    const payload = {
      id: foodId,
      categoryId: form.categoryId,
      name: form.name.trim(),
      description: form.description.trim(),
      imageUrl: form.imageUrl.trim(),
      price: parseMoney(form.price, currency),
      discountPrice: form.discountPrice ? parseMoney(form.discountPrice, currency) : null,
      costPrice: form.costPrice ? parseMoney(form.costPrice, currency) : 0,
      prepTimeMinutes: Number(form.prepTimeMinutes) || 15,
      calories: form.calories ? Number(form.calories) : null,
      isVeg: form.isVeg,
      spiceLevel: form.spiceLevel,
      isAvailable: form.isAvailable,
      isRecommended: form.isRecommended,
      isPopular: form.isPopular,
      tags: form.tags.split(',').map((tag) => tag.trim()).filter(Boolean),
      allergens: form.allergens.split(',').map((tag) => tag.trim()).filter(Boolean),
      happyHourPrice: form.happyHourPrice ? parseMoney(form.happyHourPrice, currency) : null,
      happyHourStartMin: timeToMinutes(form.happyHourStart),
      happyHourEndMin: timeToMinutes(form.happyHourEnd),
      happyHourDays: form.happyHourDays,
      variantGroups: form.variantGroups.map((group, index) => ({
        id: group.id,
        name: group.name.trim(),
        kind: group.kind,
        isRequired: group.isRequired,
        minSelect: group.minSelect,
        maxSelect: group.maxSelect,
        sortOrder: index,
        options: group.options
          .filter((option) => option.name.trim())
          .map((option, optionIndex) => ({
            id: option.id,
            name: option.name.trim(),
            priceDelta: parseMoney(String(option.priceDelta), currency),
            isDefault: option.isDefault,
            isAvailable: option.isAvailable,
            sortOrder: optionIndex,
            recipeId: option.recipeId ?? null,
          })),
      })),
      branches: form.branches.map((row) => ({
        branchId: row.branchId,
        // Blank stays null: the branch inherits, and a later change to the
        // base price still reaches it.
        price: row.price.trim() ? parseMoney(row.price, currency) : null,
        isAvailable: row.isAvailable,
        stationId: row.stationId || null,
        noKitchenRequired: row.noKitchenRequired,
      })),
    }

    const result = await callAction(() => saveFood(payload))
    setSaving(false)

    if (!result.ok) {
      if (result.fieldErrors) {
        setErrors(
          Object.fromEntries(
            Object.entries(result.fieldErrors).map(([key, messages]) => [key, messages[0]]),
          ),
        )
      }
      toast.error(result.error)
      return
    }

    toast.success('Menu item saved')
    /*
     * Refreshed explicitly, on its own request.
     *
     * This dialog used to close and rely on the action's own re-render to
     * repaint the list behind it. That mechanism has already failed here in
     * production once — re-rendering a page this heavy inside the action's POST
     * blew the serverless budget and the caller saw "that did not work" with
     * the record already written (`features/branches/actions.ts:43-49`). An
     * explicit refresh runs on its own budget, and the owner sees their dish
     * immediately rather than waiting for the next pulse.
     */
    router.refresh()
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="xl" className="max-h-[92vh]">
        <DialogHeader>
          <DialogTitle>{foodId ? 'Edit menu item' : 'New menu item'}</DialogTitle>
          <DialogDescription>
            Prices are in {currency}. Everything here shows on the guest menu instantly.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <Tabs defaultValue="details">
            <TabsList className="w-full">
              <TabsTrigger value="details" className="flex-1">
                Details
              </TabsTrigger>
              <TabsTrigger value="options" className="flex-1">
                Options
                {form.variantGroups.length ? (
                  <Badge size="sm" variant="secondary">
                    {form.variantGroups.length}
                  </Badge>
                ) : null}
              </TabsTrigger>
              <TabsTrigger value="pricing" className="flex-1">
                Pricing
              </TabsTrigger>
              {/*
                Worth a tab when there is more than one location, OR when the
                kitchen has sections — because then it holds which section cooks
                this dish at each place.

                This condition and the panel's own used to disagree: the panel
                allowed sections, the button did not, so on a single-location
                restaurant the section picker existed and could not be reached
                by any means at all.
              */}
              {branches.length > 1 || stations.length > 0 ? (
                <TabsTrigger value="branches" className="flex-1">
                  {stations.length > 0 && branches.length <= 1 ? 'Kitchen' : 'Locations'}
                  <span className="ml-1.5 rounded bg-muted px-1 text-[10px] tabular-nums">
                    {form.branches.length}
                  </span>
                </TabsTrigger>
              ) : null}
              {foodId ? (
                <TabsTrigger value="recipe" className="flex-1">
                  Recipe
                </TabsTrigger>
              ) : null}
            </TabsList>

            {/* ── details ─────────────────────────────────────────── */}
            <TabsContent value="details" className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Name" required error={errors.name} className="sm:col-span-2">
                  <Input value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="Margherita Pizza" />
                </Field>

                <Field label="Category" required error={errors.categoryId}>
                  <Select value={form.categoryId} onValueChange={(value) => set('categoryId', value)}>
                    <SelectTrigger>
                      <SelectValue placeholder="Choose" />
                    </SelectTrigger>
                    <SelectContent>
                      {categories.map((entry) => (
                        <SelectItem key={entry.id} value={entry.id}>
                          {entry.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>

                <Field label="Spice level">
                  <Select value={form.spiceLevel} onValueChange={(value) => set('spiceLevel', value as FormState['spiceLevel'])}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {['NONE', 'MILD', 'MEDIUM', 'HOT', 'EXTRA_HOT'].map((level) => (
                        <SelectItem key={level} value={level}>
                          {level.replace('_', ' ').toLowerCase()}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>

                {/*
                  Which section of the kitchen cooks it.
                  Here, beside the category, and not only on the Locations tab:
                  this is the question asked while a dish is being written, and
                  a dish with no section is what stops the kitchen accepting the
                  order it lands on.

                  Sections belong to ONE location, so a dish sold at several
                  genuinely needs a different section at each and no single
                  value can express it. That case shows what is set and sends
                  you to the per-location pickers; the ordinary case — one
                  location — is answered right here.
                */}
                {stations.length > 0 && soleBranch ? (
                  <Field
                    label="Kitchen section"
                    className="sm:col-span-2"
                    hint={
                      soleStationId || soleNoKitchen
                        ? undefined
                        : 'Until this is set, the kitchen cannot accept an order containing this dish.'
                    }
                  >
                    <Select
                      value={soleNoKitchen ? 'none' : soleStationId || 'unset'}
                      onValueChange={(value) => setSoleStation(value)}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="unset">Not decided yet</SelectItem>
                        {stationsAt(soleBranch).map((station) => (
                          <SelectItem key={station.id} value={station.id}>
                            {station.name}
                          </SelectItem>
                        ))}
                        <SelectItem value="none">Needs no kitchen</SelectItem>
                      </SelectContent>
                    </Select>
                  </Field>
                ) : null}

                {stations.length > 0 && !soleBranch && form.branches.length > 1 ? (
                  <Field label="Kitchen section" className="sm:col-span-2">
                    <p className="rounded-lg border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
                      {sectionSummary}{' '}
                      <span className="text-foreground">
                        Set it per location on the Locations tab.
                      </span>
                    </p>
                  </Field>
                ) : null}
              </div>

              <Field label="Description">
                <Textarea
                  value={form.description}
                  onChange={(e) => set('description', e.target.value)}
                  placeholder="A short, appetising description"
                  rows={2}
                />
              </Field>

              <Field label="Photo" hint="Upload from your device, or paste an image URL">
                <ImageUpload value={form.imageUrl} onChange={(url) => set('imageUrl', url)} />
              </Field>

              <div className="grid gap-4 sm:grid-cols-3">
                <Field label="Prep time (min)">
                  <Input type="number" value={form.prepTimeMinutes} onChange={(e) => set('prepTimeMinutes', e.target.value)} />
                </Field>
                <Field label="Calories">
                  <Input type="number" value={form.calories} onChange={(e) => set('calories', e.target.value)} placeholder="—" />
                </Field>
                <Field label="Tags" hint="Comma separated">
                  <Input value={form.tags} onChange={(e) => set('tags', e.target.value)} placeholder="bestseller, new" />
                </Field>
              </div>

              <Field label="Allergens" hint="Comma separated">
                <Input value={form.allergens} onChange={(e) => set('allergens', e.target.value)} placeholder="nuts, dairy" />
              </Field>

              <div className="flex flex-wrap gap-4 rounded-lg border p-3">
                <Toggle label="Vegetarian" checked={form.isVeg} onChange={(v) => set('isVeg', v)} />
                <Toggle label="Available" checked={form.isAvailable} onChange={(v) => set('isAvailable', v)} />
                <Toggle label="Popular" checked={form.isPopular} onChange={(v) => set('isPopular', v)} />
                <Toggle label="Recommended" checked={form.isRecommended} onChange={(v) => set('isRecommended', v)} />
              </div>
            </TabsContent>

            {/* ── options ─────────────────────────────────────────── */}
            <TabsContent value="options" className="space-y-4">
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={() => addGroup('VARIANT')}>
                  <Plus /> Variant group
                </Button>
                <Button variant="outline" size="sm" onClick={() => addGroup('ADDON')}>
                  <Plus /> Add-on group
                </Button>
              </div>

              {form.variantGroups.length === 0 ? (
                <p className="rounded-lg border border-dashed py-8 text-center text-sm text-muted-foreground">
                  No options yet. Variants are single-choice (e.g. size); add-ons are multi-choice
                  (e.g. extra toppings).
                </p>
              ) : (
                form.variantGroups.map((group, groupIndex) => (
                  <div key={groupIndex} className="rounded-lg border p-3">
                    <div className="flex items-center gap-2">
                      <Input
                        value={group.name}
                        onChange={(e) => updateGroup(groupIndex, { name: e.target.value })}
                        placeholder="Group name"
                        className="max-w-[200px]"
                      />
                      <Badge variant={group.kind === 'VARIANT' ? 'info' : 'secondary'}>
                        {group.kind === 'VARIANT' ? 'Single choice' : 'Multi choice'}
                      </Badge>
                      <label className="ml-auto flex items-center gap-1.5 text-xs">
                        <Checkbox
                          checked={group.isRequired}
                          onCheckedChange={(v) =>
                            updateGroup(groupIndex, { isRequired: Boolean(v), minSelect: v ? 1 : 0 })
                          }
                        />
                        Required
                      </label>
                      {group.kind === 'ADDON' ? (
                        <label className="flex items-center gap-1.5 text-xs">
                          Max
                          <Input
                            type="number"
                            value={group.maxSelect}
                            onChange={(e) =>
                              updateGroup(groupIndex, { maxSelect: Number(e.target.value) || 1 })
                            }
                            className="h-8 w-16"
                          />
                        </label>
                      ) : null}
                      <div className="flex shrink-0">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          disabled={groupIndex === 0}
                          onClick={() => moveGroup(groupIndex, -1)}
                          aria-label="Move group up"
                        >
                          <ChevronUp />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          disabled={groupIndex === form.variantGroups.length - 1}
                          onClick={() => moveGroup(groupIndex, 1)}
                          aria-label="Move group down"
                        >
                          <ChevronDown />
                        </Button>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => removeGroup(groupIndex)}
                        aria-label="Remove group"
                      >
                        <Trash2 className="text-destructive" />
                      </Button>
                    </div>

                    <Separator className="my-3" />

                    <div className="space-y-2">
                      {/*
                        Column labels, because a bare row of inputs gives no
                        clue what the number means or what the round button and
                        the tick do.
                      */}
                      <div className="flex items-center gap-2 pb-1 text-[11px] uppercase tracking-wide text-muted-foreground">
                        {group.kind === 'VARIANT' && group.maxSelect <= 1 ? (
                          <span className="w-4 shrink-0" title="Pre-selected">•</span>
                        ) : null}
                        <span className="flex-1">Option</span>
                        <span className="w-28">
                          {group.kind === 'VARIANT' && group.maxSelect <= 1 ? 'Price' : 'Adds'}
                        </span>
                        <span className="w-6 shrink-0" title="On sale">On</span>
                        <span className="w-[5.5rem] shrink-0" />
                      </div>

                      {group.options.map((option, optionIndex) => {
                        const asPrice = group.kind === 'VARIANT' && group.maxSelect <= 1
                        return (
                        <div key={optionIndex} className="flex items-center gap-2">
                          {/*
                            Which one is ticked when the guest opens the sheet.
                            Only meaningful for a single-choice group — an
                            add-on group has no "the" default.
                          */}
                          {asPrice ? (
                            <button
                              type="button"
                              onClick={() => setDefaultOption(groupIndex, optionIndex)}
                              aria-label={`Make ${option.name || 'this option'} the default`}
                              title="Pre-selected for the guest"
                              className={`flex size-4 shrink-0 items-center justify-center rounded-full border ${
                                option.isDefault ? 'border-primary bg-primary' : 'border-input'
                              }`}
                            >
                              {option.isDefault ? (
                                <span className="size-1.5 rounded-full bg-primary-foreground" />
                              ) : null}
                            </button>
                          ) : null}

                          <Input
                            value={option.name}
                            onChange={(e) =>
                              setOptionField(groupIndex, optionIndex, { name: e.target.value })
                            }
                            placeholder="Option name"
                          />

                          {/*
                            The PRICE, not the difference.

                            This was a bare number meaning "+550 on top of the
                            dish". An owner asked what a full portion costs
                            should not have to add two numbers together, and the
                            spec writes it the way people say it: Full — 1400.
                            The difference is still what gets stored, so a rise
                            in the dish's price carries every size with it —
                            `variant-pricing.ts` owns the conversion.
                          */}
                          <Input
                            type="number"
                            value={asPrice ? roundPercent(basePrice + option.priceDelta) : option.priceDelta}
                            onChange={(e) =>
                              setOptionField(groupIndex, optionIndex, {
                                priceDelta: asPrice
                                  ? roundPercent(Number(e.target.value) - basePrice)
                                  : Number(e.target.value),
                              })
                            }
                            className="w-28"
                            title={asPrice ? `What this size costs (${currency})` : `Added to the price (${currency})`}
                          />

                          {/*
                            What this choice takes from stock. Optional and
                            usually blank — "no onions" moves nothing — but
                            "extra chicken" without this consumed and cost
                            nothing at all, on every plate, silently.
                          */}
                          {recipes.length > 0 ? (
                            <select
                              className="h-9 w-32 shrink-0 rounded-md border bg-background px-2 text-xs"
                              value={option.recipeId ?? ''}
                              title="Recipe this option consumes from stock"
                              onChange={(e) =>
                                setOptionField(groupIndex, optionIndex, {
                                  recipeId: e.target.value || null,
                                })
                              }
                            >
                              <option value="">No stock used</option>
                              {recipes.map((recipe) => (
                                <option key={recipe.id} value={recipe.id}>
                                  {recipe.name}
                                </option>
                              ))}
                            </select>
                          ) : null}

                          {/* 86 a size without deleting it. */}
                          <label className="flex shrink-0 items-center gap-1 text-xs" title="On sale">
                            <Checkbox
                              checked={option.isAvailable}
                              onCheckedChange={(v) =>
                                setOptionField(groupIndex, optionIndex, { isAvailable: Boolean(v) })
                              }
                            />
                          </label>

                          <div className="flex shrink-0">
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              disabled={optionIndex === 0}
                              onClick={() => moveOption(groupIndex, optionIndex, -1)}
                              aria-label="Move option up"
                            >
                              <ChevronUp />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              disabled={optionIndex === group.options.length - 1}
                              onClick={() => moveOption(groupIndex, optionIndex, 1)}
                              aria-label="Move option down"
                            >
                              <ChevronDown />
                            </Button>
                          </div>

                          <Button
                            variant="ghost"
                            size="icon-sm"
                            onClick={() =>
                              updateGroup(groupIndex, {
                                options: group.options.filter((_, i) => i !== optionIndex),
                              })
                            }
                            aria-label="Remove option"
                          >
                            <Trash2 className="text-muted-foreground" />
                          </Button>
                        </div>
                        )
                      })}
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          updateGroup(groupIndex, {
                            options: [
                              ...group.options,
                              { name: '', priceDelta: 0, isDefault: false, isAvailable: true },
                            ],
                          })
                        }
                      >
                        <Plus /> Add option
                      </Button>
                    </div>
                  </div>
                ))
              )}
            </TabsContent>

            {/* ── pricing ─────────────────────────────────────────── */}
            <TabsContent value="pricing" className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-3">
                <Field label={`Price (${currency})`} required error={errors.price}>
                  <Input type="number" value={form.price} onChange={(e) => set('price', e.target.value)} placeholder="0.00" />
                </Field>
                <Field label="Offer price" hint="Optional; must be lower">
                  <Input type="number" value={form.discountPrice} onChange={(e) => set('discountPrice', e.target.value)} placeholder="—" />
                </Field>
                <Field label="Cost price" hint="For profit reports">
                  <Input type="number" value={form.costPrice} onChange={(e) => set('costPrice', e.target.value)} placeholder="0.00" />
                </Field>
              </div>

              <Separator />

              <div>
                <p className="mb-1 text-sm font-semibold">Happy hour pricing</p>
                <p className="mb-3 text-xs text-muted-foreground">
                  A lower price during set hours. Leave the price blank to disable.
                </p>
                <div className="grid gap-4 sm:grid-cols-3">
                  <Field label="Happy hour price">
                    <Input type="number" value={form.happyHourPrice} onChange={(e) => set('happyHourPrice', e.target.value)} placeholder="—" />
                  </Field>
                  <Field label="From">
                    <Input type="time" value={form.happyHourStart} onChange={(e) => set('happyHourStart', e.target.value)} />
                  </Field>
                  <Field label="To">
                    <Input type="time" value={form.happyHourEnd} onChange={(e) => set('happyHourEnd', e.target.value)} />
                  </Field>
                </div>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {DAYS.map((day, index) => (
                    <button
                      key={day}
                      type="button"
                      onClick={() =>
                        set(
                          'happyHourDays',
                          form.happyHourDays.includes(index)
                            ? form.happyHourDays.filter((d) => d !== index)
                            : [...form.happyHourDays, index],
                        )
                      }
                      className={cn(
                        'rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors',
                        form.happyHourDays.includes(index)
                          ? 'border-primary bg-primary text-primary-foreground'
                          : 'hover:bg-muted',
                      )}
                    >
                      {day}
                    </button>
                  ))}
                  <span className="self-center text-xs text-muted-foreground">
                    {form.happyHourDays.length === 0 ? 'All days' : ''}
                  </span>
                </div>
              </div>
            </TabsContent>

            {/* ── which locations sell it ─────────────────────────── */}
            {branches.length > 1 || stations.length > 0 ? (
              <TabsContent value="branches" className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  Tick a location to put this on its menu. Each keeps its own price and can take it
                  off without affecting anyone else.
                </p>

                <ul className="space-y-2">
                  {branches.map((branch) => {
                    const row = form.branches.find((b) => b.branchId === branch.id)
                    const on = Boolean(row)
                    return (
                      <li
                        key={branch.id}
                        className={`rounded-lg border p-3 transition ${
                          on ? 'border-primary/40 bg-primary/5' : 'border-border'
                        }`}
                      >
                        <div className="flex flex-wrap items-center gap-3">
                          <label className="flex flex-1 items-center gap-2.5 text-sm font-medium">
                            <input
                              type="checkbox"
                              className="size-4 accent-[hsl(var(--primary))]"
                              checked={on}
                              onChange={(event) =>
                                setForm((current) => ({
                                  ...current,
                                  branches: event.target.checked
                                    ? [
                                        ...current.branches,
                                        {
                                          branchId: branch.id,
                                          price: '',
                                          isAvailable: true,
                                          stationId: '',
                                          noKitchenRequired: false,
                                        },
                                      ]
                                    : current.branches.filter((b) => b.branchId !== branch.id),
                                }))
                              }
                            />
                            {branch.name}
                            {branch.type !== 'BRANCH' ? (
                              <span className="text-xs font-normal text-muted-foreground">
                                {branch.type.replace(/_/g, ' ').toLowerCase()}
                              </span>
                            ) : null}
                          </label>

                          {on ? (
                            <>
                              <div className="w-32">
                                <Input
                                  inputMode="decimal"
                                  placeholder={form.price || 'Same price'}
                                  value={row?.price ?? ''}
                                  onChange={(event) =>
                                    setForm((current) => ({
                                      ...current,
                                      branches: current.branches.map((b) =>
                                        b.branchId === branch.id
                                          ? { ...b, price: event.target.value }
                                          : b,
                                      ),
                                    }))
                                  }
                                />
                              </div>
                              <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                                <input
                                  type="checkbox"
                                  className="size-3.5 accent-[hsl(var(--primary))]"
                                  checked={row?.isAvailable ?? true}
                                  onChange={(event) =>
                                    setForm((current) => ({
                                      ...current,
                                      branches: current.branches.map((b) =>
                                        b.branchId === branch.id
                                          ? { ...b, isAvailable: event.target.checked }
                                          : b,
                                      ),
                                    }))
                                  }
                                />
                                On sale
                              </label>
                            </>
                          ) : null}
                        </div>

                        {/*
                          Which section of this branch's kitchen cooks it.
                          Shown only where sections actually exist, so a
                          restaurant that does not use them never sees the
                          question — and an unmapped dish is what stops the
                          kitchen accepting an order, so the empty option says
                          so rather than reading as a harmless blank.
                        */}
                        {on && stationsAt(branch.id).length > 0 ? (
                          <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-border pt-2">
                            <span className="text-xs text-muted-foreground">Cooked at</span>
                            <select
                              className="h-9 rounded-lg border border-input bg-background px-2 text-sm"
                              value={row?.noKitchenRequired ? 'none' : row?.stationId ?? ''}
                              onChange={(event) =>
                                setForm((current) => ({
                                  ...current,
                                  branches: current.branches.map((b) =>
                                    b.branchId === branch.id
                                      ? {
                                          ...b,
                                          noKitchenRequired: event.target.value === 'none',
                                          stationId:
                                            event.target.value === 'none' ? '' : event.target.value,
                                        }
                                      : b,
                                  ),
                                }))
                              }
                            >
                              <option value="">Not decided — blocks the kitchen</option>
                              {stationsAt(branch.id).map((station) => (
                                <option key={station.id} value={station.id}>
                                  {station.name}
                                </option>
                              ))}
                              <option value="none">Needs no kitchen</option>
                            </select>
                            {!row?.noKitchenRequired && !row?.stationId ? (
                              <span className="text-xs text-warning">
                                The kitchen cannot accept an order with this on it
                              </span>
                            ) : null}
                          </div>
                        ) : null}
                      </li>
                    )
                  })}
                </ul>

                <div className="space-y-2 border-l-2 border-border pl-3 text-xs leading-relaxed text-muted-foreground">
                  <p>
                    Leave a price blank and that location charges the price on the Details tab.
                    Change it there later and every blank location follows — only the ones you have
                    typed a number into stay put.
                  </p>
                  <p>
                    <strong>On sale</strong> is for &ldquo;we have run out today&rdquo;. Unticking
                    the location entirely takes it off their menu.
                  </p>
                  {form.branches.length === 0 ? (
                    <p className="text-amber-600 dark:text-amber-400">
                      No location is selected, so this dish will not appear on any menu.
                    </p>
                  ) : null}
                </div>
              </TabsContent>
            ) : null}

            {/* ── recipe ──────────────────────────────────────────── */}
            {foodId ? (
              <TabsContent value="recipe" className="space-y-3">
                {/*
                  This tab used to be a second ingredient editor, writing a flat
                  table the depletion resolver ignored whenever the dish also had
                  a recipe on the Recipes screen. Ingredients typed here saved
                  and then did nothing. One screen owns a dish's ingredients now,
                  and this points at it rather than competing with it.
                */}
                <p className="text-sm text-muted-foreground">
                  Ingredients live on the Recipes screen, where you also see what
                  the dish costs you and what it earns.
                </p>
                <Button variant="outline" onClick={() => router.push(`/dashboard/recipes/${foodId}`)}>
                  Open this dish&rsquo;s recipe
                </Button>
              </TabsContent>
            ) : null}
          </Tabs>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={save} loading={saving} disabled={loading}>
            {foodId ? 'Save changes' : 'Create item'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string
  checked: boolean
  onChange: (value: boolean) => void
}) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <Switch checked={checked} onCheckedChange={onChange} />
      {label}
    </label>
  )
}

/** Two rows swapped, or the same array when the move would fall off an end. */
function swap<T>(rows: T[], from: number, to: number): T[] {
  if (to < 0 || to >= rows.length) return rows
  const next = [...rows]
  ;[next[from], next[to]] = [next[to], next[from]]
  return next
}

/**
 * Money, to two places.
 *
 * Converting a price to a difference and back drifts in floating point —
 * 1400 − 850 lands on 550.0000000000001 often enough to show up in an input
 * box. The value is major units at this point; `parseMoney` turns it into
 * minor units on save.
 */
