'use client'

import * as React from 'react'
import { ArrowDownLeft, ArrowUpRight, Lock, Unlock } from 'lucide-react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/feedback'
import { Input, Textarea } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { SectionCard } from '@/features/dashboard/components/page-header'
import { LocalDateTime } from '@/components/local-time'
import { formatMoney, minorUnitFactor } from '@/lib/money'
import { closeDrawerAction, openDrawerAction, recordCashMovementAction } from '../actions'
import type { DrawerPageData } from '../queries'

/**
 * The cashier's drawer screen.
 *
 * Deliberately one page rather than a wizard: a cashier closing up at midnight
 * wants the expected figure, the count box and the variance in front of them at
 * once, not spread over steps. The variance is shown live as they type so a
 * miscount is caught before the drawer is closed rather than after.
 */
export function DrawerConsole({ data }: { data: DrawerPageData }) {
  const money = (minor: number) => formatMoney(minor, data.currency)

  return (
    <div className="space-y-6">
      {data.open ? <OpenDrawerPanel data={data} money={money} /> : <OpenForm data={data} />}
      <History data={data} money={money} />
    </div>
  )
}

// ── opening ──────────────────────────────────────────────────────────────────

function OpenForm({ data }: { data: DrawerPageData }) {
  const [float, setFloat] = React.useState('')
  const [branchId, setBranchId] = React.useState(
    data.branches.find((b) => b.isDefault)?.id ?? data.branches[0]?.id ?? '',
  )
  const [note, setNote] = React.useState('')
  const [busy, setBusy] = React.useState(false)

  const submit = async () => {
    const value = Number(float)
    if (!Number.isFinite(value) || value < 0) {
      toast.error('Enter the cash you are starting with')
      return
    }
    setBusy(true)
    const result = await openDrawerAction({ openingFloat: value, branchId, note })
    setBusy(false)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    toast.success('Drawer opened')
  }

  return (
    <SectionCard
      title="Open your drawer"
      description="Count the cash you are starting with. Everything you take today is measured against it."
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="float">Opening float</Label>
          <Input
            id="float"
            inputMode="decimal"
            placeholder="0.00"
            value={float}
            onChange={(e) => setFloat(e.target.value)}
          />
        </div>
        {data.branches.length > 1 && (
          <div className="space-y-1.5">
            <Label htmlFor="branch">Branch</Label>
            <select
              id="branch"
              className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm"
              value={branchId}
              onChange={(e) => setBranchId(e.target.value)}
            >
              {data.branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="opennote">Note (optional)</Label>
          <Input
            id="opennote"
            placeholder="e.g. took over from the morning shift"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
      </div>
      <Button className="mt-4" onClick={submit} disabled={busy}>
        <Unlock className="mr-2 h-4 w-4" />
        {busy ? 'Opening…' : 'Open drawer'}
      </Button>
    </SectionCard>
  )
}

// ── open drawer ──────────────────────────────────────────────────────────────

function OpenDrawerPanel({
  data,
  money,
}: {
  data: DrawerPageData
  money: (minor: number) => string
}) {
  const open = data.open!
  const factor = minorUnitFactor(data.currency)

  const [counted, setCounted] = React.useState('')
  const [closeNote, setCloseNote] = React.useState('')
  const [busy, setBusy] = React.useState(false)

  // Live variance while the cashier counts, so a slip is caught before closing.
  const countedMinor = Number(counted) * factor
  const variance =
    counted.trim() && Number.isFinite(countedMinor)
      ? Math.round(countedMinor) - open.expectedCash
      : null

  const close = async () => {
    const value = Number(counted)
    if (!counted.trim() || !Number.isFinite(value) || value < 0) {
      toast.error('Enter the cash you counted')
      return
    }
    setBusy(true)
    const result = await closeDrawerAction({
      sessionId: open.session.id,
      countedCash: value,
      note: closeNote,
    })
    setBusy(false)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    const v = result.data.variance
    if (v === 0) toast.success('Drawer closed and balanced exactly')
    else toast.warning(`Drawer closed — ${v > 0 ? 'over' : 'short'} by ${money(Math.abs(v))}`)
  }

  return (
    <>
      <SectionCard
        title="Drawer open"
        actions={<Badge variant="success">Open</Badge>}
      >
        <p className="-mt-2 mb-4 text-sm text-muted-foreground">
          Opened <LocalDateTime value={open.session.openedAt} />
        </p>

        <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Figure label="Opening float" value={money(open.openingFloat)} />
          <Figure label="Cash sales" value={money(open.cashSales)} />
          <Figure label="Cash in" value={money(open.cashIn)} />
          <Figure label="Cash out" value={money(open.cashOut)} />
          <Figure label="Card takings" value={money(open.cardSales)} muted />
          <Figure label="Expected in drawer" value={money(open.expectedCash)} emphasis />
        </dl>
      </SectionCard>

      <MovementForm sessionId={open.session.id} />

      {open.movements.length > 0 && (
        <SectionCard title="Cash movements" description="Every note in or out that was not a sale.">
          <ul className="divide-y divide-border">
            {open.movements.map((m) => (
              <li key={m.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                <span className="flex min-w-0 items-center gap-2">
                  {m.type === 'CASH_IN' ? (
                    <ArrowDownLeft className="h-4 w-4 shrink-0 text-emerald-600" />
                  ) : (
                    <ArrowUpRight className="h-4 w-4 shrink-0 text-amber-600" />
                  )}
                  <span className="truncate">{m.reason}</span>
                </span>
                <span className="shrink-0 tabular-nums">
                  {m.type === 'CASH_IN' ? '+' : '−'}
                  {money(m.amount)}
                </span>
              </li>
            ))}
          </ul>
        </SectionCard>
      )}

      <SectionCard
        title="Close drawer"
        description="Count the cash physically in the drawer and enter it. The difference is recorded, not corrected."
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="counted">Counted cash</Label>
            <Input
              id="counted"
              inputMode="decimal"
              placeholder="0.00"
              value={counted}
              onChange={(e) => setCounted(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Variance</Label>
            <div
              className={`flex h-10 items-center rounded-lg border px-3 text-sm tabular-nums ${
                variance === null
                  ? 'border-input text-muted-foreground'
                  : variance === 0
                    ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
                    : 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400'
              }`}
            >
              {variance === null
                ? 'Enter your count'
                : variance === 0
                  ? 'Balanced exactly'
                  : `${variance > 0 ? 'Over' : 'Short'} by ${money(Math.abs(variance))}`}
            </div>
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="closenote">Note (optional)</Label>
            <Textarea
              id="closenote"
              rows={2}
              placeholder="Explain any difference while you still remember it"
              value={closeNote}
              onChange={(e) => setCloseNote(e.target.value)}
            />
          </div>
        </div>
        <Button className="mt-4" variant="destructive" onClick={close} disabled={busy}>
          <Lock className="mr-2 h-4 w-4" />
          {busy ? 'Closing…' : 'Close drawer'}
        </Button>
      </SectionCard>
    </>
  )
}

function MovementForm({ sessionId }: { sessionId: string }) {
  const [type, setType] = React.useState<'CASH_IN' | 'CASH_OUT'>('CASH_OUT')
  const [amount, setAmount] = React.useState('')
  const [reason, setReason] = React.useState('')
  const [busy, setBusy] = React.useState(false)

  const submit = async () => {
    const value = Number(amount)
    if (!Number.isFinite(value) || value <= 0) {
      toast.error('Enter an amount')
      return
    }
    if (reason.trim().length < 2) {
      toast.error('Give a reason — an unexplained movement cannot be reconciled later')
      return
    }
    setBusy(true)
    const result = await recordCashMovementAction({ sessionId, type, amount: value, reason })
    setBusy(false)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    setAmount('')
    setReason('')
    toast.success('Recorded')
  }

  return (
    <SectionCard
      title="Cash in / cash out"
      description="Money that moves for a reason other than a sale — a float top-up, a supplier paid in cash, a bank drop."
    >
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="space-y-1.5">
          <Label htmlFor="mtype">Direction</Label>
          <select
            id="mtype"
            className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm"
            value={type}
            onChange={(e) => setType(e.target.value as 'CASH_IN' | 'CASH_OUT')}
          >
            <option value="CASH_OUT">Cash out</option>
            <option value="CASH_IN">Cash in</option>
          </select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="mamount">Amount</Label>
          <Input
            id="mamount"
            inputMode="decimal"
            placeholder="0.00"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="mreason">Reason</Label>
          <Input
            id="mreason"
            placeholder="e.g. paid vegetable supplier"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
      </div>
      <Button className="mt-4" variant="outline" onClick={submit} disabled={busy}>
        {busy ? 'Recording…' : 'Record movement'}
      </Button>
    </SectionCard>
  )
}

// ── history ──────────────────────────────────────────────────────────────────

function History({ data, money }: { data: DrawerPageData; money: (m: number) => string }) {
  const closed = data.recent.filter((s) => s.status === 'CLOSED')
  if (closed.length === 0) {
    return (
      <SectionCard title="Past drawers">
        <EmptyState title="No closed drawers yet" description="Closed sessions and their variances appear here." />
      </SectionCard>
    )
  }

  return (
    <SectionCard title="Past drawers" description="What was expected, what was counted, and the difference.">
      <div className="-mx-2 overflow-x-auto px-2">
        <table className="w-full min-w-[36rem] text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th className="pb-2 pr-3 font-medium">Closed</th>
              <th className="pb-2 pr-3 font-medium">Cashier</th>
              <th className="pb-2 pr-3 text-right font-medium">Expected</th>
              <th className="pb-2 pr-3 text-right font-medium">Counted</th>
              <th className="pb-2 text-right font-medium">Variance</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {closed.map((s) => (
              <tr key={s.id}>
                <td className="py-2.5 pr-3 whitespace-nowrap">
                  {s.closedAt ? <LocalDateTime value={s.closedAt} /> : '—'}
                </td>
                <td className="py-2.5 pr-3">{s.openedByName}</td>
                <td className="py-2.5 pr-3 text-right tabular-nums">
                  {s.expectedCash === null ? '—' : money(s.expectedCash)}
                </td>
                <td className="py-2.5 pr-3 text-right tabular-nums">
                  {s.countedCash === null ? '—' : money(s.countedCash)}
                </td>
                <td className="py-2.5 text-right tabular-nums">
                  {s.variance === null ? (
                    '—'
                  ) : s.variance === 0 ? (
                    <span className="text-emerald-600 dark:text-emerald-400">0</span>
                  ) : (
                    <span className="text-amber-600 dark:text-amber-400">
                      {s.variance > 0 ? '+' : '−'}
                      {money(Math.abs(s.variance))}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </SectionCard>
  )
}

function Figure({
  label,
  value,
  emphasis,
  muted,
}: {
  label: string
  value: string
  emphasis?: boolean
  muted?: boolean
}) {
  return (
    <div
      className={`rounded-lg border p-3 ${
        emphasis ? 'border-primary/40 bg-primary/5' : 'border-border'
      }`}
    >
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd
        className={`mt-1 tabular-nums ${
          emphasis ? 'text-lg font-semibold' : muted ? 'text-muted-foreground' : 'font-medium'
        }`}
      >
        {value}
      </dd>
    </div>
  )
}
