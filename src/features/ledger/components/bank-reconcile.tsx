'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { SectionCard, StatCard } from '@/features/dashboard/components/page-header'
import { formatMoney, type CurrencyCode } from '@/lib/money'
import { callAction } from '@/lib/use-action'
import {
  importBankStatementAction,
  matchBankLineAction,
  setBankLineStatusAction,
} from '../actions'

/**
 * Bank reconciliation (acCal.md §6): upload the statement your bank gives
 * you, and accept the matches TableFlow suggests. Three states only —
 * Matched, Unmatched, Duplicate — and one click each.
 */

export interface BankLineRow {
  id: string
  lineDate: string
  description: string
  reference: string | null
  amount: number
  status: 'UNMATCHED' | 'MATCHED' | 'DUPLICATE' | 'IGNORED'
  suggestion: {
    type: 'PAYMENT' | 'SUPPLIER_PAYMENT' | 'OUTGOING_PAYMENT'
    id: string
    label: string
    amount: number
    date: string
    href: string
  } | null
}

export function BankReconcile({
  counts,
  lines,
  statements,
  currency,
  canReconcile,
}: {
  counts: { matched: number; unmatched: number; duplicate: number; ignored: number }
  lines: BankLineRow[]
  statements: Array<{ id: string; fileName: string; lineCount: number; createdAt: string; uploadedByName: string }>
  currency: CurrencyCode
  canReconcile: boolean
}) {
  const router = useRouter()
  const [pendingId, setPendingId] = React.useState<string | null>(null)
  const [uploading, setUploading] = React.useState(false)
  const money = (minor: number) => formatMoney(minor, currency)

  const upload = async (file: File) => {
    setUploading(true)
    try {
      const content = await file.text()
      const result = await callAction(() =>
        importBankStatementAction({ fileName: file.name, content }),
      )
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      const { imported, duplicates, skipped } = result.data
      toast.success(
        `${imported} line(s) imported` +
          (duplicates > 0 ? `, ${duplicates} look like duplicates` : '') +
          (skipped > 0 ? `, ${skipped} row(s) could not be read` : ''),
      )
      router.refresh()
    } finally {
      setUploading(false)
    }
  }

  const accept = async (line: BankLineRow) => {
    if (!line.suggestion) return
    setPendingId(line.id)
    const result = await callAction(() =>
      matchBankLineAction({ lineId: line.id, type: line.suggestion!.type, targetId: line.suggestion!.id }),
    )
    setPendingId(null)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    router.refresh()
  }

  const setStatus = async (line: BankLineRow, status: 'UNMATCHED' | 'IGNORED') => {
    setPendingId(line.id)
    const result = await callAction(() => setBankLineStatusAction({ lineId: line.id, status }))
    setPendingId(null)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    router.refresh()
  }

  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Matched" value={counts.matched} tone="success" />
        <StatCard label="Unmatched" value={counts.unmatched} tone={counts.unmatched > 0 ? 'warning' : 'default'} />
        <StatCard label="Duplicates" value={counts.duplicate} tone={counts.duplicate > 0 ? 'destructive' : 'default'} />
        <StatCard label="Set aside" value={counts.ignored} />
      </div>

      {canReconcile ? (
        <SectionCard
          title="Import a statement"
          description="Download the CSV from your bank's website and drop it here. The same file cannot be imported twice."
        >
          <label className="flex flex-wrap items-center gap-3 text-sm">
            <input
              type="file"
              accept=".csv,text/csv,text/plain"
              disabled={uploading}
              onChange={(event) => {
                const file = event.target.files?.[0]
                if (file) void upload(file)
                event.target.value = ''
              }}
              className="text-sm file:mr-3 file:rounded-lg file:border file:bg-muted file:px-3 file:py-1.5 file:text-sm"
            />
            {uploading ? <span className="text-muted-foreground">Reading…</span> : null}
          </label>
          {statements.length > 0 ? (
            <ul className="mt-3 text-xs text-muted-foreground">
              {statements.map((statement) => (
                <li key={statement.id}>
                  {statement.fileName} · {statement.lineCount} lines ·{' '}
                  {new Date(statement.createdAt).toLocaleDateString()} · {statement.uploadedByName}
                </li>
              ))}
            </ul>
          ) : null}
        </SectionCard>
      ) : null}

      <SectionCard
        title="Lines to deal with"
        description={
          lines.length === 0
            ? 'Every imported line has been matched or set aside.'
            : 'Check the suggestion, then accept it. A suggestion always matches the amount exactly.'
        }
      >
        {lines.length > 0 ? (
          <ul className="divide-y text-sm">
            {lines.map((line) => (
              <li key={line.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="font-medium">
                    {line.description}
                    {line.status === 'DUPLICATE' ? (
                      <Badge variant="destructive" className="ml-2">
                        looks like a duplicate
                      </Badge>
                    ) : null}
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {new Date(line.lineDate).toLocaleDateString()}
                    {line.reference ? ` · ref ${line.reference}` : ''}
                  </p>
                  {line.suggestion ? (
                    <p className="mt-1 text-xs">
                      Looks like:{' '}
                      <Link href={line.suggestion.href} className="font-medium text-primary underline-offset-2 hover:underline">
                        {line.suggestion.label}
                      </Link>{' '}
                      · {money(line.suggestion.amount)} on {new Date(line.suggestion.date).toLocaleDateString()}
                    </p>
                  ) : (
                    <p className="mt-1 text-xs text-muted-foreground">
                      Nothing in TableFlow matches this amount within five days. It may be a bank charge, a
                      transfer, or something not recorded yet.
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-2 whitespace-nowrap">
                  <span className={line.amount > 0 ? 'font-semibold tabular-nums text-success' : 'font-semibold tabular-nums'}>
                    {line.amount > 0 ? '+' : '−'}
                    {money(Math.abs(line.amount))}
                  </span>
                  {canReconcile ? (
                    <>
                      {line.suggestion ? (
                        <Button size="sm" loading={pendingId === line.id} onClick={() => accept(line)}>
                          Accept match
                        </Button>
                      ) : null}
                      <Button
                        size="sm"
                        variant="ghost"
                        loading={pendingId === line.id}
                        onClick={() => setStatus(line, 'IGNORED')}
                      >
                        Set aside
                      </Button>
                    </>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        ) : null}
      </SectionCard>
    </div>
  )
}
