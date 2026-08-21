'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { Plus, Save, Trash2 } from 'lucide-react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input, Textarea } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { SectionCard } from '@/features/dashboard/components/page-header'
import { formatMoney, minorUnitFactor } from '@/lib/money'
import { LocalDateTime } from '@/components/local-time'
import { createPurchaseOrderAction, updatePurchaseOrderAction } from '../actions'
import type { PoBuilderData } from '../queries'
import { callAction } from '@/lib/use-action'

const UNITS = ['KG', 'GRAM', 'LITRE', 'ML', 'PIECE', 'PACK', 'BOTTLE', 'DOZEN', 'BOX'] as const

interface Line {
  key: string
  itemId: string
  quantity: string
  unit: string
  unitCost: string
}

/**
 * The new purchase order form.
 *
 * Choosing an item fills in its supplier's price and packaging automatically,
 * because the price a restaurant pays is a fact about the supplier's quote, not
 * something to retype from memory on every order. It stays editable — suppliers
 * change prices between orders, and the order should record what was actually
 * agreed rather than what was agreed last time.
 *
 * `prefill` carries items straight from the reorder suggestions, which is the
 * path most orders will take: see what is low, order it.
 */
export interface PoEditTarget {
  purchaseId: string
  number: string
  supplierId: string | null
  branchId: string | null
  expectedAt: string | null
  notes: string | null
  discount: number
  taxTotal: number
  lines: Array<{ itemId: string; quantity: number; unit: string | null; unitCost: number }>
}

