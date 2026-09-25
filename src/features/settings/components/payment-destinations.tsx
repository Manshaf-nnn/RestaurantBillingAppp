'use client'

import * as React from 'react'
import Link from 'next/link'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { SectionCard } from '@/features/dashboard/components/page-header'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { METHOD_LABELS, PAYMENT_METHOD_ORDER } from '@/features/payments/destinations'
import { updatePaymentDestinations } from '@/features/settings/actions'
import { callAction } from '@/lib/use-action'

/**
 * Where each payment lands (bank.md §4).
 *
 * ── One dropdown per method, and nothing else ───────────────────────────────
 *
 * This screen used to be the whole account system: it created accounts inline,
 * edited their bank details, retired them and brought them back. All of that
 * has moved to Payment details, where an account also has a balance and a
 * history — which is the point, because an account is a thing money sits in,
 * not a label on a setting.
 *
 * So what is left is the only decision this screen was ever really making:
 * which account does CASH go to. The list offers the accounts that exist and
 * nothing else — no free text, no "add one here" — so a method can only ever
 * point somewhere real.
 *
 * ── Why "Nowhere" survived the cull ─────────────────────────────────────────
 *
 * It looks like one of the "other destination options" §4 asks us to remove,
 * and it is not: it is not a destination at all. An unmapped method is how an
 * owner says "we do not take Wallet", and it is what makes `capturePayment`
 * refuse that tender with a message telling the cashier why. Remove it and the
 * only way to stop accepting a method would be to point it at an account it
 * never lands in.
 */

export interface DestinationAccount {
  code: string
  name: string
  bankName: string | null
}

const NONE = '__none__'

export function PaymentDestinations({
  accounts,
  initialMethodDestinations,
  canManage,
}: {
  accounts: DestinationAccount[]
  initialMethodDestinations: Record<string, string>
  canManage: boolean
}) {
  const [assigned, setAssigned] = React.useState<Record<string, string>>({
    ...initialMethodDestinations,
  })
  const [saving, setSaving] = React.useState(false)

  const save = async () => {
    setSaving(true)
    const result = await callAction(() =>
      updatePaymentDestinations({
        methodDestinations: Object.fromEntries(
          Object.entries(assigned).filter(([, code]) => Boolean(code)),
        ),
      }),
    )
    setSaving(false)
    if (!result.ok) return toast.error(result.error)
    toast.success('Saved')
  }

  const unmapped = PAYMENT_METHOD_ORDER.filter((method) => !assigned[method])

  return (
    <SectionCard
      title="Where each payment lands"
      description="Pick the account each payment method is filed into. Money lands there automatically the moment a cashier settles a bill."
      actions={
        canManage ? (
          <Button size="sm" onClick={save} loading={saving} disabled={saving}>
            Save
          </Button>
        ) : null
      }
    >
      {accounts.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          There are no accounts yet.{' '}
          <Link href="/dashboard/payment-details" className="text-primary underline-offset-2 hover:underline">
            Create one under Payment details
          </Link>{' '}
          and it will appear here.
        </p>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            {PAYMENT_METHOD_ORDER.map((method) => (
              <label key={method} className="flex items-center gap-3">
                <span className="w-32 shrink-0 text-sm font-medium">
                  {METHOD_LABELS[method] ?? method}
                </span>
                <Select
                  disabled={!canManage}
                  value={assigned[method] || NONE}
                  onValueChange={(value: string) =>
                    setAssigned((current) => ({
                      ...current,
                      [method]: value === NONE ? '' : value,
                    }))
                  }
                >
                  <SelectTrigger className="flex-1">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {/* Not a destination — see the note at the top of this file. */}
                    <SelectItem value={NONE}>Nowhere — not accepted</SelectItem>
                    {accounts.map((account) => (
                      <SelectItem key={account.code} value={account.code}>
                        {account.bankName ? `${account.name} · ${account.bankName}` : account.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
            ))}
          </div>

          {/*
            Said out loud, because an unmapped method is a refusal at the till
            and a cashier finding that out mid-service is the worst moment to
            learn it.
          */}
          {unmapped.length > 0 ? (
            <p className="mt-3 text-xs text-muted-foreground">
              Not accepted: {unmapped.map((method) => METHOD_LABELS[method] ?? method).join(', ')}.
              A cashier tendering one of these is refused.
            </p>
          ) : null}

          <p className="mt-3 text-xs text-muted-foreground">
            Accounts, their balances and their history live under{' '}
            <Link
              href="/dashboard/payment-details"
              className="text-primary underline-offset-2 hover:underline"
            >
              Payment details
            </Link>
            .
          </p>
        </>
      )}
    </SectionCard>
  )
}
