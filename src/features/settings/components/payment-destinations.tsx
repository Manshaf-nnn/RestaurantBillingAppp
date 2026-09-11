'use client'

import * as React from 'react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { SectionCard } from '@/features/dashboard/components/page-header'
import { callAction } from '@/lib/use-action'
import {
  METHOD_LABELS,
  PAYMENT_METHOD_ORDER,
  destinationDetailLine,
  slugifyDestinationCode,
  type PaymentDestination,
} from '@/features/payments/destinations'
import { updatePaymentDestinations } from '../actions'

/**
 * Where each payment method's money lands (bill.md §2).
 *
 * ── Method-first, on purpose ────────────────────────────────────────────────
 *
 * This screen used to be two lists: a book of accounts on top, a method→account
 * mapping underneath. It was accurate and nobody could use it — an owner
 * thinking "cash goes to BOC" had to invent an account in one list before they
 * could express the sentence in the other. So the list of methods IS the
 * screen, and an account is created inline at the moment a method needs one.
 *
 * The underlying model did not change, and deliberately so. Accounts stay
 * separate records that methods point at, because two methods routinely land in
 * one account — cash and card both swept into the current account. Inlining the
 * bank details onto each method would mean typing one account number twice,
 * and reporting one bank as two half-full ones.
 *
 * ── What this is NOT ────────────────────────────────────────────────────────
 *
 * TableFlow has no gateway and no bank API. Pointing Cash at BOC moves no money
 * and tells BOC nothing; it records where the owner considers that cash to have
 * gone, so the day's takings can be split by account and checked against a real
 * statement. The card says so, because a screen that looks like it transfers
 * money and does not is worse than no screen at all.
 */

const KIND_LABELS: Record<NonNullable<PaymentDestination['kind']>, string> = {
  BANK: 'Bank account',
  CASH: 'Cash in hand',
  WALLET: 'Wallet',
  GATEWAY: 'Payment gateway',
  OTHER: 'Other',
}

/** The sentinel values the method picker uses alongside real account codes. */
const NONE = '__none__'
const NEW = '__new__'

interface Draft {
  /** The account being edited, or null when this is a brand-new one. */
  code: string | null
  /** The method that opened the form — the one a new account gets assigned to. */
  forMethod: string | null
  name: string
  kind: NonNullable<PaymentDestination['kind']>
  bankName: string
  accountNumber: string
  holderName: string
  bankBranch: string
}

const emptyDraft = (forMethod: string | null): Draft => ({
  code: null,
  forMethod,
  name: '',
  kind: 'BANK',
  bankName: '',
  accountNumber: '',
  holderName: '',
  bankBranch: '',
})

