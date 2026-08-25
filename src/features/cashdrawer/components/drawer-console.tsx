'use client'

import * as React from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ArrowDownLeft, ArrowRightLeft, ArrowUpRight, Coins, Lock, ShieldCheck } from 'lucide-react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/feedback'
import { Input, Textarea } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { SectionCard } from '@/features/dashboard/components/page-header'
import { LocalDateTime } from '@/components/local-time'
import { formatMoney, minorUnitFactor } from '@/lib/money'
import {
  closeDrawerAction,
  forceCloseDrawerAction,
  openDrawerAction,
  recordCashMovementAction,
  reviewDrawerAction,
} from '../actions'
import { requestHandoverAction } from '@/features/handover/cash-actions'
import { MANUAL_MOVEMENT_TYPES, MOVEMENT_TYPES } from '../movement-types'
import type { DrawerPageData } from '../queries'
import { callAction } from '@/lib/use-action'

/**
 * The cashier's drawer screen.
 *
 * Deliberately one page rather than a wizard: a cashier closing up at midnight
 * wants the expected figure, the count box and the variance in front of them at
 * once, not spread over steps. The variance is shown live as they type so a
 * miscount is caught before the drawer is closed rather than after.
 *
 * The close form asks for a reason the moment the count stops matching, and the
 * button stays disabled until there is one. The server refuses either way — the
 * client half exists so nobody types a count, presses close, and is told off
 * afterwards.
 */
export function DrawerConsole({ data }: { data: DrawerPageData }) {
  const money = (minor: number) => formatMoney(minor, data.currency)

  return (
    <div className="space-y-6">
      {data.pendingHandovers.length > 0 && <IncomingHandovers data={data} money={money} />}
      {data.openNow.some((row) => !row.mine) && <OpenNow data={data} money={money} />}
      {data.review.length > 0 && <ReviewQueue data={data} money={money} />}
      {data.open ? <OpenDrawerPanel data={data} money={money} /> : <OpenForm data={data} />}
      <History data={data} money={money} />
    </div>
  )
}

// ── opening ──────────────────────────────────────────────────────────────────

