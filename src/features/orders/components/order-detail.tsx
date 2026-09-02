'use client'

import * as React from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import type { OrderStatus } from '@prisma/client'
import { ArrowLeft, Ban, Check, Clock, Printer, User } from 'lucide-react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
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
import { Input, Textarea } from '@/components/ui/input'
import { Separator } from '@/components/ui/primitives'
import { OrderStatusBadge, ORDER_STATUS_META, PaymentStatusBadge, VegIndicator } from '@/components/ui/status'
import { formatMoney, parseMoney, toMajor } from '@/lib/money'
import { cn } from '@/lib/utils'
import { printReceipt } from '@/features/printing/print'
import { buildReceipt } from '@/features/printing/receipt'
import type { PaperWidth } from '@/features/printing/paper'
import { cancelOrder, updateOrderStatus } from '../actions'
import { refundOrderPayment } from '@/features/payments/actions'
import { callAction } from '@/lib/use-action'

const NEXT_STATUS: Partial<Record<OrderStatus, { status: OrderStatus; label: string }>> = {
  PENDING: { status: 'ACCEPTED', label: 'Accept order' },
  ACCEPTED: { status: 'PREPARING', label: 'Start preparing' },
  PREPARING: { status: 'READY', label: 'Mark ready' },
  READY: { status: 'SERVED', label: 'Mark served' },
  SERVED: { status: 'COMPLETED', label: 'Complete order' },
}

export interface OrderDetailView {
  id: string
  orderNumber: string
  status: OrderStatus
  paymentStatus: 'UNPAID' | 'PARTIAL' | 'PAID' | 'REFUNDED' | 'FAILED'
  type: string
  tableNumber: string | null
  customerName: string
  customerPhone: string
  customerEmail: string | null
  notes: string | null
  cancelReason: string | null
  placedAt: string
  subtotal: number
  discountTotal: number
  loyaltyDiscount: number
  serviceCharge: number
  taxTotal: number
  tipAmount: number
  roundingAdj: number
  grandTotal: number
  paidTotal: number
  taxLabel: string
  items: Array<{
    id: string
    name: string
    optionsLabel: string
    quantity: number
    lineTotal: number
    notes: string | null
    isVeg: boolean
    status: string
  }>
  events: Array<{ id: string; status: OrderStatus; note: string | null; actorName: string | null; createdAt: string }>
  payments: Array<{
    id: string
    method: string
    amount: number
    status: string
    createdAt: string
    /** Minor units already sent back against this payment. */
    refunded: number
  }>
}

