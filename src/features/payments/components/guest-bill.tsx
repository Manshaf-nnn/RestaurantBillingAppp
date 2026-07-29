'use client'

import * as React from 'react'
import Image from 'next/image'
import Link from 'next/link'
import {
  ArrowLeft,
  BadgeCheck,
  Banknote,
  Check,
  Copy,
  CreditCard,
  Landmark,
  Loader2,
  Mail,
  MessageCircle,
  Printer,
  QrCode,
  Receipt,
} from 'lucide-react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Alert } from '@/components/ui/feedback'
import { Input } from '@/components/ui/input'
import { Separator } from '@/components/ui/primitives'
import { PaymentStatusBadge } from '@/components/ui/status'
import { EVENTS } from '@/lib/realtime/events'
import { formatMoney } from '@/lib/money'
import { cn } from '@/lib/utils'
import { useOrderRoom, useSocketEvent } from '@/hooks/use-socket'
import { AutoRefresh } from '@/components/auto-refresh'
import type { PaymentConfig } from '../service'
import { declareGuestPayment, emailReceipt, requestPaymentQr } from '../actions'

export interface BillView {
  id: string
  orderNumber: string
  tableNumber: string | null
  customerName: string
  customerEmail: string | null
  placedAt: string
  paymentStatus: 'UNPAID' | 'PARTIAL' | 'PAID' | 'REFUNDED' | 'FAILED'
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
  couponCode: string | null
  items: Array<{
    id: string
    name: string
    optionsLabel: string
    quantity: number
    unitPrice: number
    lineTotal: number
  }>
}

