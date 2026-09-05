'use client'

import Link from 'next/link'
import { Package } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/feedback'
import { LocalDateTime } from '@/components/local-time'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import { UNIT_LABELS, formatQuantity } from '@/features/inventory/units'
import { formatMoney, minorUnitFactor } from '@/lib/money'
import type { PreparedItemRow } from '../types'

/** Prepared Items: what has been made here, what is left, and what it is worth. */
export function PreparedItemsTable({
  rows,
  currency,
  locale,
  canManage,
  onHistory,
  onMakeMore,
}: {
  rows: PreparedItemRow[]
  currency: string
  locale: string
  canManage: boolean
  onHistory: (itemId: string) => void
  onMakeMore: (name: string) => void
}) {
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={<Package className="size-8" />}
        title="Nothing prepared yet"
        description="Make an item and it appears here as stock — with its quantity, average cost and value."
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

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Item</TableHead>
          <TableHead className="text-right">Available</TableHead>
          <TableHead className="text-right">Avg cost / unit</TableHead>
          <TableHead className="text-right">Stock value</TableHead>
          <TableHead>Last produced</TableHead>
          <TableHead className="text-right">Runs</TableHead>
          <TableHead />
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.id}>
            <TableCell>
              <Link href={`/dashboard/inventory/${row.id}`} className="font-medium hover:underline">
                {row.name}
              </Link>
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
                <Button variant="ghost" size="sm" onClick={() => onHistory(row.id)}>History</Button>
                {canManage ? (
                  <Button variant="outline" size="sm" onClick={() => onMakeMore(row.name)}>Make more</Button>
                ) : null}
              </div>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}
