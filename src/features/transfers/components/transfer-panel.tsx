'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { Check, PackageCheck, Send, Truck, X } from 'lucide-react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { LocalDateTime } from '@/components/local-time'
import { SectionCard } from '@/features/dashboard/components/page-header'
import {
  approveTransferAction, closeTransferAction, dispatchTransferAction, receiveTransferAction,
} from '../actions'

const REASONS = [
  { value: 'DAMAGED_IN_TRANSIT', label: 'Damaged in transit' },
  { value: 'MISSING', label: 'Missing' },
  { value: 'REJECTED_ON_ARRIVAL', label: 'Rejected on arrival' },
  { value: 'OTHER', label: 'Other' },
] as const

export interface TransferDetailView {
  id: string
  number: string
  status: string
  fromName: string
  toName: string
  notes: string | null
  requestedByName: string | null
  approvedByName: string | null
  dispatchedByName: string | null
  receivedByName: string | null
  requestedAt: string
  approvedAt: string | null
  dispatchedAt: string | null
  receivedAt: string | null
  lines: Array<{
    id: string
    name: string
    unit: string
    requestedQty: number
    sentQty: number | null
    receivedQty: number | null
    variance: number | null
    varianceReason: string | null
  }>
}

const STATUS: Record<string, { label: string; variant: 'secondary' | 'warning' | 'success' | 'destructive' }> = {
  REQUESTED: { label: 'Requested', variant: 'secondary' },
  APPROVED: { label: 'Approved', variant: 'success' },
  DISPATCHED: { label: 'On its way', variant: 'warning' },
  IN_TRANSIT: { label: 'In transit', variant: 'warning' },
  RECEIVED: { label: 'Received', variant: 'success' },
  COMPLETED: { label: 'Completed', variant: 'success' },
  REJECTED: { label: 'Rejected', variant: 'destructive' },
  CANCELLED: { label: 'Cancelled', variant: 'destructive' },
}

/**
 * One transfer, and whatever the viewer can do to it next.
 *
 * Only the action that is actually available at this stage is offered. Showing
 * a greyed-out "Receive" on a transfer nobody has dispatched invites clicking
 * it and being told no; showing nothing says the same thing more honestly.
 */
