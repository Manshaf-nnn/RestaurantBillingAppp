'use client'

import * as React from 'react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import {
  AlertTriangle,
  Clock,
  Inbox,
  ShieldCheck,
  UserCheck,
  X,
} from 'lucide-react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { EmptyState } from '@/components/ui/feedback'
import { formatDateTime } from '@/lib/datetime'
import { formatMoney, type CurrencyCode } from '@/lib/money'
import { callAction } from '@/lib/use-action'
import { cn } from '@/lib/utils'
import type { InboxCategory, InboxKind } from '@/features/accounting/inbox'
import { approvalDetailAction, decideApprovalAction } from '../actions'
import type { ApprovalDetailPayload } from '../types'
import { ApprovalDetail } from './approval-detail'
import { decidePaymentAction } from '@/features/outgoing-payments/actions'
import { decidePettyRequestAction } from '@/features/pettycash/actions'
import { reviewWastageAction } from '@/features/inventory/wastage-actions'

/**
 * The approvals desk, in the shape the Transfers screen already uses:
 * five figures, one filter bar, one table, one drawer.
 *
 * ── Only the layout changed ─────────────────────────────────────────────────
 *
 * Every decision still routes to the action that already owns its queue — the
 * same one that queue's own screen calls. Six actions, not one: a single
 * `decide(queue, id)` would need either the union of six permissions or none,
 * would nest one guarded action inside another, and would write a second audit
 * row per decision. So permission checks, branch guards, the two-person rule
 * and audit all stay exactly where they live. This component holds no
 * authority of its own and never has.
 *
 * ── Why the six categories survived the flattening ──────────────────────────
 *
 * Transfers went from four grouped lists to one flat table, and that was
 * right: those groups were four answers to one question ("is this waiting on
 * me?"), which a column answers better. These six are not that. A stock
 * transfer and a petty cash request are different things with different
 * consequences, and "three payments and one transfer" is how somebody clearing
 * this desk actually thinks about it. So the table has one row per request and
 * a heading row per category — the layout of Transfers, with the grouping that
 * earns its place.
 *
 * ── Two queues are deliberately not decidable from here ─────────────────────
 *
 * A stock count is shelves of counted numbers and a purchase order is lines
 * and prices. Approving either from a one-line summary is a rubber stamp, not
 * a decision, so those rows send you to read them instead.
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

/** Whether this viewer can act on this row right now. */
const isMine = (row: ApprovalRow) => row.decidable && row.canDecide && !row.isOwnRequest

