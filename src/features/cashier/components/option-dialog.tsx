'use client'

import * as React from 'react'
import { Minus, Plus } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Separator } from '@/components/ui/primitives'
import { cn } from '@/lib/utils'
import type { PublicMenuGroup, PublicMenuItem } from '@/features/menu/queries'
import { optionPriceLabel, replacesPrice } from '@/features/menu/variant-pricing'

/**
 * Choosing a size at the counter.
 *
 * ── Why this had to exist ───────────────────────────────────────────────────
 *
 * The till sent `optionIds: []` for every line, hard-coded, while the server
 * enforces required option groups. So the moment an owner did the thing this
 * whole feature is for — add "Portion: Normal / Full" and mark it required —
 * that dish became **un-sellable at the counter**, failing with
 * `OPTION_REQUIRED`. A guest with a phone could buy it; the cashier standing in
 * front of the guest could not.
 *
 * ── It only appears when there is something to decide ───────────────────────
 *
 * A dish with no option groups still adds on a single tap. Putting a dialog in
 * front of a cashier that has nothing in it but a Confirm button is how a till
 * gets slow, and a slow till is why people keep paper.
 *
 * ── Same rules as the guest sheet, deliberately ─────────────────────────────
 *
 * Radios for a single-choice size, checkboxes for add-ons, defaults
 * pre-selected, required groups holding the button shut. The server validates
 * all of it again regardless — this is so the cashier is never *told* about a
 * rule by having their order rejected.
 */
export function OptionDialog({
  item,
  currency,
  locale,
  money,
  onCancel,
  onConfirm,
}: {
  item: PublicMenuItem
  currency: string
  locale: string
  money: (minor: number) => string
  onCancel: () => void
  onConfirm: (optionIds: string[], quantity: number, notes: string) => void
}) {
  const [selected, setSelected] = React.useState<Record<string, string[]>>(() =>
    defaultSelection(item.groups),
  )
  const [quantity, setQuantity] = React.useState(1)
  const [notes, setNotes] = React.useState('')

  const toggle = (group: PublicMenuGroup, optionId: string) => {
    setSelected((current) => {
      const chosen = current[group.id] ?? []
      const multi = !replacesPrice(group)

      if (!multi) return { ...current, [group.id]: [optionId] }

      if (chosen.includes(optionId)) {
        return { ...current, [group.id]: chosen.filter((id) => id !== optionId) }
      }
      // Silently dropping the oldest beats refusing the tap: the cashier's
      // intent is "this one too", and an unresponsive checkbox reads as broken.
      const next = [...chosen, optionId]
      return {
        ...current,
        [group.id]: group.maxSelect > 0 ? next.slice(-group.maxSelect) : next,
      }
    })
  }

  const optionIds = Object.values(selected).flat()

  /** The first required group nobody has answered — what holds the button. */
  const missing = item.groups.find(
    (group) => group.isRequired && (selected[group.id]?.length ?? 0) < Math.max(1, group.minSelect),
  )

  const extras = item.groups
    .flatMap((group) => group.options.filter((option) => optionIds.includes(option.id)))
    .reduce((total, option) => total + option.priceDelta, 0)
  const unit = item.price + extras

  return (
    <Dialog open onOpenChange={(open) => (open ? null : onCancel())}>
      <DialogContent className="max-h-[90dvh] max-w-md overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{item.name}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {item.groups.map((group) => {
            const chosen = selected[group.id] ?? []
            const single = replacesPrice(group)

            return (
              <section key={group.id}>
                <Separator className="mb-3" />
                <div className="mb-2 flex items-baseline justify-between gap-2">
                  <h3 className="text-sm font-semibold">{group.name}</h3>
                  <span className="text-xs text-muted-foreground">
                    {group.isRequired ? 'Required' : 'Optional'}
                    {!single && group.maxSelect > 0 ? ` · up to ${group.maxSelect}` : ''}
                  </span>
                </div>

                <div className="space-y-1.5">
                  {group.options.map((option) => {
                    const on = chosen.includes(option.id)
                    const label = optionPriceLabel(option, group, item.price, money)

                    return (
                      <button
                        key={option.id}
                        type="button"
                        disabled={!option.isAvailable}
                        onClick={() => toggle(group, option.id)}
                        aria-pressed={on}
                        className={cn(
                          'flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition',
                          on ? 'border-primary bg-primary/5' : 'hover:bg-muted/50',
                          !option.isAvailable && 'cursor-not-allowed opacity-40',
                        )}
                      >
                        <span
                          className={cn(
                            'flex size-4 shrink-0 items-center justify-center border',
                            single ? 'rounded-full' : 'rounded',
                            on ? 'border-primary bg-primary' : 'border-input',
                          )}
                        >
                          {on ? (
                            <span
                              className={cn(
                                'bg-primary-foreground',
                                single ? 'size-1.5 rounded-full' : 'size-2 rounded-[2px]',
                              )}
                            />
                          ) : null}
                        </span>
                        <span className="flex-1 text-sm">
                          {option.name}
                          {!option.isAvailable ? (
                            <span className="ml-1.5 text-xs text-muted-foreground">sold out</span>
                          ) : null}
                        </span>
                        {label ? (
                          <span className="text-sm font-medium tabular-nums">{label}</span>
                        ) : null}
                      </button>
                    )
                  })}
                </div>
              </section>
            )
          })}

          <Separator />

          <div className="flex items-center justify-between gap-3">
            <span className="text-sm font-medium">Quantity</span>
            <div className="flex items-center gap-1">
              <Button
                variant="outline"
                size="icon-sm"
                aria-label="One fewer"
                onClick={() => setQuantity((q) => Math.max(1, q - 1))}
              >
                <Minus />
              </Button>
              <span className="w-8 text-center text-sm font-semibold tabular-nums">{quantity}</span>
              <Button
                variant="outline"
                size="icon-sm"
                aria-label="One more"
                onClick={() => setQuantity((q) => Math.min(50, q + 1))}
              >
                <Plus />
              </Button>
            </div>
          </div>

          <Input
            value={notes}
            onChange={(event) => setNotes(event.target.value.slice(0, 200))}
            placeholder="Note for the kitchen — e.g. no chilli"
          />
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            disabled={Boolean(missing)}
            onClick={() => onConfirm(optionIds, quantity, notes.trim())}
          >
            {missing ? `Choose ${missing.name}` : `Add · ${money(unit * quantity)}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * What is ticked when the dialog opens.
 *
 * The same rule the guest sheet uses: any option flagged default, and failing
 * that, the first available choice of a required size group. A required group
 * that opens with nothing selected makes the cashier answer a question the
 * menu already has an answer to.
 */
export function defaultSelection(groups: PublicMenuGroup[]): Record<string, string[]> {
  const chosen: Record<string, string[]> = {}

  for (const group of groups) {
    const defaults = group.options.filter((option) => option.isDefault && option.isAvailable)
    if (defaults.length > 0) {
      chosen[group.id] = replacesPrice(group)
        ? [defaults[0].id]
        : defaults.slice(0, Math.max(1, group.maxSelect)).map((option) => option.id)
      continue
    }
    if (group.isRequired && replacesPrice(group)) {
      const first = group.options.find((option) => option.isAvailable)
      if (first) chosen[group.id] = [first.id]
    }
  }

  return chosen
}
