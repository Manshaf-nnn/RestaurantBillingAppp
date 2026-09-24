'use client'

import * as React from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ArrowRight, Building2, CalendarDays, Clock, Truck, User, X } from 'lucide-react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { LocalDateTime } from '@/components/local-time'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/primitives'
import { callAction } from '@/lib/use-action'
import { cn } from '@/lib/utils'
import {
  completeTransferAction,
  dispatchTransferAction,
  transferDetailAction,
} from '../actions'
import type { TransferDetailView } from './transfer-panel'
import type { TransferSummary } from '../queries'

/**
 * One transfer, read at a glance, without leaving the list.
 *
 * ── What this can and cannot do, and why ────────────────────────────────────
 *
 * The workflow is untouched. Every state and every rule still belongs to the
 * service, and this offers only the action that is genuinely available now:
 *
 *   - **Dispatch** and **Complete** are single decisions — one tap, and the
 *     same action the full page calls. They belong here.
 *   - **Receive** is not a decision, it is a FORM: a received quantity per
 *     line and a reason for anything short. A one-tap "mark as received" would
 *     be a different workflow — it would have to assume every line arrived in
 *     full, which is the case the variance rules exist for. So the button
 *     opens the transfer, where that form lives.
 *   - **Approve** happens on the Approvals desk, as it has since
 *     recorrection.md §1 made that the single door.
 *
 * Refusing to put a form in a drawer is the point, not a limitation: the
 * screen changed, the process did not.
 */

const STATUS: Record<string, { label: string; className: string }> = {
  REQUESTED: { label: 'Requested', className: 'bg-muted text-muted-foreground' },
  APPROVED: { label: 'Approved', className: 'bg-warning/15 text-warning' },
  DISPATCHED: { label: 'In Transit', className: 'bg-primary/15 text-primary' },
  IN_TRANSIT: { label: 'In Transit', className: 'bg-primary/15 text-primary' },
  RECEIVED: { label: 'Received', className: 'bg-success/15 text-success' },
  COMPLETED: { label: 'Completed', className: 'bg-success/15 text-success' },
  REJECTED: { label: 'Rejected', className: 'bg-destructive/15 text-destructive' },
  CANCELLED: { label: 'Cancelled', className: 'bg-muted text-muted-foreground' },
}

