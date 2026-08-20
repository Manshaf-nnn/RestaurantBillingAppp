'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { CheckCircle2, Factory, Play, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { SectionCard } from '@/features/dashboard/components/page-header'
import { formatMoney } from '@/lib/money'
import {
  completeProductionAction, createProductionOrderAction,
  createProductionSpecAction, setProductionStatusAction,
} from '../actions'

const UNITS = ['KG', 'GRAM', 'LITRE', 'ML', 'PIECE', 'PACK', 'BOTTLE', 'DOZEN', 'BOX'] as const
const REASONS = [
  { value: 'PRODUCTION_LOSS', label: 'Production loss' },
  { value: 'DAMAGED', label: 'Damaged' },
  { value: 'INGREDIENT_SHORTAGE', label: 'Ingredient shortage' },
  { value: 'QUALITY_ISSUE', label: 'Quality issue' },
  { value: 'OTHER', label: 'Other' },
] as const

export interface ProductionConsoleData {
  houses: Array<{ id: string; name: string }>
  items: Array<{ id: string; name: string; unit: string; quantity: number }>
  specs: Array<{ id: string; name: string; outputName: string; outputQty: number }>
  pending: Array<{ id: string; number: string; status: string; specName: string | null; plannedQty: number }>
  currency: string
}

/**
 * Running production.
 *
 * Three things happen here and they are kept visibly separate, because only one
 * of them touches stock. Defining a recipe and planning a run change nothing;
 * completing a run consumes raw materials and creates finished goods in a
 * single transaction. The screen says so at each step rather than leaving
 * someone to find out.
 */
