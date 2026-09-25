'use client'

import * as React from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ArrowLeftRight, Landmark, Plus, Users } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { EmptyState } from '@/components/ui/feedback'
import { Input, Textarea } from '@/components/ui/input'
import { Field } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/primitives'
import { SectionCard } from '@/features/dashboard/components/page-header'
import { formatMoney } from '@/lib/money'
import { newRequestKey } from '@/lib/request-key'
import { callAction } from '@/lib/use-action'
import { cn } from '@/lib/utils'
import {
  createAccountAction,
  depositAction,
  setAccountStaffAction,
  transferAction,
  updateAccountAction,
} from '../accounts-actions'

/**
 * Payment details: the accounts, and the two things you can do to them.
 *
 * ── Kept deliberately plain ─────────────────────────────────────────────────
 *
 * bank.md §7 draws the screen: two buttons, then a card per account showing a
 * name, a bank and a balance, with Deposit and Transactions on it. No charts,
 * no analytics, no second figure. That last part matters more than it sounds —
 * a card showing both "balance" and "collected this month" invites an owner to
 * read them as the same number, and they are not.
 */

export interface AccountCard {
  accountId: string
  code: string
  name: string
  bankName: string | null
  detail: string | null
  balance: number
  isActive: boolean
}

export interface StaffOption {
  id: string
  name: string
  roleLabel: string
}

export interface AccountAccessRow {
  accountId: string
  userId: string
  canTransfer: boolean
}

