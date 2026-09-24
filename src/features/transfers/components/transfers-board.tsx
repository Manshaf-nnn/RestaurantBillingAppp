'use client'

import * as React from 'react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import {
  AlertTriangle,
  Building2,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  MoreVertical,
  Search,
  Truck,
  X,
} from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/feedback'
import { Input } from '@/components/ui/input'
import { LocalDateTime } from '@/components/local-time'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { sectionFor } from '../sections'
import type { TransferStats, TransferSummary } from '../queries'
import { TransferDrawer } from './transfer-drawer'

/**
 * The Transfers screen.
 *
 * ── What changed, and what deliberately did not ─────────────────────────────
 *
 * The layout is new: five figures across the top, one filter bar, one table,
 * and a detail drawer. What it is showing is not. Every status, every
 * transition and every action still belongs to the service — this screen reads
 * and filters, and the one place it says "waiting on you" is `sectionFor`, the
 * same function the old grouped list used.
 *
 * That signal mattered enough to keep: the question anybody opening this page
 * has is "is this waiting on ME", and the answer needs both the status and
 * which end of the transfer the viewer stands at. It moved from four headings
 * into a line under each row, and into a filter chip.
 *
 * ── Why the filters live in the URL ─────────────────────────────────────────
 *
 * Every filter is a search param, so a filtered list is a link: it survives a
 * refresh, it can be sent to the person who needs to act on it, and the back
 * button does what it looks like it does.
 */

const STATUS: Record<
  string,
  { label: string; className: string }
> = {
  REQUESTED: { label: 'Requested', className: 'bg-muted text-muted-foreground border-transparent' },
  APPROVED: { label: 'Approved', className: 'bg-warning/15 text-warning border-transparent' },
  DISPATCHED: { label: 'In Transit', className: 'bg-primary/15 text-primary border-transparent' },
  IN_TRANSIT: { label: 'In Transit', className: 'bg-primary/15 text-primary border-transparent' },
  RECEIVED: { label: 'Received', className: 'bg-success/15 text-success border-transparent' },
  COMPLETED: { label: 'Completed', className: 'bg-success/15 text-success border-transparent' },
  REJECTED: { label: 'Rejected', className: 'bg-destructive/15 text-destructive border-transparent' },
  CANCELLED: { label: 'Cancelled', className: 'bg-muted text-muted-foreground border-transparent' },
}

const QUICK_RANGES = [
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: '7d', label: 'Last 7 Days' },
  { key: 'month', label: 'This Month' },
  { key: 'lastmonth', label: 'Last Month' },
] as const

/** Local-date arithmetic, so "today" means the viewer's today. */
function rangeFor(key: string): { from: string; to: string } {
  const now = new Date()
  const iso = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const shift = (days: number) => {
    const d = new Date(now)
    d.setDate(d.getDate() + days)
    return d
  }
  switch (key) {
    case 'today':
      return { from: iso(now), to: iso(now) }
    case 'yesterday':
      return { from: iso(shift(-1)), to: iso(shift(-1)) }
    case '7d':
      return { from: iso(shift(-6)), to: iso(now) }
    case 'lastmonth': {
      const first = new Date(now.getFullYear(), now.getMonth() - 1, 1)
      const last = new Date(now.getFullYear(), now.getMonth(), 0)
      return { from: iso(first), to: iso(last) }
    }
    default: {
      const first = new Date(now.getFullYear(), now.getMonth(), 1)
      return { from: iso(first), to: iso(now) }
    }
  }
}

export interface TransfersBoardProps {
  rows: TransferSummary[]
  total: number
  page: number
  perPage: number
  pages: number
  stats: TransferStats
  branches: Array<{ id: string; name: string }>
  items: Array<{ id: string; name: string }>
  /** Branch ids this person stands at, so "waiting on you" can be worked out. */
  reachableBranchIds: string[] | null
  can: { dispatch: boolean; receive: boolean }
}

