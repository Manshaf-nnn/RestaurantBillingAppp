'use client'

import Link from 'next/link'
import { History } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/feedback'
import { LocalDateTime } from '@/components/local-time'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import { formatMoney } from '@/lib/money'
import type { ProductionHistoryRow } from '../types'

/**
 * Production History (pro.b.md §13): every run, newest first, telling the
 * complete story — reference, item, when, planned, actual, wastage, what it
 * consumed, what it cost in total and per unit, who, where, status, batch.
 * The FIFO lots behind each line are on the run's own page, one click away.
 *
 * In-progress and cancelled runs are rows here too. History that showed only
 * what finished would quietly hide the batch somebody started and never
 * completed, which is exactly the thing an owner needs to see.
 */

const STATUS: Record<string, { label: string; variant: 'success' | 'warning' | 'destructive' | 'secondary' }> = {
  COMPLETED: { label: 'Completed', variant: 'success' },
  PARTIALLY_COMPLETED: { label: 'Partly done', variant: 'warning' },
  IN_PROGRESS: { label: 'In progress', variant: 'warning' },
  CANCELLED: { label: 'Cancelled', variant: 'destructive' },
}

export function ProductionHistory({
  rows,
  currency,
  locale,
  filterItemId = null,
  onClearFilter,
}: {
  rows: ProductionHistoryRow[]
  currency: string
  locale: string
  filterItemId?: string | null
  onClearFilter?: () => void
}) {
  const visible = filterItemId ? rows.filter((r) => r.itemId === filterItemId) : rows
  const filterName = filterItemId ? rows.find((r) => r.itemId === filterItemId)?.itemName ?? null : null
  const money = (minor: number) => formatMoney(minor, currency, locale)

  return (
    <div className="space-y-3">
      {filterItemId ? (
        <div className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">Showing</span>
          <Badge variant="secondary">{filterName ?? 'one item'}</Badge>
          {onClearFilter ? (
            <Button variant="ghost" size="sm" onClick={onClearFilter}>Show all</Button>
          ) : null}
        </div>
      ) : null}

      {visible.length === 0 ? (
        <EmptyState
          icon={<History className="size-8" />}
          title={filterItemId ? 'No runs for this item yet' : 'No production yet'}
          description="Each run is listed here with what it made, what it consumed and what it cost."
        />
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Reference</TableHead>
                <TableHead>Item</TableHead>
                <TableHead>When</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Planned</TableHead>
                <TableHead className="text-right">Actual</TableHead>
                <TableHead className="text-right">Wastage</TableHead>
                <TableHead>Ingredients consumed</TableHead>
                <TableHead className="text-right">Total cost</TableHead>
                <TableHead className="text-right">Cost / unit</TableHead>
                <TableHead>Made by</TableHead>
                <TableHead>Branch</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((row) => {
                const state = STATUS[row.status] ?? { label: row.status.toLowerCase(), variant: 'secondary' as const }
                const unit = row.unit ? row.unit.toLowerCase() : ''
                return (
                  <TableRow key={row.id} data-status={row.status}>
                    <TableCell>
                      <Link href={`/dashboard/production/${row.id}`} className="font-mono text-xs hover:underline">
                        {row.number}
                      </Link>
                      {row.batchNumber ? (
                        <span className="block font-mono text-[10px] text-muted-foreground">{row.batchNumber}</span>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <Link href={`/dashboard/production/${row.id}`} className="font-medium hover:underline">
                        {row.itemName}
                      </Link>
                      {row.wasteCount > 0 ? (
                        <Badge variant="warning" size="sm" className="ml-2">ingredient waste</Badge>
                      ) : null}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      <LocalDateTime value={row.completedAt ?? row.createdAt} />
                    </TableCell>
                    <TableCell>
                      <Badge variant={state.variant} size="sm">{state.label}</Badge>
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      {row.plannedQty} {unit}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {row.actualQty !== null ? `${row.actualQty} ${unit}` : '—'}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      {row.wastageQty !== null && row.wastageQty > 0 ? `${row.wastageQty} ${unit}` : '—'}
                    </TableCell>
                    <TableCell className="max-w-[18rem] text-xs text-muted-foreground">
                      {row.consumed.length === 0
                        ? row.status === 'CANCELLED' ? 'Nothing — abandoned' : '—'
                        : row.consumed
                            .map((line) => `${line.name} ${line.quantity} ${line.unit.toLowerCase()}`)
                            .join(', ')}
                      {row.status === 'IN_PROGRESS' && row.consumed.length > 0 ? ' (planned)' : ''}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{money(row.totalCost)}</TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">{money(row.unitCost)}</TableCell>
                    <TableCell className="text-muted-foreground">{row.madeBy ?? '—'}</TableCell>
                    <TableCell className="text-muted-foreground">{row.branchName}</TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
}
