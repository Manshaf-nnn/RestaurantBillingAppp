'use client'

import * as React from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { Printer, Search, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

/**
 * The report's filter bar.
 *
 * Deliberately the same controls, the same parameter names and the same URL
 * shape as the Transfers board, so walking from the board to the report carries
 * the filters across untouched and the two screens can never be describing
 * different sets of transfers. It is also what makes `ExportMenu` correct for
 * free: it forwards the URL verbatim, so the file matches whatever is on
 * screen without either side knowing about the other.
 *
 * No callbacks cross the server boundary — the page passes strings and this
 * component owns every handler (`no-function-props`).
 */

const SELECT =
  'h-9 w-full rounded-lg border border-input bg-background px-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring'

const QUICK_RANGES = [
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: '7d', label: 'Last 7 days' },
  { key: 'month', label: 'This month' },
  { key: 'lastmonth', label: 'Last month' },
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

export function TransferReportToolbar({
  branches,
  items,
}: {
  branches: Array<{ id: string; name: string }>
  items: Array<{ id: string; name: string }>
}) {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()

  const [search, setSearch] = React.useState(params.get('search') ?? '')
  const get = (key: string) => params.get(key) ?? ''

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

  // Debounced, so typing does not fire a request per keystroke.
  React.useEffect(() => {
    const current = params.get('search') ?? ''
    if (search === current) return
    const timer = setTimeout(() => apply({ search: search || null }), 350)
    return () => clearTimeout(timer)
  }, [search, params, apply])

  const activeRange = React.useMemo(() => {
    const from = params.get('from') ?? ''
    const to = params.get('to') ?? ''
    if (!from && !to) return null
    return (
      QUICK_RANGES.find((range) => {
        const r = rangeFor(range.key)
        return r.from === from && r.to === to
      })?.key ?? 'custom'
    )
  }, [params])

  const filtered = Boolean(
    get('search') || get('fromBranch') || get('toBranch') || get('status') || get('item') ||
      get('from') || get('to'),
  )

  return (
    <div className="no-print rounded-xl border bg-card p-4 shadow-soft">
      <div className="grid gap-3 lg:grid-cols-4 xl:grid-cols-5">
        <Filter label="From location">
          <select
            className={SELECT}
            value={get('fromBranch')}
            onChange={(event) => apply({ fromBranch: event.target.value || null })}
          >
            <option value="">All locations</option>
            {branches.map((branch) => (
              <option key={branch.id} value={branch.id}>{branch.name}</option>
            ))}
          </select>
        </Filter>
        <Filter label="To location">
          <select
            className={SELECT}
            value={get('toBranch')}
            onChange={(event) => apply({ toBranch: event.target.value || null })}
          >
            <option value="">All locations</option>
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
            <option value="">All statuses</option>
            <option value="PENDING_GROUP">Pending</option>
            <option value="IN_TRANSIT_GROUP">In transit</option>
            <option value="DONE_GROUP">Received</option>
            <option value="VARIANCE">Issue / variance</option>
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
            <option value="">All items</option>
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
          <button
            key={range.key}
            type="button"
            onClick={() => {
              const r = rangeFor(range.key)
              apply(activeRange === range.key ? { from: null, to: null } : { from: r.from, to: r.to })
            }}
            className={cn(
              'rounded-full border px-3 py-1 text-xs font-medium transition',
              activeRange === range.key
                ? 'border-primary bg-primary text-primary-foreground'
                : 'border-border text-muted-foreground hover:bg-muted',
            )}
          >
            {range.label}
          </button>
        ))}

        {filtered ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              apply({
                search: null, fromBranch: null, toBranch: null, status: null,
                item: null, from: null, to: null,
              })
            }
          >
            <X /> Clear filters
          </Button>
        ) : null}
      </div>
    </div>
  )
}

/**
 * Print, from the browser's own dialog.
 *
 * `@media print` in `globals.css` already strips the sidebar and the header and
 * repeats the table head across pages, and every browser's Save-as-PDF renders
 * exactly that — so this is also how the report becomes a PDF, without a second
 * layout inside a PDF library that would drift from this one within a month.
 */
export function PrintButton({ label = 'Print' }: { label?: string }) {
  return (
    <Button variant="outline" size="sm" className="no-print" onClick={() => window.print()}>
      <Printer /> {label}
    </Button>
  )
}

function Filter({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      {children}
    </div>
  )
}