export function OrderDetail({
  order,
  currency,
  locale,
  restaurant,
  canUpdate,
  canCancel,
  canRefund,
  backHref = '/dashboard/orders',
}: {
  order: OrderDetailView
  currency: string
  locale: string
  restaurant: {
    name: string
    addressLine: string | null
    phone: string | null
    /** Thermal paper widths chosen in Settings. */
    paper: { receipt: PaperWidth; kitchen: PaperWidth }
  }
  canUpdate: boolean
  canCancel: boolean
  canRefund: boolean
  /**
   * Where the back arrow goes, or `null` to drop it.
   *
   * A back arrow to the orders list is right on the orders page and wrong in a
   * modal opened from the live floor, which has its own way out.
   */
  backHref?: string | null
}) {
  const router = useRouter()
  const [status, setStatus] = React.useState(order.status)
  const [pending, setPending] = React.useState(false)
  const [cancelOpen, setCancelOpen] = React.useState(false)
  const [reason, setReason] = React.useState('')

  const advance = async () => {
    const next = NEXT_STATUS[status]
    if (!next) return
    setPending(true)
    const result = await callAction(() => updateOrderStatus({ orderId: order.id, status: next.status }))
    setPending(false)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    setStatus(next.status)
    toast.success(`Order ${next.status.toLowerCase()}`)
    router.refresh()
  }

  const doCancel = async () => {
    setPending(true)
    const result = await callAction(() => cancelOrder({ orderId: order.id, reason }))
    setPending(false)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    setStatus('CANCELLED')
    setCancelOpen(false)
    toast.success('Order cancelled')
    router.refresh()
  }

  const money = (value: number) => formatMoney(value, currency, locale)
  const next = NEXT_STATUS[status]
  const terminal = status === 'COMPLETED' || status === 'CANCELLED'

  /*
   * The shared builder, so this screen, the till and the cashier board print
   * the same thing. This used to be a third hand-written copy of the same
   * mapping — which is how one of them ends up omitting a row the others show.
   */
  const print = () =>
    printReceipt(
      buildReceipt(
        {
          orderNumber: order.orderNumber,
          placedAt: order.placedAt,
          tableNumber: order.tableNumber,
          customerName: order.customerName,
          items: order.items,
          subtotal: order.subtotal,
          discountTotal: order.discountTotal,
          loyaltyDiscount: order.loyaltyDiscount,
          serviceCharge: order.serviceCharge,
          taxTotal: order.taxTotal,
          roundingAdj: order.roundingAdj,
          grandTotal: order.grandTotal,
          tipAmount: order.tipAmount,
          paidTotal: order.paidTotal,
          payments: order.payments
            .filter((payment) => payment.status === 'PAID' || payment.status === 'REFUNDED')
            .map((payment) => ({ method: payment.method, amount: payment.amount })),
        },
        {
          name: restaurant.name,
          currency,
          locale,
          taxLabel: order.taxLabel,
          paper: restaurant.paper,
          addressLine: restaurant.addressLine,
          phone: restaurant.phone,
        },
      ),
      // Was omitted, so this screen silently printed 58mm whatever the owner
      // had chosen in Settings.
      restaurant.paper.receipt,
    )

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          {backHref ? (
            <Button variant="ghost" size="icon" asChild aria-label="Back">
              <Link href={backHref}>
                <ArrowLeft />
              </Link>
            </Button>
          ) : null}
          <div>
            <h1 className="flex items-center gap-2 text-xl font-bold">
              #{order.orderNumber}
              <OrderStatusBadge status={status} />
              <PaymentStatusBadge status={order.paymentStatus} />
            </h1>
            <p className="text-sm text-muted-foreground">
              {new Date(order.placedAt).toLocaleString(locale)} ·{' '}
              {order.tableNumber ? `Table ${order.tableNumber}` : order.type.replace('_', ' ')}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={print}>
            <Printer /> Print
          </Button>
          {canCancel && !terminal ? (
            <Button variant="outline" className="text-destructive" onClick={() => setCancelOpen(true)}>
              <Ban /> Cancel
            </Button>
          ) : null}
          {canUpdate && next ? (
            <Button onClick={advance} loading={pending}>
              <Check /> {next.label}
            </Button>
          ) : null}
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <section className="rounded-xl border bg-card shadow-soft">
            <header className="border-b px-5 py-3">
              <h2 className="text-sm font-semibold">Items</h2>
            </header>
            <ul className="divide-y">
              {order.items.map((item) => (
                <li key={item.id} className="flex items-start gap-3 px-5 py-3">
                  <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-sm font-bold">
                    {item.quantity}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-1.5 text-sm font-medium">
                      <VegIndicator isVeg={item.isVeg} />
                      {item.name}
                    </p>
                    {item.optionsLabel ? (
                      <p className="text-xs text-muted-foreground">{item.optionsLabel}</p>
                    ) : null}
                    {item.notes ? <p className="text-xs italic text-primary">“{item.notes}”</p> : null}
                  </div>
                  <span className="shrink-0 text-sm font-semibold tabular-nums">{money(item.lineTotal)}</span>
                </li>
              ))}
            </ul>

            <div className="space-y-1.5 border-t px-5 py-4 text-sm">
              <Row label="Subtotal" value={money(order.subtotal)} />
              {order.discountTotal > 0 ? <Row label="Discount" value={`− ${money(order.discountTotal)}`} /> : null}
              {order.loyaltyDiscount > 0 ? <Row label="Loyalty" value={`− ${money(order.loyaltyDiscount)}`} /> : null}
              {order.serviceCharge > 0 ? <Row label="Service charge" value={money(order.serviceCharge)} /> : null}
              {order.taxTotal > 0 ? <Row label={order.taxLabel} value={money(order.taxTotal)} /> : null}
              {order.roundingAdj !== 0 ? <Row label="Rounding" value={money(order.roundingAdj)} /> : null}
              <Separator className="my-2" />
              <div className="flex justify-between text-base font-bold">
                <span>Total</span>
                <span>{money(order.grandTotal)}</span>
              </div>
              {/* The tip is the staff's money riding on top, not part of the bill. */}
              {order.tipAmount > 0 ? (
                <>
                  <Row label="Tip" value={money(order.tipAmount)} />
                  <div className="flex justify-between text-sm font-semibold">
                    <span>Total with tip</span>
                    <span>{money(order.grandTotal + order.tipAmount)}</span>
                  </div>
                </>
              ) : null}
              {order.paidTotal > 0 && order.paidTotal < order.grandTotal + order.tipAmount ? (
                <>
                  <Row label="Paid so far" value={money(order.paidTotal)} />
                  <div className="flex justify-between text-sm font-semibold text-warning">
                    <span>Balance due</span>
                    <span>{money(order.grandTotal + order.tipAmount - order.paidTotal)}</span>
                  </div>
                </>
              ) : null}
            </div>
          </section>

          {order.payments.length ? (
            <section className="rounded-xl border bg-card shadow-soft">
              <header className="border-b px-5 py-3">
                <h2 className="text-sm font-semibold">Payments</h2>
              </header>
              <ul className="divide-y">
                {order.payments.map((payment) => (
                  <li key={payment.id} className="px-5 py-3 text-sm">
                    <div className="flex items-center justify-between">
                      <span className="flex items-center gap-2">
                        <Badge variant="secondary">{payment.method}</Badge>
                        <span className="text-muted-foreground">
                          {new Date(payment.createdAt).toLocaleString(locale)}
                        </span>
                      </span>
                      <span className="flex items-center gap-3">
                        <span className="font-semibold">{money(payment.amount)}</span>
                        {canRefund &&
                        (payment.status === 'PAID' || payment.status === 'REFUNDED') &&
                        payment.refunded < payment.amount ? (
                          <RefundButton payment={payment} currency={currency} locale={locale} />
                        ) : null}
                      </span>
                    </div>
                    {payment.refunded > 0 ? (
                      <p className="mt-1 text-xs font-medium text-destructive">
                        {money(payment.refunded)} refunded
                        {payment.refunded < payment.amount
                          ? ` — ${money(payment.amount - payment.refunded)} still held`
                          : ''}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>

        <div className="space-y-5">
          <section className="rounded-xl border bg-card p-5 shadow-soft">
            <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
              <User className="size-4" /> Customer
            </h2>
            <dl className="space-y-1 text-sm">
              <p className="font-medium">{order.customerName}</p>
              <p className="text-muted-foreground">{order.customerPhone}</p>
              {order.customerEmail ? <p className="text-muted-foreground">{order.customerEmail}</p> : null}
            </dl>
            {order.notes ? (
              <p className="mt-3 rounded-lg bg-muted/50 px-3 py-2 text-xs">{order.notes}</p>
            ) : null}
            {order.cancelReason ? (
              <p className="mt-3 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
                Cancelled: {order.cancelReason}
              </p>
            ) : null}
          </section>

          <section className="rounded-xl border bg-card p-5 shadow-soft">
            <h2 className="mb-4 flex items-center gap-2 text-sm font-semibold">
              <Clock className="size-4" /> Timeline
            </h2>
            <ol className="space-y-4">
              {order.events.map((event, index) => (
                <li key={event.id} className="flex gap-3">
                  <div className="flex flex-col items-center">
                    <span className={cn('size-2.5 rounded-full', ORDER_STATUS_META[event.status].dot)} />
                    {index < order.events.length - 1 ? (
                      <span className="my-1 w-px flex-1 bg-border" />
                    ) : null}
                  </div>
                  <div className="pb-1">
                    <p className="text-sm font-medium">{ORDER_STATUS_META[event.status].label}</p>
                    <p className="text-xs text-muted-foreground">
                      {new Date(event.createdAt).toLocaleTimeString(locale, {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                      {event.actorName ? ` · ${event.actorName}` : ''}
                    </p>
                    {event.note ? <p className="text-xs text-muted-foreground">{event.note}</p> : null}
                  </div>
                </li>
              ))}
            </ol>
          </section>
        </div>
      </div>

      <Dialog open={cancelOpen} onOpenChange={setCancelOpen}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>Cancel this order?</DialogTitle>
            <DialogDescription>
              This releases the table and restores stock. Paid orders must be refunded first.
            </DialogDescription>
          </DialogHeader>
          <Field label="Reason" required>
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} placeholder="Why is this being cancelled?" />
          </Field>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCancelOpen(false)}>
              Keep order
            </Button>
            <Button variant="destructive" onClick={doCancel} loading={pending} disabled={reason.trim().length < 3}>
              Cancel order
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  )
}


/**
 * Give money back, from the record of it arriving.
 *
 * The amount defaults to everything the payment still holds and may be less —
 * a partial refund is several of these over time, each with its own reason.
 * Anything at or over the restaurant's approval threshold comes back with
 * "sent for approval"; the button is pressed again once a manager signs off.
 */
function RefundButton({
  payment,
  currency,
  locale,
}: {
  payment: { id: string; amount: number; refunded: number }
  currency: string
  locale: string
}) {
  const router = useRouter()
  const remaining = payment.amount - payment.refunded
  const [open, setOpen] = React.useState(false)
  const [amount, setAmount] = React.useState('')
  const [reason, setReason] = React.useState('')
  const [pending, setPending] = React.useState(false)

  const amountMinor = amount ? parseMoney(amount, currency as never) : remaining

  const submit = async () => {
    setPending(true)
    const result = await callAction(() =>
      refundOrderPayment({ paymentId: payment.id, reason, amount: amountMinor }),
    )
    setPending(false)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    toast.success('Refund recorded')
    setOpen(false)
    setAmount('')
    setReason('')
    router.refresh()
  }

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        Refund
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Refund payment</DialogTitle>
            <DialogDescription>
              Up to {formatMoney(remaining, currency, locale)} can go back on this payment.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Field label="Amount" htmlFor="refund-amount">
              <Input
                id="refund-amount"
                inputMode="decimal"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                placeholder={String(toMajor(remaining, currency as never))}
              />
            </Field>
            <Field label="Reason" htmlFor="refund-reason">
              <Textarea
                id="refund-reason"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="Why is this money going back?"
                rows={2}
              />
            </Field>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Keep it
            </Button>
            <Button
              variant="destructive"
              loading={pending}
              disabled={reason.trim().length < 3 || amountMinor < 1 || amountMinor > remaining}
              onClick={submit}
            >
              Refund {formatMoney(amountMinor, currency, locale)}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
