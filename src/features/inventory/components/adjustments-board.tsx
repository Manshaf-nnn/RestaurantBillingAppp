'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ItemPicker } from '@/components/ui/item-picker'
import { LocalDateTime } from '@/components/local-time'
import { EmptyState } from '@/components/ui/feedback'
import { SectionCard } from '@/features/dashboard/components/page-header'
import { callAction } from '@/lib/use-action'
import { adjustStockAction } from '../stock-actions'
import Link from 'next/link'

const UNITS = ['KG', 'GRAM', 'LITRE', 'ML', 'PIECE', 'PACK', 'BOTTLE', 'DOZEN', 'BOX'] as const

const SELECT = 'h-10 w-full rounded-lg border border-input bg-background px-2 text-sm'

const STATUS: Record<string, { label: string; variant: 'warning' | 'success' | 'destructive' | 'secondary' }> = {
  PENDING: { label: 'Waiting for sign-off', variant: 'warning' },
  APPROVED: { label: 'Approved', variant: 'success' },
  REJECTED: { label: 'Not approved', variant: 'destructive' },
  WITHDRAWN: { label: 'Withdrawn', variant: 'secondary' },
}

export interface AdjustmentRequestRow {
  id: string
  reference: string
  itemName: string
  quantity: number
  unit: string
  direction: 'IN' | 'OUT'
  reason: string
  status: string
  value: string
  branchName: string | null
  requestedAt: string
  decisionNote: string | null
  /** Raised by the person reading this. */
  mine: boolean
}

export interface PostedAdjustmentRow {
  id: string
  itemName: string
  quantity: number
  unit: string
  direction: 'IN' | 'OUT'
  reason: string | null
  reference: string | null
  byName: string | null
  branchName: string | null
  at: string
}

/**
 * Raising a correction, and watching what happened to it (stockMa.md).
 *
 * One form, two verbs. Somebody who may adjust a balance sees "Apply
 * correction" and the stock moves when they press it; everybody else sees
 * "Send for approval" and nothing moves until it is signed. The button says
 * which of the two will happen, because a form that looks the same and does
 * something different is how people stop reading them.
 */