export function PaymentDestinations({
  initialDestinations,
  initialMethodDestinations,
  canManage,
}: {
  initialDestinations: PaymentDestination[]
  initialMethodDestinations: Record<string, string>
  canManage: boolean
}) {
  const [destinations, setDestinations] = React.useState<PaymentDestination[]>(
    initialDestinations.map((destination) => ({ ...destination })),
  )
  const [assigned, setAssigned] = React.useState<Record<string, string>>({
    ...initialMethodDestinations,
  })
  const [draft, setDraft] = React.useState<Draft | null>(null)
  const [saving, setSaving] = React.useState(false)

  const live = destinations.filter((destination) => !destination.archived)
  const retired = destinations.filter((destination) => destination.archived)
  const accountFor = (method: string) =>
    live.find((destination) => destination.code === assigned[method]) ?? null

  /** How many methods land in one account — an edit there touches them all. */
  const usedBy = (code: string) =>
    PAYMENT_METHOD_ORDER.filter((method) => assigned[method] === code)

  const openNew = (method: string) => setDraft(emptyDraft(method))

  const openEdit = (destination: PaymentDestination) =>
    setDraft({
      code: destination.code,
      forMethod: null,
      name: destination.name,
      kind: destination.kind ?? 'BANK',
      bankName: destination.bankName ?? '',
      accountNumber: destination.accountNumber ?? '',
      holderName: destination.holderName ?? '',
      bankBranch: destination.bankBranch ?? '',
    })

  /*
   * The name fills itself in from the bank name while it is still untouched,
   * so the one field this screen genuinely needs is one the owner never has to
   * stop and answer. Once they type a name of their own, it stops following.
   */
  const setBankName = (bankName: string) =>
    setDraft((current) =>
      current === null
        ? current
        : {
            ...current,
            bankName,
            name: current.name === current.bankName ? bankName : current.name,
          },
    )

  const commitDraft = () => {
    if (draft === null) return
    const name = (draft.name || draft.bankName).trim()
    if (!name) {
      toast.error('Give the account a name, or fill in the bank name')
      return
    }

    const details = {
      name,
      kind: draft.kind,
      bankName: draft.bankName.trim(),
      accountNumber: draft.accountNumber.trim(),
      holderName: draft.holderName.trim(),
      bankBranch: draft.bankBranch.trim(),
    }

    if (draft.code) {
      setDestinations((current) =>
        current.map((destination) =>
          destination.code === draft.code ? { ...destination, ...details } : destination,
        ),
      )
    } else {
      const code = slugifyDestinationCode(
        name,
        destinations.map((destination) => destination.code),
      )
      setDestinations((current) => [...current, { code, archived: false, ...details }])
      if (draft.forMethod) {
        setAssigned((current) => ({ ...current, [draft.forMethod as string]: code }))
      }
    }
    setDraft(null)
  }

  /*
   * Retiring releases every method pointing at the account in the same gesture.
   * Leaving them pointed at it would save a map the server refuses, and the
   * owner would be told their own screen is invalid without being shown where.
   */
  const retire = (code: string) => {
    setDestinations((current) =>
      current.map((destination) =>
        destination.code === code ? { ...destination, archived: true } : destination,
      ),
    )
    setAssigned((current) =>
      Object.fromEntries(
        Object.entries(current).map(([method, value]) => [method, value === code ? '' : value]),
      ),
    )
    setDraft(null)
  }

  const save = async () => {
    if (draft !== null) {
      toast.error('Finish the account you are editing first')
      return
    }
    setSaving(true)
    const result = await callAction(() =>
      updatePaymentDestinations({ destinations, methodDestinations: assigned }),
    )
    setSaving(false)
    if (result.ok) toast.success('Saved — new payments will be recorded here')
    else toast.error(result.error)
  }

  const unbooked = PAYMENT_METHOD_ORDER.filter((method) => !assigned[method])

  return (
    <SectionCard
      title="Where each payment lands"
      description="Tell us which account takes the money for each way a guest can pay. A cashier taking cash then files it under that account automatically — you can read the totals under Payment details."
    >
      <div className="space-y-2">
        {PAYMENT_METHOD_ORDER.map((method) => {
          const account = accountFor(method)
          const detail = account ? destinationDetailLine(account) : ''
          const editingThis =
            draft !== null && (draft.forMethod === method || (account && draft.code === account.code))

          return (
            <div key={method} className="rounded-lg border">
              <div className="flex flex-wrap items-center gap-3 p-3">
                <span className="w-32 shrink-0 text-sm font-semibold">
                  {METHOD_LABELS[method] ?? method}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">goes to</span>

                <Select
                  value={account ? account.code : NONE}
                  disabled={!canManage}
                  onValueChange={(value) => {
                    if (value === NEW) { openNew(method); return }
                    setDraft(null)
                    setAssigned((current) => ({
                      ...current,
                      [method]: value === NONE ? '' : value,
                    }))
                  }}
                >
                  <SelectTrigger className="w-56">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>Nowhere — not accepted</SelectItem>
                    {live.map((destination) => (
                      <SelectItem key={destination.code} value={destination.code}>
                        {destination.name}
                      </SelectItem>
                    ))}
                    <SelectItem value={NEW}>＋ Add a bank account…</SelectItem>
                  </SelectContent>
                </Select>

                {account ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={!canManage}
                    onClick={() => openEdit(account)}
                  >
                    Bank details
                  </Button>
                ) : null}

                {detail ? (
                  <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                    {detail}
                  </span>
                ) : null}
              </div>

              {editingThis && draft !== null ? (
                <AccountForm
                  draft={draft}
                  usedByCount={draft.code ? usedBy(draft.code).length : 0}
                  onChange={setDraft}
                  onBankName={setBankName}
                  onCommit={commitDraft}
                  onCancel={() => setDraft(null)}
                  onRetire={draft.code ? () => retire(draft.code as string) : undefined}
                />
              ) : null}
            </div>
          )
        })}
      </div>

      {unbooked.length > 0 ? (
        <p className="mt-3 text-xs text-muted-foreground">
          Going nowhere:{' '}
          <span className="font-medium">
            {unbooked.map((method) => METHOD_LABELS[method] ?? method).join(', ')}
          </span>
          . A cashier who tries to take one of these is refused and sent here.
        </p>
      ) : null}

      {retired.length > 0 ? (
        <div className="mt-5">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Retired accounts
          </p>
          <div className="flex flex-wrap gap-2">
            {retired.map((destination) => (
              <span key={destination.code} className="flex items-center gap-1">
                <Badge variant="outline">{destination.name}</Badge>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!canManage}
                  onClick={() =>
                    setDestinations((current) =>
                      current.map((entry) =>
                        entry.code === destination.code ? { ...entry, archived: false } : entry,
                      ),
                    )
                  }
                >
                  Bring back
                </Button>
              </span>
            ))}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            Kept rather than deleted — money already filed under these still needs a name to report
            under.
          </p>
        </div>
      ) : null}

      <Button className="mt-5" onClick={save} loading={saving} disabled={!canManage}>
        Save
      </Button>
    </SectionCard>
  )
}

