import * as React from 'react'

import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'

/**
 * The shared vocabulary of the platform console (production.md §8).
 *
 * §8 asks twice for restraint — "keep the UI extremely simple", "do not add
 * unnecessary controls" — and twelve pages built independently would not stay
 * simple however carefully each one was written. So there are four pieces here
 * and the pages are assembled from them: a figure, a status word, a row of
 * figures and a plain table. Nothing has a chart, nothing has a filter it does
 * not need, and nothing offers an action that is not named in the spec.
 *
 * The other reason they live together: an operator reading twelve screens
 * during an incident should not have to relearn what "degraded" looks like on
 * each one.
 */

export type Tone = 'ok' | 'warn' | 'bad' | 'idle'

const TONE_CLASS: Record<Tone, string> = {
  ok: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
  warn: 'bg-amber-500/10 text-amber-700 dark:text-amber-400',
  bad: 'bg-red-500/10 text-red-700 dark:text-red-400',
  idle: 'bg-muted text-muted-foreground',
}

/** A single figure with its name, and nothing else. */
export function Stat({
  label,
  value,
  hint,
  tone = 'idle',
}: {
  label: string
  value: React.ReactNode
  hint?: React.ReactNode
  tone?: Tone
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {label}
        </div>
        <div
          className={cn(
            'mt-1 text-2xl font-semibold tabular-nums',
            tone === 'bad' && 'text-red-600 dark:text-red-400',
            tone === 'warn' && 'text-amber-600 dark:text-amber-400',
          )}
        >
          {value}
        </div>
        {hint ? <div className="mt-1 text-xs text-muted-foreground">{hint}</div> : null}
      </CardContent>
    </Card>
  )
}

export function StatRow({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{children}</div>
  )
}

/** A status word, coloured. Used for every health readout on every page. */
export function StatusPill({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return (
    <Badge variant="secondary" className={cn('font-medium', TONE_CLASS[tone])}>
      {children}
    </Badge>
  )
}

/**
 * A plain table with a heading and an honest empty state.
 *
 * The empty state is a parameter and not a default string, because "nothing to
 * show" and "nothing is wrong" are different sentences and confusing them is
 * how an operator learns to trust a screen that has stopped working. A jobs
 * page with no rows means the queue is clear; a slow-query page with no rows
 * might mean the extension is not installed.
 */
export function OpsTable({
  title,
  description,
  columns,
  rows,
  empty,
  footer,
}: {
  title: string
  description?: string
  columns: string[]
  rows: React.ReactNode[][]
  empty: string
  footer?: React.ReactNode
}) {
  return (
    <Card className="mb-6">
      <CardHeader className="pb-3">
        <CardTitle className="text-base">{title}</CardTitle>
        {description ? (
          <p className="text-sm text-muted-foreground">{description}</p>
        ) : null}
      </CardHeader>
      <CardContent className="p-0">
        {rows.length === 0 ? (
          <p className="px-6 pb-6 text-sm text-muted-foreground">{empty}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-y bg-muted/40 text-left">
                  {columns.map((column) => (
                    <th key={column} className="px-4 py-2 font-medium text-muted-foreground">
                      {column}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => (
                  <tr key={i} className="border-b last:border-0">
                    {row.map((cell, j) => (
                      <td key={j} className="px-4 py-2 align-top">
                        {cell}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {footer ? <div className="border-t px-4 py-3 text-xs text-muted-foreground">{footer}</div> : null}
      </CardContent>
    </Card>
  )
}

/** Bytes as something a person can read. */
export function bytes(value: number): string {
  if (value < 1024) return `${value} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let n = value / 1024
  let i = 0
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i += 1
  }
  return `${n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`
}

/** "4 minutes ago", for timestamps an operator is scanning. */
export function ago(iso: string | null): string {
  if (!iso) return '—'
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000)
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`
  return `${Math.round(seconds / 86_400)}d ago`
}
