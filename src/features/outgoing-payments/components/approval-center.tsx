'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/input'
import { Field } from '@/components/ui/label'
import { SectionCard, StatCard } from '@/features/dashboard/components/page-header'
import { callAction } from '@/lib/use-action'
import { formatMoney } from '@/lib/money'
import { decidePaymentAction, reversePaymentAction, sendBackPaymentAction } from '../actions'
import type { ApprovalTotals, OutgoingRow } from '../queries'

/**
 * The owner's approval center (accountsds.md §7). Every request shows the
 * whole story; approving asks for confirmation, rejecting demands a reason,
 * and send-back returns it to the accountant without deleting anything.
 */
export function ApprovalCenter({
  pending,
  recent,
  totals,
  currency,
  locale,
}: {
  pending: OutgoingRow[]
  recent: OutgoingRow[]
  totals: ApprovalTotals
  currency: string
  locale: string
}) {
  const money = (value: number) => formatMoney(value, currency, locale)

  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Waiting for you" value={money(totals.pending)} hint={`${totals.pendingCount} request(s)`} tone="warning" />
        <StatCard label="Approved, unpaid" value={money(totals.approved)} hint="the accountant executes these" />
        <StatCard label="Paid" value={money(totals.paid)} hint="all time" />
        <StatCard label="Rejected" value={money(totals.rejected)} hint="all time" />
      </div>

      {totals.byBranch.length > 0 || totals.byTarget.length > 0 ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <SectionCard title="Pending by location">
            {totals.byBranch.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing pending.</p>
            ) : (
              <ul className="space-y-1 text-sm">
                {totals.byBranch.map((row) => (
                  <li key={row.branch} className="flex justify-between">
                    <span>{row.branch}</span>
                    <span className="font-semibold tabular-nums">{money(row.amount)}</span>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>
          <SectionCard title="Pending by supplier / category">
            {totals.byTarget.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing pending.</p>
            ) : (
              <ul className="space-y-1 text-sm">
                {totals.byTarget.map((row) => (
                  <li key={row.target} className="flex justify-between">
                    <span>{row.target}</span>
                    <span className="font-semibold tabular-nums">{money(row.amount)}</span>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>
        </div>
      ) : null}

      <SectionCard
        title="Waiting for a decision"
        description="Approve with an optional note, reject with a reason, or send it back for changes."
      >
        {pending.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">Nothing waits on you.</p>
        ) : (
          <ul className="divide-y">
            {pending.map((row) => (
              <PendingRow key={row.id} row={row} currency={currency} locale={locale} />
            ))}
          </ul>
        )}
      </SectionCard>

      <SectionCard title="Recently decided" description="Approved payments wait on the accountant to execute; a paid one can only be reversed, never edited.">
        {recent.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">No history yet.</p>
        ) : (
          <ul className="divide-y">
            {recent.map((row) => (
              <DecidedRow key={row.id} row={row} currency={currency} locale={locale} />
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  )
}

function RowSummary({ row, currency, locale }: { row: OutgoingRow; currency: string; locale: string }) {
  return (
    <div className="min-w-0">
      <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
        <span className="font-mono text-xs text-muted-foreground">{row.number}</span>
        {row.supplierName ?? row.categoryName ?? '—'}
        <Badge variant="secondary">{row.kind === 'SUPPLIER' ? 'Supplier' : 'Expense'}</Badge>
      </p>
      <p className="mt-0.5 max-w-[52ch] text-xs text-muted-foreground">
        {row.description} · {row.method}
        {row.reference ? ` · ${row.reference}` : ''} · {row.branchName} · raised by {row.createdByName}
        {row.purchaseNumber ? ` · settles ${row.purchaseNumber}` : ''}
      </p>
      <p className="mt-0.5 text-sm font-semibold tabular-nums">{formatMoney(row.amount, currency, locale)}</p>
    </div>
  )
}

function PendingRow({ row, currency, locale }: { row: OutgoingRow; currency: string; locale: string }) {
  const router = useRouter()
  const [dialog, setDialog] = React.useState<'approve' | 'reject' | 'sendback' | null>(null)
  const [note, setNote] = React.useState('')
  const [pending, setPending] = React.useState(false)

  const act = async () => {
    setPending(true)
    const result = await callAction(() =>
      dialog === 'sendback'
        ? sendBackPaymentAction({ paymentId: row.id, note })
        : decidePaymentAction({ paymentId: row.id, approve: dialog === 'approve', note }),
    )
    setPending(false)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    toast.success(
      dialog === 'approve' ? 'Approved — the accountant can pay it now'
        : dialog === 'reject' ? 'Rejected' : 'Sent back for changes',
    )
    setDialog(null)
    setNote('')
    router.refresh()
  }

  return (
    <li className="flex flex-wrap items-center justify-between gap-3 py-3">
      <RowSummary row={row} currency={currency} locale={locale} />
      <div className="flex gap-2">
        <Button size="sm" onClick={() => setDialog('approve')}>Approve</Button>
        <Button size="sm" variant="outline" onClick={() => setDialog('sendback')}>Send back</Button>
        <Button size="sm" variant="destructive" onClick={() => setDialog('reject')}>Reject</Button>
      </div>

      <Dialog open={dialog !== null} onOpenChange={(open) => !open && setDialog(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {dialog === 'approve' ? `Approve ${row.number}?` : dialog === 'reject' ? `Reject ${row.number}?` : `Send ${row.number} back?`}
            </DialogTitle>
            <DialogDescription>
              {formatMoney(row.amount, currency, locale)} to {row.supplierName ?? row.categoryName ?? '—'} — {row.description}
            </DialogDescription>
          </DialogHeader>
          <Field
            label={dialog === 'approve' ? 'Note (optional)' : dialog === 'reject' ? 'Why is this refused?' : 'What needs changing?'}
            htmlFor={`note-${row.id}`}
          >
            <Textarea id={`note-${row.id}`} rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialog(null)}>Back</Button>
            <Button
              variant={dialog === 'reject' ? 'destructive' : 'default'}
              loading={pending}
              disabled={dialog !== 'approve' && note.trim().length < 3}
              onClick={act}
            >
              {dialog === 'approve' ? 'Approve payment' : dialog === 'reject' ? 'Reject payment' : 'Send back'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </li>
  )
}

function DecidedRow({ row, currency, locale }: { row: OutgoingRow; currency: string; locale: string }) {
  const router = useRouter()
  const [reverseOpen, setReverseOpen] = React.useState(false)
  const [reason, setReason] = React.useState('')
  const [pending, setPending] = React.useState(false)

  const doReverse = async () => {
    setPending(true)
    const result = await callAction(() => reversePaymentAction({ paymentId: row.id, reason }))
    setPending(false)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    toast.success(`Reversed as ${result.data.number}`)
    setReverseOpen(false)
    setReason('')
    router.refresh()
  }

  return (
    <li className="flex flex-wrap items-center justify-between gap-3 py-3">
      <RowSummary row={row} currency={currency} locale={locale} />
      <div className="flex items-center gap-2">
        <Badge
          variant={row.status === 'REJECTED' || row.status === 'REVERSED' ? 'destructive' : 'secondary'}
        >
          {row.status.toLowerCase()}
        </Badge>
        {row.status === 'PAID' && !row.reversalOfNumber ? (
          <Button size="sm" variant="ghost" onClick={() => setReverseOpen(true)}>Reverse</Button>
        ) : null}
      </div>

      <Dialog open={reverseOpen} onOpenChange={setReverseOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Reverse {row.number}?</DialogTitle>
            <DialogDescription>
              A paid payment is never edited — this records a correcting transaction, dated today, on your name.
            </DialogDescription>
          </DialogHeader>
          <Field label="Why is it being reversed?" htmlFor={`rev-${row.id}`}>
            <Textarea id={`rev-${row.id}`} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReverseOpen(false)}>Keep it</Button>
            <Button variant="destructive" loading={pending} disabled={reason.trim().length < 3} onClick={doReverse}>
              Reverse payment
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </li>
  )
}
