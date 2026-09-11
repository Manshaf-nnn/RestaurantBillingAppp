'use client'

import * as React from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { EmptyState } from '@/components/ui/feedback'
import { SectionCard } from '@/features/dashboard/components/page-header'
import { formatDateTime } from '@/lib/datetime'
import { formatMoney, type CurrencyCode } from '@/lib/money'
import { callAction } from '@/lib/use-action'
import { decideApprovalAction } from '../actions'
import { decidePaymentAction } from '@/features/outgoing-payments/actions'
import { decidePettyRequestAction } from '@/features/pettycash/actions'

/**
 * Everything waiting on a decision, from every branch, on one screen
 * (bill.md §3).
 *
 * ── Why this calls five actions and not one ─────────────────────────────────
 *
 * The tempting shape is a single `decide(queue, id)` action that switches
 * internally. It would need either the union of five permissions or none at
 * all, it would nest one guarded action inside another, and it would write a
 * second audit row for every decision. So each row calls the action that
 * already owns its queue — the same one its own screen calls — and every
 * permission check, branch guard, self-approval rule and audit entry stays
 * exactly where it lives. This component is a different view over decisions
 * that already exist, and holds no authority of its own.
 *
 * Two queues are deliberately NOT decidable here. A stock count is shelves of
 * counted numbers and a purchase order is lines and prices; approving either
 * from a one-line summary is a rubber stamp, not a decision, so those rows
 * send you to read them.
 */

/** This page's own path — a row linking here would link to itself. */
const HERE = '/dashboard/approvals'

export interface ApprovalRow {
  queue: string
  kind: 'APPROVAL_REQUEST' | 'OUTGOING_PAYMENT' | 'PETTY_CASH' | 'STOCK_COUNT' | 'PURCHASE'
  id: string
  title: string
  reason: string | null
  amount: number | null
  branchName: string | null
  requestedByName: string
  /** Set when the viewer raised it themselves — nobody approves their own. */
  isOwnRequest: boolean
  /** ISO. */
  requestedAt: string
  reference: string | null
  consequence: string
  decidable: boolean
  /** Whether this viewer holds the permission for THIS queue. */
  canDecide: boolean
  href: string
}

export function CentralApprovals({
  rows,
  currency,
  timeZone,
  locale,
}: {
  rows: ApprovalRow[]
  currency: CurrencyCode
  timeZone: string | null
  locale: string
}) {
  const router = useRouter()
  const [busy, setBusy] = React.useState<string | null>(null)
  const [rejecting, setRejecting] = React.useState<string | null>(null)
  const [reason, setReason] = React.useState('')

  const money = (value: number) => formatMoney(value, currency, locale)

  /** Routes to whichever action owns this queue. */
  const decide = async (row: ApprovalRow, approve: boolean) => {
    if (!approve && !reason.trim()) {
      toast.error('Give a reason for rejecting this request')
      return
    }
    setBusy(row.id)
    const note = reason.trim()

    /*
     * Each queue's action returns its own shape; all this needs is whether it
     * worked and what to say if it did not, so the call is narrowed to that.
     */
    const result: { ok: boolean; error?: string } = await (async () => {
      switch (row.kind) {
        case 'OUTGOING_PAYMENT':
          return callAction(() => decidePaymentAction({ paymentId: row.id, approve, note }))
        case 'PETTY_CASH':
          return callAction(() => decidePettyRequestAction({ requestId: row.id, approve, note }))
        default:
          return callAction(() => decideApprovalAction({ approvalId: row.id, approve, note }))
      }
    })()

    setBusy(null)
    if (!result.ok) {
      toast.error(result.error ?? 'That did not go through')
      return
    }
    toast.success(approve ? 'Approved' : 'Rejected')
    setRejecting(null)
    setReason('')
    router.refresh()
  }

  if (rows.length === 0) {
    return (
      <SectionCard title="Approvals">
        <EmptyState
          title="Nothing is waiting"
          description="Requests from any branch — refunds, discounts, money out, petty cash, transfers, stock counts and purchase orders — appear here the moment somebody raises one."
        />
      </SectionCard>
    )
  }

  return (
    <SectionCard
      title={`Waiting for a decision (${rows.length})`}
      description="From every branch. Each row says what approving actually does."
    >
      <ul className="divide-y">
        {rows.map((row) => (
          <li key={`${row.kind}:${row.id}`} className="py-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline">{row.queue}</Badge>
                  <span className="font-semibold">{row.title}</span>
                </p>

                {row.reason ? (
                  <p className="mt-1 text-sm text-muted-foreground">“{row.reason}”</p>
                ) : null}

                <p className="mt-1 text-xs text-muted-foreground">
                  {row.requestedByName}
                  {row.branchName ? ` · ${row.branchName}` : ' · whole restaurant'}
                  {' · '}
                  {formatDateTime(row.requestedAt, { locale, timeZone })}
                  {row.reference ? ` · ${row.reference}` : ''}
                </p>

                <p className="mt-1 text-xs text-muted-foreground">{row.consequence}</p>
              </div>

              <div className="flex shrink-0 flex-col items-end gap-2">
                {row.amount !== null ? (
                  <span className="text-base font-bold tabular-nums">{money(row.amount)}</span>
                ) : null}

                {!row.decidable || !row.canDecide || row.isOwnRequest ? (
                  /*
                   * Say WHICH of the three reasons it is.
                   *
                   * All three used to collapse into one "Open →" link that, for
                   * a generic approval request, pointed back at this very page.
                   * A screen full of rows whose only control returns you to
                   * itself, with no word about why, reads as a broken page
                   * rather than as the rules working.
                   */
                  <div className="flex flex-col items-end gap-1">
                    <span className="text-[11px] text-muted-foreground">
                      {row.isOwnRequest
                        ? 'You raised this — somebody else signs it off'
                        : !row.canDecide
                          ? 'Someone with the right permission has to decide this'
                          : 'Read the lines before deciding'}
                    </span>
                    {row.href !== HERE ? (
                      <Link
                        href={row.href}
                        className="text-xs font-medium text-primary underline-offset-2 hover:underline"
                      >
                        {row.decidable ? 'Open →' : 'Review →'}
                      </Link>
                    ) : null}
                  </div>
                ) : rejecting === row.id ? (
                  <div className="flex flex-col items-end gap-2">
                    <Input
                      autoFocus
                      value={reason}
                      maxLength={200}
                      placeholder="Why are you refusing it?"
                      onChange={(event) => setReason(event.target.value)}
                      className="w-56"
                    />
                    <span className="flex gap-2">
                      <Button
                        size="sm"
                        variant="destructive"
                        loading={busy === row.id}
                        disabled={!reason.trim()}
                        onClick={() => decide(row, false)}
                      >
                        Reject
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => { setRejecting(null); setReason('') }}
                      >
                        Cancel
                      </Button>
                    </span>
                  </div>
                ) : (
                  <span className="flex gap-2">
                    <Button size="sm" loading={busy === row.id} onClick={() => decide(row, true)}>
                      Approve
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => { setRejecting(row.id); setReason('') }}
                    >
                      Reject
                    </Button>
                  </span>
                )}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </SectionCard>
  )
}
