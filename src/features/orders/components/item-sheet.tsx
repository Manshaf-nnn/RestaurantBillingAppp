'use client'

import * as React from 'react'
import Image from 'next/image'
import { Flame, Leaf, Minus, Plus, Timer } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogTitle, SheetContent } from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/input'
import { Checkbox, RadioGroup, RadioGroupItem, Separator } from '@/components/ui/primitives'
import { SpiceLevelIndicator, VegIndicator } from '@/components/ui/status'
import { formatMoney } from '@/lib/money'
import { cn } from '@/lib/utils'
import type { PublicMenuItem } from '@/features/menu/queries'
import { SPICE_LABELS } from '../pricing'
import { useCart, type CartOption } from '../cart-store'

interface ItemSheetProps {
  item: PublicMenuItem | null
  currency: string
  locale: string
  onOpenChange: (open: boolean) => void
}

/**
 * Item detail sheet: variants, add-ons, quantity and a note for the kitchen.
 * Required option groups gate the add-to-cart button, matching server rules.
 */
export function ItemSheet({ item, currency, locale, onOpenChange }: ItemSheetProps) {
  const { addItem } = useCart()
  const [quantity, setQuantity] = React.useState(1)
  const [notes, setNotes] = React.useState('')
  const [selected, setSelected] = React.useState<Record<string, string[]>>({})

  // Reset and preselect defaults whenever a new item opens.
  React.useEffect(() => {
    if (!item) return
    setQuantity(1)
    setNotes('')
    const defaults: Record<string, string[]> = {}
    for (const group of item.groups) {
      const preselected = group.options.filter((option) => option.isDefault && option.isAvailable)
      if (preselected.length) {
        defaults[group.id] = preselected.slice(0, Math.max(1, group.maxSelect)).map((o) => o.id)
      } else if (group.isRequired && group.kind === 'VARIANT') {
        const first = group.options.find((option) => option.isAvailable)
        if (first) defaults[group.id] = [first.id]
      }
    }
    setSelected(defaults)
  }, [item])

  if (!item) return null

  const chosen: CartOption[] = item.groups.flatMap((group) =>
    (selected[group.id] ?? [])
      .map((optionId) => {
        const option = group.options.find((candidate) => candidate.id === optionId)
        if (!option) return null
        return {
          groupId: group.id,
          groupName: group.name,
          optionId: option.id,
          name: option.name,
          priceDelta: option.priceDelta,
        }
      })
      .filter((option): option is CartOption => option !== null),
  )

  const extras = chosen.reduce((total, option) => total + option.priceDelta, 0)
  const total = (item.price + extras) * quantity

  const missingGroup = item.groups.find(
    (group) => group.isRequired && (selected[group.id]?.length ?? 0) < Math.max(1, group.minSelect),
  )

  const toggleOption = (groupId: string, optionId: string, multi: boolean, maxSelect: number) => {
    setSelected((current) => {
      const existing = current[groupId] ?? []
      if (!multi) return { ...current, [groupId]: [optionId] }
      if (existing.includes(optionId)) {
        return { ...current, [groupId]: existing.filter((id) => id !== optionId) }
      }
      if (maxSelect > 0 && existing.length >= maxSelect) return current
      return { ...current, [groupId]: [...existing, optionId] }
    })
  }

  const submit = () => {
    addItem(item, chosen, quantity, notes)
    onOpenChange(false)
  }

  return (
    <Dialog open={Boolean(item)} onOpenChange={onOpenChange}>
      <SheetContent className="max-h-[92dvh]">
        <div className="px-5 pb-6">
          {item.imageUrl ? (
            <div className="relative -mx-5 mb-4 h-52 overflow-hidden">
              <Image
                src={item.imageUrl}
                alt={item.name}
                fill
                sizes="(max-width: 512px) 100vw, 512px"
                className="object-cover"
              />
            </div>
          ) : null}

          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <VegIndicator isVeg={item.isVeg} />
                <DialogTitle className="text-xl">{item.name}</DialogTitle>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <span className="text-lg font-bold">{formatMoney(item.price, currency, locale)}</span>
                {item.compareAt ? (
                  <span className="text-sm text-muted-foreground line-through">
                    {formatMoney(item.compareAt, currency, locale)}
                  </span>
                ) : null}
                {item.priceReason === 'happy-hour' ? (
                  <Badge variant="warning" size="sm">
                    <Flame /> Happy hour
                  </Badge>
                ) : item.priceReason === 'discount' ? (
                  <Badge variant="success" size="sm">
                    Offer
                  </Badge>
                ) : null}
              </div>
            </div>
          </div>

          {item.description ? (
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{item.description}</p>
          ) : null}

          <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
            <span className="flex items-center gap-1">
              <Timer className="size-3.5" /> {item.prepTimeMinutes} min
            </span>
            {item.spiceLevel !== 'NONE' ? (
              <span className="flex items-center gap-1.5">
                <SpiceLevelIndicator level={item.spiceLevel} /> {SPICE_LABELS[item.spiceLevel]}
              </span>
            ) : null}
            {item.calories ? <span>{item.calories} kcal</span> : null}
            {item.isVeg ? (
              <span className="flex items-center gap-1 text-success">
                <Leaf className="size-3.5" /> Vegetarian
              </span>
            ) : null}
          </div>

          {item.allergens.length ? (
            <p className="mt-3 rounded-lg bg-warning/10 px-3 py-2 text-xs text-warning">
              <strong>Allergens:</strong> {item.allergens.join(', ')}
            </p>
          ) : null}

          {item.groups.map((group) => {
            const multi = group.kind === 'ADDON' || group.maxSelect > 1
            const current = selected[group.id] ?? []

            return (
              <section key={group.id} className="mt-6">
                <Separator className="mb-4" />
                <div className="mb-3 flex items-baseline justify-between gap-2">
                  <h3 className="text-sm font-semibold">{group.name}</h3>
                  <span className="text-xs text-muted-foreground">
                    {group.isRequired ? 'Required' : 'Optional'}
                    {multi && group.maxSelect > 0 ? ` · up to ${group.maxSelect}` : ''}
                  </span>
                </div>

                {multi ? (
                  <div className="space-y-1">
                    {group.options.map((option) => (
                      <label
                        key={option.id}
                        className={cn(
                          'flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2.5 transition-colors',
                          current.includes(option.id) ? 'border-primary bg-primary/5' : 'hover:bg-muted/50',
                          !option.isAvailable && 'cursor-not-allowed opacity-40',
                        )}
                      >
                        <Checkbox
                          checked={current.includes(option.id)}
                          disabled={!option.isAvailable}
                          onCheckedChange={() =>
                            toggleOption(group.id, option.id, true, group.maxSelect)
                          }
                        />
                        <span className="flex-1 text-sm">{option.name}</span>
                        {option.priceDelta !== 0 ? (
                          <span className="text-sm font-medium text-muted-foreground">
                            {option.priceDelta > 0 ? '+' : ''}
                            {formatMoney(option.priceDelta, currency, locale)}
                          </span>
                        ) : null}
                      </label>
                    ))}
                  </div>
                ) : (
                  <RadioGroup
                    value={current[0] ?? ''}
                    onValueChange={(value) => toggleOption(group.id, value, false, 1)}
                    className="space-y-1"
                  >
                    {group.options.map((option) => (
                      <label
                        key={option.id}
                        className={cn(
                          'flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2.5 transition-colors',
                          current[0] === option.id ? 'border-primary bg-primary/5' : 'hover:bg-muted/50',
                          !option.isAvailable && 'cursor-not-allowed opacity-40',
                        )}
                      >
                        <RadioGroupItem value={option.id} disabled={!option.isAvailable} />
                        <span className="flex-1 text-sm">{option.name}</span>
                        {option.priceDelta !== 0 ? (
                          <span className="text-sm font-medium text-muted-foreground">
                            {option.priceDelta > 0 ? '+' : ''}
                            {formatMoney(option.priceDelta, currency, locale)}
                          </span>
                        ) : null}
                      </label>
                    ))}
                  </RadioGroup>
                )}
              </section>
            )
          })}

          <section className="mt-6">
            <Separator className="mb-4" />
            <label htmlFor="item-notes" className="text-sm font-semibold">
              Special instructions
            </label>
            <p className="mb-2 text-xs text-muted-foreground">
              Allergies, spice level, anything the kitchen should know.
            </p>
            <Textarea
              id="item-notes"
              value={notes}
              onChange={(event) => setNotes(event.target.value.slice(0, 200))}
              placeholder="e.g. no onions, extra spicy"
              rows={3}
            />
            <p className="mt-1 text-right text-xs text-muted-foreground">{notes.length}/200</p>
          </section>
        </div>

        <div className="sticky bottom-0 z-10 border-t bg-background/95 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] backdrop-blur">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1 rounded-xl border p-1">
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={() => setQuantity((value) => Math.max(1, value - 1))}
                disabled={quantity <= 1}
                aria-label="Decrease quantity"
              >
                <Minus />
              </Button>
              <span className="w-8 text-center text-base font-semibold tabular-nums">{quantity}</span>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={() => setQuantity((value) => Math.min(50, value + 1))}
                disabled={quantity >= 50}
                aria-label="Increase quantity"
              >
                <Plus />
              </Button>
            </div>

            <Button
              type="button"
              size="lg"
              className="flex-1"
              onClick={submit}
              disabled={Boolean(missingGroup) || !item.isAvailable}
            >
              {missingGroup ? `Choose ${missingGroup.name}` : `Add · ${formatMoney(total, currency, locale)}`}
            </Button>
          </div>
        </div>
      </SheetContent>
    </Dialog>
  )
}
