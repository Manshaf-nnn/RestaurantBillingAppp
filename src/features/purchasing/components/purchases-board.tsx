'use client'

import * as React from 'react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import {
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  Clock,
  MoreVertical,
  PackageCheck,
  Search,
  ShoppingCart,
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
import { formatMoney } from '@/lib/money'
import { cn } from '@/lib/utils'
import type { PurchaseStats, PurchaseSummary } from '../queries'
import { PO_PRIORITY, PO_STATUS } from '../status'

/**
 * The Purchasing screen, laid out exactly as Transfers is: five figures, one
 * filter bar, one table, pages underneath.
 *
 * The two screens answer the same question about different things — "what is
 * moving, and what is waiting on somebody" — so they read the same way: the
 * figures double as filters, every filter is a URL param (a filtered list is a
 * link that survives a refresh), and any filter change goes back to page one.
 *
 * It reads and filters. Every status and every transition still belongs to
 * the purchasing service, reached through the order's own page.
 */

const STATUS_CLASS: Record<string, string> = {
  secondary: 'bg-muted text-muted-foreground border-transparent',
  warning: 'bg-warning/15 text-warning border-transparent',
  success: 'bg-success/15 text-success border-transparent',
  destructive: 'bg-destructive/15 text-destructive border-transparent',
  info: 'bg-primary/15 text-primary border-transparent',
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

const FILTER_KEYS = ['search', 'supplier', 'status', 'location', 'item', 'priority', 'from', 'to', 'view'] as const

export interface PurchasesBoardProps {
  rows: PurchaseSummary[]
  total: number
  page: number
  perPage: number
  pages: number
  stats: PurchaseStats
  suppliers: Array<{ id: string; name: string }>
  branches: Array<{ id: string; name: string }>
  items: Array<{ id: string; name: string }>
  currency: string
  locale?: string
  can: { receive: boolean }
}

export function PurchasesBoard({
  rows,
  total,
  page,
  perPage,
  pages,
  stats,
  suppliers,
  branches,
  items,
  currency,
  locale,
  can,
}: PurchasesBoardProps) {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()

  const [search, setSearch] = React.useState(params.get('search') ?? '')
  const get = (key: string) => params.get(key) ?? ''
  const money = (minor: number) => formatMoney(minor, currency, locale)

  /** Rewrite the URL. Any filter change goes back to page one. */
  const apply = React.useCallback(
    (patch: Record<string, string | null>) => {
      const next = new URLSearchParams(params.toString())
      for (const [key, value] of Object.entries(patch)) {
        if (value === null || value === '') next.delete(key)
        else next.set(key, value)
      }
      if (!('page' in patch)) next.delete('page')
      // An old `?view=` link is a status filter under another name; the first
      // real status choice replaces it rather than fighting it.
      if ('status' in patch) next.delete('view')
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

  const from = get('from')
  const to = get('to')
  const activeRange = React.useMemo(() => {
    if (!from && !to) return null
    return (
      QUICK_RANGES.find((range) => {
        const r = rangeFor(range.key)
        return r.from === from && r.to === to
      })?.key ?? 'custom'
    )
  }, [from, to])

  const filtered = FILTER_KEYS.some((key) => Boolean(get(key)))
  const status = get('status')

  return (
    <div className="space-y-4">
      {/* ── The five figures ──────────────────────────────────────────────── */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Stat
          icon={<ClipboardList className="size-5" />}
          tone="muted"
          value={stats.total}
          label="Total Requests"
          hint="All time records"
          active={!status && !get('view')}
          onClick={() => apply({ status: null })}
        />
        <Stat
          icon={<Clock className="size-5" />}
          tone="warning"
          value={stats.pending}
          label="Pending Approval"
          hint="Waiting for a decision"
          active={status === 'PENDING_GROUP'}
          onClick={() => apply({ status: 'PENDING_GROUP' })}
        />
        <Stat
          icon={<ShoppingCart className="size-5" />}
          tone="primary"
          value={stats.toReceive}
          label="To Receive"
          hint="Approved, goods to come"
          active={status === 'OPEN_GROUP'}
          onClick={() => apply({ status: 'OPEN_GROUP' })}
        />
        <Stat
          icon={<CheckCircle2 className="size-5" />}
          tone="success"
          value={stats.received}
          label="Received"
          hint="Completed"
          active={status === 'DONE_GROUP'}
          onClick={() => apply({ status: 'DONE_GROUP' })}
        />
        <Stat
          icon={<AlertTriangle className="size-5" />}
          tone="destructive"
          value={stats.issues}
          label="Returned / Rejected"
          hint="Needs attention"
          active={status === 'ISSUE_GROUP'}
          onClick={() => apply({ status: 'ISSUE_GROUP' })}
        />
      </div>

      {/* ── Filters ───────────────────────────────────────────────────────── */}
      <div className="rounded-xl border bg-card p-4 shadow-soft">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
          <Filter label="Supplier">
            <select
              className={SELECT}
              value={get('supplier')}
              onChange={(event) => apply({ supplier: event.target.value || null })}
            >
              <option value="">All Suppliers</option>
              {suppliers.map((supplier) => (
                <option key={supplier.id} value={supplier.id}>{supplier.name}</option>
              ))}
            </select>
          </Filter>
          <Filter label="Status">
            <select
              className={SELECT}
              value={status}
              onChange={(event) => apply({ status: event.target.value || null })}
            >
              <option value="">All Status</option>
              <option value="PENDING_GROUP">Pending approval</option>
              <option value="OPEN_GROUP">To receive</option>
              <option value="DONE_GROUP">Received</option>
              <option value="ISSUE_GROUP">Returned / Rejected</option>
              <option value="DRAFT">Draft</option>
              <option value="APPROVED">Approved</option>
              <option value="ORDERED">Ordered</option>
              <option value="PARTIALLY_RECEIVED">Partially received</option>
              <option value="RECEIVED">Fully received</option>
              <option value="RETURNED">Returned for edit</option>
              <option value="REJECTED">Rejected</option>
              <option value="CLOSED">Closed</option>
              <option value="CANCELLED">Cancelled</option>
            </select>
          </Filter>
          {branches.length > 1 ? (
            <Filter label="Location">
              <select
                className={SELECT}
                value={get('location')}
                onChange={(event) => apply({ location: event.target.value || null })}
              >
                <option value="">All Locations</option>
                {branches.map((branch) => (
                  <option key={branch.id} value={branch.id}>{branch.name}</option>
                ))}
              </select>
            </Filter>
          ) : null}
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
          <Filter label="Priority">
            <select
              className={SELECT}
              value={get('priority')}
              onChange={(event) => apply({ priority: event.target.value || null })}
            >
              <option value="">Any Priority</option>
              <option value="URGENT">Urgent</option>
              <option value="NORMAL">Normal</option>
              <option value="LOW">Low</option>
            </select>
          </Filter>
          <Filter label="Date range" className="sm:col-span-2">
            <div className="flex items-center gap-1.5">
              <input
                type="date"
                className={SELECT}
                value={from}
                onChange={(event) => apply({ from: event.target.value || null })}
                aria-label="From date"
              />
              <span className="text-xs text-muted-foreground">–</span>
              <input
                type="date"
                className={SELECT}
                value={to}
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
              placeholder="Order number, supplier, item, GRN or invoice…"
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

          {filtered ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setSearch('')
                apply(Object.fromEntries(FILTER_KEYS.map((key) => [key, null])))
              }}
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
              icon={<ShoppingCart className="size-8" />}
              title={filtered ? 'Nothing matches those filters' : 'No purchase requests yet'}
              description={
                filtered
                  ? 'Try a wider date range, or clear the filters.'
                  : 'Raise a request, get it approved, and receive the goods against it. Each step appears here.'
              }
            />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[60rem] text-sm">
              <thead>
                <tr className="border-b bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-3 font-medium">#</th>
                  <th className="px-4 py-3 font-medium">Date &amp; Time</th>
                  <th className="px-4 py-3 font-medium">Supplier → Location</th>
                  <th className="px-4 py-3 text-right font-medium">Items</th>
                  <th className="px-4 py-3 text-right font-medium">Total</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium">Created By</th>
                  <th className="px-4 py-3 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {rows.map((row) => {
                  const meta = PO_STATUS[row.status]
                  const receivable =
                    can.receive && ['APPROVED', 'ORDERED', 'PARTIALLY_RECEIVED'].includes(row.status)
                  return (
                    <tr
                      key={row.id}
                      onClick={() => router.push(`/dashboard/purchases/${row.id}`)}
                      className="cursor-pointer transition-colors hover:bg-muted/50"
                      data-status={row.status}
                    >
                      <td className="px-4 py-3 font-medium tabular-nums">{row.number}</td>
                      <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">
                        <LocalDateTime value={row.createdAt} />
                      </td>
                      <td className="px-4 py-3">
                        <span className="block">
                          {row.supplierName ?? 'No supplier'}{' '}
                          <span className="text-muted-foreground">→</span> {row.branchName ?? '—'}
                        </span>
                        {row.expectedAt ? (
                          <span className="block text-xs text-muted-foreground">
                            needed <LocalDateTime value={row.expectedAt} />
                          </span>
                        ) : null}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">{row.lineCount}</td>
                      <td className="px-4 py-3 text-right font-medium tabular-nums">{money(row.total)}</td>
                      <td className="px-4 py-3">
                        <span
                          className={cn(
                            'inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium',
                            STATUS_CLASS[meta.variant],
                          )}
                        >
                          {meta.label}
                        </span>
                        {row.priority === 'URGENT' ? (
                          <Badge variant="destructive" size="sm" className="ml-1.5">
                            {PO_PRIORITY.URGENT.label}
                          </Badge>
                        ) : null}
                        {row.receivedPercent > 0 && row.receivedPercent < 100 ? (
                          <span className="block text-xs text-muted-foreground">{row.receivedPercent}% in</span>
                        ) : null}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">{row.createdByName ?? '—'}</td>
                      <td className="px-4 py-3 text-right" onClick={(event) => event.stopPropagation()}>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${row.number}`}>
                              <MoreVertical />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem asChild>
                              <Link href={`/dashboard/purchases/${row.id}`}>Open request</Link>
                            </DropdownMenuItem>
                            {receivable ? (
                              <DropdownMenuItem asChild>
                                <Link href={`/dashboard/purchases/receive?po=${row.id}`}>
                                  <PackageCheck /> Receive goods
                                </Link>
                              </DropdownMenuItem>
                            ) : null}
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
              Showing {(page - 1) * perPage + 1} – {Math.min(page * perPage, total)} of {total} requests
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
    </div>
  )
}

const SELECT = 'h-10 w-full rounded-lg border border-input bg-background px-2.5 text-sm'

function Filter({
  label,
  children,
  className,
}: {
  label: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <label className={cn('block', className)}>
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
