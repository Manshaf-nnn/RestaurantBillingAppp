'use client'

import * as React from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  ArrowLeft,
  Minus,
  Plus,
  ShoppingBag,
  Sparkles,
  Tag,
  Ticket,
  Trash2,
  UtensilsCrossed,
} from 'lucide-react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Alert, EmptyState } from '@/components/ui/feedback'
import { Field } from '@/components/ui/label'
import { Input, Textarea } from '@/components/ui/input'
import { Separator } from '@/components/ui/primitives'
import { VegIndicator } from '@/components/ui/status'
import { formatMoney } from '@/lib/money'
import { placeGuestOrder, quoteCart } from '../actions'
import { lineTotal, useCart } from '../cart-store'
import { pointsEarned, type OrderTotals } from '../pricing'
import { callAction } from '@/lib/use-action'
import { guestPath } from '@/features/orders/guest-path'

interface Props {
  currency: string
  locale: string
  taxLabel: string
  restaurantName: string
  loyaltyEnabled: boolean
  loyaltyEarnRateX100: number
  /**
   * Where this guest is, carried in the URL of every screen.
   *
   * The cart page took no params at all before, so the quote came back at the
   * restaurant's BASE prices while the menu the guest had just browsed used the
   * branch's — and a dish the branch does not sell was refused only at the
   * final tap.
   */
  slug: string
  branchCode: string
}

