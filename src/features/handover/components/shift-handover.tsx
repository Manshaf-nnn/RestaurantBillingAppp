'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { ArrowRightLeft, Check, Clock, X } from 'lucide-react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Alert, EmptyState } from '@/components/ui/feedback'
import { Input, Textarea } from '@/components/ui/input'
import { ItemPicker } from '@/components/ui/item-picker'
import { Label } from '@/components/ui/label'
import { LocalDateTime } from '@/components/local-time'
import { SectionCard } from '@/features/dashboard/components/page-header'
import {
  DenominationGrid,
  countsToNumbers,
  physicalTotal,
  type DenominationCounts,
} from '@/features/cashdrawer/components/denomination-grid'
import { formatMoney } from '@/lib/money'
import { callAction } from '@/lib/use-action'
import {
  acceptShiftHandoverAction,
  cancelShiftHandoverAction,
  previewShiftHandoverAction,
  rejectShiftHandoverAction,
  startShiftHandoverAction,
} from '../shift-actions'
import type { HandoverDone, HandoverPreview, HandoverSummary, ShiftHandoverView } from '../shift-types'

/**
 * The shift handover, for every role (recorrection.md §2, shifthandover.md §4).
 *
 *   [Start handover] → Select who takes over → Review & count → Confirm → Pending acceptance
 *   Waiting for you: Review → Accept · Reject (with a reason)
 *   Yours in progress: waiting on them · Withdraw
 *   History
 *
 * One screen for all of it, deliberately. The cash handover used to be
 * requested on the drawer console and accepted on the session screen — two
 * screens and a walk across the floor between them, with nothing telling the
 * receiver anything had happened. Now the receiver is notified, and the
 * accepting is done where the summary is.
 *
 * ── The till is counted blind ─────────────────────────────────────────────
 *
 * The count step is a grid of notes and coins and nothing else. What the
 * system expected, and the gap, are not on this screen until the handover is
 * confirmed — the server does not even send them to the person counting. A
 * count taken with the target in view is not a count.
 */

const STATUS: Record<ShiftHandoverView['status'], { label: string; variant: 'secondary' | 'warning' | 'success' | 'destructive' }> = {
  PENDING_ACCEPTANCE: { label: 'Pending acceptance', variant: 'warning' },
  COMPLETED: { label: 'Completed', variant: 'success' },
  REJECTED: { label: 'Rejected', variant: 'destructive' },
  CANCELLED: { label: 'Withdrawn', variant: 'secondary' },
}

