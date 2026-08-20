'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { Plus, Star, TrendingDown } from 'lucide-react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { SectionCard } from '@/features/dashboard/components/page-header'
import { formatMoney, minorUnitFactor } from '@/lib/money'
import { upsertSupplierItemAction } from '../actions'
import type { SupplierPricingData } from '../queries'

const UNITS = ['KG', 'GRAM', 'LITRE', 'ML', 'PIECE', 'PACK', 'BOTTLE', 'DOZEN', 'BOX'] as const

interface PriceValues {
  supplierSku?: string
  purchaseUnit?: string
  unitsPerPurchaseUnit?: string
  price: string
  leadTimeDays?: string
  minOrderQty?: string
  isPreferred?: boolean
}

/**
 * A supplier's price list.
 *
 * Each row shows whether anyone else quotes the same item and what the cheapest
 * quote is, because the useful question here is not "what does this supplier
 * charge?" — that is on the invoice — but "should I still be buying it here?".
 * A row priced above the best available quote is flagged rather than ranked
 * away, so the owner decides; the cheapest supplier is not always the right one
 * when reliability and lead time matter.
 */
export function SupplierPricing({ data }: { data: SupplierPricingData }) {
  const router = useRouter()
  const factor = minorUnitFactor(data.currency)
  const money = (m: number) => formatMoney(m, data.currency)

  const [adding, setAdding] = React.useState(false)
  const [newItemId, setNewItemId] = React.useState('')
  const [busy, setBusy] = React.useState<string | null>(null)

  const save = async (itemId: string, values: PriceValues) => {
    setBusy(itemId)
    const result = await upsertSupplierItemAction({
      supplierId: data.supplier.id,
      itemId,
      supplierSku: values.supplierSku ?? '',
      purchaseUnit: values.purchaseUnit || undefined,
      unitsPerPurchaseUnit: values.unitsPerPurchaseUnit ? Number(values.unitsPerPurchaseUnit) : undefined,
      price: Number(values.price) || 0,
      leadTimeDays: values.leadTimeDays ? Number(values.leadTimeDays) : undefined,
      minOrderQty: values.minOrderQty ? Number(values.minOrderQty) : undefined,
      isPreferred: values.isPreferred ?? false,
    })
    setBusy(null)
    if (!result.ok) { toast.error(result.error); return }
    toast.success('Saved')
    setAdding(false)
    setNewItemId('')
    router.refresh()
  }

  return (
    <div className="space-y-5">
      <SectionCard title="Contact">
        <dl className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Company" value={data.supplier.company} />
          <Field label="Contact" value={data.supplier.contactName} />
          <Field label="Phone" value={data.supplier.phone} />
          <Field label="Payment terms" value={data.supplier.paymentTerms.replace('_', ' ').toLowerCase()} />
        </dl>
      </SectionCard>

      <SectionCard
        title="Price list"
        description="What this supplier charges. Prices feed the purchase order form and the reorder suggestions automatically."
        actions={
          data.available.length > 0 ? (
            <Button size="sm" variant="outline" onClick={() => setAdding((v) => !v)}>
              <Plus className="mr-1.5 h-4 w-4" />
              Add item
            </Button>
          ) : null
        }
      >
        {adding && (
          <div className="mb-4 rounded-lg border border-dashed border-border p-3">
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1 sm:col-span-2">
                <Label className="text-xs">Item</Label>
                <select
                  className="h-10 w-full rounded-lg border border-input bg-background px-2 text-sm"
                  value={newItemId}
                  onChange={(e) => setNewItemId(e.target.value)}
                >
                  <option value="">Choose…</option>
                  {data.available.map((i) => (
                    <option key={i.id} value={i.id}>{i.name}</option>
                  ))}
                </select>
              </div>
              <div className="flex items-end">
                <Button
                  className="w-full"
                  disabled={!newItemId || busy !== null}
                  onClick={() => save(newItemId, { price: '0' })}
                >
                  Add
                </Button>
              </div>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              Added at zero — set the price on the row that appears.
            </p>
          </div>
        )}

        {data.priced.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            No prices yet. Add an item to start building this supplier&apos;s list.
          </p>
        ) : (
          <ul className="space-y-3">
            {data.priced.map((row) => (
              <PriceRow
                key={row.itemId}
                row={row}
                factor={factor}
                money={money}
                busy={busy === row.itemId}
                onSave={(values) => save(row.itemId, values)}
              />
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  )
}

function PriceRow({
  row,
  factor,
  money,
  busy,
  onSave,
}: {
  row: SupplierPricingData['priced'][number]
  factor: number
  money: (m: number) => string
  busy: boolean
  onSave: (v: PriceValues) => void
}) {
  const [sku, setSku] = React.useState(row.supplierSku ?? '')
  const [unit, setUnit] = React.useState(row.purchaseUnit ?? '')
  const [per, setPer] = React.useState(row.unitsPerPurchaseUnit ? String(row.unitsPerPurchaseUnit) : '')
  const [price, setPrice] = React.useState(String(row.price / factor))
  const [lead, setLead] = React.useState(row.leadTimeDays !== null ? String(row.leadTimeDays) : '')
  const [moq, setMoq] = React.useState(row.minOrderQty !== null ? String(row.minOrderQty) : '')

  const dearer = row.bestPrice !== null && row.price > row.bestPrice

  return (
    <li className="rounded-lg border border-border p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="font-medium">{row.name}</span>
        <span className="text-xs text-muted-foreground">stocked in {row.baseUnit.toLowerCase()}</span>
        {row.isPreferred && (
          <Badge variant="success">
            <Star className="mr-1 h-3 w-3" />
            preferred
          </Badge>
        )}
        {dearer && (
          <span className="inline-flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400">
            <TrendingDown className="h-3.5 w-3.5" />
            {money(row.bestPrice!)} elsewhere
          </span>
        )}
        {row.alternativeCount > 0 && !dearer && (
          <span className="text-xs text-muted-foreground">
            {row.alternativeCount} other source{row.alternativeCount === 1 ? '' : 's'}
          </span>
        )}
      </div>

      <div className="grid grid-cols-12 gap-2">
        <Cell label="Their SKU" span="sm:col-span-2">
          <Input value={sku} onChange={(e) => setSku(e.target.value)} placeholder="—" />
        </Cell>
        <Cell label="Sold in" span="sm:col-span-2">
          <select
            className="h-10 w-full rounded-lg border border-input bg-background px-2 text-sm"
            value={unit}
            onChange={(e) => setUnit(e.target.value)}
          >
            <option value="">same as stock</option>
            {UNITS.map((u) => <option key={u} value={u}>{u.toLowerCase()}</option>)}
          </select>
        </Cell>
        <Cell label={`${row.baseUnit.toLowerCase()} per`} span="sm:col-span-1">
          <Input inputMode="decimal" value={per} onChange={(e) => setPer(e.target.value)} placeholder="—" />
        </Cell>
        <Cell label="Price" span="sm:col-span-2">
          <Input inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} />
        </Cell>
        <Cell label="Lead days" span="sm:col-span-1">
          <Input inputMode="numeric" value={lead} onChange={(e) => setLead(e.target.value)} placeholder="—" />
        </Cell>
        <Cell label="Min order" span="sm:col-span-2">
          <Input inputMode="decimal" value={moq} onChange={(e) => setMoq(e.target.value)} placeholder="—" />
        </Cell>

        <div className="col-span-12 flex flex-wrap items-center gap-3 sm:col-span-2 sm:justify-end">
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() =>
              onSave({
                supplierSku: sku, purchaseUnit: unit, unitsPerPurchaseUnit: per,
                price, leadTimeDays: lead, minOrderQty: moq, isPreferred: row.isPreferred,
              })
            }
          >
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </div>

      {!row.isPreferred && (
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            onSave({
              supplierSku: sku, purchaseUnit: unit, unitsPerPurchaseUnit: per,
              price, leadTimeDays: lead, minOrderQty: moq, isPreferred: true,
            })
          }
          className="mt-2 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          Make this the preferred source
        </button>
      )}

      {unit && unit !== row.baseUnit && !per && (
        <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">
          Say how many {row.baseUnit.toLowerCase()} are in one {unit.toLowerCase()}, or deliveries in{' '}
          {unit.toLowerCase()} cannot be converted.
        </p>
      )}
    </li>
  )
}

function Cell({
  label,
  span,
  children,
}: {
  label: string
  span: string
  children: React.ReactNode
}) {
  return (
    <div className={`col-span-6 space-y-1 ${span}`}>
      <Label className="text-xs">{label}</Label>
      {children}
    </div>
  )
}

function Field({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-0.5">{value || '—'}</dd>
    </div>
  )
}