export function GuestBill({
  bill: initial,
  restaurantName,
  restaurantAddress,
  currency,
  locale,
  paymentConfig,
}: {
  bill: BillView
  restaurantName: string
  restaurantAddress: string | null
  currency: string
  locale: string
  paymentConfig: PaymentConfig
}) {
  const [bill, setBill] = React.useState(initial)

  // Re-sync when polling (realtime off / serverless).
  React.useEffect(() => setBill(initial), [initial])
  const [qr, setQr] = React.useState<{ dataUrl: string; amount: number } | null>(null)
  const [loadingQr, setLoadingQr] = React.useState(false)
  const [showBank, setShowBank] = React.useState(false)
  const [copied, setCopied] = React.useState(false)
  const [declared, setDeclared] = React.useState(false)
  const [email, setEmail] = React.useState(initial.customerEmail ?? '')
  const [emailing, setEmailing] = React.useState(false)

  useOrderRoom(bill.id)

  useSocketEvent(EVENTS.PAYMENT_RECEIVED, (payload: { orderId: string; amount: number }) => {
    if (payload.orderId !== bill.id) return
    setBill((current) => ({
      ...current,
      paidTotal: current.paidTotal + payload.amount,
      paymentStatus:
        current.paidTotal + payload.amount >= current.grandTotal ? 'PAID' : 'PARTIAL',
    }))
    setQr(null)
    toast.success('Payment confirmed — thank you!')
  })

  const due = Math.max(0, bill.grandTotal - bill.paidTotal)
  const settled = bill.paymentStatus === 'PAID' || due === 0

  const showQr = async () => {
    setLoadingQr(true)
    const result = await requestPaymentQr({ orderId: bill.id, method: 'QR' })
    setLoadingQr(false)

    if (!result.ok) {
      toast.error(result.error)
      return
    }
    setQr({ dataUrl: result.data.qrDataUrl, amount: result.data.amount })
  }

  const declarePaid = async (reference?: string) => {
    const result = await declareGuestPayment({ orderId: bill.id, reference })
    if (result.ok) {
      setDeclared(true)
      toast.success('Our cashier will confirm shortly')
    } else {
      toast.error(result.error)
    }
  }

  const copyAccount = async () => {
    const acc = paymentConfig.accountNumber ?? ''
    try {
      await navigator.clipboard.writeText(acc)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch {
      toast.error('Could not copy — please note it down')
    }
  }

  // wa.me needs the international number with no "+" or spaces.
  const waNumber = (paymentConfig.receiptWhatsapp ?? '').replace(/[^0-9]/g, '')
  const waHref = `https://wa.me/${waNumber}?text=${encodeURIComponent(
    `Hi, I've paid my bill for order ${bill.orderNumber} (${formatMoney(due, currency, locale)}). Here is my transfer receipt:`,
  )}`

  const sendReceipt = async () => {
    setEmailing(true)
    const result = await emailReceipt({ orderId: bill.id, email })
    setEmailing(false)
    if (result.ok) toast.success(result.data.sent ? 'Receipt sent' : 'Receipt queued')
    else toast.error(result.error)
  }

  return (
    <div className="flex min-h-dvh flex-col pb-8">
      <AutoRefresh intervalMs={7000} />
      <header className="no-print sticky top-0 z-30 flex items-center gap-2 border-b bg-background/90 px-4 py-3 backdrop-blur-xl">
        <Button variant="ghost" size="icon-sm" asChild aria-label="Back">
          <Link href={`/order/track/${bill.id}`}>
            <ArrowLeft />
          </Link>
        </Button>
        <div className="min-w-0 flex-1">
          <h1 className="text-sm font-semibold leading-tight">Your bill</h1>
          <p className="text-xs text-muted-foreground">Order {bill.orderNumber}</p>
        </div>
        <PaymentStatusBadge status={bill.paymentStatus} />
      </header>

      <div className="space-y-5 p-4">
        {settled ? (
          <Alert variant="success" title="Paid in full">
            Thank you! Your bill for {formatMoney(bill.grandTotal, currency, locale)} is settled.
          </Alert>
        ) : null}

        {/* ── the bill itself ───────────────────────────────────── */}
        <section className="print-sheet surface p-5">
          <div className="text-center">
            <h2 className="text-lg font-bold tracking-tight">{restaurantName}</h2>
            {restaurantAddress ? (
              <p className="text-xs text-muted-foreground">{restaurantAddress}</p>
            ) : null}
          </div>

          <Separator className="my-4" />

          <dl className="grid grid-cols-2 gap-y-1 text-xs">
            <dt className="text-muted-foreground">Order</dt>
            <dd className="text-right font-medium">{bill.orderNumber}</dd>
            {bill.tableNumber ? (
              <>
                <dt className="text-muted-foreground">Table</dt>
                <dd className="text-right font-medium">{bill.tableNumber}</dd>
              </>
            ) : null}
            <dt className="text-muted-foreground">Guest</dt>
            <dd className="text-right font-medium">{bill.customerName}</dd>
            <dt className="text-muted-foreground">Date</dt>
            <dd className="text-right font-medium">
              {new Date(bill.placedAt).toLocaleString(locale, {
                dateStyle: 'medium',
                timeStyle: 'short',
              })}
            </dd>
          </dl>

          <Separator className="my-4" />

          <ul className="space-y-2.5">
            {bill.items.map((item) => (
              <li key={item.id} className="flex items-start justify-between gap-3 text-sm">
                <div className="min-w-0">
                  <p className="font-medium">
                    {item.name} <span className="text-muted-foreground">× {item.quantity}</span>
                  </p>
                  {item.optionsLabel ? (
                    <p className="text-xs text-muted-foreground">{item.optionsLabel}</p>
                  ) : null}
                </div>
                <span className="shrink-0 tabular-nums">
                  {formatMoney(item.lineTotal, currency, locale)}
                </span>
              </li>
            ))}
          </ul>

          <Separator className="my-4" />

          <dl className="space-y-1.5 text-sm">
            <BillRow label="Subtotal" value={formatMoney(bill.subtotal, currency, locale)} />
            {bill.discountTotal > 0 ? (
              <BillRow
                label={bill.couponCode ? `Discount (${bill.couponCode})` : 'Discount'}
                value={`− ${formatMoney(bill.discountTotal, currency, locale)}`}
                tone="success"
              />
            ) : null}
            {bill.loyaltyDiscount > 0 ? (
              <BillRow
                label="Loyalty points"
                value={`− ${formatMoney(bill.loyaltyDiscount, currency, locale)}`}
                tone="success"
              />
            ) : null}
            {bill.serviceCharge > 0 ? (
              <BillRow label="Service charge" value={formatMoney(bill.serviceCharge, currency, locale)} />
            ) : null}
            {bill.taxTotal > 0 ? (
              <BillRow label={bill.taxLabel} value={formatMoney(bill.taxTotal, currency, locale)} />
            ) : null}
            {bill.tipAmount > 0 ? (
              <BillRow label="Tip" value={formatMoney(bill.tipAmount, currency, locale)} />
            ) : null}
            {bill.roundingAdj !== 0 ? (
              <BillRow
                label="Rounding"
                value={`${bill.roundingAdj > 0 ? '+' : '−'} ${formatMoney(Math.abs(bill.roundingAdj), currency, locale)}`}
              />
            ) : null}
          </dl>

          <Separator className="my-3" />

          <div className="flex items-center justify-between text-base font-bold">
            <span>Grand total</span>
            <span>{formatMoney(bill.grandTotal, currency, locale)}</span>
          </div>

          {bill.paidTotal > 0 && !settled ? (
            <div className="mt-2 flex items-center justify-between text-sm text-muted-foreground">
              <span>Already paid</span>
              <span>− {formatMoney(bill.paidTotal, currency, locale)}</span>
            </div>
          ) : null}

          {!settled ? (
            <div className="mt-2 flex items-center justify-between text-base font-bold text-primary">
              <span>Amount due</span>
              <span>{formatMoney(due, currency, locale)}</span>
            </div>
          ) : null}

          <p className="mt-5 text-center text-[11px] text-muted-foreground">
            Thank you for dining with us · Powered by TableFlow
          </p>
        </section>

        {/* ── payment ───────────────────────────────────────────── */}
        {!settled ? (
          <section className="no-print surface p-4">
            <h2 className="mb-1 text-sm font-semibold">Pay your bill</h2>
            <p className="mb-4 text-xs text-muted-foreground">
              Pay from your phone, or call a waiter to pay by card or cash at the table.
            </p>

            {showBank ? (
              <div className="space-y-3 rounded-xl border bg-card p-4">
                <div className="flex items-center gap-2 text-sm font-semibold">
                  <Landmark className="size-4 text-primary" /> Transfer to our bank account
                </div>
                <dl className="space-y-2 text-sm">
                  {paymentConfig.bankName ? (
                    <BankRow label="Bank" value={paymentConfig.bankName} />
                  ) : null}
                  {paymentConfig.accountName ? (
                    <BankRow label="Account name" value={paymentConfig.accountName} />
                  ) : null}
                  {paymentConfig.accountNumber ? (
                    <div className="flex items-center justify-between gap-2">
                      <dt className="text-muted-foreground">Account no.</dt>
                      <dd className="flex items-center gap-2">
                        <span className="font-semibold tabular-nums tracking-wide">
                          {paymentConfig.accountNumber}
                        </span>
                        <button
                          type="button"
                          onClick={copyAccount}
                          className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                          aria-label="Copy account number"
                        >
                          {copied ? (
                            <Check className="size-4 text-success" />
                          ) : (
                            <Copy className="size-4" />
                          )}
                        </button>
                      </dd>
                    </div>
                  ) : null}
                  {paymentConfig.bankBranch ? (
                    <BankRow label="Branch" value={paymentConfig.bankBranch} />
                  ) : null}
                  <div className="flex items-center justify-between border-t pt-2 text-base font-bold text-primary">
                    <dt>Amount to transfer</dt>
                    <dd>{formatMoney(due, currency, locale)}</dd>
                  </div>
                </dl>

                {paymentConfig.receiptWhatsapp ? (
                  <Button className="w-full" asChild>
                    <a href={waHref} target="_blank" rel="noopener noreferrer">
                      <MessageCircle /> Send your receipt on WhatsApp
                    </a>
                  </Button>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    After transferring, show your receipt to our staff.
                  </p>
                )}

                {declared ? (
                  <Badge variant="success" className="w-full justify-center py-2">
                    <BadgeCheck /> Thanks! We&rsquo;ll confirm once your transfer arrives
                  </Badge>
                ) : (
                  <Button
                    variant="outline"
                    className="w-full"
                    onClick={() => declarePaid('Online bank transfer')}
                  >
                    I have completed the transfer
                  </Button>
                )}

                <Button variant="ghost" size="sm" className="w-full" onClick={() => setShowBank(false)}>
                  Choose another method
                </Button>
              </div>
            ) : qr ? (
              <div className="flex flex-col items-center gap-3 rounded-xl border bg-card p-5">
                <Image
                  src={qr.dataUrl}
                  alt="Payment QR code"
                  width={220}
                  height={220}
                  className="rounded-lg"
                  unoptimized
                />
                <p className="text-center text-sm">
                  Scan with any payment app to pay{' '}
                  <strong>{formatMoney(qr.amount, currency, locale)}</strong>
                </p>

                {declared ? (
                  <Badge variant="success">
                    <BadgeCheck /> Waiting for our cashier to confirm
                  </Badge>
                ) : (
                  <Button variant="outline" className="w-full" onClick={() => declarePaid()}>
                    I have completed the payment
                  </Button>
                )}

                <Button variant="ghost" size="sm" onClick={() => setQr(null)}>
                  Hide QR code
                </Button>
              </div>
            ) : (
              <div className="grid gap-2">
                {paymentConfig.qr !== false ? (
                  <PaymentOption
                    icon={QrCode}
                    label="Scan & pay"
                    hint="UPI, wallets and banking apps"
                    onClick={showQr}
                    loading={loadingQr}
                  />
                ) : null}
                {paymentConfig.bankTransfer && paymentConfig.accountNumber ? (
                  <PaymentOption
                    icon={Landmark}
                    label="Online / bank transfer"
                    hint="Transfer to our account & send the receipt"
                    onClick={() => setShowBank(true)}
                  />
                ) : null}
                {paymentConfig.card !== false ? (
                  <PaymentOption
                    icon={CreditCard}
                    label="Card at the table"
                    hint="Our waiter will bring the terminal"
                    onClick={() => declarePaid()}
                  />
                ) : null}
                {paymentConfig.cash !== false ? (
                  <PaymentOption
                    icon={Banknote}
                    label="Cash"
                    hint="Pay our cashier directly"
                    onClick={() => declarePaid()}
                  />
                ) : null}
              </div>
            )}
          </section>
        ) : null}

        {/* ── receipt ───────────────────────────────────────────── */}
        <section className="no-print surface space-y-3 p-4">
          <h2 className="text-sm font-semibold">Receipt</h2>

          <div className="flex gap-2">
            <Input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="you@example.com"
              startIcon={<Mail />}
              aria-label="Email for receipt"
            />
            <Button variant="outline" onClick={sendReceipt} loading={emailing} disabled={!email}>
              Send
            </Button>
          </div>

          <Button variant="outline" className="w-full" onClick={() => window.print()}>
            <Printer /> Print or save as PDF
          </Button>

          <Button variant="ghost" className="w-full" asChild>
            <Link href="/order/menu">
              <Receipt /> Back to the menu
            </Link>
          </Button>
        </section>
      </div>
    </div>
  )
}

function PaymentOption({
  icon: Icon,
  label,
  hint,
  onClick,
  loading,
}: {
  icon: React.ElementType
  label: string
  hint: string
  onClick: () => void
  loading?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={loading}
      className={cn(
        'flex items-center gap-3 rounded-xl border p-3.5 text-left transition-colors',
        'hover:border-primary hover:bg-primary/5 disabled:opacity-60',
      )}
    >
      <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
        {loading ? <Loader2 className="size-5 animate-spin" /> : <Icon className="size-5" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold">{label}</span>
        <span className="block text-xs text-muted-foreground">{hint}</span>
      </span>
    </button>
  )
}

function BankRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  )
}

function BillRow({
  label,
  value,
  tone,
}: {
  label: string
  value: string
  tone?: 'success'
}) {
  return (
    <div className="flex items-center justify-between">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn('tabular-nums', tone === 'success' && 'font-medium text-success')}>{value}</dd>
    </div>
  )
}