export function ShiftHandoverPanel({
  viewerId,
  viewerName,
  waiting,
  mine,
  history,
  canCancelOthers,
  currency,
  locale,
  branchId,
  showHistory = true,
}: {
  viewerId: string
  viewerName: string
  /** Handovers waiting for the viewer to accept. */
  waiting: ShiftHandoverView[]
  /** The viewer's own handover still waiting on somebody. */
  mine: ShiftHandoverView | null
  history: ShiftHandoverView[]
  canCancelOthers: boolean
  currency: string
  locale: string
  /** The switcher's choice, for somebody who works across every location. */
  branchId: string | null
  /** The Shift tab renders the history itself, with filters. */
  showHistory?: boolean
}) {
  const router = useRouter()
  const [starting, setStarting] = React.useState(false)
  const [reviewing, setReviewing] = React.useState<ShiftHandoverView | null>(null)
  const [details, setDetails] = React.useState<ShiftHandoverView | null>(null)
  const [busy, setBusy] = React.useState<string | null>(null)

  const money = (minor: number) => formatMoney(minor, currency, locale)

  const cancel = async (row: ShiftHandoverView) => {
    setBusy(row.id)
    const result = await callAction(() => cancelShiftHandoverAction({ handoverId: row.id }))
    setBusy(null)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    toast.success(result.data.reopenedSessionId ? 'Withdrawn — your drawer is open again with what you counted.' : 'Withdrawn.')
    router.refresh()
  }

  return (
    <div className="space-y-5">
      {waiting.length > 0 ? (
        <SectionCard
          title={`Waiting for you (${waiting.length})`}
          description="Somebody is handing their shift to you. Read what they left before you accept it."
        >
          <ul className="space-y-3">
            {waiting.map((row) => (
              <li key={row.id} className="rounded-lg border border-primary/40 bg-primary/5 p-3 text-sm">
                <p className="flex flex-wrap items-center gap-2 font-medium">
                  {row.fromName} → you
                  <span className="font-normal text-muted-foreground">
                    · {row.branchName} · <LocalDateTime value={row.createdAt} />
                  </span>
                </p>
                <p className="mt-1 text-muted-foreground">
                  {row.summary.drawer
                    ? `Till ${row.summary.drawer.sessionNumber} counted ${money(row.summary.drawer.countedCash ?? 0)}${
                        row.summary.drawer.variance ? ` (${row.summary.drawer.variance > 0 ? 'over' : 'short'} by ${money(Math.abs(row.summary.drawer.variance))})` : ''
                      } · `
                    : ''}
                  {row.summary.orders.open} open order{row.summary.orders.open === 1 ? '' : 's'} · {row.summary.tasks.length} open task{row.summary.tasks.length === 1 ? '' : 's'}
                </p>
                <div className="mt-2 flex gap-2">
                  <Button size="sm" onClick={() => setReviewing(row)}>Review &amp; accept</Button>
                </div>
              </li>
            ))}
          </ul>
        </SectionCard>
      ) : null}

      <SectionCard
        title="Your handover"
        description={
          mine
            ? undefined
            : 'Going home? Hand your shift — and your till, if you have one — to whoever is taking over.'
        }
        actions={
          mine ? null : (
            <Button onClick={() => setStarting(true)}>
              <ArrowRightLeft className="mr-2 h-4 w-4" />
              Start handover
            </Button>
          )
        }
      >
        {mine ? (
          <div className="space-y-2 text-sm">
            <div className="flex flex-wrap items-center gap-3">
              <Badge variant="warning"><Clock /> waiting</Badge>
              <span>
                Waiting for <strong>{mine.toName}</strong> to accept · started <LocalDateTime value={mine.createdAt} />
              </span>
              <Button variant="outline" size="sm" className="ml-auto" loading={busy === mine.id} onClick={() => cancel(mine)}>
                Withdraw
              </Button>
            </div>
            {mine.summary.drawer ? <Reconciliation drawer={mine.summary.drawer} money={money} /> : null}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            You have nothing in progress. Starting one shows you a summary of your shift first — orders, open tasks, notes, and your drawer if you have one — then the person you choose accepts it on their own screen.
          </p>
        )}
      </SectionCard>

      {showHistory ? (
        <SectionCard title="Handover history" description="Who handed over to whom, and what was decided.">
          <HandoverHistoryTable
            rows={history}
            viewerId={viewerId}
            mineId={mine?.id ?? null}
            canCancelOthers={canCancelOthers}
            busy={busy}
            money={money}
            onDetails={setDetails}
            onCancel={cancel}
          />
        </SectionCard>
      ) : null}

      <StartHandoverDialog
        open={starting}
        onClose={() => setStarting(false)}
        viewerName={viewerName}
        branchId={branchId}
        currency={currency}
        locale={locale}
      />

      <ReviewDialog
        row={reviewing}
        onClose={() => setReviewing(null)}
        currency={currency}
        locale={locale}
      />

      <HandoverDetailsDialog row={details} onClose={() => setDetails(null)} currency={currency} locale={locale} />
    </div>
  )
}

/* ── the history table, shared with the Shift tab's filtered history ─────── */