export function CartCheckout({
  currency,
  locale,
  taxLabel,
  restaurantName,
  loyaltyEnabled,
  loyaltyEarnRateX100,
  slug,
  branchCode,
}: Props) {
  const router = useRouter()
  const { state, hydrated, itemCount, subtotal, setQuantity, removeLine, setCoupon, setCustomer, clearLines } =
    useCart()

  const [totals, setTotals] = React.useState<OrderTotals | null>(null)
  const [couponInput, setCouponInput] = React.useState(state.couponCode)
  const [couponError, setCouponError] = React.useState<string | null>(null)
  const [eta, setEta] = React.useState<number | null>(null)
  const [orderNotes, setOrderNotes] = React.useState('')
  const [formError, setFormError] = React.useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>({})
  const [placing, setPlacing] = React.useState(false)

  /*
   * One id for this cart, regenerated only once an order actually succeeds.
   *
   * A ref rather than state so a re-render cannot change it mid-submit — the
   * whole value is that a retry carries the SAME key. That is what lets the
   * server return the order the guest already has instead of creating a second
   * one and deducting another set of ingredients.
   */
  const idempotencyKey = React.useRef(
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`,
  )
  const [quoting, startQuote] = React.useTransition()

  React.useEffect(() => {
    if (hydrated && !state.table) router.replace(guestPath(slug, branchCode))
  }, [hydrated, state.table, router])

  // Re-quote whenever the basket or coupon changes — totals always come from
  // the server so tax, service charge and offers cannot drift.
  const requote = React.useCallback(
    (code: string) => {
      if (!state.lines.length) {
        setTotals(null)
        return
      }
      startQuote(async () => {
        const result = await callAction(() =>
          quoteCart(
            {
              items: state.lines.map((line) => ({
                foodId: line.foodId,
                quantity: line.quantity,
                optionIds: line.options.map((option) => option.optionId),
              })),
              couponCode: code || undefined,
              phone: state.customer.phone || undefined,
            },
            undefined,
            /*
             * The branch the guest scanned. It was already being passed to
             * `placeGuestOrder` twelve lines below and dropped here, so the
             * summary priced at the restaurant's base prices while the menu
             * they had just browsed priced at the branch's.
             */
            state.table?.branchCode ?? null,
          ),
        )

        if (result.ok) {
          setTotals(result.data.totals)
          setEta(result.data.estimatedMinutes)
          setCouponError(result.data.couponError)
        } else {
          setFormError(result.error)
        }
      })
    },
    [state.lines, state.customer.phone],
  )

  React.useEffect(() => {
    if (hydrated) requote(state.couponCode)
  }, [hydrated, requote, state.couponCode])

  const applyCoupon = () => {
    const code = couponInput.trim().toUpperCase()
    setCoupon(code)
    setCouponError(null)
  }

  const placeOrder = async () => {
    setFormError(null)
    setFieldErrors({})

    // Captured rather than read inside the closure below: narrowing does not
    // survive into a callback, since `state` could change before it runs.
    const table = state.table
    if (!table) {
      router.replace(guestPath(slug, branchCode))
      return
    }

    setPlacing(true)
    const result = await callAction(() => placeGuestOrder({
      idempotencyKey: idempotencyKey.current,
      tableId: table.tableId,
      // The branch the guest actually scanned, so the order cannot be filed
      // against the default one by a lost cookie.
      branchCode: table.branchCode ?? '',
      customerName: state.customer.name,
      customerPhone: state.customer.phone,
      customerEmail: state.customer.email || '',
      notes: orderNotes,
      couponCode: state.couponCode || '',
      redeemPoints: 0,
      items: state.lines.map((line) => ({
        foodId: line.foodId,
        quantity: line.quantity,
        optionIds: line.options.map((option) => option.optionId),
        notes: line.notes || '',
      })),
    }))
    setPlacing(false)

    if (!result.ok) {
      setFormError(result.error)
      if (result.fieldErrors) {
        setFieldErrors(
          Object.fromEntries(
            Object.entries(result.fieldErrors).map(([key, messages]) => [key, messages[0]]),
          ),
        )
      }
      return
    }

    try {
      window.localStorage.setItem(
        'ros:last-order',
        JSON.stringify({ orderId: result.data.orderId, orderNumber: result.data.orderNumber }),
      )
    } catch {
      // unavailable storage should not block the checkout flow
    }

    clearLines()
    toast.success(`Order ${result.data.orderNumber} sent to the kitchen`)
    router.push(`/order/track/${result.data.orderId}`)
  }

  if (!hydrated) {
    return <div className="p-6 text-sm text-muted-foreground">Loading your cart…</div>
  }

  if (itemCount === 0) {
    return (
      <div className="flex min-h-dvh flex-col">
        <Header title="Your order" />
        <div className="flex flex-1 items-center p-6">
          <EmptyState
            className="w-full border-none"
            icon={<ShoppingBag />}
            title="Your cart is empty"
            description="Add something from the menu and it will show up here."
            action={
              <Button asChild size="lg">
                <Link href="/order/menu">
                  <UtensilsCrossed /> Browse the menu
                </Link>
              </Button>
            }
          />
        </div>
      </div>
    )
  }

  const canSubmit =
    state.customer.name.trim().length >= 2 && state.customer.phone.trim().length >= 7 && !placing

  return (
    <div className="flex min-h-dvh flex-col pb-40">
      <Header title="Your order" subtitle={state.table ? `Table ${state.table.tableNumber}` : undefined} />

      <div className="space-y-5 p-4">
        {/* ── items ─────────────────────────────────────────────── */}
        <section className="surface divide-y overflow-hidden">
          {state.lines.map((line) => (
            <div key={line.key} className="flex gap-3 p-3">
              <div className="relative size-16 shrink-0 overflow-hidden rounded-lg bg-muted">
                {line.imageUrl ? (
                  <Image src={line.imageUrl} alt={line.name} fill sizes="64px" className="object-cover" />
                ) : (
                  <span className="flex size-full items-center justify-center text-xl">🍽️</span>
                )}
              </div>

              <div className="min-w-0 flex-1">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="flex items-center gap-1.5 text-sm font-semibold">
                      <VegIndicator isVeg={line.isVeg} />
                      <span className="truncate">{line.name}</span>
                    </p>
                    {line.options.length ? (
                      <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                        {line.options.map((option) => option.name).join(' · ')}
                      </p>
                    ) : null}
                    {line.notes ? (
                      <p className="mt-1 text-xs italic text-primary">“{line.notes}”</p>
                    ) : null}
                  </div>

                  <button
                    type="button"
                    onClick={() => removeLine(line.key)}
                    className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                    aria-label={`Remove ${line.name}`}
                  >
                    <Trash2 className="size-4" />
                  </button>
                </div>

                <div className="mt-2 flex items-center justify-between">
                  <div className="flex items-center gap-1 rounded-lg border p-0.5">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="size-7"
                      onClick={() => setQuantity(line.key, line.quantity - 1)}
                      aria-label="Decrease"
                    >
                      <Minus className="size-3.5" />
                    </Button>
                    <span className="w-6 text-center text-sm font-semibold tabular-nums">
                      {line.quantity}
                    </span>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="size-7"
                      onClick={() => setQuantity(line.key, line.quantity + 1)}
                      aria-label="Increase"
                    >
                      <Plus className="size-3.5" />
                    </Button>
                  </div>

                  <span className="text-sm font-bold">
                    {formatMoney(lineTotal(line), currency, locale)}
                  </span>
                </div>
              </div>
            </div>
          ))}

          <Link
            href="/order/menu"
            className="flex items-center justify-center gap-2 p-3 text-sm font-medium text-primary transition-colors hover:bg-primary/5"
          >
            <Plus className="size-4" /> Add more items
          </Link>
        </section>

        {/* ── coupon ────────────────────────────────────────────── */}
        <section className="surface p-4">
          <div className="mb-2 flex items-center gap-2">
            <Ticket className="size-4 text-primary" />
            <h2 className="text-sm font-semibold">Have a coupon?</h2>
          </div>
          <div className="flex gap-2">
            <Input
              value={couponInput}
              onChange={(event) => setCouponInput(event.target.value.toUpperCase())}
              placeholder="WELCOME10"
              className="uppercase"
              aria-label="Coupon code"
            />
            <Button variant="outline" onClick={applyCoupon} loading={quoting}>
              Apply
            </Button>
          </div>
          {couponError ? (
            <p className="mt-2 text-xs font-medium text-destructive">{couponError}</p>
          ) : state.couponCode && totals && totals.discountTotal > 0 ? (
            <p className="mt-2 flex items-center gap-1.5 text-xs font-medium text-success">
              <Tag className="size-3.5" /> {state.couponCode} applied — you saved{' '}
              {formatMoney(totals.discountTotal, currency, locale)}
            </p>
          ) : null}
        </section>

        {/* ── guest details ─────────────────────────────────────── */}
        <section className="surface space-y-4 p-4">
          <h2 className="text-sm font-semibold">Your details</h2>

          <Field label="Name" htmlFor="customerName" required error={fieldErrors.customerName}>
            <Input
              id="customerName"
              value={state.customer.name}
              onChange={(event) => setCustomer({ name: event.target.value })}
              placeholder="Your name"
              autoComplete="name"
            />
          </Field>

          <Field
            label="Mobile number"
            htmlFor="customerPhone"
            required
            hint="So we can reach you about this order"
            error={fieldErrors.customerPhone}
          >
            <Input
              id="customerPhone"
              type="tel"
              inputMode="tel"
              value={state.customer.phone}
              onChange={(event) => setCustomer({ phone: event.target.value })}
              placeholder="+91 98765 43210"
              autoComplete="tel"
            />
          </Field>

          <Field label="Note for the kitchen" htmlFor="orderNotes">
            <Textarea
              id="orderNotes"
              value={orderNotes}
              onChange={(event) => setOrderNotes(event.target.value.slice(0, 300))}
              placeholder="Anything else we should know?"
              rows={2}
            />
          </Field>
        </section>

        {/* ── bill ──────────────────────────────────────────────── */}
        <section className="surface space-y-2 p-4 text-sm">
          <h2 className="mb-3 text-sm font-semibold">Bill summary</h2>

          <Row label="Item total" value={formatMoney(totals?.subtotal ?? subtotal, currency, locale)} />

          {totals && totals.discountTotal > 0 ? (
            <Row
              label="Coupon discount"
              value={`− ${formatMoney(totals.discountTotal, currency, locale)}`}
              tone="success"
            />
          ) : null}

          {totals && totals.serviceCharge > 0 ? (
            <Row label="Service charge" value={formatMoney(totals.serviceCharge, currency, locale)} />
          ) : null}

          {totals && totals.taxTotal > 0 ? (
            <Row label={taxLabel} value={formatMoney(totals.taxTotal, currency, locale)} />
          ) : null}

          {totals && totals.roundingAdj !== 0 ? (
            <Row
              label="Rounding"
              value={`${totals.roundingAdj > 0 ? '+' : '−'} ${formatMoney(Math.abs(totals.roundingAdj), currency, locale)}`}
            />
          ) : null}

          <Separator className="my-2" />

          <div className="flex items-center justify-between text-base font-bold">
            <span>To pay</span>
            <span>{formatMoney(totals?.grandTotal ?? subtotal, currency, locale)}</span>
          </div>

          {loyaltyEnabled && loyaltyEarnRateX100 > 0
            ? (() => {
                const earned = pointsEarned(totals?.grandTotal ?? subtotal, loyaltyEarnRateX100)
                return earned > 0 ? (
                  <div className="mt-2 flex items-center gap-1.5 rounded-lg bg-primary/5 px-3 py-2 text-xs font-medium text-primary">
                    <Sparkles className="size-3.5 shrink-0" />
                    You&rsquo;ll earn {earned.toLocaleString()} point{earned === 1 ? '' : 's'} on this order
                  </div>
                ) : null
              })()
            : null}

          {eta ? (
            <p className="pt-1 text-xs text-muted-foreground">
              Estimated preparation time · about {eta} minutes
            </p>
          ) : null}
        </section>

        {formError ? <Alert variant="destructive">{formError}</Alert> : null}

        <p className="px-1 text-center text-xs text-muted-foreground">
          By placing this order you agree that {restaurantName} will prepare it for table{' '}
          {state.table?.tableNumber}. Payment is collected at the table.
        </p>
      </div>

      <div className="fixed inset-x-0 bottom-0 z-40 mx-auto max-w-lg border-t bg-background/95 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] backdrop-blur">
        <Button
          size="xl"
          className="w-full"
          onClick={placeOrder}
          disabled={!canSubmit}
          loading={placing}
        >
          {placing
            ? 'Sending to the kitchen…'
            : `Place order · ${formatMoney(totals?.grandTotal ?? subtotal, currency, locale)}`}
        </Button>
        {!canSubmit && !placing ? (
          <p className="mt-2 text-center text-xs text-muted-foreground">
            Add your name and mobile number to continue
          </p>
        ) : null}
      </div>
    </div>
  )
}

function Header({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <header className="sticky top-0 z-30 flex items-center gap-2 border-b bg-background/90 px-4 py-3 backdrop-blur-xl">
      <Button variant="ghost" size="icon-sm" asChild aria-label="Back to menu">
        <Link href="/order/menu">
          <ArrowLeft />
        </Link>
      </Button>
      <div>
        <h1 className="text-sm font-semibold leading-tight">{title}</h1>
        {subtitle ? <p className="text-xs text-muted-foreground">{subtitle}</p> : null}
      </div>
      {subtitle ? (
        <Badge variant="secondary" className="ml-auto">
          {subtitle}
        </Badge>
      ) : null}
    </header>
  )
}

function Row({
  label,
  value,
  tone,
}: {
  label: string
  value: string
  tone?: 'success' | 'default'
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className={tone === 'success' ? 'font-medium text-success' : 'font-medium'}>{value}</span>
    </div>
  )
}
