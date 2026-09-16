'use client'

import * as React from 'react'
import { Check } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Field } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { formatMoney, parseMoney, toMajor } from '@/lib/money'
import { newRequestKey } from '@/lib/request-key'
import { callAction } from '@/lib/use-action'
import { cn } from '@/lib/utils'
import { collectPayment } from '../actions'
import { quickCash, TENDER_METHODS, type TenderMethod } from './tender'

export interface PayableOrder {
  id: string
  orderNumber: string
  /** What is still owed, in minor units: grand total + tip − paid. */
  due: number
}

/**
 * Take payment from the orders list (abc.md §1).
 *
 * The same contract as the till's panel: `collectPayment`, one request key
 * per tender attempt that SURVIVES a failed attempt (so a retry after a lost
 * response settles the bill once) and is regenerated only after a payment
 * lands. Partial payment is the "Amount to take" field, exactly as at the
 * till. Nothing here decides money — the server prices, caps and records.
 */
export function TakePaymentDialog({
  open,
  onOpenChange,
  order,
  currency,
  locale,
  onPaid,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  order: PayableOrder | null
  currency: string
  locale: string
  /** After the server has taken the money: how much, and whether the bill is settled. */
  onPaid: (orderId: string, amount: number, settled: boolean) => void
}) {
  const [method, setMethod] = React.useState<TenderMethod>('CASH')
  const [taking, setTaking] = React.useState('')
  const [tendered, setTendered] = React.useState('')
  const [reference, setReference] = React.useState('')
  const [tip, setTip] = React.useState('')
  const [pending, setPending] = React.useState(false)
  const tenderKey = React.useRef(newRequestKey('pay'))

  // A fresh form for each bill; the key is per attempt, not per bill.
  React.useEffect(() => {
    if (!open) return
    setMethod('CASH')
    setTaking('')
    setTendered('')
    setReference('')
    setTip('')
  }, [open, order?.id])

  const due = order?.due ?? 0
  const tipMinor = tip ? parseMoney(tip, currency) : 0
  const takingMinor = Math.min(taking ? parseMoney(taking, currency) : due, due)
  const amountDue = takingMinor + tipMinor
  const tenderedMinor = tendered ? parseMoney(tendered, currency) : 0
  const change = method === 'CASH' && tenderedMinor > amountDue ? tenderedMinor - amountDue : 0

  const settle = async () => {
    if (!order) return
    setPending(true)
    const result = await callAction(() =>
      collectPayment({
        orderId: order.id,
        method,
        amount: amountDue,
        tenderedAmount: method === 'CASH' ? tenderedMinor || amountDue : undefined,
        reference: reference || '',
        tipAmount: tipMinor,
        clientRequestId: tenderKey.current,
      }),
    )
    setPending(false)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    tenderKey.current = newRequestKey('pay')
    toast.success(
      result.data.change > 0
        ? `Paid. Change due ${formatMoney(result.data.change, currency, locale)}`
        : 'Payment recorded',
    )
    onPaid(order.id, amountDue, result.data.settled)
    onOpenChange(false)
  }

  return (
    <Dialog open={open && order !== null} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Take payment · #{order?.orderNumber}</DialogTitle>
          <DialogDescription>
            {formatMoney(due, currency, locale)} outstanding. Leave the amount blank for all of it.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <p className="mb-2 text-sm font-semibold">Payment method</p>
            <div className="grid grid-cols-3 gap-2">
              {TENDER_METHODS.map((entry) => (
                <button
                  key={entry.key}
                  type="button"
                  onClick={() => setMethod(entry.key)}
                  className={cn(
                    'flex flex-col items-center gap-1.5 rounded-lg border p-2.5 text-xs font-medium transition-colors',
                    method === entry.key ? 'border-primary bg-primary/10 text-primary' : 'hover:bg-muted/50',
                  )}
                >
                  <entry.icon className="size-5" />
                  {entry.label}
                </button>
              ))}
            </div>
          </div>

          {method === 'CASH' ? (
            <>
              <Field label="Cash tendered" htmlFor="tp-tendered">
                <Input
                  id="tp-tendered"
                  inputMode="decimal"
                  value={tendered}
                  onChange={(event) => setTendered(event.target.value)}
                  placeholder={String(toMajor(amountDue, currency))}
                />
              </Field>
              <div className="flex flex-wrap gap-2">
                {quickCash(amountDue, currency).map((preset) => (
                  <Button
                    key={preset}
                    variant="outline"
                    size="sm"
                    onClick={() => setTendered(String(toMajor(preset, currency)))}
                  >
                    {formatMoney(preset, currency, locale)}
                  </Button>
                ))}
              </div>
              {change > 0 ? (
                <div className="rounded-lg bg-success/10 px-3 py-2 text-sm font-semibold text-success">
                  Change due {formatMoney(change, currency, locale)}
                </div>
              ) : null}
            </>
          ) : (
            <Field label="Reference" htmlFor="tp-reference" hint="Transaction id, last 4 digits, etc.">
              <Input
                id="tp-reference"
                value={reference}
                onChange={(event) => setReference(event.target.value)}
                placeholder="Optional"
              />
            </Field>
          )}

          <Field label="Amount to take" htmlFor="tp-taking" hint="Enter less than the total to split the payment">
            <Input
              id="tp-taking"
              inputMode="decimal"
              value={taking}
              onChange={(event) => setTaking(event.target.value)}
              placeholder={String(toMajor(due, currency))}
            />
          </Field>

          <Field label="Tip" htmlFor="tp-tip" hint="Optional">
            <Input
              id="tp-tip"
              inputMode="decimal"
              value={tip}
              onChange={(event) => setTip(event.target.value)}
              placeholder="0"
            />
          </Field>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button loading={pending} disabled={amountDue <= 0} onClick={settle}>
            <Check /> Take {formatMoney(amountDue, currency, locale)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
