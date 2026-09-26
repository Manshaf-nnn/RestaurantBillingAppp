'use client'

import * as React from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ExternalLink, ShieldAlert, X } from 'lucide-react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Alert } from '@/components/ui/feedback'
import { LocalDateTime } from '@/components/local-time'
import { formatMoney, type CurrencyCode } from '@/lib/money'
import { callAction } from '@/lib/use-action'
import { cn } from '@/lib/utils'
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
    lines: Array<{
      id: string
      itemId: string
      name: string
      unit: string
      quantity: number
      /** Free stock at the source right now, in base units. */
      available: number
    }>
  } | null
  /** The purchase request this is about, with its lines. Read-only here. */
  purchase: {
    id: string
    number: string
    status: string
    priority: string
    branchName: string | null
    supplierName: string | null
    requiredBy: string | null
    notes: string | null
    total: number
    lines: Array<{
      id: string
      name: string
      unit: string
      quantity: number
      unitCost: number
      lineTotal: number
    }>
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

  // Escape closes, as it does on every other overlay in the app. The Dialog
  // this replaced did it for free; a hand-built drawer has to say so.
  React.useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  /*
   * What the approver will actually allow, per line.
   *
   * Starts at what was asked for, so approving without touching anything
   * behaves exactly as it did. Keyed by line id rather than index because the
   * table is re-rendered from a refreshed request after every decision.
   *
   * Declared before the early return below: a hook after a conditional
   * return runs on some renders and not others, which React refuses.
   */
  const [allow, setAllow] = React.useState<Record<string, string>>(() =>
    Object.fromEntries((request?.transfer?.lines ?? []).map((line) => [line.id, String(line.quantity)])),
  )

  if (!request) return null

  const money = (value: number) => formatMoney(value, currency, locale)

  const pending = request.status === 'PENDING'
  const blocked = request.blockedReason !== null

  const isPurchase = request.kind === 'PURCHASE_ORDER' && request.purchase !== null

  const decide = async (approve: boolean, force: boolean, returnForEdit = false) => {
    if (!approve && !note.trim()) {
      toast.error(returnForEdit ? 'Say what needs changing before sending it back' : 'Give a reason for rejecting this request')
      return
    }
    setBusy(true)
    const result = await callAction(() =>
      decideApprovalAction({
        approvalId: request.id,
        approve,
        note: note.trim(),
        force,
        returnForEdit: returnForEdit || undefined,
        /*
         * Only for a transfer, and only on an approval: a rejection sends
         * nothing anywhere, and a quantity on any other kind of request is
         * ignored by the action anyway.
         */
        approvedLines:
          approve && request.transfer
            ? request.transfer.lines.map((line) => ({
                lineId: line.id,
                quantity: Number(allow[line.id] ?? line.quantity),
              }))
            : undefined,
      }),
    )
    setBusy(false)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    toast.success(
      force ? 'Overridden and recorded' : approve ? 'Approved' : returnForEdit ? 'Sent back for edit' : 'Rejected',
    )
    onClose()
    router.refresh()
  }

  return (
    <>
      {/*
        ── A right drawer, like the Transfers screen ──────────────────────────

        The body below is unchanged: same fields, same lines, same history, same
        override, same single Approve. Only the chrome moved, from a centred
        modal to a panel anchored to the right edge — which is how a desk of
        rows is read, one row at a time, without the list underneath jumping
        out from behind a box in the middle of the screen.

        It is still `role="dialog"` with `aria-modal`, so it is still a dialog
        to a screen reader and to anything that goes looking for one.
      */}
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className={cn(
          'fixed inset-0 z-40 bg-foreground/20 backdrop-blur-[1px] transition-opacity',
          open ? 'opacity-100' : 'pointer-events-none opacity-0',
        )}
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={`${request.kindLabel} request`}
        className={cn(
          'fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col overflow-y-auto border-l bg-background p-5 shadow-xl transition-transform',
          open ? 'translate-x-0' : 'pointer-events-none translate-x-full',
        )}
      >
        <header className="mb-4 flex items-start justify-between gap-3 border-b pb-3">
          <div className="min-w-0">
            <h2 className="flex flex-wrap items-center gap-2 text-lg font-semibold">
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
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">{request.reason}</p>
          </div>
          <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close">
            <X />
          </Button>
        </header>

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
              <thead>
                <tr className="text-xs uppercase tracking-wider text-muted-foreground">
                  <th className="px-3 py-1.5 text-left font-medium">Item</th>
                  <th className="px-3 py-1.5 text-right font-medium">Asked</th>
                  <th className="px-3 py-1.5 text-right font-medium">In hand</th>
                  <th className="px-3 py-1.5 text-right font-medium">Approve</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {request.transfer.lines.map((line) => {
                  const wanted = Number(allow[line.id] ?? line.quantity)
                  // Said plainly rather than blocked: the store may know stock
                  // is arriving, and an approver who means it can still send.
                  const short = wanted > line.available + 1e-6
                  return (
                    <tr key={line.id}>
                      <td className="px-3 py-1.5">{line.name}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">
                        {line.quantity} {line.unit.toLowerCase()}
                      </td>
                      <td
                        className={cn(
                          'px-3 py-1.5 text-right tabular-nums',
                          short ? 'font-semibold text-destructive' : 'text-muted-foreground',
                        )}
                      >
                        {line.available}
                      </td>
                      <td className="px-3 py-1.5 text-right">
                        {pending && !blocked ? (
                          <input
                            type="number"
                            inputMode="decimal"
                            min={0}
                            max={line.quantity}
                            step="any"
                            value={allow[line.id] ?? String(line.quantity)}
                            onChange={(event) =>
                              setAllow((current) => ({ ...current, [line.id]: event.target.value }))
                            }
                            aria-label={`Quantity to approve for ${line.name}`}
                            className="h-8 w-24 rounded-md border border-input bg-background px-2 text-right text-sm tabular-nums"
                          />
                        ) : (
                          <span className="tabular-nums">
                            {line.quantity} {line.unit.toLowerCase()}
                          </span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            {/*
              Said once under the table rather than per row. The approver's
              real question is "can we send this", and the answer is a
              comparison they should be able to make at a glance.
            */}
            <p className="mt-2 text-xs text-muted-foreground">
              Approve less than was asked for where the shelf cannot cover it — the branch gets
              what you allow, and the request keeps a record of what they asked for. Zero sends
              none of that item.
            </p>
          </section>
        ) : null}

        {/*
          A purchase request, in full: the lines and what they cost, the site,
          the supplier, when it is needed and why. The approver's three answers
          sit at the foot with the others; the lines themselves are the
          requester's — "return for edit" is how an approver asks for a change.
        */}
        {request.purchase ? (
          <section className="mt-4">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {request.purchase.number} · {request.purchase.branchName ?? 'No location'}
              {request.purchase.supplierName ? ` · ${request.purchase.supplierName}` : ''}
            </h3>
            <table className="w-full rounded-lg border text-sm">
              <thead>
                <tr className="text-xs uppercase tracking-wider text-muted-foreground">
                  <th className="px-3 py-1.5 text-left font-medium">Item</th>
                  <th className="px-3 py-1.5 text-right font-medium">Qty</th>
                  <th className="px-3 py-1.5 text-right font-medium">Price</th>
                  <th className="px-3 py-1.5 text-right font-medium">Total</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {request.purchase.lines.map((line) => (
                  <tr key={line.id}>
                    <td className="px-3 py-1.5">{line.name}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">
                      {line.quantity} {line.unit.toLowerCase()}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{money(line.unitCost)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{money(line.lineTotal)}</td>
                  </tr>
                ))}
                <tr className="font-medium">
                  <td className="px-3 py-1.5" colSpan={3}>
                    Estimated total
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{money(request.purchase.total)}</td>
                </tr>
              </tbody>
            </table>
            <p className="mt-2 text-xs text-muted-foreground">
              {request.purchase.priority !== 'NORMAL' ? `${request.purchase.priority.toLowerCase()} priority · ` : ''}
              {request.purchase.requiredBy ? (
                <>
                  needed by <LocalDateTime value={request.purchase.requiredBy} />
                </>
              ) : (
                'no required date'
              )}
              {request.purchase.notes ? ` · ${request.purchase.notes}` : ''}
            </p>
          </section>
        ) : null}

        {request.details.length > 0 && !request.transfer && !request.purchase ? (
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
              placeholder={isPurchase ? 'Reason — required to reject or return' : 'Reason — required to reject'}
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
                    {isPurchase ? (
                      <Button variant="outline" disabled={busy} onClick={() => decide(false, true, true)}>
                        Override and return for edit
                      </Button>
                    ) : null}
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
                {isPurchase ? (
                  <Button variant="outline" disabled={busy} onClick={() => decide(false, false, true)}>
                    Return for edit
                  </Button>
                ) : null}
                <Button variant="outline" disabled={busy} onClick={() => decide(false, false)}>
                  Reject
                </Button>
              </div>
            )}
          </div>
        ) : null}
      </aside>
    </>
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
