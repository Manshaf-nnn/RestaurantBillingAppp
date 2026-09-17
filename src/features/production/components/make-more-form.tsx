'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import type { StockUnit } from '@prisma/client'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { UNIT_LABELS, formatQuantity } from '@/features/inventory/units'
import { newRequestKey } from '@/lib/request-key'
import { useAction } from '@/lib/use-action'
import { makeMoreAction } from '../actions'

/**
 * Add Production / Make More (aO.md §5).
 *
 * The second time something is made there is nothing left to decide: the item
 * exists, its recipe says what goes in, and the cook is standing in front of
 * the finished pot. So this asks the one question that is still open — how
 * much did you make? — and completes the production in one step against the
 * recipe on file.
 *
 * No ingredient editing here on purpose. Changing what goes in is changing
 * how the item is made, which is the Make an Item form's job: it pre-fills
 * from this same recipe and versions it properly when the lines change.
 *
 * One request key per attempt, minted when the form is shown and again after
 * each success, so a double tap makes one batch rather than two.
 */
export function MakeMoreForm({
  itemId,
  itemName,
  branchId,
  units,
  defaultUnit,
  hasRecipe,
}: {
  itemId: string
  itemName: string
  branchId: string | null
  units: StockUnit[]
  defaultUnit: StockUnit
  /** Without one there is nothing to scale; the card says so instead. */
  hasRecipe: boolean
}) {
  const router = useRouter()
  const { busy, run } = useAction()
  const key = React.useRef(newRequestKey('more'))

  const [quantity, setQuantity] = React.useState('')
  const [unit, setUnit] = React.useState<StockUnit>(defaultUnit)

  const value = Number(quantity)
  const ready = quantity.trim() !== '' && Number.isFinite(value) && value > 0 && Boolean(branchId) && hasRecipe

  if (!hasRecipe) {
    return (
      <p className="text-sm text-muted-foreground">
        There is no recipe on file for {itemName} yet, so there is nothing to repeat. Make it once on
        Make an Item, listing what goes in, and it can be repeated from here afterwards.
      </p>
    )
  }

  const submit = () =>
    void run(
      () =>
        makeMoreAction({
          clientRequestId: key.current,
          branchId: branchId!,
          itemId,
          quantity: value,
          unit,
        }),
      {
        onDone: (result) => {
          key.current = newRequestKey('more')
          setQuantity('')
          toast.success(
            result.replayed
              ? `${result.number} was already recorded — nothing moved twice`
              : `${result.number} — ${formatQuantity(result.producedQty, result.item.unit)} ${result.item.name} into stock`,
          )
          router.refresh()
        },
      },
    )

  return (
    <div className="space-y-3">
      <div className="grid gap-2 sm:grid-cols-[1fr_8rem_auto] sm:items-end">
        <div className="space-y-1">
          <Label className="text-xs" htmlFor="make-more-qty">
            How much are you making?
          </Label>
          <Input
            id="make-more-qty"
            type="number"
            inputMode="decimal"
            min={0}
            step="any"
            placeholder="0"
            value={quantity}
            onChange={(event) => setQuantity(event.target.value)}
            disabled={!branchId}
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs" htmlFor="make-more-unit">Unit</Label>
          <select
            id="make-more-unit"
            className="h-10 w-full rounded-lg border border-input bg-background px-2 text-sm"
            value={unit}
            onChange={(event) => setUnit(event.target.value as StockUnit)}
            disabled={!branchId}
          >
            {units.map((option) => (
              <option key={option} value={option}>{UNIT_LABELS[option]}</option>
            ))}
          </select>
        </div>
        <Button disabled={busy || !ready} loading={busy} onClick={submit}>
          Complete production
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Takes the ingredients above, scaled to this amount, out of stock here and puts {itemName} on
        the shelf at exactly what they cost. One record, with its own reference number.
      </p>
    </div>
  )
}
