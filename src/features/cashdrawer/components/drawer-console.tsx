'use client'

import * as React from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ArrowDownLeft, ArrowRightLeft, ArrowUpRight, Lock, ShieldCheck } from 'lucide-react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/feedback'
import { Input, Textarea } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { SectionCard } from '@/features/dashboard/components/page-header'
import { LocalDateTime } from '@/components/local-time'
import { formatMoney } from '@/lib/money'
import {
  closeDrawerAction,
  forceCloseDrawerAction,
  openDrawerAction,
  recordCashMovementAction,
  reviewDrawerAction,
} from '../actions'
import { MANUAL_MOVEMENT_TYPES, MOVEMENT_TYPES } from '../movement-types'
import type { DrawerPageData } from '../queries'
import type { DrawerClosure } from '../closure'
import { ClosurePreview } from './closure-preview'
import { DenominationGrid } from './denomination-grid'
import { callAction } from '@/lib/use-action'

/**
 * The cashier's drawer screen.
 *
 * Deliberately one page rather than a wizard: a cashier closing up at midnight
 * wants the expected figure, the count box and the variance in front of them at
 * once, not spread over steps. The variance is shown live as they type so a
 * miscount is caught before the drawer is closed rather than after.
 *
 * The close form asks for a reason only when the gap crosses the restaurant's
 * own tolerance (Settings → Cash), and then the button waits for it. The server
 * refuses either way — the client half exists so nobody types a count, presses
 * close, and is told off afterwards.
 */
