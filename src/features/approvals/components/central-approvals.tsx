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
import type { InboxCategory, InboxKind } from '@/features/accounting/inbox'
import { approvalDetailAction, decideApprovalAction } from '../actions'
import type { ApprovalDetailPayload } from '../types'
import { ApprovalDetail } from './approval-detail'
import { decidePaymentAction } from '@/features/outgoing-payments/actions'
import { decidePettyRequestAction } from '@/features/pettycash/actions'
import { reviewWastageAction } from '@/features/inventory/wastage-actions'

/**
 * Everything waiting on a decision, from every branch, on one screen
 * (bill.md §3), in sections (recorrection.md §1).
 *
 * ── Why this calls six actions and not one ──────────────────────────────────
 *
 * The tempting shape is a single `decide(queue, id)` action that switches
 * internally. It would need either the union of six permissions or none at
 * all, it would nest one guarded action inside another, and it would write a
 * second audit row for every decision. So each row calls the action that
 * already owns its queue — the same one its own screen calls — and every
 * permission check, branch guard, self-approval rule and audit entry stays
 * exactly where it lives. This component is a different view over decisions
 * that already exist, and holds no authority of its own.
 *
 * ── Sections, not badges ────────────────────────────────────────────────────
 *
 * One flat list with the queue as a badge made every row the same shape, and
 * a desk where a 20 kg chicken transfer and a 500 refund look identical is a
 * desk that gets skimmed. Each category is its own card with its own count,
 * in the order somebody clearing the desk works: stock first (it is
 * perishable and somebody is waiting to cook), then money.
 *
 * ── Details from the pending row ────────────────────────────────────────────
 *
 * "Read it in full before ruling" only worked on the decided list — the one
 * place nothing can be ruled on. The detail dialog now opens from every
 * pending request, and it is where the transfer's lines, the history and the
 * override live; the row's own Approve/Reject stay for the ordinary case.
 *
 * Two queues are deliberately NOT decidable here. A stock count is shelves of
 * counted numbers and a purchase order is lines and prices; approving either
 * from a one-line summary is a rubber stamp, not a decision, so those rows
 * send you to read them.
 */

/** This page's own path — a row linking here would link to itself. */
const HERE = '/dashboard/approvals'

/** The reading order. Kept in step with `INBOX_CATEGORIES` (a server module). */
const CATEGORY_ORDER: InboxCategory[] = [
  'Stock transfers',
  'Money out',
  'Refunds',
  'Discounts',
  'Stock adjustments',
  'Stock write-offs',
  'Other',
]

const CATEGORY_HINT: Record<InboxCategory, string> = {
  'Stock transfers': 'The source branch approves. Approving reserves the stock; dispatch moves it.',
  'Money out': 'Payments and petty cash. Whoever submitted one cannot approve it.',
  Refunds: 'Money going back to a customer.',
  Discounts: 'Reductions somebody was not allowed to apply on their own.',
  'Stock adjustments': 'Counts and corrections that would change what the books say is on the shelf.',
  'Stock write-offs': 'Stock already thrown away. Approving confirms the reason.',
  Other: 'Everything else.',
}

const KIND_LABELS: Record<string, string> = {
  REFUND: 'Refund',
  DISCOUNT: 'Discount',
  STOCK_ADJUSTMENT: 'Stock adjustment',
  PURCHASE_ORDER: 'Purchase order',
  STOCK_TRANSFER: 'Stock transfer',
  PRICE_OVERRIDE: 'Price override',
}

export interface ApprovalRow {
  category: InboxCategory
  queue: string
  kind: InboxKind
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
  /** Whether this viewer holds the permission for THIS queue, at this branch. */
  canDecide: boolean
  /**
   * When the viewer is watching rather than deciding — the destination of a
   * transfer, say — what they are waiting for. Replaces the buttons.
   */
  waitingOn: string | null
  href: string
  /** A transfer's own facts: both ends and the lines. */
  transfer: {
    number: string
    fromBranchName: string
    toBranchName: string
    lines: Array<{ name: string; unit: string; quantity: number }>
  } | null
}