export function TransfersBoard({
  rows,
  total,
  page,
  perPage,
  pages,
  stats,
  branches,
  items,
  reachableBranchIds,
  can,
}: TransfersBoardProps) {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()

  const [open, setOpen] = React.useState<string | null>(null)
  const [search, setSearch] = React.useState(params.get('search') ?? '')

  const get = (key: string) => params.get(key) ?? ''

  /** Rewrite the URL. Any filter change goes back to page one. */
  const apply = React.useCallback(
    (patch: Record<string, string | null>) => {
      const next = new URLSearchParams(params.toString())
      for (const [key, value] of Object.entries(patch)) {
        if (value === null || value === '') next.delete(key)
        else next.set(key, value)
      }
      if (!('page' in patch)) next.delete('page')
      router.push(`${pathname}?${next.toString()}`, { scroll: false })
    },
    [params, pathname, router],
  )

  // Debounced so typing does not fire a request per keystroke.
  React.useEffect(() => {
    const current = params.get('search') ?? ''
    if (search === current) return
    const timer = setTimeout(() => apply({ search: search || null }), 350)
    return () => clearTimeout(timer)
  }, [search, params, apply])

  const activeRange = React.useMemo(() => {
    const from = get('from')
    const to = get('to')
    if (!from && !to) return null
    return QUICK_RANGES.find((range) => {
      const r = rangeFor(range.key)
      return r.from === from && r.to === to
    })?.key ?? 'custom'
  }, [params])

  const filtered =
    Boolean(get('search') || get('fromBranch') || get('toBranch') || get('status') || get('item') || get('from') || get('to') || get('mine'))

  const reach = reachableBranchIds
  const hintFor = (row: TransferSummary) => {
    const atSource = reach === null || reach.includes(row.fromBranchId)
    const atDestination = reach === null || reach.includes(row.toBranchId)
    return sectionFor(row, atSource, atDestination)[1]
  }

  const selected = rows.find((row) => row.id === open) ?? null

  return (
    <div className="space-y-4">
      {/* ── The five figures ──────────────────────────────────────────────── */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Stat
          icon={<Building2 className="size-5" />}
          tone="muted"
          value={stats.total}
          label="Total Transfers"
          hint="All time records"
          active={!get('status')}
          onClick={() => apply({ status: null })}
        />
        <Stat
          icon={<Truck className="size-5" />}
          tone="primary"
          value={stats.inTransit}
          label="In Transit"
          hint="On the way"
          active={get('status') === 'IN_TRANSIT_GROUP'}
          onClick={() => apply({ status: 'IN_TRANSIT_GROUP' })}
        />
        <Stat
          icon={<Clock className="size-5" />}
          tone="warning"
          value={stats.pending}
          label="Pending"
          hint="Waiting for action"
          active={get('status') === 'PENDING_GROUP'}
          onClick={() => apply({ status: 'PENDING_GROUP' })}
        />
        <Stat
          icon={<CheckCircle2 className="size-5" />}
          tone="success"
          value={stats.received}
          label="Received"
          hint="Completed"
          active={get('status') === 'DONE_GROUP'}
          onClick={() => apply({ status: 'DONE_GROUP' })}
        />
        <Stat
          icon={<AlertTriangle className="size-5" />}
          tone="destructive"
          value={stats.variance}
          label="Issue / Variance"
          hint="Needs attention"
          active={get('status') === 'VARIANCE'}
          onClick={() => apply({ status: 'VARIANCE' })}
        />
      </div>

      {/* ── Filters ───────────────────────────────────────────────────────── */}
      <div className="rounded-xl border bg-card p-4 shadow-soft">
        <div className="grid gap-3 lg:grid-cols-4 xl:grid-cols-5">
          <Filter label="From Location">
            <select
              className={SELECT}
              value={get('fromBranch')}
              onChange={(event) => apply({ fromBranch: event.target.value || null })}
            >
              <option value="">All Locations</option>
              {branches.map((branch) => (
                <option key={branch.id} value={branch.id}>{branch.name}</option>
              ))}
            </select>
          </Filter>
          <Filter label="To Location">
            <select
              className={SELECT}
              value={get('toBranch')}
              onChange={(event) => apply({ toBranch: event.target.value || null })}
            >
              <option value="">All Locations</option>
              {branches.map((branch) => (
                <option key={branch.id} value={branch.id}>{branch.name}</option>
              ))}
            </select>
          </Filter>
          <Filter label="Status">
            <select
              className={SELECT}
              value={get('status')}
              onChange={(event) => apply({ status: event.target.value || null })}
            >
              <option value="">All Status</option>
              <option value="PENDING_GROUP">Pending</option>
              <option value="IN_TRANSIT_GROUP">In Transit</option>
              <option value="DONE_GROUP">Received</option>
              <option value="VARIANCE">Issue / Variance</option>
              <option value="REQUESTED">Requested</option>
              <option value="APPROVED">Approved</option>
              <option value="REJECTED">Rejected</option>
              <option value="CANCELLED">Cancelled</option>
            </select>
          </Filter>
          <Filter label="Item">
            <select
              className={SELECT}
              value={get('item')}
              onChange={(event) => apply({ item: event.target.value || null })}
            >
              <option value="">All Items</option>
              {items.map((item) => (
                <option key={item.id} value={item.id}>{item.name}</option>
              ))}
            </select>
          </Filter>
          <Filter label="Date range">
            <div className="flex items-center gap-1.5">
              <input
                type="date"
                className={SELECT}
                value={get('from')}
                onChange={(event) => apply({ from: event.target.value || null })}
                aria-label="From date"
              />
              <span className="text-xs text-muted-foreground">–</span>
              <input
                type="date"
                className={SELECT}
                value={get('to')}
                onChange={(event) => apply({ to: event.target.value || null })}
                aria-label="To date"
              />
            </div>
          </Filter>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <div className="relative min-w-[16rem] flex-1 sm:max-w-sm">
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search transfer, item, remark…"
              startIcon={<Search className="size-4" />}
            />
          </div>

          {QUICK_RANGES.map((range) => (
            <Chip
              key={range.key}
              active={activeRange === range.key}
              onClick={() => {
                const r = rangeFor(range.key)
                apply(activeRange === range.key ? { from: null, to: null } : { from: r.from, to: r.to })
              }}
            >
              {range.label}
            </Chip>
          ))}

          {/*
            The one thing the old grouped list did that a flat table cannot:
            answer "is any of this mine". Kept as a filter rather than four
            headings — same `sectionFor`, same question.
          */}
          <Chip active={get('mine') === '1'} onClick={() => apply({ mine: get('mine') === '1' ? null : '1' })}>
            Waiting on me
          </Chip>

          {filtered ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                apply({ search: null, fromBranch: null, toBranch: null, status: null, item: null, from: null, to: null, mine: null })
              }
            >
              <X /> Clear Filters
            </Button>
          ) : null}
        </div>
      </div>

      {/* ── The table ─────────────────────────────────────────────────────── */}
      <div className="overflow-hidden rounded-xl border bg-card shadow-soft">
        {rows.length === 0 ? (
          <div className="p-6">
            <EmptyState
              icon={<Truck className="size-8" />}
              title={filtered ? 'Nothing matches those filters' : 'No transfers yet'}
              description={
                filtered
                  ? 'Try a wider date range, or clear the filters.'
                  : 'Ask another location for stock, and it shows up here at every step until it arrives.'
              }
            />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[56rem] text-sm">
              <thead>
                <tr className="border-b bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-3 font-medium">#</th>
                  <th className="px-4 py-3 font-medium">Date &amp; Time</th>
                  <th className="px-4 py-3 font-medium">From → To</th>
                  <th className="px-4 py-3 text-right font-medium">Items</th>
                  <th className="px-4 py-3 text-right font-medium">Total Qty</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium">Created By</th>
                  <th className="px-4 py-3 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {rows.map((row) => {
                  const status = STATUS[row.status] ?? STATUS.REQUESTED
                  const hint = hintFor(row)
                  const mine = hint.includes('on you')
                  return (
                    <tr
                      key={row.id}
                      onClick={() => setOpen(row.id)}
                      className={cn(
                        'cursor-pointer transition-colors hover:bg-muted/50',
                        open === row.id && 'bg-primary/5',
                      )}
                      data-status={row.status}
                    >
                      <td className="px-4 py-3 font-medium tabular-nums">{row.number}</td>
                      <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">
                        <LocalDateTime value={row.requestedAt} />
                      </td>
                      <td className="px-4 py-3">
                        <span className="block">
                          {row.fromName} <span className="text-muted-foreground">→</span> {row.toName}
                        </span>
                        {hint ? (
                          <span className={cn('block text-xs', mine ? 'font-medium text-primary' : 'text-muted-foreground')}>
                            {hint}
                          </span>
                        ) : null}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">{row.lineCount}</td>
                      <td className="px-4 py-3 text-right tabular-nums">{row.totalQty}</td>
                      <td className="px-4 py-3">
                        <span className={cn('inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium', status.className)}>
                          {status.label}
                        </span>
                        {row.hasVariance && row.status !== 'CANCELLED' ? (
                          <Badge variant="destructive" size="sm" className="ml-1.5">variance</Badge>
                        ) : null}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">{row.requestedByName ?? '—'}</td>
                      <td className="px-4 py-3 text-right" onClick={(event) => event.stopPropagation()}>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${row.number}`}>
                              <MoreVertical />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onSelect={() => setOpen(row.id)}>Quick view</DropdownMenuItem>
                            <DropdownMenuItem asChild>
                              <Link href={`/dashboard/transfers/${row.id}`}>Open full transfer</Link>
                            </DropdownMenuItem>
                            <DropdownMenuItem asChild>
                              <Link href={`/dashboard/transfers/${row.id}/print`}>Print transfer note</Link>
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        {rows.length > 0 ? (
          <div className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3 text-sm">
            <p className="text-muted-foreground">
              Showing {(page - 1) * perPage + 1} – {Math.min(page * perPage, total)} of {total} transfers
            </p>
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="icon-sm"
                disabled={page <= 1}
                onClick={() => apply({ page: String(page - 1) })}
                aria-label="Previous page"
              >
                <ChevronLeft />
              </Button>
              {pageNumbers(page, pages).map((entry, index) =>
                entry === null ? (
                  <span key={`gap-${index}`} className="px-1 text-muted-foreground">…</span>
                ) : (
                  <Button
                    key={entry}
                    variant={entry === page ? 'default' : 'ghost'}
                    size="icon-sm"
                    onClick={() => apply({ page: String(entry) })}
                    aria-current={entry === page ? 'page' : undefined}
                  >
                    {entry}
                  </Button>
                ),
              )}
              <Button
                variant="ghost"
                size="icon-sm"
                disabled={page >= pages}
                onClick={() => apply({ page: String(page + 1) })}
                aria-label="Next page"
              >
                <ChevronRight />
              </Button>
            </div>
          </div>
        ) : null}
      </div>

      <TransferDrawer
        transferId={open}
        summary={selected}
        can={can}
        onClose={() => setOpen(null)}
      />
    </div>
  )
}

const SELECT = 'h-10 w-full rounded-lg border border-input bg-background px-2.5 text-sm'

function Filter({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  )
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors',
        active ? 'border-primary bg-primary/10 text-primary' : 'hover:bg-muted',
      )}
    >
      {children}
    </button>
  )
}

const TONES = {
  muted: 'bg-muted text-muted-foreground',
  primary: 'bg-primary/10 text-primary',
  warning: 'bg-warning/15 text-warning',
  success: 'bg-success/15 text-success',
  destructive: 'bg-destructive/10 text-destructive',
} as const

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
  tone: keyof typeof TONES
  value: number
  label: string
  hint: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'flex items-center gap-3 rounded-xl border bg-card p-4 text-left shadow-soft transition-colors hover:bg-muted/40',
        active && 'border-primary ring-1 ring-primary/30',
      )}
    >
      <span className={cn('flex size-10 shrink-0 items-center justify-center rounded-lg', TONES[tone])}>
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block text-2xl font-bold leading-none tabular-nums">{value}</span>
        <span className="mt-1 block truncate text-sm font-medium">{label}</span>
        <span className="block truncate text-xs text-muted-foreground">{hint}</span>
      </span>
    </button>
  )
}

/** 1 … 4 5 6 … 13 — never more than seven controls however long the list is. */
function pageNumbers(page: number, pages: number): Array<number | null> {
  if (pages <= 7) return Array.from({ length: pages }, (_, i) => i + 1)
  const out: Array<number | null> = [1]
  const start = Math.max(2, page - 1)
  const end = Math.min(pages - 1, page + 1)
  if (start > 2) out.push(null)
  for (let i = start; i <= end; i += 1) out.push(i)
  if (end < pages - 1) out.push(null)
  out.push(pages)
  return out
}
