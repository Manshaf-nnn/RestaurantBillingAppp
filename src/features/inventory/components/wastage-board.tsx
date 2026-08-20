'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { Check, Trash2, X } from 'lucide-react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input, Textarea } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { LocalDateTime } from '@/components/local-time'
import { SectionCard } from '@/features/dashboard/components/page-header'
import { formatMoney } from '@/lib/money'
import { recordWastageAction, reviewWastageAction } from '../wastage-actions'

const REASONS = [
  { value: 'EXPIRED', label: 'Expired' },
  { value: 'SPOILED', label: 'Spoiled' },
  { value: 'BURNT', label: 'Burnt' },
  { value: 'DAMAGED', label: 'Damaged' },
  { value: 'DROPPED', label: 'Dropped' },
  { value: 'PREPARATION', label: 'Preparation waste' },
  { value: 'CUSTOMER_RETURN', label: 'Customer return' },
  { value: 'OTHER', label: 'Other' },
] as const

const UNITS = ['KG', 'GRAM', 'LITRE', 'ML', 'PIECE', 'PACK', 'BOTTLE', 'DOZEN', 'BOX'] as const

export interface WastageRow {
  id: string
  itemName: string
  quantity: number
  unit: string
  reason: string
  reasonLabel: string
  notes: string | null
  costValue: number
  status: string
  createdByName: string | null
  approvedByName: string | null
  createdAt: string
}

/**
 * Recording and reviewing wastage.
 *
 * The form is short on purpose — item, how much, why — because it is filled in
 * next to a bin during service, and every extra field is a reason to not bother.
 * Everything optional sits below the fold.
 */