export function ApprovalsBoard({
  rows,
  currency,
  timeZone,
  locale,
  filtered,
  filters,
}: {
  rows: ApprovalRow[]
  currency: CurrencyCode
  timeZone: string | null
  locale: string
  /** Whether a filter is narrowing the list, so "nothing" can say why. */
  filtered: boolean
  /**
   * The filter bar, rendered by the page.
   *
   * A ReactNode rather than anything computed here: it needs the location and
   * staff lists, which are server reads. Elements serialize across the
   * boundary where a handler would not (`no-function-props`).
   */
  filters: React.ReactNode
}) {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()

  const [busy, setBusy] = React.useState<string | null>(null)
  const [rejecting, setRejecting] = React.useState<string | null>(null)
  const [reason, setReason] = React.useState('')
  const [detail, setDetail] = React.useState<ApprovalDetailPayload | null>(null)
  const [opening, setOpening] = React.useState<string | null>(null)

  const money = (value: number) => formatMoney(value, currency, locale)
  const get = (key: string) => params.get(key) ?? ''

  /** Rewrite the URL. The server re-runs the query; nothing is hidden here. */
  const apply = React.useCallback(
    (patch: Record<string, string | null>) => {
      const next = new URLSearchParams(params.toString())
      for (const [key, value] of Object.entries(patch)) {
        if (value === null || value === '') next.delete(key)
        else next.set(key, value)
      }
      router.push(`${pathname}?${next.toString()}`, { scroll: false })
    },
    [params, pathname, router],
  )

  /** The full request, fetched on click through the guarded read action. */
  const openDetail = async (row: ApprovalRow) => {
    setOpening(row.id)
    const result = await callAction(() => approvalDetailAction({ approvalId: row.id }))
    setOpening(null)
    if (result.ok) setDetail(result.data)
  }

  /** Routes to whichever action owns this queue. Unchanged, deliberately. */
  const decide = async (row: ApprovalRow, approve: boolean) => {
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
    toast.success(approve ? 'Approved' : 'Rejected')
    setRejecting(null)
    setReason('')
    router.refresh()
  }

  /*
   * The figures, counted from the rows on screen.
   *
   * Deliberately not a second set of queries. A card that counts something the
   * table below it cannot show is a card that disagrees with the screen it is
   * on, which is the failure the Transfers report was built to avoid. These
   * count exactly what is listed, under whatever filters are set.
   */
  const mine = rows.filter(isMine)
  const ownRequests = rows.filter((row) => row.isOwnRequest)
  const watching = rows.filter((row) => row.waitingOn !== null)
  const atStake = rows.reduce((sum, row) => sum + (row.amount ?? 0), 0)
  const oldest = rows.reduce<string | null>(
    (worst, row) => (worst === null || row.requestedAt < worst ? row.requestedAt : worst),
    null,
  )

  const view = get('view')
  const visible = rows.filter((row) => {
    if (view === 'mine') return isMine(row)
    if (view === 'own') return row.isOwnRequest
    if (view === 'watching') return row.waitingOn !== null
    return true
  })

  const groups = CATEGORY_ORDER.map((category) => ({
    category,
    rows: visible.filter((row) => row.category === category),
  })).filter((group) => group.rows.length > 0)

  return (
    <div className="space-y-4">
      {/* ── The five figures ──────────────────────────────────────────────── */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Stat
          icon={<Inbox className="size-5" />}
          tone="muted"
          value={rows.length}
          label="Waiting"
          hint="From every branch"
          active={!view}
          onClick={() => apply({ view: null })}
        />
        <Stat
          icon={<ShieldCheck className="size-5" />}
          tone="primary"
          value={mine.length}
          label="Waiting on me"
          hint="You can decide these"
          active={view === 'mine'}
          onClick={() => apply({ view: view === 'mine' ? null : 'mine' })}
        />
        <Stat
          icon={<UserCheck className="size-5" />}
          tone="warning"
          value={ownRequests.length}
          label="Raised by me"
          hint="Somebody else signs these off"
          active={view === 'own'}
          onClick={() => apply({ view: view === 'own' ? null : 'own' })}
        />
        <Stat
          icon={<Clock className="size-5" />}
          tone="muted"
          value={watching.length}
          label="Watching"
          hint="Another branch decides"
          active={view === 'watching'}
          onClick={() => apply({ view: view === 'watching' ? null : 'watching' })}
        />
        <Stat
          icon={<AlertTriangle className="size-5" />}
          tone={atStake > 0 ? 'destructive' : 'muted'}
          value={money(atStake)}
          label="Money at stake"
          hint={oldest ? `Oldest ${formatDateTime(oldest, { locale, timeZone })}` : 'Nothing waiting'}
        />
      </div>

      {/* ── Filters ───────────────────────────────────────────────────────── */}
      <div className="rounded-xl border bg-card p-4 shadow-soft">
        {filters}
        {view ? (
          <Button variant="ghost" size="sm" onClick={() => apply({ view: null })}>
            <X /> Show everything waiting
          </Button>
        ) : null}
      </div>

      {/* ── The table ─────────────────────────────────────────────────────── */}
      <div className="overflow-hidden rounded-xl border bg-card shadow-soft">
        {groups.length === 0 ? (
          <div className="p-6">
            <EmptyState
              icon={<Inbox className="size-8" />}
              title={
                filtered || view ? 'Nothing waiting matches those filters' : 'Nothing is waiting'
              }
              description={
                filtered || view
                  ? 'Clear a filter to widen the list. Decided requests are in the history below.'
                  : 'Requests from any branch — transfers, refunds, discounts, money out, petty cash, write-offs, stock counts and purchase orders — appear here the moment somebody raises one.'
              }
            />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[56rem] text-sm">
              <thead>
                <tr className="border-b bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-3 font-medium">What is being asked</th>
                  <th className="px-4 py-3 font-medium">Raised by</th>
                  <th className="px-4 py-3 font-medium">Location</th>
                  <th className="px-4 py-3 text-right font-medium">Amount</th>
                  <th className="px-4 py-3 font-medium">Raised</th>
                  <th className="px-4 py-3 text-right font-medium">Decision</th>
                </tr>
              </thead>
              {groups.map((group) => (
                <tbody key={group.category} className="divide-y border-b last:border-b-0">
                  {/*
                    The heading row. Six categories with their counts, because
                    a stock transfer and a petty cash request are different
                    things and "three payments and one transfer" is how anybody
                    clearing this desk reads it.
                  */}
                  <tr className="bg-muted/20">
                    <th colSpan={6} className="px-4 py-2 text-left">
                      {/*
                        One template string, not `{category} ({count})`.
                        JSX would render that as three text nodes with comment
                        markers between them, which reads the same in a browser
                        and not the same to anything parsing the HTML.
                      */}
                      <span className="text-sm font-semibold">
                        {`${group.category} (${group.rows.length})`}
                      </span>
                      <span className="ml-2 text-xs font-normal text-muted-foreground">
                        {CATEGORY_HINT[group.category]}
                      </span>
                    </th>
                  </tr>

                  {group.rows.map((row) => (
                    <tr
                      key={`${row.kind}:${row.id}`}
                      className={cn('align-top', isMine(row) && 'bg-primary/5')}
                      data-kind={row.kind}
                    >
                      <td className="px-4 py-3">
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
                          What the transfer actually asks for, on the row:
                          from where, to where, which items, how many. A count
                          of lines is not something anybody can approve.
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

                        {row.reason ? (
                          <p className="mt-1 text-sm text-muted-foreground">“{row.reason}”</p>
                        ) : null}
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
                            /*
                             * The other end of a transfer: the person who
                             * raised it watching it wait. Not theirs to decide,
                             * and they are told whose it is rather than shown a
                             * dead button.
                             */
                            <span className="text-[11px] text-muted-foreground">{row.waitingOn}</span>
                          ) : !row.decidable || !row.canDecide || row.isOwnRequest ? (
                            /*
                             * Say WHICH of the three reasons it is. All three
                             * used to collapse into one "Open →" link that, for
                             * a generic request, pointed back at this very page.
                             */
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
                                  onClick={() => {
                                    setRejecting(null)
                                    setReason('')
                                  }}
                                >
                                  Cancel
                                </Button>
                              </span>
                            </div>
                          ) : (
                            <span className="flex gap-2">
                              <Button
                                size="sm"
                                loading={busy === row.id}
                                onClick={() => decide(row, true)}
                              >
                                Approve
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => {
                                  setRejecting(row.id)
                                  setReason('')
                                }}
                              >
                                Reject
                              </Button>
                            </span>
                          )}

                          {/*
                            The whole request — lines, history, the override —
                            for the generic queue, in the drawer. The other
                            queues have their own screens, which Open reaches.
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
                          ) : row.href !== HERE &&
                            row.decidable &&
                            row.canDecide &&
                            !row.isOwnRequest ? (
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
              ))}
            </table>
          </div>
        )}

        {groups.length > 0 ? (
          <div className="border-t px-4 py-3 text-sm text-muted-foreground">
            Showing {visible.length} of {rows.length} waiting for a decision. Each row says what
            approving actually does.
          </div>
        ) : null}
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

/** One of the five figures. Clicking narrows the list, as on Transfers. */
function Stat({
  icon,
  tone,
  value,
  label,
  hint,
  active,
  onClick,
}: {
  icon: React.ReactNode
  tone: 'muted' | 'primary' | 'warning' | 'destructive'
  value: number | string
  label: string
  hint: string
  active?: boolean
  onClick?: () => void
}) {
  const TONES = {
    muted: 'bg-muted text-muted-foreground',
    primary: 'bg-primary/10 text-primary',
    warning: 'bg-warning/15 text-warning',
    destructive: 'bg-destructive/15 text-destructive',
  } as const

  const body = (
    <>
      <span className={cn('flex size-10 items-center justify-center rounded-xl', TONES[tone])}>
        {icon}
      </span>
      <span className="min-w-0 text-left">
        <span className="block truncate text-2xl font-bold tabular-nums">{value}</span>
        <span className="block text-xs font-medium">{label}</span>
        <span className="block truncate text-[11px] text-muted-foreground">{hint}</span>
      </span>
    </>
  )

  if (!onClick) {
    return (
      <div className="flex items-center gap-3 rounded-xl border bg-card p-4 shadow-soft">{body}</div>
    )
  }

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex items-center gap-3 rounded-xl border bg-card p-4 text-left shadow-soft transition hover:border-primary/40',
        active && 'border-primary ring-1 ring-primary',
      )}
    >
      {body}
    </button>
  )
}
