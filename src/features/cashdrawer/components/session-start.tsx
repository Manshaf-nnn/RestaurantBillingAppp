'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { ArrowRight, Banknote, Coins, LogOut, Wallet } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Input, Textarea } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { formatMoney, minorUnitFactor } from '@/lib/money'
import { callAction } from '@/lib/use-action'
import { openDrawerAction } from '../actions'
import { acceptHandoverAction, declineHandoverAction } from '@/features/handover/cash-actions'
// Imported here rather than passed down: a server component cannot hand a
// function to a client one, and a server action imported directly is the
// supported way across that boundary.
import { logout } from '@/features/auth/actions'

/**
 * Start of shift.
 *
 * ── Why this is a screen and not a dialog ───────────────────────────────────
 *
 * It is the thing standing between a cashier and their work, so it has to be
 * unmissable and it has to be the only thing on the page. A dismissible dialog
 * over the till would be dismissed, and then the first cash sale of the day
 * would be attributed to nothing.
 *
 * ── The order of the questions ──────────────────────────────────────────────
 *
 * Branch, then till, then money. Branch first because it narrows the tills —
 * offering every counter in the chain and validating afterwards would be a
 * worse version of the same question. Money last because it is the only part
 * that needs the drawer physically in front of them.
 *
 * A cashier with one branch and one till never sees the first two: both
 * collapse to a single choice, and a single choice is not a question.
 *
 * ── Two piles of money ──────────────────────────────────────────────────────
 *
 * The float and the petty cash tin are separate fields because they are
 * separate tins. Adding them together at this screen would be the last moment
 * anybody could tell them apart, and every petty cash figure downstream would
 * be a guess.
 */

export interface SessionStartBranch {
  id: string
  name: string
}

export interface SessionStartRegister {
  id: string
  name: string
  branchId: string
}

export interface SessionStartHandover {
  id: string
  fromName: string
  branchName: string | null
  registerName: string | null
  countedAmount: number
  note: string | null
}

