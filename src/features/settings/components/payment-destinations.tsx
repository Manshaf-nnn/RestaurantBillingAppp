'use client'

import * as React from 'react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
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
  slugifyDestinationCode,
  type PaymentDestination,
} from '@/features/payments/destinations'
import { updatePaymentDestinations } from '../actions'

/**
 * Where each payment method's money is booked (bill.md §2).
 *
 * ── What this is NOT ────────────────────────────────────────────────────────
 *
 * TableFlow has no gateway and no bank API. Choosing "BOC" for Cash moves no
 * money and tells no bank anything; it records the owner's decision about
 * which account that cash is considered to have landed in, so the day's
 * takings can be split by account and reconciled against a real statement.
 * The card says so plainly, because a screen that looks like it transfers
 * money and does not is worse than no screen.
 *
 * ── Two lists, not one ──────────────────────────────────────────────────────
 *
 * The accounts exist independently of the methods that point at them: two
 * methods commonly share one bank, and an account outlives the method that
 * first created it. So the top half is a book of accounts and the bottom half
 * is an assignment — which is also why retiring an account is not deleting it.
 *
 * ── Why nothing here decides anything ───────────────────────────────────────
 *
 * The refusal that actually stops a payment lives in `capturePayment`. This
 * screen only writes the map it reads from. Everything it shows — which
 * methods are unassigned, which account is retired — is a preview of what the
 * server will do, never the check itself.
 */

const KIND_LABELS: Record<NonNullable<PaymentDestination['kind']>, string> = {
  BANK: 'Bank account',
  CASH: 'Cash in hand',
  WALLET: 'Wallet',
  OTHER: 'Other',
}

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
  const [saving, setSaving] = React.useState(false)

  const live = destinations.filter((destination) => !destination.archived)
  const retired = destinations.filter((destination) => destination.archived)

  const addAccount = () => {
    const code = slugifyDestinationCode(
      `Account ${destinations.length + 1}`,
      destinations.map((destination) => destination.code),
    )
    setDestinations((current) => [...current, { code, name: '', kind: 'BANK' }])
  }

  const editAccount = (code: string, patch: Partial<PaymentDestination>) =>
    setDestinations((current) =>
      current.map((destination) =>
        destination.code === code ? { ...destination, ...patch } : destination,
      ),
    )

  /*
   * Retiring pulls the account out from under every method pointing at it, in
   * the same gesture. Leaving those methods pointed at a retired account would
   * save a map the server refuses, and the owner would be told their own screen
   * is invalid without being shown which row to fix.
   */
  const retire = (code: string) => {
    editAccount(code, { archived: true })
    setAssigned((current) =>
      Object.fromEntries(
        Object.entries(current).map(([method, value]) => [method, value === code ? '' : value]),
      ),
    )
  }

  const save = async () => {
    const named = destinations.filter(
      (destination) => destination.name.trim().length > 0 || destination.archived,
    )
    if (named.length !== destinations.length) {
      toast.error('Give every account a name, or remove the blank row')
      return
    }

    setSaving(true)
    const result = await callAction(() =>
      updatePaymentDestinations({ destinations: named, methodDestinations: assigned }),
    )
    setSaving(false)
    if (result.ok) toast.success('Payment destinations saved')
    else toast.error(result.error)
  }

  const unassigned = PAYMENT_METHOD_ORDER.filter((method) => !assigned[method])

  return (
    <SectionCard
      title="Where the money goes"
      description="Each payment method is booked to one account, for the whole restaurant. This is bookkeeping only — TableFlow moves no money and talks to no bank."
    >
      <div className="space-y-6">
        <div>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Your accounts
          </p>
          <div className="space-y-2">
            {live.map((destination) => (
              <div
                key={destination.code}
                className="flex flex-wrap items-center gap-2 rounded-lg border p-2"
              >
                <Input
                  value={destination.name}
                  maxLength={60}
                  disabled={!canManage}
                  placeholder="e.g. BOC current account"
                  className="min-w-[12rem] flex-1"
                  onChange={(event) => editAccount(destination.code, { name: event.target.value })}
                />
                <Select
                  value={destination.kind ?? 'OTHER'}
                  disabled={!canManage}
                  onValueChange={(kind) =>
                    editAccount(destination.code, { kind: kind as PaymentDestination['kind'] })
                  }
                >
                  <SelectTrigger className="w-40">
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
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!canManage}
                  onClick={() => retire(destination.code)}
                >
                  Retire
                </Button>
              </div>
            ))}

            {live.length === 0 ? (
              <p className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">
                No accounts yet. Until you add one and point your methods at it, the till will
                refuse to settle.
              </p>
            ) : null}
          </div>

          <Button size="sm" variant="outline" className="mt-2" disabled={!canManage} onClick={addAccount}>
            Add an account
          </Button>
        </div>

        <div>
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            What goes where
          </p>
          <p className="mb-3 text-xs text-muted-foreground">
            A method with no account cannot be settled — the cashier is told to come here. Leave one
            blank on purpose if you do not accept it.
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            {PAYMENT_METHOD_ORDER.map((method) => (
              <label
                key={method}
                className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2"
              >
                <span className="text-sm font-medium">{METHOD_LABELS[method] ?? method}</span>
                <Select
                  value={assigned[method] || 'NONE'}
                  disabled={!canManage}
                  onValueChange={(code) =>
                    setAssigned((current) => ({ ...current, [method]: code === 'NONE' ? '' : code }))
                  }
                >
                  <SelectTrigger className="w-44">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="NONE">Not accepted</SelectItem>
                    {live
                      .filter((destination) => destination.name.trim().length > 0)
                      .map((destination) => (
                        <SelectItem key={destination.code} value={destination.code}>
                          {destination.name}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </label>
            ))}
          </div>

          {unassigned.length > 0 ? (
            <p className="mt-3 text-xs text-muted-foreground">
              Not booked anywhere:{' '}
              <span className="font-medium">
                {unassigned.map((method) => METHOD_LABELS[method] ?? method).join(', ')}
              </span>
              . Taking one of these at the till will be refused.
            </p>
          ) : null}
        </div>

        {retired.length > 0 ? (
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Retired
            </p>
            <div className="flex flex-wrap gap-2">
              {retired.map((destination) => (
                <span key={destination.code} className="flex items-center gap-2">
                  <Badge variant="outline">{destination.name || destination.code}</Badge>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={!canManage}
                    onClick={() => editAccount(destination.code, { archived: false })}
                  >
                    Bring back
                  </Button>
                </span>
              ))}
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              Kept, not deleted: payments already booked to these still need a name to report under.
            </p>
          </div>
        ) : null}

        <Button onClick={save} loading={saving} disabled={!canManage}>
          Save destinations
        </Button>
      </div>
    </SectionCard>
  )
}