export function TransferPanel({
  detail,
  can,
}: {
  detail: TransferDetailView
  can: { approve: boolean; dispatch: boolean; receive: boolean }
}) {
  const router = useRouter()
  const status = STATUS[detail.status] ?? STATUS.REQUESTED

  const [received, setReceived] = React.useState<Record<string, string>>({})
  const [reasons, setReasons] = React.useState<Record<string, string>>({})
  const [busy, setBusy] = React.useState(false)

  const run = async (fn: () => Promise<{ ok: boolean; error?: string }>, done: string) => {
    setBusy(true)
    const result = await fn()
    setBusy(false)
    if (!result.ok) { toast.error(result.error ?? 'That did not work'); return }
    toast.success(done)
    router.refresh()
  }

  const receivable = detail.status === 'DISPATCHED' || detail.status === 'IN_TRANSIT'

  const submitReceive = async () => {
    const lines = detail.lines
      .filter((l) => (l.sentQty ?? 0) > 0)
      .map((l) => {
        const qty = received[l.id] === undefined ? (l.sentQty ?? 0) : Number(received[l.id]) || 0
        const short = qty < (l.sentQty ?? 0) - 1e-6
        return {
          lineId: l.id,
          receivedQty: qty,
          varianceReason: short ? (reasons[l.id] || undefined) : undefined,
        }
      })

    const missingReason = lines.find(
      (l, i) => l.receivedQty < (detail.lines.filter((x) => (x.sentQty ?? 0) > 0)[i]?.sentQty ?? 0) - 1e-6
        && !l.varianceReason,
    )
    if (missingReason) {
      toast.error('Something is short — choose a reason before receiving')
      return
    }

    await run(
      () => receiveTransferAction({ transferId: detail.id, lines }),
      'Received into stock',
    )
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border p-3 text-sm">
        <Badge variant={status.variant}>{status.label}</Badge>
        <span className="font-medium">{detail.fromName} → {detail.toName}</span>
        {detail.notes && <span className="text-muted-foreground">{detail.notes}</span>}
      </div>

      {can.approve && detail.status === 'REQUESTED' && (
        <SectionCard
          title="Approve this request"
          description="Approving reserves the stock at the source so it cannot be promised twice. It does not move anything yet."
        >
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => run(() => approveTransferAction(detail.id), 'Approved')} disabled={busy}>
              <Check className="mr-2 h-4 w-4" />
              Approve
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => run(
                () => closeTransferAction({ transferId: detail.id, status: 'REJECTED', reason: 'Not needed' }),
                'Rejected',
              )}
            >
              <X className="mr-2 h-4 w-4" />
              Reject
            </Button>
          </div>
        </SectionCard>
      )}

      {can.dispatch && detail.status === 'APPROVED' && (
        <SectionCard
          title="Send it"
          description="Stock leaves here now and shows as in transit at the destination until someone receives it."
        >
          <Button onClick={() => run(() => dispatchTransferAction({ transferId: detail.id }), 'Dispatched')} disabled={busy}>
            <Truck className="mr-2 h-4 w-4" />
            Dispatch
          </Button>
        </SectionCard>
      )}

      <SectionCard title="Items">
        <div className="-mx-2 overflow-x-auto px-2">
          <table className="w-full min-w-[34rem] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="pb-2 pr-3 font-medium">Item</th>
                <th className="pb-2 pr-3 text-right font-medium">Requested</th>
                <th className="pb-2 pr-3 text-right font-medium">Sent</th>
                <th className="pb-2 pr-3 text-right font-medium">Received</th>
                <th className="pb-2 text-right font-medium">Variance</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {detail.lines.map((l) => (
                <tr key={l.id}>
                  <td className="py-2.5 pr-3 font-medium">{l.name}</td>
                  <td className="py-2.5 pr-3 text-right tabular-nums">{l.requestedQty} {l.unit.toLowerCase()}</td>
                  <td className="py-2.5 pr-3 text-right tabular-nums">{l.sentQty ?? '—'}</td>
                  <td className="py-2.5 pr-3 text-right tabular-nums">{l.receivedQty ?? '—'}</td>
                  <td className="py-2.5 text-right tabular-nums">
                    {l.variance === null || l.variance === 0 ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      <span className="text-red-600 dark:text-red-400">
                        {l.variance} {l.varianceReason ? `(${l.varianceReason.replace(/_/g, ' ').toLowerCase()})` : ''}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SectionCard>

      {can.receive && receivable && (
        <SectionCard
          title="Receive delivery"
          description="Enter what actually arrived. Anything short needs a reason — the sent quantity is kept either way."
        >
          <ul className="space-y-3">
            {detail.lines.filter((l) => (l.sentQty ?? 0) > 0).map((l) => {
              const qty = received[l.id] === undefined ? String(l.sentQty ?? 0) : received[l.id]
              const short = Number(qty) < (l.sentQty ?? 0) - 1e-6
              return (
                <li key={l.id} className="grid grid-cols-12 items-end gap-2">
                  <div className="col-span-12 sm:col-span-5">
                    <p className="font-medium">{l.name}</p>
                    <p className="text-xs text-muted-foreground">{l.sentQty} {l.unit.toLowerCase()} sent</p>
                  </div>
                  <div className="col-span-5 space-y-1 sm:col-span-3">
                    <Label className="text-xs">Received</Label>
                    <Input
                      inputMode="decimal"
                      value={qty}
                      onChange={(e) => setReceived((c) => ({ ...c, [l.id]: e.target.value }))}
                    />
                  </div>
                  {short && (
                    <div className="col-span-7 space-y-1 sm:col-span-4">
                      <Label className="text-xs">Why is it short?</Label>
                      <select
                        className="h-10 w-full rounded-lg border border-input bg-background px-2 text-sm"
                        value={reasons[l.id] ?? ''}
                        onChange={(e) => setReasons((c) => ({ ...c, [l.id]: e.target.value }))}
                      >
                        <option value="">Choose…</option>
                        {REASONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                      </select>
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
          <Button className="mt-4" onClick={submitReceive} disabled={busy}>
            <PackageCheck className="mr-2 h-4 w-4" />
            {busy ? 'Receiving…' : 'Receive into stock'}
          </Button>
        </SectionCard>
      )}

      <SectionCard title="Timeline">
        <ul className="space-y-2 text-sm">
          <Step label="Requested" at={detail.requestedAt} by={detail.requestedByName} />
          <Step label="Approved" at={detail.approvedAt} by={detail.approvedByName} />
          <Step label="Dispatched" at={detail.dispatchedAt} by={detail.dispatchedByName} />
          <Step label="Received" at={detail.receivedAt} by={detail.receivedByName} />
        </ul>
      </SectionCard>
    </div>
  )
}

function Step({ label, at, by }: { label: string; at: string | null; by: string | null }) {
  return (
    <li className="flex items-center gap-3">
      <span
        className={`h-2 w-2 shrink-0 rounded-full ${at ? 'bg-primary' : 'bg-muted-foreground/30'}`}
      />
      <span className={at ? '' : 'text-muted-foreground'}>{label}</span>
      <span className="ml-auto text-xs text-muted-foreground">
        {at ? <><LocalDateTime value={at} />{by ? ` · ${by}` : ''}</> : 'not yet'}
      </span>
    </li>
  )
}