export function SessionStart({
  cashierName,
  branches,
  registers,
  handovers,
  currency,
  next,
}: {
  cashierName: string
  branches: SessionStartBranch[]
  registers: SessionStartRegister[]
  handovers: SessionStartHandover[]
  currency: string
  next: string
}) {
  const router = useRouter()
  const money = (minor: number) => formatMoney(minor, currency)
  const factor = minorUnitFactor(currency)

  const [branchId, setBranchId] = React.useState(branches[0]?.id ?? '')
  const branchRegisters = React.useMemo(
    () => registers.filter((r) => r.branchId === branchId),
    [registers, branchId],
  )
  const [registerId, setRegisterId] = React.useState('')
  const [float, setFloat] = React.useState('')
  const [petty, setPetty] = React.useState('')
  const [note, setNote] = React.useState('')
  const [confirming, setConfirming] = React.useState(false)
  const [busy, setBusy] = React.useState(false)

  // Reset the till whenever the branch changes: keeping the previous branch's
  // selection would post a register id the server is bound to refuse.
  React.useEffect(() => {
    setRegisterId(branchRegisters[0]?.id ?? '')
  }, [branchRegisters])

  const floatValue = Number(float)
  const pettyValue = petty.trim() ? Number(petty) : 0
  const amountsValid =
    Number.isFinite(floatValue) && floatValue >= 0 && Number.isFinite(pettyValue) && pettyValue >= 0

  const branchName = branches.find((b) => b.id === branchId)?.name ?? null
  const registerName = branchRegisters.find((r) => r.id === registerId)?.name ?? null

  const start = async () => {
    if (!amountsValid) {
      toast.error('Enter the cash you are starting with')
      return
    }
    setBusy(true)
    const result = await callAction(() =>
      openDrawerAction({
        openingFloat: floatValue,
        openingPettyCash: pettyValue,
        branchId,
        registerId,
        note,
      }),
    )
    setBusy(false)
    if (!result.ok) {
      toast.error(result.error)
      setConfirming(false)
      return
    }
    toast.success('Drawer open. Have a good shift.')
    router.replace(next)
    router.refresh()
  }

  const takeOver = async (id: string) => {
    setBusy(true)
    const result = await callAction(() => acceptHandoverAction({ handoverId: id }))
    setBusy(false)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    toast.success('Till taken on')
    router.replace(next)
    router.refresh()
  }

  const decline = async (id: string) => {
    setBusy(true)
    const result = await callAction(() => declineHandoverAction({ handoverId: id }))
    setBusy(false)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    toast.message('Declined. Tell your manager what you counted.')
    router.refresh()
  }

  const nowhereToWork = branches.length === 0

  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-10">
      <div className="w-full max-w-lg space-y-5">
        <div className="space-y-1.5 text-center">
          <span className="mx-auto flex size-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
            <Wallet className="size-7" />
          </span>
          <h1 className="text-2xl font-bold tracking-tight">
            Good to see you, {cashierName.split(' ')[0]}
          </h1>
          <p className="text-balance text-sm text-muted-foreground">
            Start your drawer before you take any money. Every rupee you handle today is counted
            against what you enter here.
          </p>
        </div>

        {/*
          A till waiting to be taken on comes first: somebody is standing at the
          counter holding the notes, and starting a fresh drawer instead would
          leave that cash belonging to nobody.
        */}
        {handovers.map((handover) => (
          <div
            key={handover.id}
            className="rounded-xl border border-primary/40 bg-primary/5 p-4 text-sm"
          >
            <p className="font-medium">
              {handover.fromName} handed you {handover.registerName ?? 'a till'}
              {handover.branchName ? ` at ${handover.branchName}` : ''}
            </p>
            <p className="mt-1 text-muted-foreground">
              They counted <span className="font-semibold tabular-nums text-foreground">
                {money(handover.countedAmount)}
              </span>
              . Count it yourself before you accept — once you do, it is yours to balance.
            </p>
            {handover.note ? (
              <p className="mt-1 italic text-muted-foreground">“{handover.note}”</p>
            ) : null}
            <div className="mt-3 flex gap-2">
              <Button size="sm" disabled={busy} onClick={() => takeOver(handover.id)}>
                Take it on
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => decline(handover.id)}
              >
                It does not match
              </Button>
            </div>
          </div>
        ))}

        {nowhereToWork ? (
          <div className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
            You are not assigned to a location yet, so there is no till to open. Ask your manager to
            put you on one.
          </div>
        ) : confirming ? (
          <div className="rounded-xl border border-border bg-card p-5 shadow-soft">
            <h2 className="text-base font-semibold">Check this before you start</h2>
            <dl className="mt-3 space-y-2 text-sm">
              <Line label="Cashier" value={cashierName} />
              {branchName ? <Line label="Branch" value={branchName} /> : null}
              {registerName ? <Line label="Till" value={registerName} /> : null}
              {/*
                `factor`, never a hardcoded ×100. In a zero-decimal currency —
                JPY, KRW, VND — minorUnitFactor is 1, and ×100 would show this
                cashier a confirmation panel claiming a ¥5,000 float is
                ¥500,000 immediately before they commit to it.
              */}
              <Line label="Opening cash" value={money(Math.round(floatValue * factor))} strong />
              <Line label="Opening petty cash" value={money(Math.round(pettyValue * factor))} />
            </dl>
            <p className="mt-3 text-xs text-muted-foreground">
              These two are counted separately all shift. The float is the drawer; the petty cash is
              the tin you buy small things from.
            </p>
            <div className="mt-4 flex gap-2">
              <Button className="flex-1" disabled={busy} onClick={start}>
                Start my shift <ArrowRight />
              </Button>
              <Button variant="ghost" disabled={busy} onClick={() => setConfirming(false)}>
                Back
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-4 rounded-xl border border-border bg-card p-5 shadow-soft">
            {branches.length > 1 ? (
              <div className="space-y-1.5">
                <Label htmlFor="branch">Branch</Label>
                <select
                  id="branch"
                  className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm"
                  value={branchId}
                  onChange={(e) => setBranchId(e.target.value)}
                >
                  {branches.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}

            {/* Only worth asking when there is genuinely more than one answer. */}
            {branchRegisters.length > 1 ? (
              <div className="space-y-1.5">
                <Label htmlFor="register">Till</Label>
                <select
                  id="register"
                  className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm"
                  value={registerId}
                  onChange={(e) => setRegisterId(e.target.value)}
                >
                  {branchRegisters.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="float" className="flex items-center gap-1.5">
                  <Banknote className="size-3.5 text-muted-foreground" /> Opening cash
                </Label>
                <Input
                  id="float"
                  inputMode="decimal"
                  placeholder="0.00"
                  autoFocus
                  value={float}
                  onChange={(e) => setFloat(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">The change float in the drawer.</p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="petty" className="flex items-center gap-1.5">
                  <Coins className="size-3.5 text-muted-foreground" /> Opening petty cash
                </Label>
                <Input
                  id="petty"
                  inputMode="decimal"
                  placeholder="0.00"
                  value={petty}
                  onChange={(e) => setPetty(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  The separate tin. Leave blank if there is none.
                </p>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="note">Note (optional)</Label>
              <Textarea
                id="note"
                rows={2}
                placeholder="Anything worth remembering about this shift"
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </div>

            <Button
              className="w-full"
              disabled={busy || !amountsValid || !float.trim()}
              onClick={() => setConfirming(true)}
            >
              Review and start <ArrowRight />
            </Button>
          </div>
        )}

        {/*
          Always reachable. Somebody who cannot open a drawer — no branch, a
          till already taken — must never be stuck on this page with no way out.
        */}
        <form action={logout}>
          <Button type="submit" variant="ghost" className="w-full">
            <LogOut /> Sign out
          </Button>
        </form>
      </div>
    </main>
  )
}

function Line({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={`tabular-nums ${strong ? 'text-base font-semibold' : ''}`}>{value}</dd>
    </div>
  )
}
