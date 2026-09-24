'use client'

import * as React from 'react'
import Link from 'next/link'
import { Package, Search, Timer } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/feedback'
import { Input } from '@/components/ui/input'
import { LocalDateTime } from '@/components/local-time'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import { UNIT_LABELS, formatQuantity } from '@/features/inventory/units'
import { formatMoney, minorUnitFactor } from '@/lib/money'
import type { OpenBatch, PreparedItemRow } from '../types'

/**
 * Prepared Items (recorrection.md §3): everything this kitchen makes, each in
 * one of two states — in progress (a batch created and not yet marked done)
 * or stocked. Search and a state filter, because a kitchen with forty
 * prepared items and three batches on the go needs "which three" answered
 * in one glance, not found by scrolling.
 *
 * The row is a link to the item's own page (aO.md §5), where what is on the
 * shelf, how it is made, "How much did you make?" and Make More all live. So
 * the row stays a row: one line per item however many batches it has open.
 */

type Filter = 'all' | 'in-progress' | 'stocked'

const SELECT = 'h-10 rounded-lg border border-input bg-background px-2 text-sm'

export function PreparedItemsTable({
  rows,
  openBatches,
  currency,
  locale,
  canManage,
}: {
  rows: PreparedItemRow[]
  openBatches: OpenBatch[]
  currency: string
  locale: string
  canManage: boolean
}) {
  const [search, setSearch] = React.useState('')
  const [filter, setFilter] = React.useState<Filter>('all')

  const batchesByItem = React.useMemo(() => {
    const map = new Map<string, OpenBatch[]>()
    for (const batch of openBatches) {
      if (!batch.itemId) continue
      map.set(batch.itemId, [...(map.get(batch.itemId) ?? []), batch])
    }
    return map
  }, [openBatches])

  const needle = search.trim().toLowerCase()
  const visible = rows.filter((row) => {
    const open = batchesByItem.has(row.id)
    if (filter === 'in-progress' && !open) return false
    if (filter === 'stocked' && open) return false
    return !needle || row.name.toLowerCase().includes(needle)
  })
  // In progress first: it is the state somebody is waiting on.
  const ordered = [...visible].sort(
    (a, b) => Number(batchesByItem.has(b.id)) - Number(batchesByItem.has(a.id)),
  )

  if (rows.length === 0) {
    return (
      <EmptyState
        icon={<Package className="size-8" />}
        title="Nothing prepared yet"
        description="Create a prepared item on the Make an Item tab and it appears here — in progress until you mark it done, then as stock with its quantity, average cost and value."
      />
    )
  }

  const money = (minor: number) => formatMoney(Math.round(minor), currency, locale)
  const factor = minorUnitFactor(currency)
  const perUnit = (minor: number) => {
    const major = minor / factor
    const digits = major !== 0 && Math.abs(major) < 1 ? 4 : 2
    return major.toLocaleString(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits })
  }
  const inProgress = openBatches.filter((b) => b.itemId).length

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full max-w-xs">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search prepared items…"
            aria-label="Search prepared items"
            className="pl-8"
          />
        </div>
        <select
          className={SELECT}
          value={filter}
          onChange={(event) => setFilter(event.target.value as Filter)}
          aria-label="Show"
        >
          <option value="all">All ({rows.length})</option>
          <option value="in-progress">In progress ({batchesByItem.size})</option>
          <option value="stocked">Stocked ({rows.length - batchesByItem.size})</option>
        </select>
        {inProgress > 0 ? (
          <span className="text-xs text-muted-foreground">
            {inProgress} batch{inProgress === 1 ? '' : 'es'} waiting to be marked done.
          </span>
        ) : null}
      </div>

      {ordered.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">Nothing matches.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Item</TableHead>
              <TableHead>State</TableHead>
              <TableHead className="text-right">Available</TableHead>
              <TableHead className="text-right">Avg cost / unit</TableHead>
              <TableHead className="text-right">Stock value</TableHead>
              <TableHead>Last produced</TableHead>
              <TableHead className="text-right">Runs</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {ordered.map((row) => {
              const open = batchesByItem.get(row.id) ?? []
              return (
                <TableRow key={row.id} data-state={open.length > 0 ? 'in-progress' : 'stocked'}>
                  <TableCell>
                    <Link href={`/dashboard/production/items/${row.id}`} className="font-medium hover:underline">
                      {row.name}
                    </Link>
                  </TableCell>
                  <TableCell>
                    {open.length > 0 ? (
                      <span className="flex flex-wrap items-center gap-1.5">
                        <Badge variant="warning"><Timer /> in progress</Badge>
                        <span className="text-xs text-muted-foreground">
                          {open.length === 1
                            ? `aiming ${open[0].plannedQty} ${open[0].unit ? UNIT_LABELS[open[0].unit] : ''}`
                            : `${open.length} batches`}
                        </span>
                      </span>
                    ) : (
                      <Badge variant="secondary">stocked</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{formatQuantity(row.available, row.unit)}</TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {perUnit(row.costPerUnit)} / {UNIT_LABELS[row.unit]}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{money(row.stockValue)}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {row.lastProducedAt ? <LocalDateTime value={row.lastProducedAt} /> : 'Never'}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{row.runs}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      {/*
                        The batch waiting on somebody, when there is exactly
                        one. With several open there is no single "the" batch,
                        so the item page lists them — but Details is offered
                        either way, which it was not before: an item with two
                        open batches used to lose its action button entirely.
                      */}
                      {open.length === 1 && canManage ? (
                        <Button size="sm" asChild>
                          <Link href={`/dashboard/production/${open[0].id}`}>{open[0].issued ? 'Complete production' : 'Issue ingredients'}</Link>
                        </Button>
                      ) : null}
                      <Button variant="ghost" size="sm" asChild>
                        <Link href={`/dashboard/production/items/${row.id}`}>
                          {open.length > 1 ? `Details (${open.length} open)` : 'Details'}
                        </Link>
                      </Button>
                      {/*
                        Another batch of the SAME item (pro.b.md §12), never a
                        duplicate item.

                        `?tab=make` is what makes this work at all. It used to
                        be `?make=<id>` alone, a same-route navigation that left
                        the tab state on Prepared — so the click did nothing
                        visible, and the form it was meant to open was not even
                        mounted. The tab is read from the URL now.
                      */}
                      {canManage ? (
                        <Button variant="outline" size="sm" asChild>
                          <Link href={`/dashboard/production?tab=make&make=${row.id}`}>Make more</Link>
                        </Button>
                      ) : null}
                    </div>
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      )}
    </div>
  )
}
