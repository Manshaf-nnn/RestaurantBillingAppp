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

/** Production History: every completed run, newest first. */
export function ProductionHistory({
  rows,
  currency,
  locale,
  filterItemId,
  onClearFilter,
}: {
  rows: ProductionHistoryRow[]
  currency: string
  locale: string
  filterItemId: string | null
  onClearFilter: () => void
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
          <Button variant="ghost" size="sm" onClick={onClearFilter}>Show all</Button>
        </div>
      ) : null}

      {visible.length === 0 ? (
        <EmptyState
          icon={<History className="size-8" />}
          title={filterItemId ? 'No runs for this item yet' : 'No production yet'}
          description="Each completed run is listed here with what it made and what it cost."
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>When</TableHead>
              <TableHead>Item</TableHead>
              <TableHead className="text-right">Quantity</TableHead>
              <TableHead className="text-right">Total cost</TableHead>
              <TableHead className="text-right">Cost / unit</TableHead>
              <TableHead>Made by</TableHead>
              <TableHead>Where</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map((row) => (
              <TableRow key={row.id}>
                <TableCell className="whitespace-nowrap text-muted-foreground">
                  {row.completedAt ? <LocalDateTime value={row.completedAt} /> : '—'}
                </TableCell>
                <TableCell>
                  <Link href={`/dashboard/production/${row.id}`} className="font-medium hover:underline">
                    {row.itemName}
                  </Link>
                  {row.wasteCount > 0 ? (
                    <Badge variant="warning" size="sm" className="ml-2">waste</Badge>
                  ) : null}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {row.quantity} {row.unit ? row.unit.toLowerCase() : ''}
                </TableCell>
                <TableCell className="text-right tabular-nums">{money(row.totalCost)}</TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">{money(row.unitCost)}</TableCell>
                <TableCell className="text-muted-foreground">{row.madeBy ?? '—'}</TableCell>
                <TableCell className="text-muted-foreground">{row.branchName}</TableCell>
                <TableCell className="text-right">
                  <Link href={`/dashboard/production/${row.id}`} className="font-mono text-xs text-muted-foreground hover:underline">
                    {row.number}
                  </Link>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  )
}
