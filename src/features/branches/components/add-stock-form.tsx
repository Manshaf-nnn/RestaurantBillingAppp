'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { PackagePlus } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useAction } from '@/lib/use-action'
import { SectionCard } from '@/features/dashboard/components/page-header'
import { recordStockMovement } from '@/features/inventory/actions'

/**
 * Put stock into this location.
 *
 * The location page used to have exactly one text box on it — "Storage areas" —
 * so an owner wanting to add sugar to a warehouse typed "sugar" into it and got
 * a shelf named sugar. The page then told him "nothing held here yet, stock
 * appears once something is received or transferred in" while offering no way to
 * do either. This is that missing way.
 *
 * It posts a normal receipt through the ledger at this branch, so the stock is
 * immediately visible in "Stock here", transferable, and reconcilable — unlike
 * the old paths, which recorded no location at all.
 */
export function AddStockForm({
  branchId,
  branchName,
  items,
  shelves,
  currency,
}: {
  branchId: string
  branchName: string
  items: Array<{ id: string; name: string; unit: string }>
  shelves: Array<{ id: string; name: string }>
  currency: string
}) {
  const router = useRouter()
  const { busy, run } = useAction()
  const [itemId, setItemId] = React.useState('')
  const [quantity, setQuantity] = React.useState('')
  const [shelfId, setShelfId] = React.useState('')
  const [reason, setReason] = React.useState('')

  const item = items.find((i) => i.id === itemId)

  const submit = () =>
    run(
      () =>
        recordStockMovement({
          itemId,
          type: 'PURCHASE',
          quantity: Number(quantity),
          branchId,
          storageLocationId: shelfId,
          reason: reason || `Added at ${branchName}`,
        }),
      {
        success: () => `${quantity} ${item?.unit.toLowerCase() ?? ''} of ${item?.name} added`,
        onDone: () => {
          setItemId('')
          setQuantity('')
          setReason('')
          router.refresh()
        },
      },
    )

  if (items.length === 0) {
    return (
      <SectionCard title="Add stock">
        <p className="py-4 text-sm text-muted-foreground">
          Create an inventory item first, under <strong>Stock</strong>. Then you can add it here.
        </p>
      </SectionCard>
    )
  }

  return (
    <SectionCard
      title="Add stock here"
      description={`Put stock straight onto ${branchName}'s shelves — an opening count, or a delivery that arrived without a purchase order.`}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="add-item">Item</Label>
          <select
            id="add-item"
            className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm"
            value={itemId}
            onChange={(e) => setItemId(e.target.value)}
          >
            <option value="">Choose an item…</option>
            {items.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name} ({i.unit.toLowerCase()})
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="add-qty">
            Quantity {item ? `(${item.unit.toLowerCase()})` : ''}
          </Label>
          <Input
            id="add-qty"
            inputMode="decimal"
            placeholder="e.g. 25"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
          />
        </div>

        {shelves.length > 0 && (
          <div className="space-y-1.5">
            <Label htmlFor="add-shelf">Storage area (optional)</Label>
            <select
              id="add-shelf"
              className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm"
              value={shelfId}
              onChange={(e) => setShelfId(e.target.value)}
            >
              <option value="">Anywhere in this location</option>
              {shelves.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </div>
        )}

        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="add-reason">Note (optional)</Label>
          <Input
            id="add-reason"
            placeholder="e.g. opening count, or delivery from Ampara Traders"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
      </div>

      <div className="mt-4 flex items-center gap-3">
        <Button onClick={submit} disabled={busy || !itemId || !(Number(quantity) > 0)}>
          <PackagePlus className="mr-2 h-4 w-4" />
          {busy ? 'Adding…' : 'Add to this location'}
        </Button>
        <p className="text-xs text-muted-foreground">
          Recorded in the stock ledger, so it shows in reports and can be transferred.
          Cost comes from the item&apos;s average, in {currency}.
        </p>
      </div>
    </SectionCard>
  )
}