export function HandoverHistoryTable({
  rows,
  viewerId,
  mineId,
  canCancelOthers,
  busy,
  money,
  onDetails,
  onCancel,
}: {
  rows: ShiftHandoverView[]
  viewerId: string
  mineId: string | null
  canCancelOthers: boolean
  busy: string | null
  money: (minor: number) => string
  onDetails: (row: ShiftHandoverView) => void
  onCancel: (row: ShiftHandoverView) => void
}) {
  if (rows.length === 0) {
    return <EmptyState title="No handovers yet" description="Every handover — accepted, rejected or withdrawn — is listed here." />
  }
  return (
    <div className="-mx-2 overflow-x-auto px-2">
      <table className="w-full min-w-[40rem] text-sm">
        <thead>
          <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
            <th className="pb-2 pr-3 font-medium">Date</th>
            <th className="pb-2 pr-3 font-medium">Outgoing</th>
            <th className="pb-2 pr-3 font-medium">Receiving</th>
            <th className="pb-2 pr-3 font-medium">Location</th>
            <th className="pb-2 pr-3 font-medium">Shift</th>
            <th className="pb-2 pr-3 font-medium">Till</th>
            <th className="pb-2 pr-3 font-medium">Status</th>
            <th className="pb-2" />
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.map((row) => {
            const status = STATUS[row.status]
            const own = row.fromId === viewerId
            return (
              <tr key={row.id} data-status={row.status}>
                <td className="py-2 pr-3 text-muted-foreground"><LocalDateTime value={row.createdAt} /></td>
                <td className="py-2 pr-3">{row.fromName}</td>
                <td className="py-2 pr-3">{row.toName}</td>
                <td className="py-2 pr-3">{row.branchName}</td>
                <td className="py-2 pr-3 text-muted-foreground">
                  {row.templateName ?? (row.summary.shift ? <>since <LocalDateTime value={row.summary.shift.clockInAt} /></> : '—')}
                </td>
                <td className="py-2 pr-3 tabular-nums">
                  {row.cash ? `${money(row.cash.countedAmount)}${row.cash.variance ? ` (${row.cash.variance > 0 ? '+' : '−'}${money(Math.abs(row.cash.variance))})` : ''}` : '—'}
                </td>
                <td className="py-2 pr-3"><Badge variant={status.variant}>{status.label}</Badge></td>
                <td className="py-2 text-right">
                  <span className="flex justify-end gap-1">
                    <Button variant="ghost" size="sm" onClick={() => onDetails(row)}>Details</Button>
                    {row.status === 'PENDING_ACCEPTANCE' && (own || canCancelOthers) && row.id !== mineId ? (
                      <Button variant="outline" size="sm" loading={busy === row.id} onClick={() => onCancel(row)}>Withdraw</Button>
                    ) : null}
                  </span>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

export function HandoverDetailsDialog({
  row,
  onClose,
  currency,
  locale,
}: {
  row: ShiftHandoverView | null
  onClose: () => void
  currency: string
  locale: string
}) {
  return (
    <Dialog open={row !== null} onOpenChange={(next) => (next ? null : onClose())}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        {row ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex flex-wrap items-center gap-2">
                {row.fromName} → {row.toName}
                <Badge variant={STATUS[row.status].variant}>{STATUS[row.status].label}</Badge>
              </DialogTitle>
              <DialogDescription>
                {row.branchName} · <LocalDateTime value={row.createdAt} />
                {row.decidedAt ? <> · decided <LocalDateTime value={row.decidedAt} />{row.decidedByName ? ` by ${row.decidedByName}` : ''}</> : null}
              </DialogDescription>
            </DialogHeader>
            {row.rejectReason ? (
              <Alert variant="destructive" title="Not accepted">{row.rejectReason}</Alert>
            ) : null}
            {row.notes ? <p className="text-sm">“{row.notes}”</p> : null}
            <SummaryView summary={row.summary} currency={currency} locale={locale} />
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

/* ── the wizard: Select → Review & count → Confirm ───────────────────────── */

function StartHandoverDialog({
  open,
  onClose,
  viewerName,
  branchId,
  currency,
  locale,
}: {
  open: boolean
  onClose: () => void
  viewerName: string
  branchId: string | null
  currency: string
  locale: string
}) {
  const router = useRouter()
  const [step, setStep] = React.useState<'select' | 'review' | 'done'>('select')
  const [preview, setPreview] = React.useState<HandoverPreview | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [toUserId, setToUserId] = React.useState('')
  const [counts, setCounts] = React.useState<DenominationCounts>({})
  const [notes, setNotes] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [done, setDone] = React.useState<{ to: string; drawer: HandoverDone['drawer'] } | null>(null)

  const money = (minor: number) => formatMoney(minor, currency, locale)

  // Fresh each time it opens: the drawer moves with every sale.
  React.useEffect(() => {
    if (!open) return
    setStep('select')
    setToUserId('')
    setCounts({})
    setNotes('')
    setDone(null)
    setPreview(null)
    setLoading(true)
    void callAction(() => previewShiftHandoverAction({ branchId: branchId ?? '' })).then((result) => {
      setLoading(false)
      if (result.ok) setPreview(result.data)
      else toast.error(result.error)
    })
  }, [open, branchId])

  const receiver = preview?.receivers.find((r) => r.id === toUserId) ?? null
  const counted = preview ? physicalTotal(preview.denominations, counts) : 0
  const anyCounted = Object.keys(countsToNumbers(counts)).length > 0
  const countOk = !preview?.hasDrawer || anyCounted

  const confirm = async () => {
    if (!preview || !toUserId || !countOk) return
    setBusy(true)
    const result = await callAction(() =>
      startShiftHandoverAction({
        toUserId,
        branchId: preview.branchId,
        notes,
        counts: preview.hasDrawer ? countsToNumbers(counts) : null,
      }),
    )
    setBusy(false)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    setDone({ to: receiver?.name ?? 'them', drawer: result.data.drawer })
    setStep('done')
    router.refresh()
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? null : onClose())}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {step === 'select' ? 'Who is taking over?' : step === 'review' ? 'Review your shift' : 'Handed over'}
          </DialogTitle>
          <DialogDescription>
            {step === 'select'
              ? `Step 1 of 3 — at ${preview?.branchName ?? 'your location'}. Only people who can do your job here are listed.`
              : step === 'review'
                ? 'Step 2 of 3 — this is what they will see. Confirm to hand over; nothing changes until you do.'
                : `Waiting for ${done?.to ?? 'them'} to accept. They have been notified.`}
          </DialogDescription>
        </DialogHeader>

        {loading ? <p className="text-sm text-muted-foreground">Looking at your shift…</p> : null}

        {step === 'select' && preview ? (
          <div className="space-y-3">
            {preview.receivers.length === 0 ? (
              <Alert variant="warning" title="Nobody to hand to">
                Nobody at {preview.branchName} can take over your shift right now{preview.hasDrawer ? ' — the till goes with it, so they need to work a till' : ''}.
              </Alert>
            ) : (
              <div className="space-y-1.5">
                <Label>Taking over</Label>
                <ItemPicker
                  options={preview.receivers.map((r) => ({
                    value: r.id,
                    label: r.name,
                    hint: `${r.roleLabel} — ${r.branchName ?? 'every location'}${r.available ? '' : ' · already has a handover waiting'}`,
                    disabled: !r.available,
                  }))}
                  value={toUserId}
                  onChange={setToUserId}
                  placeholder="Choose a colleague…"
                  searchPlaceholder="Search by name…"
                />
              </div>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={onClose}>Not now</Button>
              <Button disabled={!toUserId} onClick={() => setStep('review')}>Review</Button>
            </div>
          </div>
        ) : null}

        {step === 'review' && preview ? (
          <div className="space-y-4">
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-lg border p-3 text-sm">
              <dt className="text-xs text-muted-foreground">Outgoing</dt>
              <dd className="font-medium">{viewerName}</dd>
              <dt className="text-xs text-muted-foreground">Receiving</dt>
              <dd className="font-medium">{receiver?.name} <span className="font-normal text-muted-foreground">({receiver?.roleLabel})</span></dd>
              <dt className="text-xs text-muted-foreground">When</dt>
              <dd className="font-medium">Now — the record is stamped when you confirm</dd>
            </dl>
            <SummaryView summary={preview.summary} currency={currency} locale={locale} />

            {preview.hasDrawer && preview.summary.drawer ? (
              <div className="space-y-3 rounded-lg border p-3" data-testid="handover-count">
                <p className="text-sm font-medium">Your till goes with your shift. Count it, note by note.</p>
                <DenominationGrid
                  denominations={preview.denominations}
                  counts={counts}
                  onChange={setCounts}
                  money={money}
                  idPrefix="sh-count"
                />
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-muted/40 px-4 py-3">
                  <span className="text-sm font-medium">Cash counted</span>
                  <span className="text-xl font-bold tabular-nums">{money(counted)}</span>
                </div>
                <p className="text-xs text-muted-foreground">
                  {/*
                    Said out loud, because a cashier who expects to see a
                    variance and does not will assume the screen is broken.
                  */}
                  The difference against what the system expected is worked out when you confirm, and shown on your handover card.
                </p>
              </div>
            ) : null}

            <div className="space-y-1.5">
              <Label htmlFor="sh-notes">Anything they should know (optional)</Label>
              <Textarea
                id="sh-notes"
                rows={2}
                value={notes}
                onChange={(event) => setNotes(event.target.value.slice(0, 1000))}
                placeholder="e.g. table 6 still owes for two drinks; the walk-in door sticks"
              />
            </div>

            <div className="flex justify-between gap-2">
              <Button variant="ghost" onClick={() => setStep('select')}>Back</Button>
              <Button disabled={busy || !countOk} loading={busy} onClick={confirm}>
                <Check className="mr-2 h-4 w-4" />
                Confirm handover
              </Button>
            </div>
          </div>
        ) : null}

        {step === 'done' ? (
          <div className="space-y-3">
            {done?.drawer ? (
              <div className="rounded-lg border p-3 text-sm" data-testid="handover-reconciliation">
                <p className="mb-2 font-medium">Your till, reconciled</p>
                <Reconciliation
                  drawer={{
                    countedCash: done.drawer.countedCash,
                    expectedCash: done.drawer.expectedCash,
                    variance: done.drawer.variance,
                    needsReview: done.drawer.needsReview,
                  }}
                  money={money}
                />
              </div>
            ) : null}
            <div className="flex justify-end">
              <Button onClick={onClose}>Done</Button>
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

/** Counted against expected — shown only once the count has been submitted. */
function Reconciliation({
  drawer,
  money,
}: {
  drawer: { countedCash: number | null; expectedCash: number | null; variance: number | null; needsReview?: boolean }
  money: (minor: number) => string
}) {
  if (drawer.countedCash === null || drawer.expectedCash === null || drawer.variance === null) return null
  const over = drawer.variance > 0
  return (
    <dl className="grid grid-cols-3 gap-2 text-sm">
      <div className="rounded-lg border bg-muted/30 px-3 py-2">
        <dt className="text-xs text-muted-foreground">Counted</dt>
        <dd className="font-semibold tabular-nums">{money(drawer.countedCash)}</dd>
      </div>
      <div className="rounded-lg border bg-muted/30 px-3 py-2">
        <dt className="text-xs text-muted-foreground">Expected</dt>
        <dd className="font-semibold tabular-nums">{money(drawer.expectedCash)}</dd>
      </div>
      <div className="rounded-lg border bg-muted/30 px-3 py-2">
        <dt className="text-xs text-muted-foreground">{drawer.variance === 0 ? 'Balanced' : over ? 'Over' : 'Short'}</dt>
        <dd className={`font-semibold tabular-nums ${drawer.variance === 0 ? '' : over ? 'text-success' : 'text-destructive'}`}>
          {drawer.variance === 0 ? '✓' : money(Math.abs(drawer.variance))}
        </dd>
        {drawer.needsReview ? <dd className="text-xs text-muted-foreground">Waiting for a manager’s review</dd> : null}
      </div>
    </dl>
  )
}

/* ── the receiver's side: read it, then accept or reject with a reason ───── */

function ReviewDialog({
  row,
  onClose,
  currency,
  locale,
}: {
  row: ShiftHandoverView | null
  onClose: () => void
  currency: string
  locale: string
}) {
  const router = useRouter()
  const [rejecting, setRejecting] = React.useState(false)
  const [reason, setReason] = React.useState('')
  const [busy, setBusy] = React.useState(false)

  React.useEffect(() => {
    setRejecting(false)
    setReason('')
  }, [row?.id])

  const accept = async () => {
    if (!row) return
    setBusy(true)
    const result = await callAction(() => acceptShiftHandoverAction({ handoverId: row.id }))
    setBusy(false)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    toast.success(result.data.sessionId ? 'Shift accepted — the till is yours now.' : 'Shift accepted.')
    onClose()
    router.refresh()
  }

  const reject = async () => {
    if (!row || reason.trim().length < 2) return
    setBusy(true)
    const result = await callAction(() => rejectShiftHandoverAction({ handoverId: row.id, reason: reason.trim() }))
    setBusy(false)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    toast.message('Not accepted. They have been told why.')
    onClose()
    router.refresh()
  }

  return (
    <Dialog open={row !== null} onOpenChange={(next) => (next ? null : onClose())}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        {row ? (
          <>
            <DialogHeader>
              <DialogTitle>{row.fromName} is handing their shift to you</DialogTitle>
              <DialogDescription>
                {row.branchName} · <LocalDateTime value={row.createdAt} />. Once you accept, what is open is yours
                {row.summary.drawer ? ' — and the till opens in your name with what they counted' : ''}.
              </DialogDescription>
            </DialogHeader>
            {row.notes ? <p className="text-sm">“{row.notes}”</p> : null}
            <SummaryView summary={row.summary} currency={currency} locale={locale} />

            {rejecting ? (
              <div className="space-y-2 border-t pt-3">
                <Label htmlFor="sh-reject">Why are you not accepting it?</Label>
                <Input
                  id="sh-reject"
                  autoFocus
                  value={reason}
                  onChange={(event) => setReason(event.target.value.slice(0, 300))}
                  placeholder={row.summary.drawer ? 'e.g. the drawer count does not match' : 'e.g. I am not on shift tonight'}
                />
                <div className="flex justify-end gap-2">
                  <Button variant="ghost" disabled={busy} onClick={() => setRejecting(false)}>Back</Button>
                  <Button variant="destructive" disabled={busy || reason.trim().length < 2} loading={busy} onClick={reject}>
                    <X className="mr-2 h-4 w-4" />
                    Reject
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex justify-end gap-2 border-t pt-3">
                <Button variant="outline" disabled={busy} onClick={() => setRejecting(true)}>Reject…</Button>
                <Button disabled={busy} loading={busy} onClick={accept}>
                  <Check className="mr-2 h-4 w-4" />
                  Accept
                </Button>
              </div>
            )}
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

/* ── the summary, the same wherever it is read ───────────────────────────── */

export function SummaryView({ summary, currency, locale }: { summary: HandoverSummary; currency: string; locale: string }) {
  const money = (minor: number) => formatMoney(minor, currency, locale)
  const drawer = summary.drawer
  const pendingWork = [
    summary.orders.pending ? `${summary.orders.pending} order${summary.orders.pending === 1 ? '' : 's'} waiting to be accepted` : null,
    summary.transfers?.toDispatch ? `${summary.transfers.toDispatch} transfer${summary.transfers.toDispatch === 1 ? '' : 's'} to dispatch` : null,
    summary.transfers?.toReceive ? `${summary.transfers.toReceive} transfer${summary.transfers.toReceive === 1 ? '' : 's'} to receive` : null,
    summary.deliveriesToReceive ? `${summary.deliveriesToReceive} deliver${summary.deliveriesToReceive === 1 ? 'y' : 'ies'} to receive` : null,
  ].filter((line): line is string => line !== null)

  return (
    <div className="space-y-3 text-sm" data-testid="handover-summary">
      <div className="grid gap-2 sm:grid-cols-3">
        <Stat label="Location" value={summary.branchName} />
        <Stat label="Orders today" value={String(summary.orders.today)} hint={`${summary.orders.open} still open`} />
        <Stat
          label={summary.shift?.templateName ? `${summary.shift.templateName} shift — since` : 'On shift since'}
          value={summary.shift ? <LocalDateTime value={summary.shift.clockInAt} /> : '—'}
        />
      </div>

      {drawer ? (
        <div className="rounded-lg border p-3" data-testid="handover-drawer">
          <p className="font-medium">Till {drawer.sessionNumber}{drawer.registerName ? ` · ${drawer.registerName}` : ''}</p>
          <dl className="mt-1 grid grid-cols-2 gap-x-4 gap-y-0.5 text-muted-foreground sm:grid-cols-3">
            <dt>Opening cash</dt><dd className="tabular-nums">{money(drawer.openingFloat)}</dd>
            {drawer.cashSales !== undefined ? (<><dt>Cash sales</dt><dd className="tabular-nums">{money(drawer.cashSales)}</dd></>) : null}
            {drawer.refunds !== undefined ? (<><dt>Cash refunds</dt><dd className="tabular-nums">{money(drawer.refunds)}</dd></>) : null}
            {drawer.cashIn !== undefined ? (<><dt>Cash in</dt><dd className="tabular-nums">{money(drawer.cashIn)}</dd></>) : null}
            {drawer.cashOut !== undefined ? (<><dt>Cash out</dt><dd className="tabular-nums">{money(drawer.cashOut)}</dd></>) : null}
            {drawer.movements !== undefined ? (<><dt>Movements</dt><dd className="tabular-nums">{drawer.movements}</dd></>) : null}
          </dl>
          {drawer.expectedCash !== null && drawer.countedCash !== null && drawer.variance !== null ? (
            <div className="mt-2">
              <Reconciliation drawer={drawer} money={money} />
            </div>
          ) : drawer.expectedCash !== null ? (
            <p className="mt-1 text-muted-foreground">Expected {money(drawer.expectedCash)}</p>
          ) : (
            <p className="mt-1 text-xs text-muted-foreground">Expected cash and the difference are shown once the count is submitted.</p>
          )}
        </div>
      ) : null}

      {pendingWork.length > 0 ? (
        <div>
          <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Still to do</p>
          <ul className="divide-y rounded-lg border">
            {pendingWork.map((line) => (
              <li key={line} className="px-3 py-1.5">{line}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <div>
        <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Open tasks ({summary.tasks.length})
        </p>
        {summary.tasks.length === 0 ? (
          <p className="text-muted-foreground">Nothing outstanding.</p>
        ) : (
          <ul className="divide-y rounded-lg border">
            {summary.tasks.map((task) => (
              <li key={task.id} className="flex flex-wrap items-center gap-2 px-3 py-1.5">
                <span>{task.title}</span>
                <span className="ml-auto text-xs text-muted-foreground">
                  {task.assigneeName ?? 'anyone'}{task.dueAt ? <> · due <LocalDateTime value={task.dueAt} /></> : null}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Notes left for the next shift ({summary.notes.length})
        </p>
        {summary.notes.length === 0 ? (
          <p className="text-muted-foreground">None.</p>
        ) : (
          <ul className="divide-y rounded-lg border">
            {summary.notes.map((note, index) => (
              <li key={index} className="px-3 py-1.5">
                <span className="whitespace-pre-wrap">{note.body}</span>
                <span className="ml-2 text-xs text-muted-foreground">— {note.authorName}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

function Stat({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div className="rounded-lg border border-border bg-muted/30 px-3 py-2">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="font-semibold">{value}</p>
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  )
}
