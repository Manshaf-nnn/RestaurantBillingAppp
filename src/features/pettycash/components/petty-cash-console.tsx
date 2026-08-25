'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { Check, Coins, HandCoins, Plus, X } from 'lucide-react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/feedback'
import { Input, Textarea } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { SectionCard } from '@/features/dashboard/components/page-header'
import { LocalDateTime } from '@/components/local-time'
import { formatMoney } from '@/lib/money'
import { callAction } from '@/lib/use-action'
import {
  cancelPettyRequestAction,
  createPettyRequestAction,
  decidePettyRequestAction,
  payPettyRequestAction,
} from '../actions'
import type { PettyCashPageData } from '../queries'

/**
 * The petty cash screen.
 *
 * ── What the layout is arguing ──────────────────────────────────────────────
 *
 * The tin's balance sits at the top and never moves, because the only question
 * anybody asks here is "can I afford this". Underneath, the queue is ordered by
 * what needs a decision rather than by date: a request nobody has looked at is
 * the item with a person waiting behind it.
 *
 * Paying is a separate press from approving, and deliberately so. Approving
 * says the spend is allowed; paying says the notes left the tin. Collapsing
 * them would mean a request could be authorised on Monday and marked as paid on
 * Monday even though the cash went out on Thursday, and the tin would never
 * reconcile.
 */
export function PettyCashConsole({ data }: { data: PettyCashPageData }) {
  const money = (minor: number) => formatMoney(minor, data.currency)

  return (
    <div className="space-y-6">
      <Fund data={data} money={money} />
      {data.canRequest ? <NewRequest data={data} /> : null}
      <Queue data={data} money={money} />
    </div>
  )
}

function Fund({ data, money }: { data: PettyCashPageData; money: (m: number) => string }) {
  const { totals } = data

  return (
    <SectionCard
      title="The petty cash tin"
      description="Separate from the drawer. Only what is actually paid out reduces it."
      actions={
        data.openSession ? (
          <Badge variant="outline">{data.openSession.sessionNumber}</Badge>
        ) : (
          <Badge variant="warning">No drawer open</Badge>
        )
      }
    >
      <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Figure label="Opening fund" value={money(totals.opening)} />
        <Figure label="Topped up from drawer" value={money(totals.toppedUp)} muted />
        <Figure label="Spent from the tin" value={money(totals.spentFromFund)} muted />
        <Figure label="Left in the tin" value={money(totals.balance)} emphasis />
      </dl>

      <dl className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Figure
          label="Waiting for a decision"
          value={`${totals.pendingCount} · ${money(totals.pendingValue)}`}
        />
        <Figure
          label="Approved, not yet paid"
          value={`${totals.approvedCount} · ${money(totals.approvedValue)}`}
        />
        <Figure label="Paid" value={String(totals.paidCount)} muted />
        <Figure label="Rejected" value={String(totals.rejectedCount)} muted />
      </dl>

      {totals.spentFromDrawer > 0 ? (
        <p className="mt-3 text-xs text-muted-foreground">
          A further {money(totals.spentFromDrawer)} was paid straight out of the drawer in this
          period. That money never entered the tin, so it is not deducted above — it comes off the
          drawer&rsquo;s expected cash instead.
        </p>
      ) : null}

      {!data.openSession ? (
        <p className="mt-3 text-xs text-muted-foreground">
          Open a drawer before paying anything out: an expense has to be recorded against the shift
          the notes left, or the tin cannot be reconciled at close.
        </p>
      ) : null}
    </SectionCard>
  )
}

