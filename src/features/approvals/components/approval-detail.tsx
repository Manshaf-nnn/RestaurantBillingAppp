'use client'

import * as React from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ExternalLink, ShieldAlert } from 'lucide-react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Alert } from '@/components/ui/feedback'
import { LocalDateTime } from '@/components/local-time'
import { formatMoney, type CurrencyCode } from '@/lib/money'
import { callAction } from '@/lib/use-action'
import { decideApprovalAction } from '../actions'

export interface ApprovalDetailView {
  id: string
  kind: string
  kindLabel: string
  status: string
  reason: string
  amount: number | null
  branchName: string | null
  requestedByName: string
  requestedAt: string
  decidedByName: string | null
  decidedAt: string | null
  decisionNote: string | null
  /** Set when the two-person rule was overridden to decide this (§9). */
  forcedAt: string | null
  /** The record it is about, when there is one worth opening. */
  href: string | null
  reference: string | null
  /** What would be applied — the payload, flattened for reading. */
  details: Array<{ label: string; value: string }>
  history: Array<{ id: string; action: string; actorName: string; createdAt: string; entity: string }>
  /** Why this viewer may not decide it normally, if they may not. */
  blockedReason: string | null
  /** Whether this viewer holds `approvals.force`. */
  mayForce: boolean
  /** The transfer this is about, with its lines (recorrection.md §1). */
  transfer: {
    number: string
    status: string
    fromBranchName: string
    toBranchName: string
    lines: Array<{ name: string; unit: string; quantity: number }>
  } | null
}

/**
 * Read the whole request before ruling on it (correctionA.md §9).
 *
 * ── Why the detail exists at all ───────────────────────────────────────────
 *
 * §9 asks that nobody approve or reject before they can open and inspect the
 * complete request. The queue shows a line; a line is enough to recognise a
 * request you were expecting and not enough to judge one you were not. What
 * this adds is the payload — what would actually happen — and the audit trail
 * of the record it concerns, which together answer "and what has already been
 * done to this" rather than only "what is being asked".
 *
 * ── The override, and why it is ugly on purpose ────────────────────────────
 *
 * When the ordinary rule refuses this viewer — it is their own request, or
 * they are not on this location's approver list — the buttons do not simply
 * disappear for somebody holding `approvals.force`. They are replaced by a
 * clearly marked override that states what it is breaking. A control that
 * looks identical to the ordinary one produces overrides by accident, and an
 * override nobody noticed making is the same as no control.
 */
