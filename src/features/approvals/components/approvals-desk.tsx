'use client'

import * as React from 'react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { ArrowLeftRight, CheckCircle2, Clock, Inbox, Package, ShieldAlert, Wallet, XCircle } from 'lucide-react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { EmptyState } from '@/components/ui/feedback'
import { formatDateTime } from '@/lib/datetime'
import { formatMoney, type CurrencyCode } from '@/lib/money'
import { callAction } from '@/lib/use-action'
import { cn } from '@/lib/utils'
import type { InboxKind, RequestType } from '@/features/accounting/inbox'
import { approvalDetailAction, decideApprovalAction } from '../actions'
import type { ApprovalDetailPayload } from '../types'
import { ApprovalDetail } from './approval-detail'
import { decidePaymentAction } from '@/features/outgoing-payments/actions'
import { decidePettyRequestAction } from '@/features/pettycash/actions'
import { reviewWastageAction } from '@/features/inventory/wastage-actions'

/**
 * The approvals desk: four tabs by what is being asked for, each with the
 * requests still waiting and the ones already settled.
 *
 * ── Why tabs replaced one grouped list ──────────────────────────────────────
 *
 * Everything waiting used to be a single table with seven category headings,
 * and it read as one long scroll: somebody who came to clear the money went
 * past transfers and write-offs to reach it, and the question "what happened
 * to the request I raised on Tuesday" had no answer at all, because the
 * history below listed only the generic queue and none of the four that keep
 * their decision on the record itself.
 *
 * So the desk is now two questions asked in order. WHAT KIND — a stock
 * transfer, money, a purchase order, or something else. THEN — is it still
 * waiting, or is it done. A request appears in Pending until somebody rules
 * on it and in Record from the moment they do; it is never in both, because
 * the two lists read the same rows through opposite halves of one status
 * predicate.
 *
 * ── What did NOT change ─────────────────────────────────────────────────────
 *
 * Every decision still routes to the action that already owns its queue — the
 * same one that queue's own screen calls. Six actions, not one: a single
 * `decide(queue, id)` would need either the union of six permissions or none,
 * would nest one guarded action inside another, and would write a second
 * audit row per decision. Permission checks, branch guards, the two-person
 * rule and audit all stay where they live. This component holds no authority
 * of its own.
 */

/** This page's own path — a row linking here would link to itself. */
const HERE = '/dashboard/approvals'

const TYPE_ORDER: RequestType[] = ['TRANSFER', 'MONEY', 'PURCHASE', 'OTHER']

const TYPE_TABS: Record<RequestType, { label: string; icon: React.ReactNode }> = {
  TRANSFER: { label: 'Stock transfer', icon: <ArrowLeftRight className="size-4" /> },
  MONEY: { label: 'Money', icon: <Wallet className="size-4" /> },
  PURCHASE: { label: 'PO request', icon: <Package className="size-4" /> },
  OTHER: { label: 'Other', icon: <Inbox className="size-4" /> },
}

const KIND_LABELS: Record<string, string> = {
  REFUND: 'Refund',
  DISCOUNT: 'Discount',
  STOCK_ADJUSTMENT: 'Stock adjustment',
  PURCHASE_ORDER: 'Purchase order',
  STOCK_TRANSFER: 'Stock transfer',
  PRICE_OVERRIDE: 'Price override',
}

/** How each settled outcome reads, and in what colour. */
const OUTCOME: Record<string, { label: string; variant: 'success' | 'destructive' | 'secondary' | 'warning' }> = {
  APPROVED: { label: 'Approved', variant: 'success' },
  PAID: { label: 'Paid', variant: 'success' },
  RECEIVED: { label: 'Fully received', variant: 'success' },
  ORDERED: { label: 'Ordered', variant: 'success' },
  PARTIALLY_RECEIVED: { label: 'Partially received', variant: 'warning' },
  RETURNED: { label: 'Returned for edit', variant: 'warning' },
  REJECTED: { label: 'Rejected', variant: 'destructive' },
  CANCELLED: { label: 'Cancelled', variant: 'destructive' },
  REVERSED: { label: 'Reversed', variant: 'destructive' },
  WITHDRAWN: { label: 'Withdrawn', variant: 'secondary' },
  CLOSED: { label: 'Closed', variant: 'secondary' },
}

export interface PendingRow {
  type: RequestType
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
  /** When the viewer is watching rather than deciding, what they are waiting for. */
  waitingOn: string | null
  href: string
  transfer: {
    number: string
    fromBranchName: string
    toBranchName: string
    lines: Array<{ name: string; unit: string; quantity: number }>
  } | null
}