export function WastageBoard({
  items,
  rows,
  currency,
  canApprove,
}: {
  items: Array<{ id: string; name: string; unit: string; quantity: number }>
  rows: WastageRow[]
  currency: string
  canApprove: boolean
}) {
  const router = useRouter()
  const money = (m: number) => formatMoney(m, currency)

  const [itemId, setItemId] = React.useState('')
  const [quantity, setQuantity] = React.useState('')
  const [unit, setUnit] = React.useState('')
  const [reason, setReason] = React.useState<string>('SPOILED')
  const [reasonNote, setReasonNote] = React.useState('')
  const [notes, setNotes] = React.useState('')
  const [busy, setBusy] = React.useState(false)

  const item = items.find((i) => i.id === itemId)
  React.useEffect(() => { if (item) setUnit(item.unit) }, [item])

  const submit = async () => {
    const q = Number(quantity)
    if (!itemId) { toast.error('Choose an item'); return }
    if (!Number.isFinite(q) || q <= 0) { toast.error('Enter how much was wasted'); return }
    if (reason === 'OTHER' && reasonNote.trim().length < 2) {
      toast.error('Say what happened when the reason is Other'); return
    }

    setBusy(true)
    const result = await recordWastageAction({
      itemId, quantity: q, unit: unit || undefined, reason, reasonNote, notes,
    })
    setBusy(false)
    if (!result.ok) { toast.error(result.error); return }
    toast.success(`Recorded — ${money(result.data.costValue)} written off`)
    setQuantity(''); setReasonNote(''); setNotes('')
    router.refresh()
  }

  const review = async (id: string, approve: boolean) => {
    setBusy(true)
    const result = await reviewWastageAction({ wastageId: id, approve })
    setBusy(false)
    if (!result.ok) { toast.error(result.error); return }
    toast.success(approve ? 'Approved' : 'Marked as disputed')
    router.refresh()
  }

  const pending = rows.filter((r) => r.status === 'RECORDED')

  return (
    <div className="space-y-5">
      <SectionCard
        title="Record wastage"
        description="Stock comes off immediately — the food is already gone. A manager reviews it afterwards."
      >
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="space-y-1.5 lg:col-span-2">
            <Label htmlFor="w-item">Item</Label>
            <select
              id="w-item"
              className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm"
              value={itemId}
              onChange={(e) => setItemId(e.target.value)}
            >
              <option value="">Choose…</option>
              {items.map((i) => (
                <option key={i.id} value={i.id}>{i.name}</option>
              ))}
            </select>
            {item && (
              <p className="text-xs text-muted-foreground">
                {item.quantity} {item.unit.toLowerCase()} in stock
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="w-qty">Quantity</Label>
            <Input id="w-qty" inputMode="decimal" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="w-unit">Unit</Label>
            <select
              id="w-unit"
              className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm"
              value={unit}
              onChange={(e) => setUnit(e.target.value)}
            >
              {UNITS.map((u) => <option key={u} value={u}>{u.toLowerCase()}</option>)}
            </select>
          </div>

          <div className="space-y-1.5 lg:col-span-2">
            <Label htmlFor="w-reason">Reason</Label>
            <select
              id="w-reason"
              className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            >
              {REASONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
            </select>
          </div>

          {reason === 'OTHER' && (
            <div className="space-y-1.5 lg:col-span-2">
              <Label htmlFor="w-note">What happened?</Label>
              <Input id="w-note" value={reasonNote} onChange={(e) => setReasonNote(e.target.value)} />
            </div>
          )}

          <div className="space-y-1.5 sm:col-span-2 lg:col-span-4">
            <Label htmlFor="w-notes">Notes (optional)</Label>
            <Textarea id="w-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
        </div>

        <Button className="mt-4" onClick={submit} disabled={busy}>
          <Trash2 className="mr-2 h-4 w-4" />
          {busy ? 'Recording…' : 'Record wastage'}
        </Button>
      </SectionCard>

      {canApprove && pending.length > 0 && (
        <SectionCard
          title="Awaiting review"
          description="These already came off stock. Reviewing confirms they were genuine."
          actions={<Badge variant="warning">{pending.length}</Badge>}
        >
          <ul className="divide-y divide-border">
            {pending.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-3 py-3 text-sm">
                <div className="min-w-0 flex-1">
                  <p className="font-medium">
                    {r.itemName} · {r.quantity} {r.unit.toLowerCase()}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {r.reasonLabel}
                    {r.notes ? ` — ${r.notes}` : ''}
                    {r.createdByName ? ` · ${r.createdByName}` : ''}
                  </p>
                </div>
                <span className="tabular-nums">{money(r.costValue)}</span>
                <div className="flex gap-1">
                  <Button size="sm" variant="outline" onClick={() => review(r.id, true)} disabled={busy}>
                    <Check className="h-4 w-4" />
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => review(r.id, false)} disabled={busy}>
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </SectionCard>
      )}

      <SectionCard title="Recent wastage">
        {rows.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">Nothing recorded yet.</p>
        ) : (
          <div className="-mx-2 overflow-x-auto px-2">
            <table className="w-full min-w-[38rem] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="pb-2 pr-3 font-medium">When</th>
                  <th className="pb-2 pr-3 font-medium">Item</th>
                  <th className="pb-2 pr-3 text-right font-medium">Quantity</th>
                  <th className="pb-2 pr-3 font-medium">Reason</th>
                  <th className="pb-2 pr-3 text-right font-medium">Value</th>
                  <th className="pb-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="whitespace-nowrap py-2.5 pr-3 text-muted-foreground">
                      <LocalDateTime value={r.createdAt} />
                    </td>
                    <td className="py-2.5 pr-3 font-medium">{r.itemName}</td>
                    <td className="py-2.5 pr-3 text-right tabular-nums">
                      {r.quantity} {r.unit.toLowerCase()}
                    </td>
                    <td className="py-2.5 pr-3">{r.reasonLabel}</td>
                    <td className="py-2.5 pr-3 text-right tabular-nums text-red-600 dark:text-red-400">
                      {money(r.costValue)}
                    </td>
                    <td className="py-2.5">
                      <Badge
                        variant={
                          r.status === 'APPROVED' ? 'success'
                            : r.status === 'REJECTED' ? 'destructive' : 'secondary'
                        }
                      >
                        {r.status.toLowerCase()}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>
    </div>
  )
}