export function ProductionConsole({ data }: { data: ProductionConsoleData }) {
  const router = useRouter()
  const money = (m: number) => formatMoney(m, data.currency)
  const [busy, setBusy] = React.useState(false)

  // ── recipe ────────────────────────────────────────────────────────────────
  const [specName, setSpecName] = React.useState('')
  const [outputId, setOutputId] = React.useState('')
  const [outputQty, setOutputQty] = React.useState('')
  const [shelfLife, setShelfLife] = React.useState('')
  const [lines, setLines] = React.useState<Array<{ key: string; itemId: string; quantity: string; unit: string }>>([])

  const saveSpec = async () => {
    const items = lines.filter((l) => l.itemId && Number(l.quantity) > 0)
      .map((l) => ({ itemId: l.itemId, quantity: Number(l.quantity), unit: l.unit }))
    if (!specName.trim() || !outputId || !(Number(outputQty) > 0) || items.length === 0) {
      toast.error('Name it, say what it produces and add raw materials')
      return
    }
    setBusy(true)
    const r = await createProductionSpecAction({
      name: specName, outputItemId: outputId, outputQty: Number(outputQty),
      shelfLifeDays: shelfLife ? Number(shelfLife) : undefined, items,
    })
    setBusy(false)
    if (!r.ok) { toast.error(r.error); return }
    toast.success('Recipe saved')
    setSpecName(''); setOutputId(''); setOutputQty(''); setShelfLife(''); setLines([])
    router.refresh()
  }

  // ── run ───────────────────────────────────────────────────────────────────
  const [houseId, setHouseId] = React.useState(data.houses[0]?.id ?? '')
  const [specId, setSpecId] = React.useState('')
  const [batches, setBatches] = React.useState('')

  const startRun = async () => {
    setBusy(true)
    const r = await createProductionOrderAction({ branchId: houseId, specId, plannedQty: Number(batches) })
    setBusy(false)
    if (!r.ok) { toast.error(r.error); return }
    toast.success(`${r.data.number} planned — nothing consumed yet`)
    setSpecId(''); setBatches('')
    router.refresh()
  }

  const move = async (orderId: string, status: string) => {
    setBusy(true)
    const r = await setProductionStatusAction({ orderId, status })
    setBusy(false)
    if (!r.ok) { toast.error(r.error); return }
    toast.success('Updated')
    router.refresh()
  }

  // ── completion ────────────────────────────────────────────────────────────
  const [made, setMade] = React.useState<Record<string, string>>({})
  const [reason, setReason] = React.useState<Record<string, string>>({})

  const finish = async (orderId: string, planned: number) => {
    const actual = made[orderId] === undefined ? planned : Number(made[orderId])
    if (!Number.isFinite(actual) || actual < 0) { toast.error('Enter how many batches were made'); return }
    if (actual < planned && !reason[orderId]) {
      toast.error('Made less than planned — choose a reason')
      return
    }
    setBusy(true)
    const r = await completeProductionAction({
      orderId, actualQty: actual,
      varianceReason: actual < planned ? reason[orderId] : undefined,
    })
    setBusy(false)
    if (!r.ok) { toast.error(r.error); return }
    toast.success(`${r.data.produced} produced at ${money(r.data.unitCost)} each`)
    router.refresh()
  }

  if (data.houses.length === 0) {
    return (
      <SectionCard title="No production house">
        <p className="py-6 text-center text-sm text-muted-foreground">
          Add a location of type <strong>Production house</strong> first, then production runs appear here.
        </p>
      </SectionCard>
    )
  }

  return (
    <div className="space-y-5">
      {data.pending.length > 0 && (
        <SectionCard
          title="Runs in progress"
          description="None of these have consumed anything. Stock moves only when a run is completed."
        >
          <ul className="divide-y divide-border">
            {data.pending.map((p) => {
              const actual = made[p.id] === undefined ? String(p.plannedQty) : made[p.id]
              const short = Number(actual) < p.plannedQty
              return (
                <li key={p.id} className="py-3">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <Factory className="h-4 w-4 text-muted-foreground" />
                    <span className="font-medium tabular-nums">{p.number}</span>
                    <span>{p.specName ?? 'Run'}</span>
                    <Badge variant="secondary">{p.status.replace(/_/g, ' ').toLowerCase()}</Badge>
                    <span className="text-muted-foreground">{p.plannedQty} batches planned</span>
                  </div>

                  <div className="mt-2 flex flex-wrap items-end gap-2">
                    {p.status === 'DRAFT' && (
                      <Button size="sm" onClick={() => move(p.id, 'APPROVED')} disabled={busy}>
                        <CheckCircle2 className="mr-1.5 h-4 w-4" />
                        Approve
                      </Button>
                    )}
                    {(p.status === 'APPROVED' || p.status === 'IN_PROGRESS') && (
                      <>
                        <div className="space-y-1">
                          <Label className="text-xs">Batches actually made</Label>
                          <Input
                            className="w-32"
                            inputMode="decimal"
                            value={actual}
                            onChange={(e) => setMade((c) => ({ ...c, [p.id]: e.target.value }))}
                          />
                        </div>
                        {short && (
                          <div className="space-y-1">
                            <Label className="text-xs">Why short?</Label>
                            <select
                              className="h-10 rounded-lg border border-input bg-background px-2 text-sm"
                              value={reason[p.id] ?? ''}
                              onChange={(e) => setReason((c) => ({ ...c, [p.id]: e.target.value }))}
                            >
                              <option value="">Choose…</option>
                              {REASONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                            </select>
                          </div>
                        )}
                        <Button size="sm" onClick={() => finish(p.id, p.plannedQty)} disabled={busy}>
                          <Play className="mr-1.5 h-4 w-4" />
                          Complete run
                        </Button>
                      </>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        </SectionCard>
      )}

      <SectionCard
        title="Start a run"
        description="Planning consumes nothing. Approve it, then complete it when the food is actually made."
      >
        <div className="grid gap-4 sm:grid-cols-3">
          {data.houses.length > 1 && (
            <div className="space-y-1.5">
              <Label htmlFor="house">Production house</Label>
              <select id="house" className="h-10 w-full rounded-lg border border-input bg-background px-2 text-sm"
                value={houseId} onChange={(e) => setHouseId(e.target.value)}>
                {data.houses.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
              </select>
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="spec">What to make</Label>
            <select id="spec" className="h-10 w-full rounded-lg border border-input bg-background px-2 text-sm"
              value={specId} onChange={(e) => setSpecId(e.target.value)}>
              <option value="">Choose a recipe…</option>
              {data.specs.map((s) => (
                <option key={s.id} value={s.id}>{s.name} — {s.outputQty} {s.outputName} per batch</option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="batches">Batches</Label>
            <Input id="batches" inputMode="decimal" value={batches} onChange={(e) => setBatches(e.target.value)} />
          </div>
        </div>
        <Button className="mt-4" onClick={startRun} disabled={busy || !specId || !(Number(batches) > 0)}>
          <Plus className="mr-2 h-4 w-4" />
          Plan run
        </Button>
        {data.specs.length === 0 && (
          <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">
            No production recipes yet — add one below first.
          </p>
        )}
      </SectionCard>

      <SectionCard
        title="Production recipe"
        description="What one batch consumes and produces. Different from a menu recipe: this turns stock into different stock."
      >
        <div className="grid gap-4 sm:grid-cols-4">
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="sp-name">Name</Label>
            <Input id="sp-name" placeholder="e.g. Chicken Patty" value={specName} onChange={(e) => setSpecName(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sp-out">Produces</Label>
            <select id="sp-out" className="h-10 w-full rounded-lg border border-input bg-background px-2 text-sm"
              value={outputId} onChange={(e) => setOutputId(e.target.value)}>
              <option value="">Choose…</option>
              {data.items.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sp-qty">Per batch</Label>
            <Input id="sp-qty" inputMode="decimal" value={outputQty} onChange={(e) => setOutputQty(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sp-life">Shelf life (days)</Label>
            <Input id="sp-life" inputMode="numeric" placeholder="optional" value={shelfLife} onChange={(e) => setShelfLife(e.target.value)} />
          </div>
        </div>

        <p className="mt-4 mb-2 text-sm font-medium">Raw materials used per batch</p>
        <ul className="space-y-2">
          {lines.map((l) => (
            <li key={l.key} className="grid grid-cols-12 items-end gap-2">
              <div className="col-span-12 sm:col-span-6">
                <select className="h-10 w-full rounded-lg border border-input bg-background px-2 text-sm"
                  value={l.itemId}
                  onChange={(e) => setLines((c) => c.map((x) => x.key === l.key ? { ...x, itemId: e.target.value } : x))}>
                  <option value="">Choose an ingredient…</option>
                  {data.items.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
                </select>
              </div>
              <div className="col-span-5 sm:col-span-3">
                <Input inputMode="decimal" placeholder="Qty" value={l.quantity}
                  onChange={(e) => setLines((c) => c.map((x) => x.key === l.key ? { ...x, quantity: e.target.value } : x))} />
              </div>
              <div className="col-span-5 sm:col-span-2">
                <select className="h-10 w-full rounded-lg border border-input bg-background px-2 text-sm"
                  value={l.unit}
                  onChange={(e) => setLines((c) => c.map((x) => x.key === l.key ? { ...x, unit: e.target.value } : x))}>
                  {UNITS.map((u) => <option key={u} value={u}>{u.toLowerCase()}</option>)}
                </select>
              </div>
              <button type="button" aria-label="Remove"
                onClick={() => setLines((c) => c.filter((x) => x.key !== l.key))}
                className="col-span-2 flex h-10 items-center justify-center rounded-lg border border-border text-muted-foreground hover:bg-muted sm:col-span-1">
                <Trash2 className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>

        <div className="mt-3 flex gap-2">
          <Button variant="outline" size="sm"
            onClick={() => setLines((c) => [...c, { key: `${Date.now()}-${c.length}`, itemId: '', quantity: '', unit: 'KG' }])}>
            <Plus className="mr-1.5 h-4 w-4" />
            Add material
          </Button>
          <Button size="sm" onClick={saveSpec} disabled={busy}>Save recipe</Button>
        </div>
      </SectionCard>
    </div>
  )
}