function NewRequest({ data }: { data: PettyCashPageData }) {
  const router = useRouter()
  const [open, setOpen] = React.useState(false)
  const [category, setCategory] = React.useState(data.categories[0] ?? 'Other')
  const [description, setDescription] = React.useState('')
  const [amount, setAmount] = React.useState('')
  const [reference, setReference] = React.useState('')
  const [paidFrom, setPaidFrom] = React.useState<'PETTY_FUND' | 'DRAWER'>('PETTY_FUND')
  const [branchId, setBranchId] = React.useState(
    data.branches.find((b) => b.isDefault)?.id ?? data.branches[0]?.id ?? '',
  )
  const [busy, setBusy] = React.useState(false)

  const submit = async () => {
    const value = Number(amount)
    if (!Number.isFinite(value) || value <= 0) {
      toast.error('Enter an amount')
      return
    }
    if (description.trim().length < 2) {
      toast.error('Say what the money was for')
      return
    }
    setBusy(true)
    const result = await callAction(() =>
      createPettyRequestAction({
        category,
        description,
        amount: value,
        reference,
        paidFrom,
        branchId,
      }),
    )
    setBusy(false)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    setDescription('')
    setAmount('')
    setReference('')
    setOpen(false)
    toast.success('Sent for approval')
    router.refresh()
  }

  return (
    <SectionCard
      title="Ask for petty cash"
      description="What it is for, how much, and which tin it comes out of."
      actions={
        <Button variant="ghost" size="sm" onClick={() => setOpen((o) => !o)}>
          <Plus className="mr-2 h-4 w-4" />
          {open ? 'Cancel' : 'New request'}
        </Button>
      }
    >
      {open ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <div className="space-y-1.5">
            <Label htmlFor="pcat">Category</Label>
            <select
              id="pcat"
              className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
            >
              {data.categories.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pamount">Amount</Label>
            <Input
              id="pamount"
              inputMode="decimal"
              placeholder="0.00"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pfrom">Paid from</Label>
            <select
              id="pfrom"
              className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm"
              value={paidFrom}
              onChange={(e) => setPaidFrom(e.target.value as 'PETTY_FUND' | 'DRAWER')}
            >
              <option value="PETTY_FUND">The petty cash tin</option>
              <option value="DRAWER">The till drawer</option>
            </select>
            <p className="text-xs text-muted-foreground">
              {paidFrom === 'PETTY_FUND'
                ? 'Comes off the tin. The drawer is untouched.'
                : 'Comes off the drawer, so it reduces expected cash at close.'}
            </p>
          </div>
          {data.branches.length > 1 && (
            <div className="space-y-1.5">
              <Label htmlFor="pbranch">Branch</Label>
              <select
                id="pbranch"
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
          <div className="space-y-1.5">
            <Label htmlFor="pref">Receipt / invoice no.</Label>
            <Input
              id="pref"
              placeholder="Optional"
              value={reference}
              onChange={(e) => setReference(e.target.value)}
            />
          </div>
          <div className="space-y-1.5 sm:col-span-2 lg:col-span-3">
            <Label htmlFor="pdesc">What is it for?</Label>
            <Textarea
              id="pdesc"
              rows={2}
              placeholder="e.g. two crates of tomatoes from the market, the delivery did not arrive"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div className="sm:col-span-2 lg:col-span-3">
            <Button onClick={submit} disabled={busy}>
              {busy ? 'Sending…' : 'Send for approval'}
            </Button>
          </div>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          Everything spent in cash goes through here, so it can be found again at the end of the
          month.
        </p>
      )}
    </SectionCard>
  )
}

const STATUS_STYLE: Record<string, { label: string; variant: 'success' | 'warning' | 'outline' | 'destructive' }> = {
  DRAFT: { label: 'Draft', variant: 'outline' },
  PENDING: { label: 'Waiting', variant: 'warning' },
  APPROVED: { label: 'Approved', variant: 'success' },
  PAID: { label: 'Paid', variant: 'success' },
  REJECTED: { label: 'Rejected', variant: 'destructive' },
  CANCELLED: { label: 'Withdrawn', variant: 'outline' },
}

/** Undecided first, then approved-and-unpaid, then everything settled. */
const ORDER: Record<string, number> = {
  PENDING: 0,
  APPROVED: 1,
  DRAFT: 2,
  PAID: 3,
  REJECTED: 4,
  CANCELLED: 5,
}

function Queue({ data, money }: { data: PettyCashPageData; money: (m: number) => string }) {
  const router = useRouter()
  const [busy, setBusy] = React.useState<string | null>(null)

  const rows = [...data.rows].sort(
    (a, b) =>
      (ORDER[a.status] ?? 9) - (ORDER[b.status] ?? 9) ||
      b.requestedAt.localeCompare(a.requestedAt),
  )

  if (rows.length === 0) {
    return (
      <SectionCard title="Petty cash ledger">
        <EmptyState
          title="Nothing here yet"
          description="Requests, approvals and payments all appear in this list."
        />
      </SectionCard>
    )
  }

  const act = async (id: string, run: () => Promise<{ ok: boolean; error?: string }>, done: string) => {
    setBusy(id)
    const result = await run()
    setBusy(null)
    if (!result.ok) {
      toast.error(result.error ?? 'That did not work')
      return
    }
    toast.success(done)
    router.refresh()
  }

  return (
    <SectionCard
      title="Petty cash ledger"
      description="Every request, what happened to it, and who signed."
    >
      <div className="-mx-2 overflow-x-auto px-2">
        <table className="w-full min-w-[52rem] text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th className="pb-2 pr-3 font-medium">Raised</th>
              <th className="pb-2 pr-3 font-medium">What for</th>
              <th className="pb-2 pr-3 font-medium">From</th>
              <th className="pb-2 pr-3 text-right font-medium">Amount</th>
              <th className="pb-2 pr-3 font-medium">Status</th>
              <th className="pb-2 font-medium">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((r) => {
              const style = STATUS_STYLE[r.status] ?? STATUS_STYLE.DRAFT
              /*
               * Paying needs an open drawer AT THE REQUEST'S BRANCH — money
               * leaves a particular till, and the server refuses a mismatch.
               * Hiding the button rather than letting it fail is the whole
               * difference between a rule and an error message.
               */
              const canPay =
                data.canApprove &&
                r.status === 'APPROVED' &&
                data.openSession !== null &&
                data.openSession.branchId === r.branchId

              return (
                <tr key={r.id}>
                  <td className="whitespace-nowrap py-2.5 pr-3 text-muted-foreground">
                    <LocalDateTime value={r.requestedAt} />
                  </td>
                  <td className="py-2.5 pr-3">
                    <span className="block">{r.description}</span>
                    <span className="block text-xs text-muted-foreground">
                      {r.category}
                      {r.branchName ? ` · ${r.branchName}` : ''}
                      {r.reference ? ` · ${r.reference}` : ''}
                      {r.requestedByName ? ` · ${r.requestedByName}` : ''}
                    </span>
                  </td>
                  <td className="py-2.5 pr-3 text-xs text-muted-foreground">
                    {r.paidFrom === 'PETTY_FUND' ? 'Tin' : 'Drawer'}
                  </td>
                  <td className="py-2.5 pr-3 text-right tabular-nums">{money(r.amount)}</td>
                  <td className="py-2.5 pr-3">
                    <Badge variant={style.variant}>{style.label}</Badge>
                    {r.status === 'PAID' && r.paidByName ? (
                      <span className="ml-2 text-xs text-muted-foreground">by {r.paidByName}</span>
                    ) : null}
                    {r.status === 'APPROVED' && r.decidedByName ? (
                      <span className="ml-2 text-xs text-muted-foreground">
                        by {r.decidedByName}
                      </span>
                    ) : null}
                  </td>
                  <td className="py-2.5">
                    <div className="flex flex-wrap gap-1.5">
                      {data.canApprove && r.status === 'PENDING' ? (
                        <>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busy === r.id}
                            onClick={() =>
                              act(
                                r.id,
                                () =>
                                  callAction(() =>
                                    decidePettyRequestAction({ requestId: r.id, approve: true }),
                                  ),
                                'Approved',
                              )
                            }
                          >
                            <Check className="mr-1 h-3.5 w-3.5" /> Approve
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={busy === r.id}
                            onClick={() =>
                              act(
                                r.id,
                                () =>
                                  callAction(() =>
                                    decidePettyRequestAction({ requestId: r.id, approve: false }),
                                  ),
                                'Rejected',
                              )
                            }
                          >
                            <X className="mr-1 h-3.5 w-3.5" /> Reject
                          </Button>
                        </>
                      ) : null}

                      {canPay ? (
                        <Button
                          size="sm"
                          disabled={busy === r.id}
                          onClick={() =>
                            act(
                              r.id,
                              () =>
                                callAction(() =>
                                  payPettyRequestAction({
                                    requestId: r.id,
                                    sessionId: data.openSession!.id,
                                  }),
                                ),
                              'Paid',
                            )
                          }
                        >
                          <HandCoins className="mr-1 h-3.5 w-3.5" /> Pay out
                        </Button>
                      ) : null}

                      {r.status === 'PENDING' || r.status === 'DRAFT' ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy === r.id}
                          onClick={() =>
                            act(
                              r.id,
                              () => callAction(() => cancelPettyRequestAction({ requestId: r.id })),
                              'Withdrawn',
                            )
                          }
                        >
                          Withdraw
                        </Button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <p className="mt-3 flex items-start gap-2 text-xs text-muted-foreground">
        <Coins className="mt-0.5 size-3.5 shrink-0" />
        Anything at or above {money(data.approvalThreshold)} has to be approved by somebody other
        than the person who asked.
      </p>
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