export function DrawerConsole({ data }: { data: DrawerPageData }) {
  const money = (minor: number) => formatMoney(minor, data.currency)

  return (
    <div className="space-y-6">
      {data.pendingHandovers.length > 0 && <IncomingHandovers data={data} money={money} />}
      {data.openNow.some((row) => !row.mine) && <OpenNow data={data} money={money} />}
      {data.review.length > 0 && <ReviewQueue data={data} money={money} />}
      {/*
        Opening a till is its own permission (staff.A.md §6). This used to
        render the form whenever no session was open, for anybody who could
        reach the screen — so somebody deliberately allowed the drawer view and
        not the drawer got a full opening-float form and a refusal after
        filling it in. The server refuses either way; this is so the screen
        stops asking.
      */}
      {data.open ? (
        <OpenDrawerPanel data={data} money={money} />
      ) : data.canOpen ? (
        <OpenForm data={data} />
      ) : (
        <SectionCard
          title="No drawer open"
          description="Opening a till is not part of your access. Ask a manager to open one, or to take the handover of a till that is already running."
        >
          <EmptyState
            icon={<Lock />}
            title="You cannot open a till"
            description="You can still take payments against a till somebody else has opened."
          />
        </SectionCard>
      )}
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

  const [counts, setCounts] = React.useState<Record<string, string>>({})
  const [closeNote, setCloseNote] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  /** The closure, once it exists. Nothing above it is revealed before then. */
  const [closure, setClosure] = React.useState<DrawerClosure | null>(null)

  /*
   * ── What this form deliberately does not compute (correctionA.md §4) ─────
   *
   * There used to be a live variance here, recalculated on every keystroke,
   * with a comment saying it was "so a slip is caught before closing". It is
   * gone, and so is the expected figure it was measured against — the server
   * no longer sends either to the person closing their own drawer.
   *
   * The reasoning is the whole of §4: a cashier who can see the gap can close
   * it. Not by stealing, necessarily — by counting again, and again, until the
   * number agrees, which destroys the only evidence the count was ever there
   * to produce. The physical total below is the sum of what they say they are
   * holding, and nothing on this screen tells them whether it is right.
   *
   * The server multiplies the counts too, and its answer is the one recorded.
   * This total exists so somebody can see they typed 4 where they meant 14.
   */
  const physicalTotal = data.denominations.reduce((sum, d) => {
    const n = Number(counts[String(d.value)] ?? '')
    return sum + (Number.isFinite(n) && n > 0 ? Math.trunc(n) * d.value : 0)
  }, 0)
  const anyCounted = Object.values(counts).some((v) => Number(v) > 0)

  const close = async () => {
    if (!anyCounted) {
      toast.error('Count the drawer first')
      return
    }
    setBusy(true)
    const numeric: Record<string, number> = {}
    for (const [value, raw] of Object.entries(counts)) {
      const n = Number(raw)
      if (Number.isFinite(n) && n > 0) numeric[value] = Math.trunc(n)
    }
    const result = await callAction(() =>
      closeDrawerAction({ sessionId: open.session.id, counts: numeric, note: closeNote }),
    )
    setBusy(false)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    /*
     * The figures arrive now and are shown now (§4): a printable closure
     * preview with the totals and the variance on it. The count is committed
     * and unchangeable at this point, so there is nothing left to tune.
     *
     * `router.refresh()` waits until the preview is dismissed. Refreshing
     * here would replace the page underneath the one thing the cashier is
     * supposed to print.
     */
    setClosure(result.data)
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

        {/*
          Cash sales and expected cash are absent for the person closing this
          drawer (correctionA.md §4) — absent from the payload, not merely
          unrendered. `maySeeReconciliation` says which of the two readers this
          is; a manager reconciling the floor sees all of it.
        */}
        <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Figure label="Opening float" value={money(open.openingFloat)} />
          {data.maySeeReconciliation ? (
            <Figure label="Cash sales" value={money(open.cashSales)} />
          ) : null}
          <Figure label="Cash in" value={money(open.cashIn)} />
          <Figure label="Cash out" value={money(open.cashOut)} />
          <Figure label="Card takings" value={money(open.cardSales)} muted />
          <Figure label="Other takings" value={money(open.otherSales)} muted />
          {data.maySeeReconciliation ? (
            <Figure label="Expected in drawer" value={money(open.expectedCash)} emphasis />
          ) : null}
        </dl>

        {/*
          The petty cash tin used to sit here, beside the drawer (correctionA.md
          §4 retires it — all cash movements belong to the drawer now). A cash
          expense is a CASH_OUT movement below; the tin's history is still on
          the petty cash screen for anybody reconciling an older close.
        */}
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

      <HandoverForm data={data} />

      <SectionCard
        title="Close drawer"
        description="Count what is physically in the drawer, note by note. The system works out the rest."
      >
        {/*
          A grid of counts, not a total box (correctionA.md §4). The same grid
          the shift handover counts with, so the two ways of ending a till
          cannot drift into counting differently.
        */}
        <DenominationGrid denominations={data.denominations} counts={counts} onChange={setCounts} money={money} />

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-muted/40 px-4 py-3">
          <span className="text-sm font-medium">Cash counted</span>
          <span className="text-xl font-bold tabular-nums">{money(physicalTotal)}</span>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          {/*
            Said out loud, because a cashier who expects to see a variance and
            does not will assume the screen is broken and go looking for it.
          */}
          The difference against what the system expected is worked out when you close, and shown
          on the closure slip.
        </p>

        <div className="mt-4 space-y-1.5">
          <Label htmlFor="closenote">Anything else (optional)</Label>
          <Textarea
            id="closenote"
            rows={2}
            placeholder="Notes for whoever reads this later"
            value={closeNote}
            onChange={(e) => setCloseNote(e.target.value)}
          />
        </div>
        <Button className="mt-4" variant="destructive" onClick={close} disabled={busy || !anyCounted}>
          <Lock className="mr-2 h-4 w-4" />
          {busy ? 'Closing…' : 'Close drawer'}
        </Button>
      </SectionCard>

      <ClosurePreview
        closure={closure}
        currency={data.currency}
        denominations={data.denominations}
        branchName={data.openBranchName}
        registerName={data.openRegisterName}
        money={money}
        onClose={() => {
          setClosure(null)
          router.refresh()
        }}
      />
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

function HandoverForm({ data }: { data: DrawerPageData }) {
  /*
   * A pointer, not a form (recorrection.md §2).
   *
   * Handing the till on is part of handing the SHIFT on — the same moment,
   * the same person taking over, and the drawer count is one line of the
   * summary they accept. Keeping a second, cash-only form here meant two
   * doors to one handover, and the one that skipped the shift summary was
   * the one people used. The count, the variance rule and the one-in-flight
   * guard are unchanged; they run from the shift handover now.
   */
  if (data.handoverCandidates.length === 0) return null
  return (
    <SectionCard
      title="Hand over the till"
      description="Done as part of your shift handover: count the drawer there, pick who takes over, and their session opens with what you counted when they accept."
    >
      <Button variant="outline" asChild>
        <Link href="/dashboard/handover">
          <ArrowRightLeft className="mr-2 h-4 w-4" />
          Hand over your shift
        </Link>
      </Button>
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
              {/* Part of a shift handover: accepted there. A bare till handover (legacy) still goes through the session screen. */}
              <Link href={h.shiftHandoverId ? '/dashboard/handover' : '/cashier/session'}>
                {h.shiftHandoverId ? 'Review and accept the shift' : 'Take it on'}
              </Link>
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
              Why are you closing it? (optional)
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
    toast.success('Checked')
    router.refresh()
  }

  return (
    <SectionCard
      title="A cash difference needs attention"
      description="Somebody counted a drawer and the money did not match what the sales say should be in it. Nothing is blocked — this is here so a big gap is never quietly forgotten."
      actions={<Badge variant="warning">{data.review.length}</Badge>}
    >
      <ul className="space-y-3">
        {data.review.map((s) => {
          /*
           * Show the working, not just the verdict.
           *
           * The owner's own question was "the float was 10,000, so why does a
           * bigger count need checking?" — because expected cash is not "more
           * than the float": it is the float plus every cash sale, minus every
           * refund and payout. Without the sum on screen, "over by 9,000" reads
           * as good news, when it usually means a sale was taken in cash and
           * never rung up. `shiftFlow` is that whole middle section in one
           * line: everything that moved through the drawer after opening.
           */
          const shiftFlow =
            s.expectedCash !== null ? s.expectedCash - s.openingFloat : null

          return (
            <li key={s.id} className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
                <span className="font-medium">
                  {s.registerName ?? s.sessionNumber}
                  {s.branchName ? ` · ${s.branchName}` : ''}
                  {s.closedAt ? (
                    <span className="font-normal text-muted-foreground">
                      {' '}· counted by {s.closedByName ?? s.openedByName},{' '}
                      <LocalDateTime value={s.closedAt} />
                    </span>
                  ) : null}
                </span>
                <span className="font-semibold tabular-nums text-amber-700 dark:text-amber-400">
                  {s.variance === null
                    ? '—'
                    : `${money(Math.abs(s.variance))} ${s.variance > 0 ? 'MORE' : 'LESS'} than expected`}
                </span>
              </div>

              <dl className="mt-2 max-w-xs space-y-0.5 text-sm tabular-nums">
                <div className="flex justify-between gap-6">
                  <dt className="text-muted-foreground">Started with (float)</dt>
                  <dd>{money(s.openingFloat)}</dd>
                </div>
                <div className="flex justify-between gap-6">
                  <dt className="text-muted-foreground">Cash sales − payouts</dt>
                  <dd>{shiftFlow === null ? '—' : `${shiftFlow < 0 ? '−' : '+'} ${money(Math.abs(shiftFlow))}`}</dd>
                </div>
                <div className="flex justify-between gap-6 border-t border-border pt-0.5 font-medium">
                  <dt>Should have been</dt>
                  <dd>{s.expectedCash === null ? '—' : money(s.expectedCash)}</dd>
                </div>
                <div className="flex justify-between gap-6 font-medium">
                  <dt>Actually counted</dt>
                  <dd>{s.countedCash === null ? '—' : money(s.countedCash)}</dd>
                </div>
              </dl>

              {s.variance !== null && s.variance > 0 ? (
                <p className="mt-2 text-xs text-muted-foreground">
                  More money than expected usually means a cash sale was never rung up.
                </p>
              ) : null}
              {s.varianceReason ? (
                <p className="mt-1 text-sm italic text-muted-foreground">
                  {s.closedByName ?? s.openedByName} said: “{s.varianceReason}”
                </p>
              ) : null}

              {data.canReview ? (
                <>
                  <div className="mt-3 flex flex-wrap items-end gap-2">
                    <div className="min-w-[16rem] flex-1 space-y-1.5">
                      <Label htmlFor={`rn-${s.id}`}>What happened? (optional)</Label>
                      <Input
                        id={`rn-${s.id}`}
                        value={notes[s.id] ?? ''}
                        onChange={(e) => setNotes((n) => ({ ...n, [s.id]: e.target.value }))}
                        placeholder="e.g. till roll checked, two unrung teas"
                      />
                    </div>
                    <Button size="sm" disabled={busy === s.id} onClick={() => signOff(s.id)}>
                      <ShieldCheck className="mr-2 h-4 w-4" />
                      {busy === s.id ? 'Saving…' : "I've checked this"}
                    </Button>
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">
                    This changes nothing about the count — it records that you have seen it.
                  </p>
                </>
              ) : (
                /*
                 * A manager sees the queue but not the button. Saying WHY beats
                 * the blank space the approvals screen leaves managers with —
                 * a control that seems broken teaches people to ignore it.
                 */
                <p className="mt-3 text-xs text-muted-foreground">
                  Waiting for the owner or admin to check this.
                </p>
              )}
            </li>
          )
        })}
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