export function AccountsPanel({
  accounts,
  staff,
  access,
  currency,
  locale,
  canManage,
  basePath,
}: {
  accounts: AccountCard[]
  staff: StaffOption[]
  access: AccountAccessRow[]
  /*
   * The currency and locale, NOT a ready-made formatter.
   *
   * A server component cannot hand a function across the boundary — React has
   * to serialise every prop — and passing one fails at render with "Functions
   * cannot be passed directly to Client Components". So the two values travel
   * and the formatter is built here, which is what every other client
   * component in this app does.
   */
  currency: string
  locale: string
  /** Creating, depositing and assigning staff. Reading needs less. */
  canManage: boolean
  basePath: string
}) {
  const money = React.useCallback(
    (minor: number) => formatMoney(minor, currency, locale),
    [currency, locale],
  )
  const router = useRouter()
  const [busy, setBusy] = React.useState(false)
  const [open, setOpen] = React.useState<
    | { kind: 'create' }
    | { kind: 'edit'; account: AccountCard }
    | { kind: 'deposit'; account: AccountCard }
    | { kind: 'transfer' }
    | { kind: 'staff'; account: AccountCard }
    | null
  >(null)

  const done = (message: string) => {
    toast.success(message)
    setOpen(null)
    router.refresh()
  }

  const live = accounts.filter((account) => account.isActive)

  return (
    <SectionCard
      title="Accounts"
      description="Where your money is held. A payment lands in the account its method points at, automatically."
      actions={
        canManage ? (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => setOpen({ kind: 'create' })}>
              <Plus /> Create account
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={live.length < 2}
              title={live.length < 2 ? 'Two accounts are needed before money can move between them' : undefined}
              onClick={() => setOpen({ kind: 'transfer' })}
            >
              <ArrowLeftRight /> Money transfer
            </Button>
          </div>
        ) : null
      }
    >
      {accounts.length === 0 ? (
        <EmptyState
          icon={<Landmark className="size-8" />}
          title="No accounts yet"
          description={
            canManage
              ? 'Create one for each bank account you keep. Payments will land in whichever you point them at.'
              : 'You have not been given access to any account yet. An owner can assign one.'
          }
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {accounts.map((account) => (
            <div
              key={account.accountId}
              className={cn(
                'flex flex-col rounded-xl border bg-card p-4 shadow-soft',
                !account.isActive && 'opacity-60',
              )}
            >
              <p className="truncate text-sm font-semibold">{account.name}</p>
              <p className="truncate text-xs text-muted-foreground">
                {account.detail || account.bankName || '—'}
                {account.isActive ? '' : ' · retired'}
              </p>

              {/*
                One figure, and it is the balance. Anything alongside it would
                be read as the same money by somebody glancing.
              */}
              <p className="mt-3 text-2xl font-bold tabular-nums">{money(account.balance)}</p>
              <p className="text-[11px] text-muted-foreground">Balance · all locations</p>

              <div className="mt-3 flex flex-wrap gap-1.5 border-t pt-3">
                {canManage && account.isActive ? (
                  <Button size="sm" variant="outline" onClick={() => setOpen({ kind: 'deposit', account })}>
                    Deposit
                  </Button>
                ) : null}
                <Button size="sm" variant="ghost" asChild>
                  <Link href={`${basePath}/${account.code}`}>Transactions</Link>
                </Button>
                {canManage ? (
                  <>
                    <Button size="sm" variant="ghost" onClick={() => setOpen({ kind: 'edit', account })}>
                      Edit
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setOpen({ kind: 'staff', account })}
                      aria-label={`Who may use ${account.name}`}
                    >
                      <Users />
                    </Button>
                  </>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── Create / edit ─────────────────────────────────────────────── */}
      {open?.kind === 'create' || open?.kind === 'edit' ? (
        <AccountDialog
          account={open.kind === 'edit' ? open.account : null}
          busy={busy}
          onClose={() => setOpen(null)}
          onSave={async (values) => {
            setBusy(true)
            const result = await callAction(() =>
              open.kind === 'edit'
                ? updateAccountAction({ accountId: open.account.accountId, ...values })
                : createAccountAction(values),
            )
            setBusy(false)
            if (!result.ok) return toast.error(result.error)
            done(open.kind === 'edit' ? 'Account updated' : 'Account created')
          }}
        />
      ) : null}

      {/* ── Deposit ───────────────────────────────────────────────────── */}
      {open?.kind === 'deposit' ? (
        <DepositDialog
          account={open.account}
          money={money}
          busy={busy}
          onClose={() => setOpen(null)}
          onSave={async (amount, reason, key) => {
            setBusy(true)
            const result = await callAction(() =>
              depositAction({ accountId: open.account.accountId, amount, reason, clientRequestId: key }),
            )
            setBusy(false)
            if (!result.ok) return toast.error(result.error)
            done(`${money(amount)} added to ${open.account.name}`)
          }}
        />
      ) : null}

      {/* ── Transfer ──────────────────────────────────────────────────── */}
      {open?.kind === 'transfer' ? (
        <TransferDialog
          accounts={live}
          money={money}
          busy={busy}
          onClose={() => setOpen(null)}
          onSave={async (values, key) => {
            setBusy(true)
            const result = await callAction(() => transferAction({ ...values, clientRequestId: key }))
            setBusy(false)
            if (!result.ok) return toast.error(result.error)
            done('Money transferred')
          }}
        />
      ) : null}

      {/* ── Who may use it ────────────────────────────────────────────── */}
      {open?.kind === 'staff' ? (
        <StaffDialog
          account={open.account}
          staff={staff}
          rows={access.filter((row) => row.accountId === open.account.accountId)}
          busy={busy}
          onClose={() => setOpen(null)}
          onSave={async (rows) => {
            setBusy(true)
            const result = await callAction(() =>
              setAccountStaffAction({ accountId: open.account.accountId, staff: rows }),
            )
            setBusy(false)
            if (!result.ok) return toast.error(result.error)
            done('Access updated')
          }}
        />
      ) : null}
    </SectionCard>
  )
}

/* ── Dialogs ──────────────────────────────────────────────────────────────── */

function AccountDialog({
  account,
  busy,
  onClose,
  onSave,
}: {
  account: AccountCard | null
  busy: boolean
  onClose: () => void
  onSave: (values: {
    name: string
    bankName: string
    accountNumber: string
    holderName: string
  }) => void
}) {
  const [name, setName] = React.useState(account?.name ?? '')
  const [bankName, setBankName] = React.useState(account?.bankName ?? '')
  const [accountNumber, setAccountNumber] = React.useState('')
  const [holderName, setHolderName] = React.useState('')

  return (
    <Dialog open onOpenChange={(next) => (next ? null : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{account ? `Edit ${account.name}` : 'Create an account'}</DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <Field label="Account name" required hint="What you call it — “BOC Main Account”.">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="BOC Main Account" autoFocus />
          </Field>
          <Field label="Bank name">
            <Input value={bankName} onChange={(e) => setBankName(e.target.value)} placeholder="BOC" />
          </Field>
          <Field label="Account number">
            <Input
              value={accountNumber}
              onChange={(e) => setAccountNumber(e.target.value)}
              placeholder="1234567890"
            />
          </Field>
          <Field label="Holder name">
            <Input value={holderName} onChange={(e) => setHolderName(e.target.value)} placeholder="Nimal Perera" />
          </Field>
          <p className="text-xs text-muted-foreground">
            Recorded for your own reference. Nothing here is sent to a bank.
          </p>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            loading={busy}
            disabled={busy || !name.trim()}
            onClick={() => onSave({ name, bankName, accountNumber, holderName })}
          >
            {account ? 'Save' : 'Create'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function DepositDialog({
  account,
  money,
  busy,
  onClose,
  onSave,
}: {
  account: AccountCard
  money: (minor: number) => string
  busy: boolean
  onClose: () => void
  onSave: (amount: number, reason: string, key: string) => void
}) {
  const [major, setMajor] = React.useState('')
  const [reason, setReason] = React.useState('')
  // One key per dialog, so a retry after a dropped connection deposits once.
  const key = React.useRef(newRequestKey('deposit'))
  const amount = Math.round(Number(major || 0) * 100)

  return (
    <Dialog open onOpenChange={(next) => (next ? null : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Deposit into {account.name}</DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <Field label="Amount" required>
            <Input
              type="number"
              inputMode="decimal"
              min={0}
              step="any"
              value={major}
              onChange={(e) => setMajor(e.target.value)}
              autoFocus
            />
          </Field>
          <Field label="Note" hint="Optional — “opening balance”, “cash banked”.">
            <Input value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
          <p className="text-xs text-muted-foreground">
            Balance after this: <strong className="tabular-nums">{money(account.balance + amount)}</strong>.
            This records money in TableFlow only — no bank is contacted.
          </p>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button loading={busy} disabled={busy || amount <= 0} onClick={() => onSave(amount, reason, key.current)}>
            Deposit
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function TransferDialog({
  accounts,
  money,
  busy,
  onClose,
  onSave,
}: {
  accounts: AccountCard[]
  money: (minor: number) => string
  busy: boolean
  onClose: () => void
  onSave: (
    values: { fromAccountId: string; toAccountId: string; amount: number; reason: string },
    key: string,
  ) => void
}) {
  const [fromAccountId, setFrom] = React.useState(accounts[0]?.accountId ?? '')
  const [toAccountId, setTo] = React.useState(accounts[1]?.accountId ?? '')
  const [major, setMajor] = React.useState('')
  const [reason, setReason] = React.useState('')
  const key = React.useRef(newRequestKey('transfer'))

  const amount = Math.round(Number(major || 0) * 100)
  const from = accounts.find((a) => a.accountId === fromAccountId)
  const short = from ? amount > from.balance : false
  const same = fromAccountId === toAccountId

  const select = (value: string, onChange: (next: string) => void, label: string) => (
    <select
      aria-label={label}
      className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      {accounts.map((account) => (
        <option key={account.accountId} value={account.accountId}>
          {account.name}
        </option>
      ))}
    </select>
  )

  return (
    <Dialog open onOpenChange={(next) => (next ? null : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Money transfer</DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <Field label="From" required hint={from ? `Holds ${money(from.balance)}` : undefined}>
            {select(fromAccountId, setFrom, 'Account the money leaves')}
          </Field>
          <Field label="To" required error={same ? 'Choose a different account' : undefined}>
            {select(toAccountId, setTo, 'Account the money goes to')}
          </Field>
          <Field
            label="Amount"
            required
            error={short ? 'That account does not hold that much' : undefined}
          >
            <Input
              type="number"
              inputMode="decimal"
              min={0}
              step="any"
              value={major}
              onChange={(e) => setMajor(e.target.value)}
            />
          </Field>
          <Field label="Reason" required hint="Why the money is moving. This is what explains it later.">
            <Textarea value={reason} onChange={(e) => setReason(e.target.value.slice(0, 160))} rows={2} />
          </Field>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            loading={busy}
            disabled={busy || amount <= 0 || same || short || !reason.trim()}
            onClick={() => onSave({ fromAccountId, toAccountId, amount, reason }, key.current)}
          >
            Transfer {amount > 0 ? money(amount) : ''}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function StaffDialog({
  account,
  staff,
  rows,
  busy,
  onClose,
  onSave,
}: {
  account: AccountCard
  staff: StaffOption[]
  rows: AccountAccessRow[]
  busy: boolean
  onClose: () => void
  onSave: (next: Array<{ userId: string; canTransfer: boolean }>) => void
}) {
  const [chosen, setChosen] = React.useState<Record<string, boolean>>(() =>
    Object.fromEntries(rows.map((row) => [row.userId, true])),
  )
  const [mayTransfer, setMayTransfer] = React.useState<Record<string, boolean>>(() =>
    Object.fromEntries(rows.map((row) => [row.userId, row.canTransfer])),
  )

  return (
    <Dialog open onOpenChange={(next) => (next ? null : onClose())}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Who may use {account.name}</DialogTitle>
        </DialogHeader>

        <p className="text-xs text-muted-foreground">
          Owners and administrators always have full access. Everyone else sees this account only if
          you tick them here — and can move money out of it only if you tick the second box.
        </p>

        {staff.length === 0 ? (
          <p className="py-4 text-sm text-muted-foreground">There is no other staff to assign yet.</p>
        ) : (
          <ul className="divide-y">
            {staff.map((person) => (
              <li key={person.id} className="flex items-center gap-3 py-2.5">
                <Checkbox
                  checked={Boolean(chosen[person.id])}
                  onCheckedChange={(value) =>
                    setChosen((current) => ({ ...current, [person.id]: value === true }))
                  }
                  aria-label={`Give ${person.name} access`}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{person.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">{person.roleLabel}</span>
                </span>
                <label className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                  <Checkbox
                    checked={Boolean(mayTransfer[person.id])}
                    disabled={!chosen[person.id]}
                    onCheckedChange={(value) =>
                      setMayTransfer((current) => ({ ...current, [person.id]: value === true }))
                    }
                    aria-label={`Let ${person.name} transfer from this account`}
                  />
                  Can transfer
                </label>
              </li>
            ))}
          </ul>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            loading={busy}
            disabled={busy}
            onClick={() =>
              onSave(
                staff
                  .filter((person) => chosen[person.id])
                  .map((person) => ({
                    userId: person.id,
                    canTransfer: Boolean(mayTransfer[person.id]),
                  })),
              )
            }
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