export function ApprovalDetail({
  request,
  currency,
  locale,
  open,
  onClose,
}: {
  request: ApprovalDetailView | null
  currency: CurrencyCode
  locale: string
  open: boolean
  onClose: () => void
}) {
  const router = useRouter()
  const [note, setNote] = React.useState('')
  const [busy, setBusy] = React.useState(false)

  React.useEffect(() => {
    if (!open) setNote('')
  }, [open])

  if (!request) return null

  const money = (value: number) => formatMoney(value, currency, locale)
  const pending = request.status === 'PENDING'
  const blocked = request.blockedReason !== null

  const decide = async (approve: boolean, force: boolean) => {
    if (!approve && !note.trim()) {
      toast.error('Give a reason for rejecting this request')
      return
    }
    setBusy(true)
    const result = await callAction(() =>
      decideApprovalAction({ approvalId: request.id, approve, note: note.trim(), force }),
    )
    setBusy(false)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    toast.success(force ? 'Overridden and recorded' : approve ? 'Approved' : 'Rejected')
    onClose()
    router.refresh()
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? null : onClose())}>
      <DialogContent size="lg" className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2">
            {request.kindLabel}
            <Badge
              variant={
                request.status === 'APPROVED'
                  ? 'success'
                  : request.status === 'PENDING'
                    ? 'warning'
                    : 'secondary'
              }
            >
              {request.status.toLowerCase()}
            </Badge>
            {request.forcedAt ? (
              // Marked for as long as the record exists, in the list and here.
              <Badge variant="destructive">
                <ShieldAlert /> overridden
              </Badge>
            ) : null}
          </DialogTitle>
          <DialogDescription>{request.reason}</DialogDescription>
        </DialogHeader>

        <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5 text-sm">
          <Field label="Requested by" value={request.requestedByName} />
          <Field
            label="Requested"
            value={<LocalDateTime value={request.requestedAt} />}
          />
          <Field label="Location" value={request.branchName ?? 'All locations'} />
          <Field label="Amount" value={request.amount === null ? '—' : money(request.amount)} />
          {request.decidedByName ? (
            <>
              <Field label="Decided by" value={request.decidedByName} />
              <Field
                label="Decided"
                value={request.decidedAt ? <LocalDateTime value={request.decidedAt} /> : '—'}
              />
            </>
          ) : null}
          {request.decisionNote ? (
            <div className="col-span-2">
              <Field label="Decision note" value={request.decisionNote} />
            </div>
          ) : null}
        </dl>

        {/*
          What is actually being asked for (recorrection.md §1). The payload
          holds a branch id and a line COUNT; the person deciding needs the
          items, the quantities and both ends by name, and should not have
          to leave for the Transfers tab to get them.
        */}
        {request.transfer ? (
          <section className="mt-4">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {request.transfer.number} · {request.transfer.fromBranchName} → {request.transfer.toBranchName}
            </h3>
            <table className="w-full rounded-lg border text-sm">
              <tbody className="divide-y">
                {request.transfer.lines.map((line, index) => (
                  <tr key={`${line.name}-${index}`}>
                    <td className="px-3 py-1.5">{line.name}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">
                      {line.quantity} {line.unit.toLowerCase()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ) : null}

        {request.details.length > 0 && !request.transfer ? (
          <section className="mt-4">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              What would happen
            </h3>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-lg border p-3 text-sm">
              {request.details.map((row) => (
                <Field key={row.label} label={row.label} value={row.value} />
              ))}
            </dl>
          </section>
        ) : null}

        {request.href ? (
          <Button variant="outline" size="sm" className="mt-3 self-start" asChild>
            <Link href={request.href}>
              <ExternalLink /> Open {request.reference ?? 'the record'}
            </Link>
          </Button>
        ) : null}

        <section className="mt-4">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            History
          </h3>
          {request.history.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing has happened to it yet.</p>
          ) : (
            <ul className="divide-y rounded-lg border text-sm">
              {request.history.map((entry) => (
                <li key={entry.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
                  <span className="font-medium">{entry.action}</span>
                  <span className="text-muted-foreground">{entry.actorName}</span>
                  <span className="ml-auto text-xs text-muted-foreground">
                    <LocalDateTime value={entry.createdAt} />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {pending ? (
          <div className="mt-5 space-y-3 border-t pt-4">
            <Input
              value={note}
              onChange={(event) => setNote(event.target.value.slice(0, 200))}
              placeholder="Reason — required to reject"
              aria-label="Decision note"
            />

            {blocked ? (
              request.mayForce ? (
                <>
                  <Alert variant="warning">
                    {request.blockedReason}. You can override this, and the override is
                    recorded against the request permanently.
                  </Alert>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="destructive"
                      disabled={busy}
                      onClick={() => decide(true, true)}
                    >
                      <ShieldAlert /> Override and approve
                    </Button>
                    <Button variant="outline" disabled={busy} onClick={() => decide(false, true)}>
                      Override and reject
                    </Button>
                  </div>
                </>
              ) : (
                <Alert variant="warning">
                  {request.blockedReason}.
                </Alert>
              )
            ) : (
              <div className="flex flex-wrap gap-2">
                <Button disabled={busy} onClick={() => decide(true, false)}>
                  Approve
                </Button>
                <Button variant="outline" disabled={busy} onClick={() => decide(false, false)}>
                  Reject
                </Button>
              </div>
            )}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  )
}