/** The bank details for one account. Everything optional but the name. */
function AccountForm({
  draft,
  usedByCount,
  onChange,
  onBankName,
  onCommit,
  onCancel,
  onRetire,
}: {
  draft: Draft
  usedByCount: number
  onChange: React.Dispatch<React.SetStateAction<Draft | null>>
  onBankName: (value: string) => void
  onCommit: () => void
  onCancel: () => void
  onRetire?: () => void
}) {
  const set = (patch: Partial<Draft>) =>
    onChange((current) => (current === null ? current : { ...current, ...patch }))

  return (
    <div className="border-t bg-muted/30 p-3">
      <p className="mb-3 text-xs text-muted-foreground">
        Everything here is optional except what to call it — and that fills itself in from the bank
        name. Nothing is sent anywhere; it is recorded so you can match a statement.
        {usedByCount > 1
          ? ` Used by ${usedByCount} payment methods, so a change here applies to all of them.`
          : ''}
      </p>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Bank name" hint="e.g. Bank of Ceylon">
          <Input
            autoFocus
            value={draft.bankName}
            maxLength={80}
            placeholder="Bank of Ceylon"
            onChange={(event) => onBankName(event.target.value)}
          />
        </Field>
        <Field label="Account number">
          <Input
            value={draft.accountNumber}
            maxLength={40}
            placeholder="0012345678"
            onChange={(event) => set({ accountNumber: event.target.value })}
          />
        </Field>
        <Field label="Account holder">
          <Input
            value={draft.holderName}
            maxLength={80}
            placeholder="The name on the account"
            onChange={(event) => set({ holderName: event.target.value })}
          />
        </Field>
        <Field label="Bank branch">
          <Input
            value={draft.bankBranch}
            maxLength={80}
            placeholder="Colombo"
            onChange={(event) => set({ bankBranch: event.target.value })}
          />
        </Field>
        <Field label="What to call it" hint="How it appears on reports and under Payment details">
          <Input
            value={draft.name}
            maxLength={60}
            placeholder={draft.bankName || 'BOC current'}
            onChange={(event) => set({ name: event.target.value })}
          />
        </Field>
        <Field label="Type">
          <Select
            value={draft.kind}
            onValueChange={(kind) => set({ kind: kind as Draft['kind'] })}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(KIND_LABELS).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" onClick={onCommit}>
          {draft.code ? 'Update account' : 'Add account'}
        </Button>
        <Button size="sm" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        {onRetire ? (
          <Button size="sm" variant="ghost" className="ml-auto" onClick={onRetire}>
            Retire this account
          </Button>
        ) : null}
      </div>
    </div>
  )
}