function OpenForm({ data }: { data: DrawerPageData }) {
  const router = useRouter()
  const [float, setFloat] = React.useState('')
  const [petty, setPetty] = React.useState('')
  const [branchId, setBranchId] = React.useState(
    data.branches.find((b) => b.isDefault)?.id ?? data.branches[0]?.id ?? '',
  )
  const [registerId, setRegisterId] = React.useState('')
  const [note, setNote] = React.useState('')
  const [busy, setBusy] = React.useState(false)

  const branchRegisters = data.registers.filter((r) => r.branchId === branchId)

  const submit = async () => {
    const value = Number(float)
    if (!Number.isFinite(value) || value < 0) {
      toast.error('Enter the cash you are starting with')
      return
    }
    const pettyValue = petty.trim() ? Number(petty) : 0
    if (!Number.isFinite(pettyValue) || pettyValue < 0) {
      toast.error('Enter the petty cash you are starting with, or leave it blank')
      return
    }
    setBusy(true)
    const result = await callAction(() =>
      openDrawerAction({
        openingFloat: value,
        openingPettyCash: pettyValue,
        branchId,
        registerId,
        note,
      }),
    )
    setBusy(false)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    toast.success('Drawer opened')
    router.refresh()
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
        <div className="space-y-1.5">
          <Label htmlFor="petty">Opening petty cash</Label>
          <Input
            id="petty"
            inputMode="decimal"
            placeholder="0.00"
            value={petty}
            onChange={(e) => setPetty(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            The separate tin, counted on its own all shift.
          </p>
        </div>
        {data.branches.length > 1 && (
          <div className="space-y-1.5">
            <Label htmlFor="branch">Branch</Label>
            <select
              id="branch"
              className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm"
              value={branchId}
              onChange={(e) => {
                setBranchId(e.target.value)
                setRegisterId('')
              }}
            >
              {data.branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </div>
        )}
        {/* One till is not a choice, so it is not a question. */}
        {branchRegisters.length > 1 && (
          <div className="space-y-1.5">
            <Label htmlFor="register">Till</Label>
            <select
              id="register"
              className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm"
              value={registerId}
              onChange={(e) => setRegisterId(e.target.value)}
            >
              <option value="">First free till</option>
              {branchRegisters.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="opennote">Note (optional)</Label>
          <Input
            id="opennote"
            placeholder="Anything worth remembering about this shift"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
      </div>
      <Button className="mt-4" onClick={submit} disabled={busy}>
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
  const router = useRouter()
  const factor = minorUnitFactor(data.currency)

  const [counted, setCounted] = React.useState('')
  const [varianceReason, setVarianceReason] = React.useState('')
  const [closeNote, setCloseNote] = React.useState('')
  const [busy, setBusy] = React.useState(false)

  // Live variance while the cashier counts, so a slip is caught before closing.
  const countedMinor = Number(counted) * factor
  const variance =
    counted.trim() && Number.isFinite(countedMinor)
      ? Math.round(countedMinor) - open.expectedCash
      : null

  const needsReason = variance !== null && variance !== 0
  const reasonMissing = needsReason && varianceReason.trim().length < 2

  const close = async () => {
    const value = Number(counted)
    if (!counted.trim() || !Number.isFinite(value) || value < 0) {
      toast.error('Enter the cash you counted')
      return
    }
    setBusy(true)
    const result = await callAction(() =>
      closeDrawerAction({
        sessionId: open.session.id,
        countedCash: value,
        varianceReason,
        note: closeNote,
      }),
    )
    setBusy(false)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    const v = result.data.variance
    if (result.data.needsReview) {
      toast.warning(
        `Drawer counted — ${v > 0 ? 'over' : 'short'} by ${money(Math.abs(v))}. A manager has to sign it off.`,
      )
    } else if (v === 0) {
      toast.success('Drawer closed and balanced exactly')
    } else {
      toast.warning(`Drawer closed — ${v > 0 ? 'over' : 'short'} by ${money(Math.abs(v))}`)
    }
    router.refresh()
  }

  return (
    <>
      <SectionCard title="Drawer open" actions={<Badge variant="success">Open</Badge>}>
        <p className="-mt-2 mb-4 text-sm text-muted-foreground">
          {open.session.sessionNumber}
          {data.openBranchName ? ` · ${data.openBranchName}` : ''}
          {data.openRegisterName ? ` · ${data.openRegisterName}` : ''} · opened{' '}
          <LocalDateTime value={open.session.openedAt} />
        </p>

        <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Figure label="Opening float" value={money(open.openingFloat)} />
          <Figure label="Cash sales" value={money(open.cashSales)} />
          <Figure label="Cash in" value={money(open.cashIn)} />
          <Figure label="Cash out" value={money(open.cashOut)} />
          <Figure label="Card takings" value={money(open.cardSales)} muted />
          <Figure label="Other takings" value={money(open.otherSales)} muted />
          <Figure label="Expected in drawer" value={money(open.expectedCash)} emphasis />
        </dl>

        {/*
          The tin, shown next to the drawer but never added to it. Two figures
          side by side is the clearest possible statement that they are two
          different piles of money.
        */}
        <div className="mt-4 rounded-lg border border-border bg-muted/30 p-3">
          <p className="flex items-center gap-2 text-sm font-medium">
            <Coins className="size-4 text-muted-foreground" /> Petty cash tin
          </p>
          <dl className="mt-2 grid gap-3 sm:grid-cols-4">
            <Figure label="Opening" value={money(open.openingPettyCash)} />
            <Figure label="Topped up" value={money(open.pettyCashToppedUp)} muted />
            <Figure label="Spent" value={money(open.pettyCashSpent)} muted />
            <Figure label="Left in the tin" value={money(open.pettyCashBalance)} emphasis />
          </dl>
          <p className="mt-2 text-xs text-muted-foreground">
            Separate from the drawer. Only an expense paid <em>from the drawer</em> changes the
            figure above.{' '}
            <Link href="/dashboard/petty-cash" className="underline underline-offset-2">
              Petty cash
            </Link>
          </p>
        </div>
      </SectionCard>

      <MovementForm sessionId={open.session.id} />

      {open.movements.length > 0 && (
        <SectionCard title="Cash movements" description="Every note in or out that was not a sale.">
          <ul className="divide-y divide-border">
            {open.movements.map((m) => (
              <li key={m.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                <span className="flex min-w-0 items-center gap-2">
                  {m.signedAmount > 0 ? (
                    <ArrowDownLeft className="h-4 w-4 shrink-0 text-emerald-600" />
                  ) : (
                    <ArrowUpRight className="h-4 w-4 shrink-0 text-amber-600" />
                  )}
                  <span className="min-w-0">
                    <span className="block truncate">{m.reason}</span>
                    <span className="block text-xs text-muted-foreground">
                      {MOVEMENT_TYPES[m.type].label}
                      {m.reference ? ` · ${m.reference}` : ''}
                    </span>
                  </span>
                </span>
                <span className="shrink-0 tabular-nums">
                  {m.signedAmount > 0 ? '+' : '−'}
                  {money(m.amount)}
                </span>
              </li>
            ))}
          </ul>
        </SectionCard>
      )}

      <HandoverForm data={data} money={money} variance={variance} />

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

          {/*
            Appears the instant the count stops matching, and the close button
            waits for it. This used to be one optional box labelled "(optional)",
            which meant the most useful sentence about the shift was the one
            nobody had to write — and by morning nobody could.
          */}
          {needsReason && (
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="variancereason">
                Why is it {variance! > 0 ? 'over' : 'short'}? <span className="text-destructive">*</span>
              </Label>
              <Input
                id="variancereason"
                placeholder="e.g. gave change from the wrong note on table 4"
                value={varianceReason}
                onChange={(e) => setVarianceReason(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Write it now. Nobody remembers this tomorrow.
              </p>
            </div>
          )}

          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="closenote">Anything else (optional)</Label>
            <Textarea
              id="closenote"
              rows={2}
              placeholder="Notes for whoever reads this later"
              value={closeNote}
              onChange={(e) => setCloseNote(e.target.value)}
            />
          </div>
        </div>
        <Button
          className="mt-4"
          variant="destructive"
          onClick={close}
          disabled={busy || reasonMissing}
        >
          <Lock className="mr-2 h-4 w-4" />
          {busy ? 'Closing…' : 'Close drawer'}
        </Button>
      </SectionCard>
    </>
  )
}

function MovementForm({ sessionId }: { sessionId: string }) {
  const router = useRouter()
  const [type, setType] = React.useState<(typeof MANUAL_MOVEMENT_TYPES)[number]>('CASH_OUT')
  const [amount, setAmount] = React.useState('')
  const [reason, setReason] = React.useState('')
  const [reference, setReference] = React.useState('')
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
    const result = await callAction(() =>
      recordCashMovementAction({ sessionId, type, amount: value, reason, reference }),
    )
    setBusy(false)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    setAmount('')
    setReason('')
    setReference('')
    toast.success('Recorded')
    router.refresh()
  }

  return (
    <SectionCard
      title="Cash in / cash out"
      description="Money that moves for a reason other than a sale — a float top-up, a supplier paid in cash, a bank drop."
    >
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="space-y-1.5">
          <Label htmlFor="mtype">What happened</Label>
          <select
            id="mtype"
            className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm"
            value={type}
            onChange={(e) =>
              setType(e.target.value as (typeof MANUAL_MOVEMENT_TYPES)[number])
            }
          >
            {MANUAL_MOVEMENT_TYPES.map((t) => (
              <option key={t} value={t}>
                {MOVEMENT_TYPES[t].label}
              </option>
            ))}
          </select>
          <p className="text-xs text-muted-foreground">{MOVEMENT_TYPES[type].hint}</p>
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
        <div className="space-y-1.5">
          <Label htmlFor="mref">Reference (optional)</Label>
          <Input
            id="mref"
            placeholder="Slip or invoice no."
            value={reference}
            onChange={(e) => setReference(e.target.value)}
          />
        </div>
      </div>
      <Button className="mt-4" variant="outline" onClick={submit} disabled={busy}>
        {busy ? 'Recording…' : 'Record movement'}
      </Button>
    </SectionCard>
  )
}

// ── handover ─────────────────────────────────────────────────────────────────

function HandoverForm({
  data,
  money,
  variance,
}: {
  data: DrawerPageData
  money: (m: number) => string
  variance: number | null
}) {
  const open = data.open!
  const router = useRouter()
  const [show, setShow] = React.useState(false)
  const [toUserId, setToUserId] = React.useState('')
  const [counted, setCounted] = React.useState('')
  const [reason, setReason] = React.useState('')
  const [note, setNote] = React.useState('')
  const [busy, setBusy] = React.useState(false)

  if (data.handoverCandidates.length === 0) return null

  const factor = minorUnitFactor(data.currency)
  const countedMinor = Number(counted) * factor
  const gap =
    counted.trim() && Number.isFinite(countedMinor)
      ? Math.round(countedMinor) - open.expectedCash
      : null
  const reasonMissing = gap !== null && gap !== 0 && reason.trim().length < 2

  const submit = async () => {
    const value = Number(counted)
    if (!counted.trim() || !Number.isFinite(value) || value < 0) {
      toast.error('Count the drawer before you hand it on')
      return
    }
    if (!toUserId) {
      toast.error('Pick who is taking over')
      return
    }
    setBusy(true)
    const result = await callAction(() =>
      requestHandoverAction({
        sessionId: open.session.id,
        toUserId,
        countedAmount: value,
        varianceReason: reason,
        note,
      }),
    )
    setBusy(false)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    toast.success('Handed over. They confirm it on their own screen.')
    router.refresh()
  }

  return (
    <SectionCard
      title="Hand over the till"
      description="Your session closes and theirs opens with what you counted, so only one of you is ever accountable for it."
      actions={
        <Button variant="ghost" size="sm" onClick={() => setShow((s) => !s)}>
          <ArrowRightLeft className="mr-2 h-4 w-4" />
          {show ? 'Not now' : 'Hand over'}
        </Button>
      }
    >
      {show ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="hto">Taking over</Label>
            <select
              id="hto"
              className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm"
              value={toUserId}
              onChange={(e) => setToUserId(e.target.value)}
            >
              <option value="">Choose someone</option>
              {data.handoverCandidates.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="hcount">You counted</Label>
            <Input
              id="hcount"
              inputMode="decimal"
              placeholder="0.00"
              value={counted}
              onChange={(e) => setCounted(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Expected {money(open.expectedCash)}
              {gap !== null && gap !== 0
                ? ` · ${gap > 0 ? 'over' : 'short'} by ${money(Math.abs(gap))}`
                : ''}
            </p>
          </div>
          {gap !== null && gap !== 0 && (
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="hreason">
                Why is it {gap > 0 ? 'over' : 'short'}? <span className="text-destructive">*</span>
              </Label>
              <Input
                id="hreason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="A handover is a close. It needs the same explanation."
              />
            </div>
          )}
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="hnote">Note for them (optional)</Label>
            <Input
              id="hnote"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. table 6 still owes for two drinks"
            />
          </div>
          <div className="sm:col-span-2">
            <Button onClick={submit} disabled={busy || reasonMissing}>
              {busy ? 'Handing over…' : 'Hand over the till'}
            </Button>
          </div>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          Going home mid-service? Count the drawer and pass it on rather than leaving it open.
          {variance !== null ? ' Your count above is not used here — count again for the handover.' : ''}
        </p>
      )}
    </SectionCard>
  )
}

function IncomingHandovers({
  data,
  money,
}: {
  data: DrawerPageData
  money: (m: number) => string
}) {
  return (
    <SectionCard
      title="A till is waiting for you"
      description="Somebody counted their drawer and handed it on. Count it yourself, then take it."
    >
      <ul className="space-y-3">
        {data.pendingHandovers.map((h) => (
          <li key={h.id} className="rounded-lg border border-primary/40 bg-primary/5 p-3 text-sm">
            <p className="font-medium">
              {h.fromName} · {h.registerName ?? 'till'}
              {h.branchName ? ` at ${h.branchName}` : ''}
            </p>
            <p className="mt-1 text-muted-foreground">
              Counted <span className="font-semibold tabular-nums text-foreground">{money(h.countedAmount)}</span>
              {h.variance !== 0
                ? ` (${h.variance > 0 ? 'over' : 'short'} by ${money(Math.abs(h.variance))})`
                : ' and it balanced'}
              .
            </p>
            {h.note ? <p className="mt-1 italic text-muted-foreground">“{h.note}”</p> : null}
            <Button className="mt-2" size="sm" asChild>
              <Link href="/cashier/session">Take it on</Link>
            </Button>
          </li>
        ))}
      </ul>
    </SectionCard>
  )
}

// ── open right now ───────────────────────────────────────────────────────────

/**
 * Drawers open on the floor, and a way to close one somebody walked away from.
 *
 * ── Why this card exists ────────────────────────────────────────────────────
 *
 * A cashier goes home without closing. Their session keeps the till, and the
 * next cashier is told "somebody else already has this till open" — with no
 * screen anywhere showing whose, and no way to do anything about it. The shift
 * cannot start.
 *
 * Only other people's drawers are listed. Your own is the panel below, with the
 * ordinary close form; showing it twice would offer two different ways to close
 * the same session, one of which records you as having closed it on your own
 * behalf.
 */
function OpenNow({ data, money }: { data: DrawerPageData; money: (m: number) => string }) {
  const rows = data.openNow.filter((row) => !row.mine)

  return (
    <SectionCard
      title="Open right now"
      description="Drawers somebody still has out. Close one only when they have finished with it."
      actions={<Badge variant="outline">{rows.length}</Badge>}
    >
      <ul className="space-y-3">
        {rows.map((row) => (
          <ForceCloseRow key={row.id} row={row} money={money} />
        ))}
      </ul>
    </SectionCard>
  )
}

function ForceCloseRow({
  row,
  money,
}: {
  row: DrawerPageData['openNow'][number]
  money: (m: number) => string
}) {
  const router = useRouter()
  const [open, setOpen] = React.useState(false)
  const [counted, setCounted] = React.useState(true)
  const [amount, setAmount] = React.useState('')
  const [reason, setReason] = React.useState('')
  const [busy, setBusy] = React.useState(false)

  const submit = async () => {
    const value = Number(amount)
    if (counted && (!amount.trim() || !Number.isFinite(value) || value < 0)) {
      toast.error('Enter what you counted, or say you could not count it')
      return
    }
    if (reason.trim().length < 2) {
      toast.error('Say why you are closing somebody else’s drawer')
      return
    }
    setBusy(true)
    const result = await callAction(() =>
      forceCloseDrawerAction({
        sessionId: row.id,
        counted,
        ...(counted ? { countedCash: value } : {}),
        reason,
      }),
    )
    setBusy(false)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    const v = result.data.variance
    if (v === null) toast.success('Closed. The variance is recorded as unknown.')
    else if (v === 0) toast.success('Closed and balanced exactly')
    else toast.warning(`Closed — ${v > 0 ? 'over' : 'short'} by ${money(Math.abs(v))}`)
    router.refresh()
  }

  return (
    <li className="rounded-lg border border-border p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
        <span className="font-medium">
          {row.openedByName}
          <span className="ml-2 font-mono text-xs text-muted-foreground">{row.sessionNumber}</span>
        </span>
        <span className="text-muted-foreground">
          {[row.branchName, row.registerName].filter(Boolean).join(' · ')} · open since{' '}
          <LocalDateTime value={row.openedAt} />
        </span>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        Should hold{' '}
        <span className="font-semibold tabular-nums text-foreground">
          {money(row.expectedCash)}
        </span>{' '}
        — opened with {money(row.openingFloat)}.
      </p>

      <div className="mt-2 flex flex-wrap gap-2">
        <Button variant="ghost" size="sm" asChild>
          <Link href={`/dashboard/cash-drawer/${row.id}`}>See everything</Link>
        </Button>
        <Button variant="outline" size="sm" onClick={() => setOpen((o) => !o)}>
          <Lock className="mr-2 h-3.5 w-3.5" />
          {open ? 'Not now' : 'Close it for them'}
        </Button>
      </div>

      {open ? (
        <div className="mt-3 space-y-3 border-t border-border pt-3">
          {/*
            Counting is the default, because an owner standing at the till
            should record what is really there. The alternative is not "assume
            it balanced" — it is "say the variance is unknown", which is the
            honest record when nobody looked.
          */}
          <div className="flex flex-wrap gap-3 text-sm">
            <label className="flex items-center gap-2">
              <input
                type="radio"
                className="size-4"
                checked={counted}
                onChange={() => setCounted(true)}
              />
              I have counted it
            </label>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                className="size-4"
                checked={!counted}
                onChange={() => setCounted(false)}
              />
              I cannot count it now
            </label>
          </div>

          {counted ? (
            <div className="space-y-1.5">
              <Label htmlFor={`fc-amt-${row.id}`}>Counted cash</Label>
              <Input
                id={`fc-amt-${row.id}`}
                inputMode="decimal"
                placeholder="0.00"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Any difference is recorded against {row.openedByName}, whose shift it was.
              </p>
            </div>
          ) : (
            <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-800 dark:text-amber-300">
              The variance will be recorded as <strong>unknown</strong>, not as zero. Closing at
              the expected figure would claim the till balanced when nobody checked.
            </p>
          )}

          <div className="space-y-1.5">
            <Label htmlFor={`fc-why-${row.id}`}>
              Why are you closing it? <span className="text-destructive">*</span>
            </Label>
            <Input
              id={`fc-why-${row.id}`}
              placeholder="e.g. Ann went home without closing"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>

          <Button size="sm" variant="destructive" disabled={busy} onClick={submit}>
            {busy ? 'Closing…' : 'Close this drawer'}
          </Button>
        </div>
      ) : null}
    </li>
  )
}

// ── review ───────────────────────────────────────────────────────────────────

function ReviewQueue({ data, money }: { data: DrawerPageData; money: (m: number) => string }) {
  const router = useRouter()
  const [busy, setBusy] = React.useState<string | null>(null)
  const [notes, setNotes] = React.useState<Record<string, string>>({})

  const signOff = async (id: string) => {
    setBusy(id)
    const result = await callAction(() =>
      reviewDrawerAction({ sessionId: id, note: notes[id] ?? '' }),
    )
    setBusy(null)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    toast.success('Signed off')
    router.refresh()
  }

  return (
    <SectionCard
      title="Waiting for you to sign off"
      description="These drawers were counted and came out far enough from expected to need a second pair of eyes."
      actions={<Badge variant="warning">{data.review.length}</Badge>}
    >
      <ul className="space-y-3">
        {data.review.map((s) => (
          <li key={s.id} className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
              <span className="font-medium">
                {s.sessionNumber} · {s.openedByName}
                {s.branchName ? ` · ${s.branchName}` : ''}
                {s.registerName ? ` · ${s.registerName}` : ''}
              </span>
              <span className="tabular-nums text-amber-700 dark:text-amber-400">
                {s.variance === null
                  ? '—'
                  : `${s.variance > 0 ? 'Over' : 'Short'} by ${money(Math.abs(s.variance))}`}
              </span>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              Expected {s.expectedCash === null ? '—' : money(s.expectedCash)}, counted{' '}
              {s.countedCash === null ? '—' : money(s.countedCash)}.
            </p>
            {s.varianceReason ? (
              <p className="mt-1 text-sm italic text-muted-foreground">“{s.varianceReason}”</p>
            ) : null}
            <div className="mt-3 flex flex-wrap items-end gap-2">
              <div className="min-w-[16rem] flex-1 space-y-1.5">
                <Label htmlFor={`rn-${s.id}`}>Your note (optional)</Label>
                <Input
                  id={`rn-${s.id}`}
                  value={notes[s.id] ?? ''}
                  onChange={(e) => setNotes((n) => ({ ...n, [s.id]: e.target.value }))}
                  placeholder="What you did about it"
                />
              </div>
              <Button size="sm" disabled={busy === s.id} onClick={() => signOff(s.id)}>
                <ShieldCheck className="mr-2 h-4 w-4" />
                {busy === s.id ? 'Signing…' : 'Sign off'}
              </Button>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              The count is not changed by signing off. It records that you have seen it.
            </p>
          </li>
        ))}
      </ul>
    </SectionCard>
  )
}

// ── history ──────────────────────────────────────────────────────────────────

function History({ data, money }: { data: DrawerPageData; money: (m: number) => string }) {
  const past = data.recent.filter((s) => s.status !== 'OPEN')
  if (past.length === 0) {
    return (
      <SectionCard title="Past drawers">
        <EmptyState
          title="No closed drawers yet"
          description="Closed sessions and their variances appear here."
        />
      </SectionCard>
    )
  }

  return (
    <SectionCard
      title="Past drawers"
      description="What was expected, what was counted, and the difference."
      actions={
        <Button variant="ghost" size="sm" asChild>
          <Link href="/dashboard/reports/cash-drawer">Full report</Link>
        </Button>
      }
    >
      <div className="-mx-2 overflow-x-auto px-2">
        <table className="w-full min-w-[46rem] text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th className="pb-2 pr-3 font-medium">Session</th>
              <th className="pb-2 pr-3 font-medium">Closed</th>
              <th className="pb-2 pr-3 font-medium">Cashier</th>
              <th className="pb-2 pr-3 font-medium">Till</th>
              <th className="pb-2 pr-3 text-right font-medium">Expected</th>
              <th className="pb-2 pr-3 text-right font-medium">Counted</th>
              <th className="pb-2 text-right font-medium">Variance</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {past.map((s) => (
              <tr key={s.id}>
                <td className="whitespace-nowrap py-2.5 pr-3 font-mono text-xs">
                  {s.sessionNumber}
                  {s.status === 'PENDING_REVIEW' ? (
                    <Badge variant="warning" className="ml-2">
                      In review
                    </Badge>
                  ) : null}
                </td>
                <td className="whitespace-nowrap py-2.5 pr-3">
                  {s.closedAt ? <LocalDateTime value={s.closedAt} /> : '—'}
                </td>
                <td className="py-2.5 pr-3">{s.openedByName}</td>
                <td className="py-2.5 pr-3 text-muted-foreground">
                  {[s.branchName, s.registerName].filter(Boolean).join(' · ') || '—'}
                </td>
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
