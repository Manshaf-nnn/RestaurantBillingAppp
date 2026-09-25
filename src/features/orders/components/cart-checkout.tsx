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
import { addGuestOrderItems, placeGuestOrder, quoteCart } from '../actions'
import { lineTotal, useCart } from '../cart-store'
import { pointsEarned, type OrderTotals } from '../pricing'
import { callAction } from '@/lib/use-action'
import { listGuestLocations, lookupGuestIdentity } from '@/features/qr/guest-actions'
import type { GuestLocation } from '@/features/qr/locations'

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
  /** Where this cart's own links go — `/order/<slug>/<branch>` or `/m/<code>`. */
  basePath: string
  /**
   * The printed QR code this basket was built under (ar.md §11, §15, §24).
   *
   * Carried so the order records where it came from, and so a coupon scoped to
   * one QR menu can be told apart from the same code typed at the till.
   */
  qrCode?: string | null
  /**
   * False for a code with no table behind it — a delivery leaflet, a takeaway
   * counter (ar.md §3). The guest was never asked to seat themselves, so this
   * screen must not send them back to a question that is not there. The order
   * becomes a TAKEAWAY and the branch comes from the code.
   */
  requiresTable?: boolean
  /**
   * What this screen shows and says (ar.md §13), from Settings → Guest
   * experience. Every default reproduces exactly what it showed before.
   */
  showCoupon?: boolean
  showName?: boolean
  showPhone?: boolean
  showNote?: boolean
  showPointsEarned?: boolean
  detailsHeading?: string
  phoneHint?: string
  /** The branch that code belongs to, since no table can settle it. */
  branchCode?: string | null
}

