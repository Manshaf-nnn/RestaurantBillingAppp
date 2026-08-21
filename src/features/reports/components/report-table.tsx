'use client'

import * as React from 'react'
import Link from 'next/link'
import { Download } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { SectionCard } from '@/features/dashboard/components/page-header'
import { formatMoney, type CurrencyCode } from '@/lib/money'

/**
 * How a column is displayed. A NAME, not a function.
 *
 * This used to be `format?: (row) => string`, and every report page passed a
 * closure. React encodes the server tree into a Flight payload before it
 * reaches the browser and a function cannot be encoded, so the serializer threw
 * "Functions cannot be passed directly to Client Components" and the page died.
 * It defeated four rounds of debugging: the build passes because these pages are
 * force-dynamic and never prerendered, and a loader health check reports green
 * because the throw happens after the loader returns, while React encodes the
 * tree.
 *
 * A string crosses the boundary happily, so the formatting moved to this side of
 * it — which is also where `currency` and `locale` were already needed.
 */
export type ColumnFormat =
  | 'money'
  | 'percent'
  | 'delta'
  | 'quantity'
  | 'label'
  | 'boolean'
  | 'text'

export interface Column {
  key: string
  label: string
  align?: 'left' | 'right'
  format?: ColumnFormat
  /** Shown when the value is null or undefined. Defaults to an em dash. */
  fallback?: string
  /** 'quantity' only — the row key holding the unit, e.g. 'unit'. */
  unitKey?: string
  /** 'boolean' only. */
  trueLabel?: string
  falseLabel?: string
}

const round2 = (n: number) => Math.round(n * 100) / 100

function render(
  column: Column,
  row: Record<string, unknown>,
  currency: CurrencyCode,
  locale: string,
): string {
  const value = row[column.key]
  const fallback = column.fallback ?? '—'

  // Money is the exception: an absent amount is nought, not unknown, and a
  // report column of dashes where the zeroes should be reads as broken.
  if (column.format === 'money') return formatMoney(Number(value ?? 0), currency, locale)

  if (value === null || value === undefined) return fallback

  switch (column.format) {
    case 'percent':
      return `${value}%`
    case 'delta':
      return `${Number(value) > 0 ? '+' : ''}${value}%`
    case 'quantity': {
      const unit = column.unitKey ? String(row[column.unitKey] ?? '').toLowerCase() : ''
      return `${round2(Number(value))}${unit ? ` ${unit}` : ''}`
    }
    case 'label':
      return String(value).replace(/_/g, ' ').toLowerCase()
    case 'boolean':
      return value ? (column.trueLabel ?? 'yes') : (column.falseLabel ?? 'no')
    case 'text':
      return String(value)
    default:
      return String(value)
  }
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
  currency = 'INR',
  locale = 'en-IN',
  empty = 'Nothing in this period.',
  hrefTemplate,
}: {
  title: string
  description?: string
  columns: Column[]
  rows: Array<Record<string, unknown>>
  filename: string
  currency?: CurrencyCode
  locale?: string
  empty?: string
  /**
   * Makes each row lead somewhere: `'/dashboard/inventory/{itemId}'`, with
   * `{key}` filled in from that row.
   *
   * A **string**, not a callback, for the same reason `format` is a string —
   * every caller of this component is a Server Component, and a function
   * cannot cross the RSC boundary. Passing one throws at render time, which is
   * exactly how five report pages were left returning 500s earlier in this
   * project. A row whose template resolves to a blank value is simply not
   * linked rather than linking to a broken URL.
   *
   * Reports were dead ends before this: you could read that Sugar was the
   * biggest wastage of the month and had no way to reach Sugar.
   */
  hrefTemplate?: string
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
              {rows.map((row, i) => {
                const href = hrefTemplate ? resolveHref(hrefTemplate, row) : null
                return (
                  <tr
                    key={i}
                    className={href ? 'cursor-pointer transition-colors hover:bg-muted/40' : ''}
                  >
                    {columns.map((c, columnIndex) => (
                      <td
                        key={c.key}
                        className={`py-2.5 pr-3 ${c.align === 'right' ? 'text-right tabular-nums' : ''}`}
                      >
                        {/*
                          The link wraps the FIRST cell only, not the row. An
                          anchor cannot legally contain a <tr>, and a row-level
                          onClick would need this to be a client component with
                          a callback the server pages cannot supply — as well as
                          being invisible to the keyboard and to a middle click.
                        */}
                        {href && columnIndex === 0 ? (
                          <Link href={href} className="font-medium hover:underline">
                            {render(c, row, currency, locale)}
                          </Link>
                        ) : (
                          render(c, row, currency, locale)
                        )}
                      </td>
                    ))}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </SectionCard>
  )
}

/**
 * Fill `{key}` placeholders from a row.
 *
 * Returns null when any placeholder is missing or blank, so a row with no id
 * stays plain text instead of linking to `/dashboard/inventory/undefined`.
 */
function resolveHref(template: string, row: Record<string, unknown>): string | null {
  let missing = false

  const href = template.replace(/\{(\w+)\}/g, (_match, key: string) => {
    const value = row[key]
    if (value === null || value === undefined || value === '') {
      missing = true
      return ''
    }
    return encodeURIComponent(String(value))
  })

  return missing ? null : href
}