export function PoBuilder({
  data,
  prefill,
  editing,
}: {
  data: PoBuilderData
  prefill?: Array<{ itemId: string; quantity: number }>
  /*
   * The same form, editing an existing draft. `updatePurchaseOrder` has been in
   * the service since purchasing was built and nothing ever called it — so a
   * draft with a wrong quantity could only be cancelled and re-raised, losing
   * its number and its history. Only drafts reach here; the service refuses
   * anything further along.
   */
  editing?: PoEditTarget
}) {
  const router = useRouter()
  const factor = minorUnitFactor(data.currency)
  const money = (minor: number) => formatMoney(minor, data.currency)
  const itemById = React.useMemo(() => new Map(data.items.map((i) => [i.id, i])), [data.items])

  /** A new line, priced from the item's preferred supplier where there is one. */
  const lineFor = (itemId: string, quantity = '', key?: string): Line => {
    const item = itemById.get(itemId)
    const source = item?.sources[0]
    return {
      key: key ?? `${Date.now()}-${Math.round(Math.random() * 1e6)}`,
      itemId,
      quantity,
      unit: source?.purchaseUnit ?? item?.unit ?? 'PIECE',
      unitCost: source ? String(source.price / factor) : item ? String(item.fallbackCost / factor) : '',
    }
  }

  const [supplierId, setSupplierId] = React.useState(() => {
    if (editing) return editing.supplierId ?? ''
    // Pre-select the supplier that covers most of the prefilled items.
    if (!prefill?.length) return ''
    const tally = new Map<string, number>()
    for (const row of prefill) {
      const source = itemById.get(row.itemId)?.sources[0]
      if (source) tally.set(source.supplierId, (tally.get(source.supplierId) ?? 0) + 1)
    }
    return [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? ''
  })
  const [lines, setLines] = React.useState<Line[]>(() => {
    if (editing) {
      // The saved values, not re-derived ones. An order records what was
      // actually agreed, and re-pricing it from today's list on open would
      // quietly change the order someone is only trying to correct a typo in.
      return editing.lines.map((row, i) => ({
        key: `edit-${i}`,
        itemId: row.itemId,
        quantity: String(row.quantity),
        unit: row.unit ?? itemById.get(row.itemId)?.unit ?? 'PIECE',
        unitCost: String(row.unitCost / factor),
      }))
    }
    return prefill?.length
      ? prefill.map((row, i) => lineFor(row.itemId, String(row.quantity), `pre-${i}`))
      : []
  })
  // Defaults to the restaurant's main location, so a single-site restaurant
  // never has to think about it and a multi-site one must choose deliberately.
  const [branchId, setBranchId] = React.useState(
    () =>
      editing?.branchId ??
      data.locations.find((l) => l.isDefault)?.id ??
      data.locations[0]?.id ??
      '',
  )
  const [expectedAt, setExpectedAt] = React.useState(editing?.expectedAt?.slice(0, 10) ?? '')
  const [discount, setDiscount] = React.useState(
    editing && editing.discount > 0 ? String(editing.discount / factor) : '',
  )
  const [taxTotal, setTaxTotal] = React.useState(
    editing && editing.taxTotal > 0 ? String(editing.taxTotal / factor) : '',
  )
  const [notes, setNotes] = React.useState(editing?.notes ?? '')
  const [busy, setBusy] = React.useState(false)

  const update = (key: string, patch: Partial<Line>) =>
    setLines((current) =>
      current.map((l) => {
        if (l.key !== key) return l
        /*
         * Changing the item re-prices the line, because a price belongs to an
         * item and keeping the old one would be wrong. The quantity is kept —
         * it is about the order, not the item — and so is a cost the buyer
         * typed deliberately, which used to be discarded silently.
         */
        if (patch.itemId && patch.itemId !== l.itemId) {
          const fresh = lineFor(patch.itemId, l.quantity, l.key)
          const source = itemById.get(l.itemId)?.sources[0]
          const wasDefault =
            l.unitCost === '' ||
            l.unitCost === String((source?.price ?? itemById.get(l.itemId)?.fallbackCost ?? 0) / factor)
          return wasDefault ? fresh : { ...fresh, unitCost: l.unitCost }
        }
        return { ...l, ...patch }
      }),
    )

  const subtotal = lines.reduce((sum, l) => {
    const q = Number(l.quantity), c = Number(l.unitCost)
    return Number.isFinite(q) && Number.isFinite(c) ? sum + q * c * factor : sum
  }, 0)
  const discountMinor = Math.min(Math.max(0, Number(discount) || 0) * factor, subtotal)
  const taxMinor = Math.max(0, Number(taxTotal) || 0) * factor
  const total = subtotal - discountMinor + taxMinor

  const submit = async () => {
    const payload = lines
      .filter((l) => l.itemId && Number(l.quantity) > 0)
      .map((l) => ({
        itemId: l.itemId,
        quantity: Number(l.quantity),
        unit: l.unit,
        unitCost: Number(l.unitCost) || 0,
      }))

    if (payload.length === 0) {
      toast.error('Add at least one item with a quantity')
      return
    }

    // Two lines for one item double what is ordered, and the supplier delivers
    // it. Caught here as well as on the server so it is said while the form is
    // still open.
    const duplicate = payload.find((l, i) => payload.findIndex((o) => o.itemId === l.itemId) !== i)
    if (duplicate) {
      toast.error(
        `${itemById.get(duplicate.itemId)?.name ?? 'That item'} is on the order twice — combine the lines`,
      )
      return
    }

    setBusy(true)
    const body = {
      supplierId,
      branchId,
      expectedAt,
      notes,
      discount: Number(discount) || 0,
      taxTotal: Number(taxTotal) || 0,
      lines: payload,
    }
    const result = await callAction(() =>
      editing
        ? updatePurchaseOrderAction({ purchaseId: editing.purchaseId, ...body })
        : createPurchaseOrderAction(body),
    )
    setBusy(false)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    if (editing) {
      toast.success(`${editing.number} updated`)
      router.push(`/dashboard/purchases/${editing.purchaseId}`)
    } else {
      const created = result.data as { id: string; number: string }
      toast.success(`${created.number} created as a draft`)
      router.push(`/dashboard/purchases/${created.id}`)
    }
  }

  return (
    <div className="space-y-5">
      <SectionCard title="Supplier and delivery">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="supplier">Supplier</Label>
            <select
              id="supplier"
              className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm"
              value={supplierId}
              onChange={(e) => setSupplierId(e.target.value)}
            >
              <option value="">No supplier</option>
              {data.suppliers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} · {s.paymentTerms.replace('_', ' ').toLowerCase()}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="expected">Expected delivery</Label>
            <Input id="expected" type="date" value={expectedAt} onChange={(e) => setExpectedAt(e.target.value)} />
          </div>
          {/*
            Where the goods physically arrive. This was missing, so every
            purchase was raised against no location — and on receipt the stock
            credited no shelf, leaving warehouses permanently empty while the
            restaurant-wide total rose.
          */}
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="destination">Deliver to</Label>
            <select
              id="destination"
              className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm"
              value={branchId}
              onChange={(e) => setBranchId(e.target.value)}
            >
              {data.locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name} · {l.type.replace(/_/g, ' ').toLowerCase()}
                </option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground">
              The stock lands here when the delivery is received.
            </p>
          </div>
        </div>
      </SectionCard>

      <SectionCard
        title="Items"
        description="Choosing an item fills in its supplier's price and packaging. Change either if this order was agreed differently."
        actions={lines.length > 0 ? <Badge variant="secondary">{lines.length}</Badge> : null}
      >
        {lines.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            Nothing on this order yet.
          </p>
        ) : (
          <ul className="space-y-2">
            {lines.map((line) => {
              const item = itemById.get(line.itemId)
              const source = item?.sources[0]
              const q = Number(line.quantity) || 0
              const c = Number(line.unitCost) || 0
              return (
                <li key={line.key} className="grid grid-cols-12 items-end gap-2">
                  <div className="col-span-12 space-y-1 sm:col-span-4">
                    <Label className="text-xs">Item</Label>
                    <select
                      className="h-10 w-full rounded-lg border border-input bg-background px-2 text-sm"
                      value={line.itemId}
                      onChange={(e) => update(line.key, { itemId: e.target.value })}
                    >
                      <option value="">Choose…</option>
                      {data.items.map((i) => (
                        <option key={i.id} value={i.id}>{i.name}</option>
                      ))}
                    </select>
                  </div>

                  <div className="col-span-4 space-y-1 sm:col-span-2">
                    <Label className="text-xs">Quantity</Label>
                    <Input
                      inputMode="decimal"
                      value={line.quantity}
                      onChange={(e) => update(line.key, { quantity: e.target.value })}
                    />
                  </div>

                  <div className="col-span-4 space-y-1 sm:col-span-2">
                    <Label className="text-xs">Unit</Label>
                    <select
                      className="h-10 w-full rounded-lg border border-input bg-background px-2 text-sm"
                      value={line.unit}
                      onChange={(e) => update(line.key, { unit: e.target.value })}
                    >
                      {UNITS.map((u) => <option key={u} value={u}>{u.toLowerCase()}</option>)}
                    </select>
                  </div>

                  <div className="col-span-4 space-y-1 sm:col-span-2">
                    <Label className="text-xs">Cost / unit</Label>
                    <Input
                      inputMode="decimal"
                      value={line.unitCost}
                      onChange={(e) => update(line.key, { unitCost: e.target.value })}
                    />
                  </div>

                  <div className="col-span-8 text-right text-sm font-medium tabular-nums sm:col-span-1">
                    {money(Math.round(q * c * factor))}
                  </div>

                  <button
                    type="button"
                    aria-label="Remove line"
                    onClick={() => setLines((cur) => cur.filter((l) => l.key !== line.key))}
                    className="col-span-4 flex h-10 items-center justify-center rounded-lg border border-border text-muted-foreground hover:bg-muted sm:col-span-1"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>

                  {item && (
                    <p className="col-span-12 -mt-1 pl-1 text-xs text-muted-foreground">
                      {item.quantity} {item.unit.toLowerCase()} in stock
                      {source ? ` · ${source.supplierName}` : ' · no supplier price set'}
                      {source?.minOrderQty ? ` · min ${source.minOrderQty}` : ''}
                      {source?.leadTimeDays !== null && source?.leadTimeDays !== undefined
                        ? ` · ${source.leadTimeDays} day lead time`
                        : ''}
                    </p>
                  )}

                  {/*
                    What it last actually cost, beside what the price list says.
                    The prefilled figure is the supplier's standing quote, or
                    failing that the weighted average — neither of which is what
                    was paid last time, which is the number a buyer is actually
                    checking against. Clicking it fills the cost box; it never
                    overwrites anything on its own.
                  */}
                  {item ? (
                    <p className="col-span-12 -mt-1 pl-1 text-xs">
                      {item.lastPurchase ? (
                        <>
                          <span className="text-muted-foreground">Last paid </span>
                          <button
                            type="button"
                            onClick={() =>
                              update(line.key, {
                                unitCost: String(item.lastPurchase!.unitCost / factor),
                              })
                            }
                            className="font-medium text-primary underline-offset-2 hover:underline"
                          >
                            {money(item.lastPurchase.unitCost)}
                          </button>
                          <span className="text-muted-foreground">
                            {' '}
                            on <LocalDateTime value={item.lastPurchase.at} />
                            {item.lastPurchase.supplierName
                              ? ` · ${item.lastPurchase.supplierName}`
                              : ''}
                          </span>
                        </>
                      ) : (
                        <span className="text-muted-foreground">No previous purchase</span>
                      )}
                    </p>
                  ) : null}
                </li>
              )
            })}
          </ul>
        )}

        <Button
          variant="outline"
          size="sm"
          className="mt-4"
          onClick={() => setLines((cur) => [...cur, lineFor('')])}
        >
          <Plus className="mr-1.5 h-4 w-4" />
          Add item
        </Button>
      </SectionCard>

      <SectionCard title="Totals" description="Discount and tax apply to the whole order, as they do on a supplier invoice.">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="discount">Discount</Label>
            <Input id="discount" inputMode="decimal" placeholder="0" value={discount} onChange={(e) => setDiscount(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="tax">Tax</Label>
            <Input id="tax" inputMode="decimal" placeholder="0" value={taxTotal} onChange={(e) => setTaxTotal(e.target.value)} />
          </div>
        </div>

        <dl className="mt-4 space-y-1 text-sm">
          <Row label="Subtotal" value={money(Math.round(subtotal))} />
          {discountMinor > 0 && <Row label="Discount" value={`− ${money(Math.round(discountMinor))}`} />}
          {taxMinor > 0 && <Row label="Tax" value={money(Math.round(taxMinor))} />}
          <div className="flex justify-between border-t border-border pt-2 text-base font-semibold">
            <dt>Total</dt>
            <dd className="tabular-nums">{money(Math.round(total))}</dd>
          </div>
        </dl>
      </SectionCard>

      <SectionCard title="Notes">
        <Textarea rows={2} placeholder="Anything the supplier needs to know" value={notes} onChange={(e) => setNotes(e.target.value)} />
      </SectionCard>

      <Button size="lg" onClick={submit} disabled={busy}>
        <Save className="mr-2 h-4 w-4" />
        {busy
          ? editing
            ? 'Saving…'
            : 'Creating…'
          : editing
            ? 'Save changes'
            : 'Create order'}
      </Button>
      <p className="text-xs text-muted-foreground">
        The order is created as a draft. It has to be approved before goods can be received against it,
        and no stock changes until a delivery actually arrives.
      </p>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  )
}