export function CartCheckout({
  currency,
  locale,
  taxLabel,
  restaurantName,
  loyaltyEnabled,
  loyaltyEarnRateX100,
  slug,
  basePath,
  qrCode = null,
  requiresTable = true,
  branchCode = null,
  showCoupon = true,
  showName = true,
  showPhone = true,
  showNote = true,
  showPointsEarned = true,
  detailsHeading = 'Your details',
  phoneHint = 'Add it to collect loyalty points on this order',
}: Props) {
  const router = useRouter()
  const { state, hydrated, itemCount, subtotal, setQuantity, removeLine, setCoupon, setCustomer, clearLines, stopAdding } =
    useCart()
  /*
   * "Add to order" mode (aO.md §3): the basket is new dishes joining the
   * order the guest already has. No name, no coupon, no new order — the
   * lines are sent through `addGuestOrderItems` and the guest goes back to
   * their tracker.
   */
  const adding = state.addingTo

  const [totals, setTotals] = React.useState<OrderTotals | null>(null)
  const [couponInput, setCouponInput] = React.useState(state.couponCode)
  const [couponError, setCouponError] = React.useState<string | null>(null)
  const [eta, setEta] = React.useState<number | null>(null)
  const [orderNotes, setOrderNotes] = React.useState('')

  /* ── Where it is going, and who is ordering ─────────────────────────────── */

  const [locations, setLocations] = React.useState<GuestLocation[]>([])
  const [locationRequired, setLocationRequired] = React.useState(false)
  const [locationId, setLocationId] = React.useState('')

  /*
   * The owner's list for THIS code and THIS guest's category.
   *
   * Fetched rather than rendered into the page because the category is chosen
   * on the way in, after this page's props were decided. An empty list is the
   * ordinary answer for a table code and costs one request.
   */
  React.useEffect(() => {
    if (!qrCode) return
    let live = true
    void callAction(() =>
      listGuestLocations({ code: qrCode, categoryId: state.customer.categoryId || '' }, slug),
    ).then((result) => {
      if (!live || !result.ok) return
      setLocations(result.data.locations)
      setLocationRequired(result.data.required)
    })
    return () => {
      live = false
    }
  }, [qrCode, state.customer.categoryId, slug])

  /*
   * A returning guest types their number and gets their own name back.
   *
   * Debounced, and only fills a name box the guest has left EMPTY — somebody
   * halfway through typing "Jon" must not have it replaced by "Jonathan" under
   * their cursor. The same courtesy the till already extends at
   * `cashier-board.tsx`, and the same shape: look up, never overwrite.
   */
  const knownPhone = React.useRef('')
  /*
   * The name as it stands right now, without making it a dependency.
   *
   * The check has to happen when the ANSWER arrives, not when the request was
   * sent — a guest types their number, then starts typing their name, and the
   * reply must not land on top of what they are in the middle of writing. A
   * ref reads the latest value without re-running the effect on every
   * keystroke in the name box, which would cancel the lookup each time.
   */
  const nameRef = React.useRef(state.customer.name)
  nameRef.current = state.customer.name

  React.useEffect(() => {
    const phone = state.customer.phone.trim()
    if (!qrCode || phone.length < 7 || phone === knownPhone.current) return
    let live = true
    const timer = setTimeout(() => {
      void callAction(() => lookupGuestIdentity({ code: qrCode, phone }, slug)).then((result) => {
        if (!live || !result.ok || !result.data.found) return
        const name = result.data.name
        knownPhone.current = phone
        // Never over-write what the guest has already written.
        if (name && !nameRef.current.trim()) setCustomer({ name })
      })
    }, 400)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [state.customer.phone, qrCode, slug, setCustomer])
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
    if (requiresTable && hydrated && !state.table) router.replace(basePath)
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
              qrCode: qrCode || undefined,
            },
            slug,
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
    // A code with no table was never going to have one; only send the guest
    // back when the question actually exists on the screen behind them.
    if (!table && requiresTable) {
      router.replace(basePath)
      return
    }

    setPlacing(true)
    if (adding) {
      const addition = await callAction(() =>
        addGuestOrderItems({
          orderId: adding.orderId,
          items: state.lines.map((line) => ({
            foodId: line.foodId,
            quantity: line.quantity,
            optionIds: line.options.map((option) => option.optionId),
            notes: line.notes || '',
          })),
        }, slug),
      )
      setPlacing(false)
      if (!addition.ok) {
        setFormError(addition.error)
        return
      }
      clearLines()
      stopAdding()
      toast.success(`Added to order ${addition.data.orderNumber}`)
      router.push(`/order/track/${addition.data.orderId}`)
      return
    }
    const result = await callAction(() => placeGuestOrder({
      idempotencyKey: idempotencyKey.current,
      tableId: table?.tableId ?? '',
      // The branch the guest actually scanned, so the order cannot be filed
      // against the default one by a lost cookie.
      // The table settles the branch when there is one; the code does otherwise.
      branchCode: table?.branchCode ?? branchCode ?? '',
      customerName: state.customer.name,
      customerPhone: state.customer.phone,
      customerEmail: state.customer.email || '',
      // Which printed code this basket was built under (ar.md §15, §24).
      qrCode: qrCode || '',
      notes: orderNotes,
      deliveryLocationId: locationId,
      couponCode: state.couponCode || '',
      redeemPoints: 0,
      items: state.lines.map((line) => ({
        foodId: line.foodId,
        quantity: line.quantity,
        optionIds: line.options.map((option) => option.optionId),
        notes: line.notes || '',
      })),
    }, slug))
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
        <Header title="Your order" menuHref={`${basePath}/menu`} />
        <div className="flex flex-1 items-center p-6">
          <EmptyState
            className="w-full border-none"
            icon={<ShoppingBag />}
            title="Your cart is empty"
            description="Add something from the menu and it will show up here."
            action={
              <Button asChild size="lg">
                <Link href={`${basePath}/menu`}>
                  <UtensilsCrossed /> Browse the menu
                </Link>
              </Button>
            }
          />
        </div>
      </div>
    )
  }

  /*
   * Nothing about the guest's identity gates the order any more. A phone
   * number is how loyalty finds them, not a condition of being fed — the field
   * stays, labelled for what it earns them, and blank is fine.
   */
  const canSubmit = !placing

  return (
    <div className="flex min-h-dvh flex-col pb-40">
      <Header
        menuHref={`${basePath}/menu`}
        title={adding ? 'Add to your order' : 'Your order'}
        subtitle={
          adding
            ? `Adding to order ${adding.orderNumber}${state.table ? ` · Table ${state.table.tableNumber}` : ''}`
            : state.table
              ? `Table ${state.table.tableNumber}`
              : undefined
        }
      />

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
            href={`${basePath}/menu`}
            className="flex items-center justify-center gap-2 p-3 text-sm font-medium text-primary transition-colors hover:bg-primary/5"
          >
            <Plus className="size-4" /> Add more items
          </Link>
        </section>

        {/* ── coupon (a new order only) ─────────────────────────── */}
        {adding || !showCoupon ? null : (
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
        )}

        {/* ── guest details (a new order only) ───────────────────── */}
        {adding || (!showName && !showPhone && !showNote) ? null : (
        <section className="surface space-y-4 p-4">
          <h2 className="text-sm font-semibold">{detailsHeading}</h2>

          {/*
            Where it goes, first — before who is ordering.
            
            A delivery guest's first question about their own order is whether
            this place can even reach them, and an empty list answers it before
            they type a name. Grouped when the owner grouped them, because
            forty flat buttons is not a picker.
          */}
          {locations.length > 0 ? (
            <Field
              label={locationRequired ? 'Deliver to' : 'Deliver to (optional)'}
              htmlFor="deliveryLocation"
              error={fieldErrors.deliveryLocationId}
              hint="Choose the closest place to you."
            >
              <select
                id="deliveryLocation"
                className="h-10 w-full rounded-lg border border-border bg-background px-3 text-sm"
                value={locationId}
                onChange={(event) => setLocationId(event.target.value)}
              >
                <option value="">Select a place…</option>
                {groupLocations(locations).map((group) =>
                  group.name ? (
                    <optgroup key={group.name} label={group.name}>
                      {group.items.map((place) => (
                        <option key={place.id} value={place.id}>
                          {place.name}
                        </option>
                      ))}
                    </optgroup>
                  ) : (
                    group.items.map((place) => (
                      <option key={place.id} value={place.id}>
                        {place.name}
                      </option>
                    ))
                  ),
                )}
              </select>
            </Field>
          ) : null}

          {showName ? (
          <Field label="Name (optional)" htmlFor="customerName" error={fieldErrors.customerName}>
            <Input
              id="customerName"
              value={state.customer.name}
              onChange={(event) => setCustomer({ name: event.target.value })}
              placeholder="Your name"
              autoComplete="name"
            />
          </Field>
          ) : null}

          {showPhone ? (
          <Field
            label="Mobile number (optional)"
            htmlFor="customerPhone"
            hint={phoneHint}
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
          ) : null}

          {showNote ? (
          <Field label="Note for the kitchen" htmlFor="orderNotes">
            <Textarea
              id="orderNotes"
              value={orderNotes}
              onChange={(event) => setOrderNotes(event.target.value.slice(0, 300))}
              placeholder="Anything else we should know?"
              rows={2}
            />
          </Field>
          ) : null}
        </section>
        )}

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
            <span>{adding ? 'Added to your bill' : 'To pay'}</span>
            <span>{formatMoney(totals?.grandTotal ?? subtotal, currency, locale)}</span>
          </div>

          {showPointsEarned && loyaltyEnabled && loyaltyEarnRateX100 > 0
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
          {adding
            ? `These items join order ${adding.orderNumber} at table ${state.table?.tableNumber ?? ''} and are paid with it.`
            : `By placing this order you agree that ${restaurantName} will prepare it for table ${state.table?.tableNumber ?? ''}. Payment is collected at the table.`}
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
            : adding
              ? `Add to order ${adding.orderNumber} · ${formatMoney(totals?.grandTotal ?? subtotal, currency, locale)}`
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

/**
 * `menuHref` used to be the literal `/order/menu`, which is the legacy
 * redirect page: going back from the cart dropped the branch and bounced the
 * guest through the "which location are you at?" chooser. It takes the caller's
 * own base path now, so back goes back.
 */
function Header({ title, subtitle, menuHref }: { title: string; subtitle?: string; menuHref: string }) {
  return (
    <header className="sticky top-0 z-30 flex items-center gap-2 border-b bg-background/90 px-4 py-3 backdrop-blur-xl">
      <Button variant="ghost" size="icon-sm" asChild aria-label="Back to menu">
        <Link href={menuHref}>
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

/**
 * The owner's locations, under their headings.
 *
 * A campus list is naturally two or three groups — Hostels, Staff Quarters,
 * Academic — and forty flat options in a `<select>` is a scroll nobody reads.
 * Ungrouped entries keep their place in the owner's own order rather than
 * being swept into an "Other" bucket at the bottom, because the owner sorted
 * them deliberately and a picker that reorders their list is lying about it.
 */
function groupLocations(
  locations: GuestLocation[],
): Array<{ name: string | null; items: GuestLocation[] }> {
  const out: Array<{ name: string | null; items: GuestLocation[] }> = []
  for (const place of locations) {
    const name = place.groupName?.trim() || null
    const last = out[out.length - 1]
    if (last && last.name === name) last.items.push(place)
    else out.push({ name, items: [place] })
  }
  return out
}
