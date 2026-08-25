'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { CheckCircle2, Eye, Save, Search, Send, Trash2 } from 'lucide-react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input, Textarea } from '@/components/ui/input'
import { SectionCard } from '@/features/dashboard/components/page-header'
import { formatMoney } from '@/lib/money'
import { UNIT_LABELS, formatQuantity } from '../units'
import {
  approveStockCountAction, cancelStockCountAction, recordCountLinesAction, submitStockCountAction,
} from '../stock-actions'
import type { StockCountDetail } from '../count-queries'
import { callAction } from '@/lib/use-action'

/**
 * The counting sheet.
 *
 * Two things shape this screen. First, it is used standing up, on a tablet, in
 * a cold store — so the rows are large, the only input is a number, and nothing
 * is more than one tap away.
 *
 * Second, it is a blind count: while counting, the system quantity is hidden.
 * Showing someone the number they are expected to find turns counting into
 * confirming, and the discrepancy you are counting to find is exactly the one
 * that gets rubber-stamped. The variance appears once the sheet is submitted,
 * on the review screen, where the person approving it can act on it.
 */
export function CountSheet({
  detail,
  canApprove,
}: {
  detail: StockCountDetail
  canApprove: boolean
}) {
  const router = useRouter()
  const money = (minor: number) => formatMoney(minor, detail.currency)

  const editable = detail.status === 'DRAFT'
  const awaiting = detail.status === 'AWAITING_APPROVAL'
  const done = detail.status === 'APPROVED' || detail.status === 'CANCELLED'

  const [search, setSearch] = React.useState('')
  const [values, setValues] = React.useState<Record<string, string>>(() =>
    Object.fromEntries(
      detail.sheet
        .filter((row) => row.countedQty !== null)
        .map((row) => [row.itemId, String(row.countedQty)]),
    ),
  )
  const [busy, setBusy] = React.useState(false)
  const [approveNote, setApproveNote] = React.useState('')
  const [revealed, setRevealed] = React.useState(false)
  /*
   * The sheet offers every item in the restaurant, because a count is how you
   * find stock the book does not know is here. But handing somebody four
   * hundred lines on a tablet in a cold store produces a count nobody finishes,
   * and an unfinished count is worse than none. So the default is what this
   * branch stocks, and the rest is one tap away rather than unreachable.
   */
  const [scope, setScope] = React.useState<'here' | 'all'>('here')

  const heldCount = React.useMemo(
    () => detail.sheet.filter((row) => row.heldHere).length,
    [detail.sheet],
  )

  const visible = React.useMemo(() => {
    const term = search.trim().toLowerCase()
    // A search always looks everywhere — somebody typing a name is looking for
    // that item, not asking whether the book expects it to be here.
    const base = scope === 'here' && !term ? detail.sheet.filter((r) => r.heldHere) : detail.sheet
    if (!term) return base
    return base.filter(
      (row) =>
        row.name.toLowerCase().includes(term) ||
        (row.sku?.toLowerCase().includes(term) ?? false) ||
        (row.category?.toLowerCase().includes(term) ?? false),
    )
  }, [detail.sheet, search, scope])

  const enteredCount = Object.values(values).filter((v) => v.trim() !== '').length

  const save = async () => {
    const lines = Object.entries(values)
      .filter(([, v]) => v.trim() !== '')
      .map(([itemId, v]) => ({ itemId, countedQty: Number(v) }))
      .filter((l) => Number.isFinite(l.countedQty) && l.countedQty >= 0)

    if (lines.length === 0) {
      toast.error('Enter at least one count')
      return
    }
    setBusy(true)
    const result = await callAction(() => recordCountLinesAction({ stockCountId: detail.id, lines }))
    setBusy(false)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    toast.success(`${result.data.recorded} counted. Nothing has moved yet.`)
    router.refresh()
  }

  const submit = async () => {
    setBusy(true)
    const result = await callAction(() => submitStockCountAction(detail.id))
    setBusy(false)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    toast.success('Sent for approval')
    router.refresh()
  }

  const discard = async () => {
    if (!window.confirm('Discard this count? Nothing has moved, so nothing is lost.')) return
    setBusy(true)
    const result = await callAction(() => cancelStockCountAction(detail.id))
    setBusy(false)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    toast.success('Count discarded')
    router.push('/dashboard/inventory/counts')
  }

  const approve = async () => {
    setBusy(true)
    const result = await callAction(() => approveStockCountAction({
      stockCountId: detail.id,
      notes: approveNote,
    }))
    setBusy(false)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    toast.success(
      `Approved — ${result.data.adjusted} adjusted, ${result.data.unchanged} already correct`,
    )
    router.refresh()
  }

  return (
    <div className="space-y-5">
      <StatusBanner detail={detail} />

      {/* ── counting ─────────────────────────────────────────────────────── */}
      {editable && (
        <SectionCard
          title="Count the shelf"
          description="Enter what you physically find. The system's figure is hidden on purpose — count what is there, not what you expect."
          actions={
            <Badge variant="secondary">
              {enteredCount} / {heldCount}
            </Badge>
          }
        >
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1 rounded-lg border border-border p-0.5">
              {([
                { key: 'here' as const, label: 'Stocked here', n: heldCount },
                { key: 'all' as const, label: 'All items', n: detail.sheet.length },
              ]).map((tab) => (
                <button
                  key={tab.key}
                  type="button"
                  aria-pressed={scope === tab.key}
                  onClick={() => setScope(tab.key)}
                  className={`rounded-md px-2.5 py-1.5 text-xs font-medium transition ${
                    scope === tab.key
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                  }`}
                >
                  {tab.label} · {tab.n}
                </button>
              ))}
            </div>
            <div className="relative min-w-[12rem] flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="pl-9"
                placeholder="Find an item"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
          </div>

          <ul className="divide-y divide-border">
            {visible.map((row) => (
              <li key={row.itemId} className="flex items-center gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{row.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {[row.sku, row.category, row.locationName].filter(Boolean).join(' · ') || '—'}
                    {!row.heldHere && (
                      <span className="ml-1 text-amber-600 dark:text-amber-400">
                        · not stocked here
                      </span>
                    )}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Input
                    className="h-11 w-28 text-right text-base tabular-nums"
                    inputMode="decimal"
                    placeholder="—"
                    value={values[row.itemId] ?? ''}
                    onChange={(e) =>
                      setValues((current) => ({ ...current, [row.itemId]: e.target.value }))
                    }
                  />
                  <span className="w-10 text-sm text-muted-foreground">
                    {UNIT_LABELS[row.unit]}
                  </span>
                </div>
              </li>
            ))}
          </ul>

          {visible.length === 0 && (
            <p className="py-8 text-center text-sm text-muted-foreground">Nothing matches that.</p>
          )}

          <div className="mt-4 flex flex-wrap gap-2">
            <Button onClick={save} disabled={busy}>
              <Save className="mr-2 h-4 w-4" />
              {busy ? 'Saving…' : 'Save count'}
            </Button>
            <Button variant="outline" onClick={submit} disabled={busy || detail.totals.counted === 0}>
              <Send className="mr-2 h-4 w-4" />
              Send for approval
            </Button>
            <Button variant="ghost" onClick={discard} disabled={busy} className="ml-auto">
              <Trash2 className="mr-2 h-4 w-4" />
              Discard
            </Button>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            Saving records what you found. Stock does not move until a manager approves it.
          </p>
        </SectionCard>
      )}

      {/* ── review ───────────────────────────────────────────────────────── */}
      {(awaiting || done || (editable && revealed)) && detail.review.length > 0 && (
        <SectionCard
          title="Variance"
          description="What the system held, what was counted, and the difference."
          actions={
            <Badge variant={detail.totals.withVariance > 0 ? 'destructive' : 'success'}>
              {detail.totals.withVariance} differ
            </Badge>
          }
        >
          <div className="-mx-2 overflow-x-auto px-2">
            <table className="w-full min-w-[40rem] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="pb-2 pr-3 font-medium">Item</th>
                  <th className="pb-2 pr-3 text-right font-medium">System</th>
                  <th className="pb-2 pr-3 text-right font-medium">Counted</th>
                  <th className="pb-2 pr-3 text-right font-medium">Variance</th>
                  <th className="pb-2 text-right font-medium">Value</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {detail.review.map((line) => {
                  const off = Math.abs(line.variance) > 1e-6
                  return (
                    <tr key={line.itemId}>
                      <td className="py-2.5 pr-3">
                        <span className="font-medium">{line.name}</span>
                        {line.notes && (
                          <span className="block text-xs text-muted-foreground">{line.notes}</span>
                        )}
                      </td>
                      <td className="py-2.5 pr-3 text-right tabular-nums text-muted-foreground">
                        {formatQuantity(line.systemQty, line.unit)}
                      </td>
                      <td className="py-2.5 pr-3 text-right tabular-nums">
                        {formatQuantity(line.countedQty, line.unit)}
                      </td>
                      <td
                        className={`py-2.5 pr-3 text-right tabular-nums font-medium ${
                          !off
                            ? 'text-emerald-600 dark:text-emerald-400'
                            : line.variance > 0
                              ? 'text-amber-600 dark:text-amber-400'
                              : 'text-red-600 dark:text-red-400'
                        }`}
                      >
                        {!off
                          ? '0'
                          : `${line.variance > 0 ? '+' : '−'}${formatQuantity(Math.abs(line.variance), line.unit)}`}
                      </td>
                      <td className="py-2.5 text-right tabular-nums text-muted-foreground">
                        {off ? money(line.varianceValue) : '—'}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
              <tfoot>
                <tr className="border-t border-border font-medium">
                  <td className="pt-2.5 pr-3" colSpan={4}>
                    Net variance
                  </td>
                  <td className="pt-2.5 text-right tabular-nums">
                    {money(detail.totals.netVarianceValue)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </SectionCard>
      )}

      {editable && detail.review.length > 0 && !revealed && (
        <button
          type="button"
          onClick={() => setRevealed(true)}
          className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-border py-3 text-sm text-muted-foreground hover:bg-muted"
        >
          <Eye className="h-4 w-4" />
          Reveal variance for what I have counted so far
        </button>
      )}

      {/* ── approval ─────────────────────────────────────────────────────── */}
      {awaiting && canApprove && (
        <SectionCard
          title="Approve"
          description="This is the only step that changes stock. Each difference is posted to the ledger as an adjustment against your name."
        >
          <Textarea
            rows={2}
            placeholder="Note (optional) — explain anything unusual while you still remember it"
            value={approveNote}
            onChange={(e) => setApproveNote(e.target.value)}
          />
          <Button className="mt-3" onClick={approve} disabled={busy}>
            <CheckCircle2 className="mr-2 h-4 w-4" />
            {busy ? 'Posting…' : `Approve and adjust ${detail.totals.withVariance} item(s)`}
          </Button>
        </SectionCard>
      )}

      {awaiting && !canApprove && (
        <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-300">
          Waiting for a manager to approve. Stock has not changed yet.
        </p>
      )}
    </div>
  )
}

function StatusBanner({ detail }: { detail: StockCountDetail }) {
  const map = {
    DRAFT: { label: 'Counting', variant: 'secondary' as const },
    AWAITING_APPROVAL: { label: 'Awaiting approval', variant: 'warning' as const },
    APPROVED: { label: 'Approved', variant: 'success' as const },
    CANCELLED: { label: 'Cancelled', variant: 'destructive' as const },
  }
  const status = map[detail.status]

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border p-3 text-sm">
      <Badge variant={status.variant}>{status.label}</Badge>
      <span className="text-muted-foreground">
        {detail.totals.counted} counted · {detail.totals.uncounted} not yet counted
      </span>
      {detail.approvedByName && (
        <span className="text-muted-foreground">Approved by {detail.approvedByName}</span>
      )}
    </div>
  )
}