export interface RecordRow {
  type: RequestType
  queue: string
  id: string
  title: string
  reason: string | null
  amount: number | null
  branchName: string | null
  requestedByName: string
  requestedAt: string
  decidedByName: string | null
  decidedAt: string | null
  outcome: string
  decisionNote: string | null
  forced: boolean
  reference: string | null
  href: string
}

/** Whether this viewer can act on this row right now. */
const isMine = (row: PendingRow) => row.decidable && row.canDecide && !row.isOwnRequest

export function ApprovalsDesk({
  type,
  tab,
  pending,
  record,
  counts,
  currency,
  timeZone,
  locale,
  hint,
  filters,
  filtered,
}: {
  type: RequestType
  tab: 'pending' | 'record'
  /** Only this tab's rows; the server reads only this tab's queues. */
  pending: PendingRow[]
  record: RecordRow[]
  /** Waiting, per type, for the badges. */
  counts: Record<RequestType, number>
  currency: CurrencyCode
  timeZone: string | null
  locale: string
  hint: string
  /**
   * The filter bar, rendered by the page — it needs the location and staff
   * lists, which are server reads. An element serializes across the boundary
   * where a handler would not (`no-function-props`).
   */
  filters: React.ReactNode
  filtered: boolean
}) {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()

  const [busy, setBusy] = React.useState<string | null>(null)
  const [rejecting, setRejecting] = React.useState<string | null>(null)
  const [reason, setReason] = React.useState('')
  const [detail, setDetail] = React.useState<ApprovalDetailPayload | null>(null)
  const [opening, setOpening] = React.useState<string | null>(null)
  const [onlyMine, setOnlyMine] = React.useState(false)

  const money = (value: number) => formatMoney(value, currency, locale)

  /** Rewrite the URL. The server re-runs the query; nothing is hidden here. */
  const go = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params.toString())
    for (const [key, value] of Object.entries(patch)) {
      if (value === null || value === '') next.delete(key)
      else next.set(key, value)
    }
    router.push(`${pathname}?${next.toString()}`, { scroll: false })
  }

  /** The full request, fetched on click through the guarded read action. */
  const openDetail = async (row: PendingRow) => {
    setOpening(row.id)
    const result = await callAction(() => approvalDetailAction({ approvalId: row.id }))
    setOpening(null)
    if (result.ok) setDetail(result.data)
  }

  /** Routes to whichever action owns this queue. Unchanged, deliberately. */
  const decide = async (row: PendingRow, approve: boolean) => {
    if (!approve && !reason.trim()) {
      toast.error('Give a reason for rejecting this request')
      return
    }
    setBusy(row.id)
    const note = reason.trim()

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
    // It leaves Pending and appears in Record on the refresh below.
    toast.success(approve ? 'Approved — moved to Record' : 'Rejected — moved to Record')
    setRejecting(null)
    setReason('')
    router.refresh()
  }

  const mine = pending.filter(isMine)
  const visible = onlyMine ? mine : pending

  return (
    <div className="space-y-4">
      {/* ── What kind of request ───────────────────────────────────────────── */}
      <div
        role="tablist"
        aria-label="Request type"
        className="flex flex-wrap gap-1.5 rounded-xl border bg-card p-1.5 shadow-soft"
      >
        {TYPE_ORDER.map((value) => {
          const active = value === type
          const waiting = counts[value] ?? 0
          return (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => go({ type: value, tab: null })}
              className={cn(
                'flex flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors',
                active
                  ? 'bg-primary text-primary-foreground shadow-soft'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              {TYPE_TABS[value].icon}
              <span className="whitespace-nowrap">{TYPE_TABS[value].label}</span>
              {waiting > 0 ? (
                <span
                  className={cn(
                    'flex min-w-5 items-center justify-center rounded-full px-1.5 text-[11px] font-bold',
                    active ? 'bg-primary-foreground/20' : 'bg-primary/10 text-primary',
                  )}
                >
                  {waiting}
                </span>
              ) : null}
            </button>
          )
        })}
      </div>

      {/* ── Waiting, or already settled ────────────────────────────────────── */}
      <div className="rounded-xl border bg-card shadow-soft">
        <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
          <div role="tablist" aria-label="Pending or record" className="flex gap-1">
            <SubTab
              active={tab === 'pending'}
              onClick={() => go({ tab: null })}
              icon={<Clock className="size-3.5" />}
              label="Pending"
              count={counts[type] ?? 0}
            />
            <SubTab
              active={tab === 'record'}
              onClick={() => go({ tab: 'record' })}
              icon={<CheckCircle2 className="size-3.5" />}
              label="Record"
            />
          </div>

          {tab === 'pending' && mine.length > 0 ? (
            <label className="ml-auto flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={onlyMine}
                onChange={(event) => setOnlyMine(event.target.checked)}
                className="size-4 rounded border-input"
              />
              Only the {mine.length} waiting on me
            </label>
          ) : null}
        </div>

        <p className="border-b bg-muted/30 px-4 py-2 text-xs text-muted-foreground">{hint}</p>

        <div className="p-4">{filters}</div>

        {tab === 'pending' ? (
          visible.length === 0 ? (
            <div className="p-6">
              <EmptyState
                icon={<Inbox className="size-8" />}
                title={
                  onlyMine
                    ? 'Nothing here is waiting on you'
                    : filtered
                      ? 'Nothing waiting matches those filters'
                      : 'Nothing is waiting'
                }
                description={
                  filtered
                    ? 'Clear a filter to widen the list, or look in Record for what has already been decided.'
                    : 'Requests appear here the moment somebody raises one. Once approved or rejected they move to Record.'
                }
              />
            </div>
          ) : (
            <PendingTable
              rows={visible}
              money={money}
              locale={locale}
              timeZone={timeZone}
              busy={busy}
              rejecting={rejecting}
              reason={reason}
              opening={opening}
              onReason={setReason}
              onStartReject={(id) => {
                setRejecting(id)
                setReason('')
              }}
              onCancelReject={() => {
                setRejecting(null)
                setReason('')
              }}
              onDecide={decide}
              onOpenDetail={openDetail}
            />
          )
        ) : record.length === 0 ? (
          <div className="p-6">
            <EmptyState
              icon={<CheckCircle2 className="size-8" />}
              title={filtered ? 'Nothing decided matches those filters' : 'Nothing has been decided yet'}
              description="Every request that is approved or rejected is kept here, with who decided it and why."
            />
          </div>
        ) : (
          <RecordTable rows={record} money={money} locale={locale} timeZone={timeZone} />
        )}
      </div>

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

function SubTab({
  active,
  onClick,
  icon,
  label,
  count,
}: {
  active: boolean
  onClick: () => void
  icon: React.ReactNode
  label: string
  count?: number
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        'flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors',
        active ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground',
      )}
    >
      {icon}
      {label}
      {count !== undefined && count > 0 ? (
        <span className="rounded-full bg-primary/10 px-1.5 text-[11px] font-bold text-primary">{count}</span>
      ) : null}
    </button>
  )
}