export function CentralApprovals({
  rows,
  currency,
  timeZone,
  locale,
  filtered,
}: {
  rows: ApprovalRow[]
  currency: CurrencyCode
  timeZone: string | null
  locale: string
  /** Whether a filter is narrowing the list, so "nothing" can say why. */
  filtered: boolean
}) {
  const router = useRouter()
  const [busy, setBusy] = React.useState<string | null>(null)
  const [rejecting, setRejecting] = React.useState<string | null>(null)
  const [reason, setReason] = React.useState('')
  const [detail, setDetail] = React.useState<ApprovalDetailPayload | null>(null)
  const [opening, setOpening] = React.useState<string | null>(null)

  const money = (value: number) => formatMoney(value, currency, locale)

  /** The full request, fetched on click through the guarded read action. */
  const openDetail = async (row: ApprovalRow) => {
    setOpening(row.id)
    const result = await callAction(() => approvalDetailAction({ approvalId: row.id }))
    setOpening(null)
    if (result.ok) setDetail(result.data)
  }

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
        case 'WASTAGE':
          return callAction(() => reviewWastageAction({ wastageId: row.id, approve, note }))
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

  const groups = CATEGORY_ORDER.map((category) => ({
    category,
    rows: rows.filter((row) => row.category === category),
  })).filter((group) => group.rows.length > 0)

  if (groups.length === 0) {
    return (
      <SectionCard title="Approvals">
        <EmptyState
          title={filtered ? 'Nothing waiting matches those filters' : 'Nothing is waiting'}
          description={
            filtered
              ? 'Clear a filter to widen the list. Decided requests are in the history below.'
              : 'Requests from any branch — transfers, refunds, discounts, money out, petty cash, write-offs, stock counts and purchase orders — appear here the moment somebody raises one.'
          }
        />
      </SectionCard>
    )
  }

  return (
    <div className="space-y-5">
      <p className="text-sm text-muted-foreground">
        {rows.length} waiting for a decision, from every branch. Each row says what approving actually does.
      </p>

      {groups.map((group) => (
        <SectionCard
          key={group.category}
          title={`${group.category} (${group.rows.length})`}
          description={CATEGORY_HINT[group.category]}
        >
          <ul className="divide-y">
            {group.rows.map((row) => (
              <li key={`${row.kind}:${row.id}`} className="py-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2">
                      {group.category === 'Money out' || group.category === 'Other' ? (
                        <Badge variant="outline">{row.queue}</Badge>
                      ) : null}
                      <span className="font-semibold">
                        {row.transfer ? `${row.transfer.number} · ` : ''}
                        {row.title}
                      </span>
                    </p>

                    {/*
                      What the transfer actually asks for, on the row itself
                      (recorrection.md §1): from where, to where, which items,
                      how many. A count of lines is not something anybody can
                      approve.
                    */}
                    {row.transfer ? (
                      <div className="mt-1 text-sm">
                        <span className="font-medium">{row.transfer.fromBranchName}</span>
                        {' → '}
                        <span className="font-medium">{row.transfer.toBranchName}</span>
                        <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-muted-foreground">
                          {row.transfer.lines.map((line, index) => (
                            <li key={`${line.name}-${index}`} className="tabular-nums">
                              {line.name} · {line.quantity} {line.unit.toLowerCase()}
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : null}

                    {row.reason ? (
                      <p className="mt-1 text-sm text-muted-foreground">“{row.reason}”</p>
                    ) : null}

                    <p className="mt-1 text-xs text-muted-foreground">
                      {row.requestedByName}
                      {row.branchName ? ` · ${row.branchName}` : ' · whole restaurant'}
                      {' · '}
                      {formatDateTime(row.requestedAt, { locale, timeZone })}
                      {row.reference && !row.transfer ? ` · ${row.reference}` : ''}
                    </p>

                    <p className="mt-1 text-xs text-muted-foreground">{row.consequence}</p>
                  </div>

                  <div className="flex shrink-0 flex-col items-end gap-2">
                    {row.amount !== null ? (
                      <span className="text-base font-bold tabular-nums">{money(row.amount)}</span>
                    ) : null}

                    {row.waitingOn ? (
                      /*
                       * The other end of a transfer: the person who raised it
                       * watching it wait. Not theirs to decide, and the spec
                       * asks that they can see where it stands.
                       */
                      <span className="text-[11px] text-muted-foreground">{row.waitingOn}</span>
                    ) : !row.decidable || !row.canDecide || row.isOwnRequest ? (
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

                    {/*
                      The whole request — lines, history, the override — for
                      the generic queue, in place. The other queues have their
                      own screens, which the Open link above reaches.
                    */}
                    {row.kind === 'APPROVAL_REQUEST' ? (
                      <button
                        type="button"
                        onClick={() => openDetail(row)}
                        disabled={opening === row.id}
                        className="text-xs font-medium text-primary underline-offset-2 hover:underline disabled:opacity-50"
                      >
                        {opening === row.id ? 'Opening…' : 'View details'}
                      </button>
                    ) : row.href !== HERE && row.decidable && row.canDecide && !row.isOwnRequest && !row.waitingOn ? (
                      <Link
                        href={row.href}
                        className="text-xs font-medium text-primary underline-offset-2 hover:underline"
                      >
                        View details
                      </Link>
                    ) : null}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </SectionCard>
      ))}

      <ApprovalDetail
        request={detail ? { ...detail, kindLabel: KIND_LABELS[detail.kind] ?? detail.kind } : null}
        currency={currency}
        locale={locale}
        open={detail !== null}
        onClose={() => setDetail(null)}
      />
    </div>
  )
}