export function AdjustmentsBoard({
  items,
  requests,
  posted,
  canApplyDirectly,
  branchId,
}: {
  items: Array<{ id: string; name: string; unit: string; quantity: number }>
  requests: AdjustmentRequestRow[]
  posted: PostedAdjustmentRow[]
  canApplyDirectly: boolean
  branchId: string | null
}) {
  const router = useRouter()
  const [busy, setBusy] = React.useState(false)
  const [itemId, setItemId] = React.useState('')
  const [direction, setDirection] = React.useState<'IN' | 'OUT'>('IN')
  const [quantity, setQuantity] = React.useState('')
  const [unit, setUnit] = React.useState('')
  const [reason, setReason] = React.useState('')
  /** Blank means "value it at what the item already costs". */
  const [unitCost, setUnitCost] = React.useState('')

  const chosen = items.find((i) => i.id === itemId) ?? null
  React.useEffect(() => {
    if (chosen) setUnit(chosen.unit)
  }, [chosen])

  const value = Number(quantity)
  const ready = Boolean(itemId) && Number.isFinite(value) && value > 0 && reason.trim().length >= 2

  const submit = async () => {
    if (!ready) return
    setBusy(true)
    const result = await callAction(() =>
      adjustStockAction({
        itemId,
        quantity: value,
        unit: unit || undefined,
        direction,
        reason: reason.trim(),
        branchId: branchId ?? undefined,
        /* Only sent on the way in, and only when typed. */
        unitCost: direction === 'IN' && unitCost.trim() ? Number(unitCost) : undefined,
      }),
    )
    setBusy(false)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    toast.success(
      result.data.status === 'APPLIED'
        ? `${result.data.reference} — stock corrected`
        : `${result.data.reference} — sent for approval. Nothing has moved yet.`,
    )
    setItemId('')
    setQuantity('')
    setReason('')
    setUnitCost('')
    router.refresh()
  }

  return (
    <div className="space-y-6">
      <SectionCard
        title={canApplyDirectly ? 'Correct a balance' : 'Report a difference'}
        description={
          canApplyDirectly
            ? 'Posts to the ledger immediately, against your name, with its own reference.'
            : 'Goes to the approvals desk. The stock moves only when somebody signs it off, and never before.'
        }
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1 sm:col-span-2">
            <Label className="text-xs">Item</Label>
            <ItemPicker
              options={items.map((i) => ({
                value: i.id,
                label: i.name,
                hint: `system says ${Math.round(i.quantity * 100) / 100} ${i.unit.toLowerCase()}`,
              }))}
              value={itemId}
              onChange={setItemId}
              placeholder="Which item is wrong…"
              searchPlaceholder="Search stock items…"
            />
          </div>

          <div className="space-y-1">
            <Label className="text-xs" htmlFor="adj-direction">There is</Label>
            <select
              id="adj-direction"
              className={SELECT}
              value={direction}
              onChange={(event) => setDirection(event.target.value as 'IN' | 'OUT')}
            >
              <option value="IN">More than the system says</option>
              <option value="OUT">Less than the system says</option>
            </select>
          </div>

          <div className="grid grid-cols-[1fr_8rem] gap-2">
            <div className="space-y-1">
              <Label className="text-xs" htmlFor="adj-qty">Difference</Label>
              <Input
                id="adj-qty"
                type="number"
                inputMode="decimal"
                min={0}
                step="any"
                placeholder="0"
                value={quantity}
                onChange={(event) => setQuantity(event.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs" htmlFor="adj-unit">Unit</Label>
              <select
                id="adj-unit"
                className={SELECT}
                value={unit}
                onChange={(event) => setUnit(event.target.value)}
              >
                {UNITS.map((u) => (
                  <option key={u} value={u}>{u.toLowerCase()}</option>
                ))}
              </select>
            </div>
          </div>

          {/*
            What it cost, when stock came IN at a price the item does not
            already carry.

            Without this the ledger values the new stock at the item's CURRENT
            cost, so a new price can never enter the FIFO queue — which is what
            drove people to try creating a second item under the same name to
            get a new price in, and to hit the duplicate-name error instead.

            Only on the way in: what leaving stock is worth is decided by the
            layers it is drawn from, never by whoever removes it.
          */}
          {direction === 'IN' && (
            <div className="space-y-1 sm:col-span-2">
              <Label className="text-xs" htmlFor="adj-cost">
                Price per {(unit || 'unit').toLowerCase()} <span className="text-muted-foreground">(optional)</span>
              </Label>
              <Input
                id="adj-cost"
                type="number"
                inputMode="decimal"
                min={0}
                step="any"
                placeholder={`Leave blank to use the current cost`}
                value={unitCost}
                onChange={(event) => setUnitCost(event.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Sets the price for this batch only. It stays queued behind stock you already have and
                takes over once that runs out. For a supplier delivery use{' '}
                <Link className="underline" href="/dashboard/purchases">Purchases</Link> instead, so the invoice
                and supplier are recorded too.
              </p>
            </div>
          )}

          <div className="space-y-1 sm:col-span-2">
            <Label className="text-xs" htmlFor="adj-reason">Why</Label>
            <Input
              id="adj-reason"
              placeholder="Counted the shelf twice — six bottles, not eight"
              maxLength={200}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </div>

          <div className="sm:col-span-2">
            <Button disabled={busy || !ready} loading={busy} onClick={submit}>
              {canApplyDirectly ? 'Apply correction' : 'Send for approval'}
            </Button>
          </div>
        </div>
      </SectionCard>

      <SectionCard
        title="Sent for approval"
        description="Corrections waiting on a signature, and what was decided about the last few."
      >
        {requests.length === 0 ? (
          <EmptyState title="Nothing waiting" description="Corrections you send for approval appear here until they are ruled on." />
        ) : (
          <ul className="divide-y divide-border">
            {requests.map((row) => {
              const state = STATUS[row.status] ?? { label: row.status, variant: 'secondary' as const }
              return (
                <li key={row.id} className="py-3 text-sm" data-status={row.status}>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs text-muted-foreground">{row.reference}</span>
                    <span className="font-medium">{row.itemName}</span>
                    <span className="tabular-nums text-muted-foreground">
                      {row.direction === 'IN' ? '+' : '−'}{row.quantity} {row.unit.toLowerCase()}
                    </span>
                    <Badge variant={state.variant} size="sm">{state.label}</Badge>
                    {row.mine ? <Badge variant="secondary" size="sm">yours</Badge> : null}
                    <span className="ml-auto text-xs text-muted-foreground">
                      <LocalDateTime value={row.requestedAt} />
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {row.reason}
                    {row.branchName ? ` · ${row.branchName}` : ''} · {row.value}
                  </p>
                  {row.decisionNote ? (
                    <p className="mt-1 text-xs italic text-muted-foreground">“{row.decisionNote}”</p>
                  ) : null}
                </li>
              )
            })}
          </ul>
        )}
      </SectionCard>

      <SectionCard title="Posted corrections" description="What actually moved, newest first.">
        {posted.length === 0 ? (
          <EmptyState title="No corrections yet" description="Every applied correction is listed here with its reference." />
        ) : (
          <ul className="divide-y divide-border">
            {posted.map((row) => (
              <li key={row.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
                {row.reference ? (
                  <span className="font-mono text-xs text-muted-foreground">{row.reference}</span>
                ) : null}
                <span className="font-medium">{row.itemName}</span>
                <span className="tabular-nums text-muted-foreground">
                  {row.direction === 'IN' ? '+' : '−'}{Math.round(row.quantity * 100) / 100} {row.unit.toLowerCase()}
                </span>
                {row.reason ? <span className="text-xs text-muted-foreground">{row.reason}</span> : null}
                <span className="ml-auto text-xs text-muted-foreground">
                  {row.byName ? `${row.byName} · ` : ''}
                  <LocalDateTime value={row.at} />
                </span>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  )
}