export function TransferDrawer({
  transferId,
  summary,
  can,
  onClose,
}: {
  transferId: string | null
  /** What the row already knows, so the panel has something to show at once. */
  summary: TransferSummary | null
  can: { dispatch: boolean; receive: boolean }
  onClose: () => void
}) {
  const router = useRouter()
  const [detail, setDetail] = React.useState<TransferDetailView | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [showAll, setShowAll] = React.useState(false)

  React.useEffect(() => {
    if (!transferId) return
    let active = true
    setDetail(null)
    setShowAll(false)
    setLoading(true)
    void callAction(() => transferDetailAction(transferId)).then((result) => {
      if (!active) return
      setLoading(false)
      if (result.ok) setDetail(result.data)
      else toast.error(result.error)
    })
    return () => {
      active = false
    }
  }, [transferId])

  // Escape closes, as it does on every other overlay in the app.
  React.useEffect(() => {
    if (!transferId) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [transferId, onClose])

  if (!transferId) return null

  const status = STATUS[detail?.status ?? summary?.status ?? 'REQUESTED'] ?? STATUS.REQUESTED
  const number = detail?.number ?? summary?.number ?? ''
  const fromName = detail?.fromName ?? summary?.fromName ?? ''
  const toName = detail?.toName ?? summary?.toName ?? ''

  const run = async (fn: () => Promise<{ ok: boolean; error?: string }>, done: string) => {
    setBusy(true)
    const result = await fn()
    setBusy(false)
    if (!result.ok) {
      toast.error(result.error ?? 'That did not work')
      return
    }
    toast.success(done)
    router.refresh()
    onClose()
  }

  const lines = detail?.lines ?? []
  const shown = showAll ? lines : lines.slice(0, 5)
  const totalQty = lines.reduce((sum, line) => sum + line.requestedQty, 0)

  return (
    <>
      {/* The scrim. Clicking it closes, which is what a scrim is for. */}
      <div
        className="fixed inset-0 z-40 bg-black/30 backdrop-blur-[1px] lg:bg-black/20"
        onClick={onClose}
        aria-hidden
      />

      <aside
        role="dialog"
        aria-modal="true"
        aria-label={`Transfer ${number}`}
        className="fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col border-l bg-card shadow-2xl"
      >
        {/* ── Head ──────────────────────────────────────────────────────── */}
        <div className="flex items-start justify-between gap-3 border-b px-5 py-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-bold tabular-nums">{number}</h2>
              <span className={cn('inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium', status.className)}>
                {status.label}
              </span>
            </div>
            {detail ? (
              <p className="mt-0.5 text-xs text-muted-foreground">
                Created on <LocalDateTime value={detail.requestedAt} />
              </p>
            ) : null}
          </div>
          <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close">
            <X />
          </Button>
        </div>

        <Tabs defaultValue="overview" className="flex min-h-0 flex-1 flex-col">
          <div className="border-b px-5">
            <TabsList>
              <TabsTrigger value="overview">Overview</TabsTrigger>
              <TabsTrigger value="items">Items{lines.length > 0 ? ` (${lines.length})` : ''}</TabsTrigger>
              <TabsTrigger value="history">History</TabsTrigger>
              <TabsTrigger value="notes">Notes</TabsTrigger>
            </TabsList>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            {loading && !detail ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : null}

            {/* ── Overview ──────────────────────────────────────────────── */}
            <TabsContent value="overview" className="mt-0 space-y-4">
              <div className="rounded-xl border p-4">
                <div className="grid grid-cols-[1fr_auto_1fr] items-start gap-2">
                  <div className="min-w-0">
                    <p className="text-xs text-muted-foreground">From Location</p>
                    <p className="mt-1 flex items-center gap-1.5 font-semibold">
                      <Building2 className="size-4 shrink-0 text-muted-foreground" />
                      <span className="truncate">{fromName}</span>
                    </p>
                  </div>
                  <ArrowRight className="mt-6 size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0">
                    <p className="text-xs text-muted-foreground">To Location</p>
                    <p className="mt-1 flex items-center gap-1.5 font-semibold">
                      <Building2 className="size-4 shrink-0 text-muted-foreground" />
                      <span className="truncate">{toName}</span>
                    </p>
                  </div>
                </div>

                {detail ? (
                  <dl className="mt-4 grid grid-cols-2 gap-4 border-t pt-4 text-sm">
                    <Fact icon={<User className="size-3.5" />} label="Created By" value={detail.requestedByName ?? '—'} />
                    <Fact
                      icon={<CalendarDays className="size-3.5" />}
                      label="Transfer Date"
                      value={<LocalDateTime value={detail.requestedAt} />}
                    />
                    <Fact
                      icon={<Truck className="size-3.5" />}
                      label="Status"
                      value={<span className={cn('inline-flex rounded-full px-2 py-0.5 text-xs font-medium', status.className)}>{status.label}</span>}
                    />
                    <Fact
                      icon={<Clock className="size-3.5" />}
                      label={detail.receivedAt ? 'Received' : detail.dispatchedAt ? 'Dispatched' : 'Requested'}
                      value={
                        <LocalDateTime value={detail.receivedAt ?? detail.dispatchedAt ?? detail.requestedAt} />
                      }
                    />
                  </dl>
                ) : null}

                {detail?.notes ? (
                  <div className="mt-4 border-t pt-4">
                    <p className="text-xs text-muted-foreground">Remarks</p>
                    <p className="mt-1 text-sm">{detail.notes}</p>
                  </div>
                ) : null}
              </div>

              {detail ? (
                <div className="rounded-xl border p-4">
                  <p className="text-sm font-semibold">Items Summary</p>
                  <div className="mt-3 grid grid-cols-2 gap-4">
                    <div>
                      <p className="text-xs text-muted-foreground">Total Items</p>
                      <p className="text-2xl font-bold tabular-nums">{lines.length}</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">Total Quantity</p>
                      <p className="text-2xl font-bold tabular-nums">{Math.round(totalQty * 1000) / 1000}</p>
                    </div>
                  </div>

                  <table className="mt-4 w-full text-sm">
                    <thead>
                      <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                        <th className="pb-2 font-medium">#</th>
                        <th className="pb-2 font-medium">Item</th>
                        <th className="pb-2 text-right font-medium">Qty</th>
                        <th className="pb-2 pl-3 font-medium">Unit</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {shown.map((line, index) => (
                        <tr key={line.id}>
                          <td className="py-2 text-muted-foreground tabular-nums">{index + 1}</td>
                          <td className="py-2">{line.name}</td>
                          <td className="py-2 text-right tabular-nums">{line.requestedQty}</td>
                          <td className="py-2 pl-3 text-muted-foreground">{line.unit.toLowerCase()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>

                  {lines.length > 5 ? (
                    <Button variant="ghost" size="sm" className="mt-2 w-full" onClick={() => setShowAll((v) => !v)}>
                      {showAll ? 'Show fewer' : `View All ${lines.length} Items`}
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </TabsContent>

            {/* ── Items ─────────────────────────────────────────────────── */}
            <TabsContent value="items" className="mt-0">
              {detail ? (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                      <th className="pb-2 font-medium">Item</th>
                      <th className="pb-2 text-right font-medium">Asked</th>
                      <th className="pb-2 text-right font-medium">Sent</th>
                      <th className="pb-2 text-right font-medium">Got</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {lines.map((line) => (
                      <tr key={line.id}>
                        <td className="py-2">
                          {line.name}
                          {line.variance !== null && Math.abs(line.variance) > 1e-6 ? (
                            <span className="ml-1.5 text-xs font-medium text-destructive">
                              {line.variance > 0 ? '+' : ''}{line.variance}
                              {line.varianceReason ? ` · ${line.varianceReason.replace(/_/g, ' ').toLowerCase()}` : ''}
                            </span>
                          ) : null}
                        </td>
                        <td className="py-2 text-right tabular-nums">{line.requestedQty}</td>
                        <td className="py-2 text-right tabular-nums text-muted-foreground">{line.sentQty ?? '—'}</td>
                        <td className="py-2 text-right tabular-nums text-muted-foreground">{line.receivedQty ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : null}
            </TabsContent>

            {/* ── History ───────────────────────────────────────────────── */}
            <TabsContent value="history" className="mt-0">
              {detail ? (
                <ol className="space-y-3">
                  <Step label="Requested" who={detail.requestedByName} at={detail.requestedAt} done />
                  <Step label="Approved" who={detail.approvedByName} at={detail.approvedAt} done={Boolean(detail.approvedAt)} />
                  <Step label="Dispatched" who={detail.dispatchedByName} at={detail.dispatchedAt} done={Boolean(detail.dispatchedAt)} />
                  <Step label="Received" who={detail.receivedByName} at={detail.receivedAt} done={Boolean(detail.receivedAt)} />
                </ol>
              ) : null}
            </TabsContent>

            {/* ── Notes ─────────────────────────────────────────────────── */}
            <TabsContent value="notes" className="mt-0">
              {detail?.notes ? (
                <p className="text-sm">{detail.notes}</p>
              ) : detail ? (
                <p className="text-sm text-muted-foreground">Nothing was written on this transfer.</p>
              ) : null}
            </TabsContent>
          </div>
        </Tabs>

        {/* ── The next action, and only the one that exists ──────────────── */}
        {detail ? (
          <div className="flex flex-wrap gap-2 border-t px-5 py-4">
            {detail.status === 'REQUESTED' ? (
              <Button className="flex-1" variant="outline" asChild>
                <Link href="/dashboard/approvals">Open the approvals desk</Link>
              </Button>
            ) : null}

            {can.dispatch && detail.status === 'APPROVED' ? (
              <Button
                className="flex-1"
                disabled={busy}
                onClick={() => run(() => dispatchTransferAction({ transferId: detail.id }), 'Dispatched')}
              >
                <Truck /> Dispatch
              </Button>
            ) : null}

            {can.receive && (detail.status === 'DISPATCHED' || detail.status === 'IN_TRANSIT') ? (
              /*
               * Receiving is a form, not a tap — a quantity per line and a
               * reason for anything short. It opens where that form lives.
               */
              <Button className="flex-1" asChild>
                <Link href={`/dashboard/transfers/${detail.id}`}>Receive this transfer</Link>
              </Button>
            ) : null}

            {can.receive && detail.status === 'RECEIVED' ? (
              <Button
                className="flex-1"
                disabled={busy}
                onClick={() => run(() => completeTransferAction(detail.id), 'Closed')}
              >
                Close it off
              </Button>
            ) : null}

            <Button variant="outline" asChild>
              <Link href={`/dashboard/transfers/${detail.id}`}>Open</Link>
            </Button>
          </div>
        ) : null}
      </aside>
    </>
  )
}

function Fact({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode
  label: string
  value: React.ReactNode
}) {
  return (
    <div>
      <dt className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {icon}
        {label}
      </dt>
      <dd className="mt-0.5 font-medium">{value}</dd>
    </div>
  )
}

function Step({
  label,
  who,
  at,
  done,
}: {
  label: string
  who: string | null
  at: string | null
  done: boolean
}) {
  return (
    <li className="flex gap-3">
      <span
        className={cn(
          'mt-1 size-2.5 shrink-0 rounded-full',
          done ? 'bg-success' : 'border border-border bg-muted',
        )}
      />
      <div className="min-w-0">
        <p className={cn('text-sm font-medium', !done && 'text-muted-foreground')}>{label}</p>
        {at ? (
          <p className="text-xs text-muted-foreground">
            <LocalDateTime value={at} />
            {who ? ` · ${who}` : ''}
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">Not yet</p>
        )}
      </div>
    </li>
  )
}
