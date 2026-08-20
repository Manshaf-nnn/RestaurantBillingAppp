'use client'

import * as React from 'react'
import { Download } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { SectionCard } from '@/features/dashboard/components/page-header'

export interface Column {
  key: string
  label: string
  align?: 'left' | 'right'
  /** Pre-formatted for display; the raw value is used for CSV. */
  format?: (row: Record<string, unknown>) => string
}

/**
 * A report table that can hand itself over as CSV.
 *
 * The download is built in the browser from the rows already on screen rather
 * than re-queried, so what you export is exactly what you were looking at.
 */
export function ReportTable({
  title,
  description,
  columns,
  rows,
  filename,
  empty = 'Nothing in this period.',
}: {
  title: string
  description?: string
  columns: Column[]
  rows: Array<Record<string, unknown>>
  filename: string
  empty?: string
}) {
  const download = () => {
    const escape = (v: unknown) => {
      const s = String(v ?? '')
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
    }
    const csv = [
      columns.map((c) => escape(c.label)).join(','),
      ...rows.map((r) => columns.map((c) => escape(r[c.key])).join(',')),
    ].join('\n')

    const blob = new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${filename}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <SectionCard
      title={title}
      description={description}
      actions={
        rows.length > 0 ? (
          <Button size="sm" variant="outline" onClick={download}>
            <Download className="mr-1.5 h-4 w-4" />
            CSV
          </Button>
        ) : null
      }
    >
      {rows.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">{empty}</p>
      ) : (
        <div className="-mx-2 overflow-x-auto px-2">
          <table className="w-full min-w-[32rem] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                {columns.map((c) => (
                  <th key={c.key} className={`pb-2 pr-3 font-medium ${c.align === 'right' ? 'text-right' : ''}`}>
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((row, i) => (
                <tr key={i}>
                  {columns.map((c) => (
                    <td
                      key={c.key}
                      className={`py-2.5 pr-3 ${c.align === 'right' ? 'text-right tabular-nums' : ''}`}
                    >
                      {c.format ? c.format(row) : String(row[c.key] ?? '')}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SectionCard>
  )
}
