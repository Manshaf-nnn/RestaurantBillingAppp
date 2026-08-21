'use client'

import * as React from 'react'
import { Loader2, Plus, Trash2 } from 'lucide-react'
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

export interface FoodFormData {
  id?: string
}

interface OptionRow {
  id?: string
  name: string
  priceDelta: number
  isDefault: boolean
  isAvailable: boolean
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

interface RecipeRow {
  itemId: string
  name: string
  unit: string
  quantity: number
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
  recipe: RecipeRow[]
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
  recipe: [],
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
  inventoryItems,
  currency,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  foodId?: string
  categories: CategoryOption[]
  inventoryItems: Array<{ id: string; name: string; unit: string }>
  currency: string
}) {
  const [form, setForm] = React.useState<FormState>(EMPTY)
  const [loading, setLoading] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [errors, setErrors] = React.useState<Record<string, string>>({})

  React.useEffect(() => {
    if (!open) return
    setErrors({})

    if (!foodId) {
      setForm({ ...EMPTY, categoryId: categories[0]?.id ?? '' })
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
            })),
          })),
          recipe: data.recipe,
        })
      })
      .finally(() => setLoading(false))
  }, [open, foodId, categories, onOpenChange])

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
        options: [{ name: '', priceDelta: 0, isDefault: kind === 'VARIANT', isAvailable: true }],
      },
    ])

  const updateGroup = (index: number, patch: Partial<GroupRow>) =>
    set(
      'variantGroups',
      form.variantGroups.map((group, i) => (i === index ? { ...group, ...patch } : group)),
    )

  const removeGroup = (index: number) =>
    set('variantGroups', form.variantGroups.filter((_, i) => i !== index))

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
          })),
      })),
      recipe: form.recipe.map((line) => ({ itemId: line.itemId, quantity: line.quantity })),
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
              {inventoryItems.length ? (
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
                      {group.options.map((option, optionIndex) => (
                        <div key={optionIndex} className="flex items-center gap-2">
                          <Input
                            value={option.name}
                            onChange={(e) =>
                              updateGroup(groupIndex, {
                                options: group.options.map((o, i) =>
                                  i === optionIndex ? { ...o, name: e.target.value } : o,
                                ),
                              })
                            }
                            placeholder="Option name"
                          />
                          <Input
                            type="number"
                            value={option.priceDelta}
                            onChange={(e) =>
                              updateGroup(groupIndex, {
                                options: group.options.map((o, i) =>
                                  i === optionIndex ? { ...o, priceDelta: Number(e.target.value) } : o,
                                ),
                              })
                            }
                            placeholder="+0"
                            className="w-24"
                            title="Price difference"
                          />
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
                      ))}
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

            {/* ── recipe ──────────────────────────────────────────── */}
            {inventoryItems.length ? (
              <TabsContent value="recipe" className="space-y-3">
                <p className="text-xs text-muted-foreground">
                  Link ingredients so stock drops automatically when this item is cooked.
                </p>
                {form.recipe.map((line, index) => (
                  <div key={index} className="flex items-center gap-2">
                    <span className="flex-1 text-sm">
                      {line.name} <span className="text-muted-foreground">({line.unit})</span>
                    </span>
                    <Input
                      type="number"
                      step="any"
                      value={line.quantity}
                      onChange={(e) =>
                        set(
                          'recipe',
                          form.recipe.map((r, i) =>
                            i === index ? { ...r, quantity: Number(e.target.value) } : r,
                          ),
                        )
                      }
                      className="w-28"
                    />
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => set('recipe', form.recipe.filter((_, i) => i !== index))}
                      aria-label="Remove ingredient"
                    >
                      <Trash2 className="text-muted-foreground" />
                    </Button>
                  </div>
                ))}
                <Select
                  value=""
                  onValueChange={(itemId) => {
                    const item = inventoryItems.find((entry) => entry.id === itemId)
                    if (item && !form.recipe.some((line) => line.itemId === itemId)) {
                      set('recipe', [
                        ...form.recipe,
                        { itemId, name: item.name, unit: item.unit, quantity: 1 },
                      ])
                    }
                  }}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Add an ingredient…" />
                  </SelectTrigger>
                  <SelectContent>
                    {inventoryItems
                      .filter((item) => !form.recipe.some((line) => line.itemId === item.id))
                      .map((item) => (
                        <SelectItem key={item.id} value={item.id}>
                          {item.name} ({item.unit})
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
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