/** Requests still waiting, with the decision controls. */
function PendingTable({
  rows,
  money,
  locale,
  timeZone,
  busy,
  rejecting,
  reason,
  opening,
  onReason,
  onStartReject,
  onCancelReject,
  onDecide,
  onOpenDetail,
}: {
  rows: PendingRow[]
  money: (value: number) => string
  locale: string
  timeZone: string | null
  busy: string | null
  rejecting: string | null
  reason: string
  opening: string | null
  onReason: (value: string) => void
  onStartReject: (id: string) => void
  onCancelReject: () => void
  onDecide: (row: PendingRow, approve: boolean) => void
  onOpenDetail: (row: PendingRow) => void
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[56rem] text-sm">
        <thead>
          <tr className="border-y bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <th className="px-4 py-3 font-medium">What is being asked</th>
            <th className="px-4 py-3 font-medium">Raised by</th>
            <th className="px-4 py-3 font-medium">Location</th>
            <th className="px-4 py-3 text-right font-medium">Amount</th>
            <th className="px-4 py-3 font-medium">Raised</th>
            <th className="px-4 py-3 text-right font-medium">Decision</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.map((row) => (
            <tr
              key={`${row.kind}:${row.id}`}
              className={cn('align-top', isMine(row) && 'bg-primary/5')}
              data-kind={row.kind}
            >
              <td className="px-4 py-3">
                <p className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline">{row.queue}</Badge>
                  <span className="font-semibold">
                    {row.transfer ? `${row.transfer.number} · ` : ''}
                    {row.title}
                  </span>
                </p>

                {/*
                  What the transfer actually asks for, on the row: from where,
                  to where, which items, how many. A count of lines is not
                  something anybody can approve.
                */}
                {row.transfer ? (
                  <div className="mt-1">
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

                {row.reason ? <p className="mt-1 text-sm text-muted-foreground">“{row.reason}”</p> : null}
                {/* Honest about what approving actually does. */}
                <p className="mt-1 text-xs text-muted-foreground">{row.consequence}</p>
                {row.reference && !row.transfer ? (
                  <p className="mt-0.5 text-xs text-muted-foreground">{row.reference}</p>
                ) : null}
              </td>

              <td className="px-4 py-3 text-muted-foreground">{row.requestedByName}</td>
              <td className="px-4 py-3 text-muted-foreground">
                {/* Null is a restaurant-wide request, not a missing value. */}
                {row.branchName ?? 'Whole restaurant'}
              </td>
              <td className="px-4 py-3 text-right font-medium tabular-nums">
                {row.amount === null ? '—' : money(row.amount)}
              </td>
              <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">
                {formatDateTime(row.requestedAt, { locale, timeZone })}
              </td>

              <td className="px-4 py-3">
                <div className="flex flex-col items-end gap-2">
                  {row.waitingOn ? (
                    <span className="text-[11px] text-muted-foreground">{row.waitingOn}</span>
                  ) : !row.decidable || !row.canDecide || row.isOwnRequest ? (
                    <div className="flex flex-col items-end gap-1">
                      <span className="text-right text-[11px] text-muted-foreground">
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
                        onChange={(event) => onReason(event.target.value)}
                        className="w-56"
                      />
                      <span className="flex gap-2">
                        <Button
                          size="sm"
                          variant="destructive"
                          loading={busy === row.id}
                          disabled={!reason.trim()}
                          onClick={() => onDecide(row, false)}
                        >
                          Reject
                        </Button>
                        <Button size="sm" variant="outline" onClick={onCancelReject}>
                          Cancel
                        </Button>
                      </span>
                    </div>
                  ) : (
                    <span className="flex gap-2">
                      <Button size="sm" loading={busy === row.id} onClick={() => onDecide(row, true)}>
                        <CheckCircle2 /> Approve
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => onStartReject(row.id)}>
                        <XCircle /> Reject
                      </Button>
                    </span>
                  )}

                  {row.kind === 'APPROVAL_REQUEST' ? (
                    <button
                      type="button"
                      onClick={() => onOpenDetail(row)}
                      disabled={opening === row.id}
                      className="text-xs font-medium text-primary underline-offset-2 hover:underline disabled:opacity-50"
                    >
                      {opening === row.id ? 'Opening…' : 'View details'}
                    </button>
                  ) : row.href !== HERE && row.decidable && row.canDecide && !row.isOwnRequest ? (
                    <Link
                      href={row.href}
                      className="text-xs font-medium text-primary underline-offset-2 hover:underline"
                    >
                      View details
                    </Link>
                  ) : null}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** What was already decided. Read-only — there is nothing to decide twice. */
function RecordTable({
  rows,
  money,
  locale,
  timeZone,
}: {
  rows: RecordRow[]
  money: (value: number) => string
  locale: string
  timeZone: string | null
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[56rem] text-sm">
        <thead>
          <tr className="border-y bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <th className="px-4 py-3 font-medium">What was asked</th>
            <th className="px-4 py-3 font-medium">Raised by</th>
            <th className="px-4 py-3 font-medium">Location</th>
            <th className="px-4 py-3 text-right font-medium">Amount</th>
            <th className="px-4 py-3 font-medium">Outcome</th>
            <th className="px-4 py-3 font-medium">Decided</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.map((row) => {
            const outcome = OUTCOME[row.outcome] ?? { label: row.outcome.toLowerCase(), variant: 'secondary' as const }
            return (
              <tr key={`${row.queue}:${row.id}`} className="align-top">
                <td className="px-4 py-3">
                  <p className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline">{row.queue}</Badge>
                    <span className="font-medium">{row.title}</span>
                  </p>
                  {row.reason ? <p className="mt-1 text-sm text-muted-foreground">“{row.reason}”</p> : null}
                  {row.reference ? (
                    <p className="mt-0.5 text-xs text-muted-foreground">{row.reference}</p>
                  ) : null}
                  {row.href !== HERE ? (
                    <Link
                      href={row.href}
                      className="mt-1 inline-block text-xs font-medium text-primary underline-offset-2 hover:underline"
                    >
                      Open →
                    </Link>
                  ) : null}
                </td>
                <td className="px-4 py-3 text-muted-foreground">{row.requestedByName}</td>
                <td className="px-4 py-3 text-muted-foreground">{row.branchName ?? 'Whole restaurant'}</td>
                <td className="px-4 py-3 text-right font-medium tabular-nums">
                  {row.amount === null ? '—' : money(row.amount)}
                </td>
                <td className="px-4 py-3">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <Badge variant={outcome.variant}>{outcome.label}</Badge>
                    {row.forced ? (
                      <Badge variant="destructive">
                        <ShieldAlert /> overridden
                      </Badge>
                    ) : null}
                  </span>
                  {row.decisionNote ? (
                    <p className="mt-1 max-w-xs text-xs text-muted-foreground">“{row.decisionNote}”</p>
                  ) : null}
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">
                  {row.decidedAt ? formatDateTime(row.decidedAt, { locale, timeZone }) : '—'}
                  {row.decidedByName ? (
                    <span className="block text-xs">by {row.decidedByName}</span>
                  ) : null}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
