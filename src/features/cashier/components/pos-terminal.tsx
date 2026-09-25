'use client'

import * as React from 'react'
import { Check, Minus, Plus, Printer, ShoppingCart, Trash2, UserPlus, X } from 'lucide-react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { formatMoney, minorUnitFactor } from '@/lib/money'
import { newRequestKey } from '@/lib/request-key'
import { createStaffOrder, type StaffOrderBill } from '@/features/orders/actions'
import type { PublicMenu, PublicMenuItem } from '@/features/menu/queries'
import { callAction } from '@/lib/use-action'
import { findCustomerAction } from '@/features/customers/actions'
import { CustomerFormDialog } from '@/features/customers/components/customer-form-dialog'
import { GuestPanel } from '@/features/customers/components/guest-panel'
import { printReceipt } from '@/features/printing/print'
import { CustomerPhoneField } from '@/features/customers/components/customer-phone-field'
import { buildReceipt, type ReceiptRestaurant } from '@/features/printing/receipt'

import {
  MenuPicker,
  OrderTypeChips,
  StepButton,
  type OrderType,
} from './menu-picker'
import { splitLine } from '@/features/orders/split-line'
import { OptionDialog } from './option-dialog'

/**
 * The till — one screen for every kind of order.
 *
 * Built for speed with one thumb on a busy counter: the menu is a grid of
 * photographs, and tapping a photo adds one of that item. Quantity is adjusted
 * with − and + on the order panel rather than by typing a number, because a
 * cashier with a queue in front of them should never have to aim at a text
 * field.
 *
 * ── Send to kitchen AND bill ────────────────────────────────────────────────
 *
 * The button used to say "Send to kitchen", and that was all it did: a toast,
 * and the cart emptied. The cashier had a hungry kitchen and no bill, and no
 * way to reach one — this route carries no sidebar, so the only way onward was
 * the URL bar.
 *
 * It now finishes the job. The order goes to the kitchen exactly as before, and
 * the panel turns into the bill, with a printer icon. Nothing prints by itself:
 * a mis-keyed order should not cost a strip of paper, and the cashier can hand
 * the guest the screen instead.
 *
 * The totals on it come from the SERVER. The subtotal below is
 * `price × quantity` and nothing more — no tax, no service charge, no discount
 * — which is fine as a running count while you ring up, and would be a lie on a
 * bill. `createStaffOrder` returns what it actually wrote to the order.
 */

interface Line {
  /** food id + chosen options: Normal and Full are two lines, not one. */
  key: string
  item: PublicMenuItem
  quantity: number
  options: Array<{ id: string; name: string; groupName: string; priceDelta: number }>
  notes: string
  /** Money off this line, minor units, for the whole line (pro.A.md §10). */
  discount: number
  discountReason: string
}

/**
 * The same collapse rule the guest cart uses (`cart-store.tsx`): identical dish
 * AND identical choices merge; anything else stays its own line. Sorted,
 * because the order a cashier ticks two add-ons in does not make a new line.
 */
function lineKey(foodId: string, optionIds: string[], notes: string): string {
  return `${foodId}::${[...optionIds].sort().join(',')}::${notes.trim().toLowerCase()}`
}

export function PosTerminal({
  menu,
  currency,
  restaurant,
  initialType = 'COUNTER',
  branchId = null,
  tables = [],
  servers = [],
  currentUserId,
  customerCategories = [],
  loyalty,
}: {
  menu: PublicMenu
  currency: string
  /** Everything a printed bill needs in its header. */
  restaurant: ReceiptRestaurant
  initialType?: OrderType
  /** The counter this till is standing at — sent with the order. */
  branchId?: string | null
  /** Free tables, so a counter order can be seated. */
  tables?: Array<{ id: string; number: string; area: string | null; status: string }>
  /** The owner's customer categories, for the Add customer form (§1). */
  customerCategories?: Array<{ id: string; name: string }>
  /** Who can be credited with serving it. */
  servers?: Array<{ id: string; name: string; role: string }>
  currentUserId?: string
  /** The programme's own settings, so points can be spent here (pro.A.md §10). */
  loyalty?: { enabled: boolean; pointValue: number }
}) {
  const [type, setType] = React.useState<OrderType>(initialType)
  const [lines, setLines] = React.useState<Line[]>([])
  const [name, setName] = React.useState('')
  const [phone, setPhone] = React.useState('')
  const [notes, setNotes] = React.useState('')
  /** The offer the cashier tapped, by code — re-checked at placement. */
  const [couponCode, setCouponCode] = React.useState('')
  /** What that offer is worth on this basket, lifted out of `GuestPanel`. */
  const [couponAmount, setCouponAmount] = React.useState(0)
  /** Points the guest chose to spend. `placeOrder` clamps it again. */
  const [redeemPoints, setRedeemPoints] = React.useState(0)
  const [busy, setBusy] = React.useState(false)
  const [discounting, setDiscounting] = React.useState<Line | null>(null)
  const [picked, setPicked] = React.useState<{ id: string; name: string; loyaltyPoints: number } | null>(null)
  const [addOpen, setAddOpen] = React.useState(false)

  /*
   * ── A number we already know fills itself in (pro.A.md §5) ──────────────
   *
   * The dropdown suggested matches, but only if the cashier noticed it and
   * tapped one. A phone number is an exact key, so once enough of it is typed
   * there is nothing to choose: the guest's name and points simply appear, and
   * the cashier does not type a name that turns out to belong to somebody the
   * system already had.
   *
   * Debounced, and the name is only auto-filled while the cashier has not
   * typed one of their own — overwriting what somebody is in the middle of
   * typing is worse than not helping.
   */
  React.useEffect(() => {
    const value = phone.trim()
    if (value.length < 7) {
      setPicked(null)
      return
    }
    let live = true
    const timer = setTimeout(() => {
      void callAction(() => findCustomerAction({ phone: value })).then((result) => {
        if (!live || !result.ok) return
        const found = result.data.customer
        setPicked(found)
        if (found) setName((current) => (current.trim() ? current : found.name))
      })
    }, 350)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [phone])
  const [cartOpen, setCartOpen] = React.useState(false)
  const [tableId, setTableId] = React.useState('')
  /*
   * How many are sitting there. Optional, and dine-in only.
   *
   * `Order.guestCount` has existed and been accepted by both order schemas
   * since the beginning with nothing anywhere to type it into, so it was null
   * on every row ever written. It is what turns takings into spend-per-head,
   * and it is what the live floor board shows beside a table.
   *
   * Not asked for a takeaway: `floor-summary.ts` already sums this column as
   * covers per table, and a guest count on a counter sale would quietly
   * corrupt that.
   */
  const [guests, setGuests] = React.useState('')
  // Defaults to whoever is signed in: a waiter taking their own order should
  // not have to find themselves in a list before they can start.
  const [servedById, setServedById] = React.useState(currentUserId ?? '')
  /** The finished bill, once the order has gone. */
  const [bill, setBill] = React.useState<StaffOrderBill | null>(null)
  /** The dish whose sizes are being chosen, if any. */
  const [choosing, setChoosing] = React.useState<PublicMenuItem | null>(null)
  /*
   * A line being given its own requirement — "one of these two, less spicy".
   * Distinct from `choosing`, which is a dish being added for the first time.
   */
  const [splitting, setSplitting] = React.useState<Line | null>(null)

  /*
   * One key per cart, so a double tap places one order.
   *
   * `placeOrder` has honoured `idempotencyKey` since it was written and the
   * till has never sent one — `disabled={busy}` was the only guard, and it
   * cannot help across a dropped connection where the browser retries. The key
   * survives a failed attempt on purpose: retrying the same cart must resolve
   * to the same order, not a second one.
   */
  const idempotencyKey = React.useRef(newKey())

  const money = (minor: number) => formatMoney(minor, currency, restaurant.locale)

  /*
   * Summed, not found. One dish can now be on the order more than once — a
   * Normal and a Full — and the badge on its photo should say how many of that
   * dish are going to the kitchen, whatever size they are.
   */
  const qtyOf = React.useCallback(
    (id: string) =>
      lines.reduce((total, line) => (line.item.id === id ? total + line.quantity : total), 0),
    [lines],
  )

  /*
   * A dish with options asks; a dish without adds on the tap.
   *
   * Putting a dialog in front of a cashier that has nothing in it but a Confirm
   * button is how a till gets slow, so the question is only asked when there is
   * genuinely something to answer.
   */
  const add = (item: PublicMenuItem) => {
    if (item.groups.length > 0) {
      setChoosing(item)
      return
    }
    addLine(item, [], 1, '')
  }

  const addLine = (
    item: PublicMenuItem,
    optionIds: string[],
    quantity: number,
    notes: string,
  ) => {
    const chosen = item.groups
      .flatMap((group) =>
        group.options
          .filter((option) => optionIds.includes(option.id))
          .map((option) => ({
            id: option.id,
            name: option.name,
            groupName: group.name,
            priceDelta: option.priceDelta,
          })),
      )
    const key = lineKey(item.id, optionIds, notes)

    setLines((current) => {
      const found = current.find((l) => l.key === key)
      if (!found) return [...current, { key, item, quantity, options: chosen, notes, discount: 0, discountReason: '' }]
      return current.map((l) =>
        l.key === key ? { ...l, quantity: Math.min(50, l.quantity + quantity) } : l,
      )
    })
  }

  /**
   * One of these is different (see `splitLine`).
   *
   * The dialog opens on what the line already is, and the units the cashier
   * asks for move onto a line of their own carrying the new options and note.
   * Any line discount stays on the ORIGINAL line: it was given on the dish the
   * cashier was looking at, and silently copying it onto a split would hand out
   * money nobody approved.
   */
  const applySplit = (source: Line, optionIds: string[], quantity: number, itemNotes: string) => {
    const chosen = source.item.groups.flatMap((group) =>
      group.options
        .filter((option) => optionIds.includes(option.id))
        .map((option) => ({
          id: option.id,
          name: option.name,
          groupName: group.name,
          priceDelta: option.priceDelta,
        })),
    )
    const nextKey = lineKey(source.item.id, optionIds, itemNotes)
    setLines((current) =>
      splitLine(current, {
        sourceKey: source.key,
        quantity,
        nextKey,
        create: (moved) => ({
          key: nextKey,
          item: source.item,
          quantity: moved,
          options: chosen,
          notes: itemNotes,
          discount: 0,
          discountReason: '',
        }),
        merge: (existing, moved) => ({
          ...existing,
          quantity: Math.min(50, existing.quantity + moved),
        }),
      }),
    )
  }

  const setQty = (key: string, quantity: number) => {
    setLines((current) =>
      quantity <= 0
        ? current.filter((l) => l.key !== key)
        : current.map((l) => (l.key === key ? { ...l, quantity: Math.min(50, quantity) } : l)),
    )
  }

  /** What one of this line costs: the dish, plus whatever was chosen on it. */
  const unitOf = (line: Line) =>
    line.item.price + line.options.reduce((total, option) => total + option.priceDelta, 0)

  const gross = lines.reduce((total, l) => total + unitOf(l) * l.quantity, 0)
  const lineDiscounts = lines.reduce(
    (total, l) => total + Math.min(l.discount, unitOf(l) * l.quantity),
    0,
  )
  const subtotal = gross - lineDiscounts
  const count = lines.reduce((total, l) => total + l.quantity, 0)

  /*
   * What the guest will actually be asked for (pro.A.md §4, §10).
   *
   * An estimate, and labelled as one: the server re-evaluates the offer and
   * re-clamps the points when the order is placed, and tax and service charge
   * are added on the bill. But a cashier who taps an offer has to see the
   * number move, or there is no way to tell whether it worked — which is the
   * whole complaint this answers.
   *
   * Clamped in the same order the engine uses: the coupon comes off first,
   * then points, and neither can take the bill below zero.
   */
  const couponOff = Math.min(couponAmount, subtotal)
  const pointsOff = Math.min(redeemPoints * (loyalty?.pointValue ?? 0), subtotal - couponOff)
  const dueNow = Math.max(0, subtotal - couponOff - pointsOff)

  /** Clear the till for the next guest. */
  const startNew = () => {
    setBill(null)
    setLines([])
    setName('')
    setPhone('')
    setNotes('')
    setCouponCode('')
    setCouponAmount(0)
    setRedeemPoints(0)
    setTableId('')
    setGuests('')
    setCartOpen(false)
    idempotencyKey.current = newKey()
  }

  const submit = async () => {
    if (lines.length === 0) {
      toast.error('Add at least one item')
      return
    }
    if (type === 'DELIVERY' && !phone.trim()) {
      toast.error('A delivery needs a phone number')
      return
    }
    // A dine-in order with no table cannot be delivered to anyone — the
    // kitchen would have nowhere to send it.
    if (type === 'DINE_IN' && !tableId) {
      toast.error('Choose a table for a dine-in order')
      return
    }

    setBusy(true)
    const result = await callAction(() =>
      createStaffOrder({
        type,
        // A table decides the branch where there is one; otherwise the sale
        // belongs to the counter on screen, not to the switcher's branch.
        branchId: branchId ?? '',
        tableId: type === 'DINE_IN' ? tableId : '',
        guestCount: type === 'DINE_IN' && guests ? Number(guests) : undefined,
        servedById,
        customerName: name,
        customerPhone: phone,
        notes,
        /*
         * The offer the cashier chose from this guest's list (pro.A.md §4).
         * Sent as a code because that is what `placeOrder` re-evaluates — the
         * list on screen is a convenience, the coupon engine is the authority.
         */
        couponCode,
        /*
         * Points to spend (pro.A.md §10). `staffOrderSchema` has accepted this
         * since placement-time redemption was built and nothing ever sent it,
         * so a guest's points could only be spent from a different screen
         * after the bill existed.
         */
        redeemPoints,
        idempotencyKey: idempotencyKey.current,
        items: lines.map((l) => ({
          foodId: l.item.id,
          quantity: l.quantity,
          optionIds: l.options.map((option) => option.id),
          notes: l.notes,
          /*
           * The per-line discount, at last. It was collected by the dialog and
           * subtracted from the subtotal on screen, and then dropped here — so
           * the cashier saw one figure, told the guest that figure, and the
           * kitchen printed another. `staffOrderSchema` defaults it to 0,
           * which is why nothing ever errored.
           */
          discount: l.discount,
          discountReason: l.discountReason,
        })),
      }),
    )
    setBusy(false)

    if (!result.ok) {
      toast.error(result.error)
      return
    }

    toast.success(`${result.data.orderNumber} sent to the kitchen`)
    setBill(result.data)
    setCartOpen(true)
  }

  const print = () => {
    if (!bill) return
    try {
      printReceipt(buildReceipt(bill, restaurant), restaurant.paper.receipt)
    } catch {
      toast.error('Unable to print the bill')
    }
  }

  return (
    /*
     * The order column is the one that has to be read while somebody is
     * waiting (pro.A.md §13): customer, points, every line with its own
     * discount, and the whole money ladder. 22rem could not hold that without
     * wrapping, so it grows and the menu — which is tiles, and reflows
     * happily — gives up the width.
     */
    <div className="grid gap-4 lg:grid-cols-[1fr_30rem] lg:items-start xl:grid-cols-[1fr_34rem]">
      {/* ── menu side ────────────────────────────────────────────────────── */}
      <div className="space-y-4">
        <OrderTypeChips value={type} onChange={setType} />
        <MenuPicker menu={menu} quantityOf={qtyOf} onAdd={add} money={money} />
      </div>

      {/* ── order side ───────────────────────────────────────────────────── */}
      <aside
        className={`${
          cartOpen ? 'fixed inset-0 z-50 overflow-y-auto bg-background p-4' : 'hidden'
        } lg:sticky lg:top-4 lg:z-auto lg:block lg:overflow-visible lg:bg-transparent lg:p-0`}
      >
        <div className="rounded-xl border border-border bg-card">
          <header className="flex items-center justify-between border-b border-border px-4 py-3">
            <h2 className="font-semibold">{bill ? `Bill · ${bill.orderNumber}` : 'Order'}</h2>
            <div className="flex items-center gap-2">
              {!bill && count > 0 && <Badge variant="secondary">{count}</Badge>}
              {bill && (
                <Badge variant="success">
                  <Check /> Sent
                </Badge>
              )}
              <button
                type="button"
                onClick={() => setCartOpen(false)}
                className="rounded-md p-1 text-muted-foreground hover:bg-muted lg:hidden"
                aria-label="Close order panel"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
          </header>

          {bill ? (
            <BillPanel bill={bill} restaurant={restaurant} onPrint={print} onNew={startNew} />
          ) : (
            <>
              {/*
                ── Who this is, and what they are owed ───────────────────────

                The guest's offers and points sit at the TOP of the order
                column, above the dishes. They used to be four fields down,
                under the phone box, which is the wrong way round: a discount
                the cashier has to scroll to find is a discount that gets
                forgotten, and the guest is standing there.

                The phone box is directly beneath, because it is what produces
                them — type a number and the panel above fills in. The panel
                renders nothing at all until a customer resolves, so an
                anonymous walk-in still sees the phone box first and no empty
                frame above it.
              */}
              <div className="space-y-2 border-b border-border p-4">
                <GuestPanel
                  customer={picked}
                  lines={lines.map((l) => ({
                    foodId: l.item.id,
                    categoryId: l.item.categoryId,
                    quantity: l.quantity,
                    lineTotal: Math.max(0, unitOf(l) * l.quantity - l.discount),
                  }))}
                  branchId={branchId}
                  currency={currency}
                  locale={restaurant.locale}
                  couponCode={couponCode}
                  onCouponChange={(code, amount) => {
                    setCouponCode(code)
                    setCouponAmount(amount)
                  }}
                  redeemPoints={redeemPoints}
                  onRedeemPointsChange={setRedeemPoints}
                  loyalty={loyalty}
                  discountableTotal={subtotal}
                />

                <div className="space-y-1">
                  <Label htmlFor="pos-phone" className="text-xs">
                    Phone {type === 'DELIVERY' ? '' : <span className="text-muted-foreground">(optional)</span>}
                  </Label>
                  {/*
                    Phone first, and then say who it is (pro.A.md §5). Typing a
                    number used to create a customer silently, with whatever
                    name was in the box; now the till says who it belongs to,
                    or offers to add them — through the same shared form the
                    CRM uses.
                  */}
                  <CustomerPhoneField
                    id="pos-phone"
                    phone={phone}
                    name={name}
                    onPhoneChange={(next) => {
                      setPhone(next)
                      setPicked(null)
                    }}
                    onPick={(customer) => {
                      setPhone(customer.phone)
                      setName(customer.name)
                      setPicked(customer)
                    }}
                  />
                </div>

                <div className="space-y-1">
                  <Label htmlFor="pos-name" className="text-xs">
                    Customer {type === 'COUNTER' && <span className="text-muted-foreground">(optional)</span>}
                  </Label>
                  <Input
                    id="pos-name"
                    placeholder={type === 'COUNTER' ? 'Walk-in' : 'Name'}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </div>

                {/*
                  Always here, not only once a number is typed (pro.A.md §5,
                  §6). A cashier looking for "where do I add this guest" should
                  find it whatever is in the boxes, and it opens the SAME form
                  the customer screen uses.
                */}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="w-full"
                  onClick={() => setAddOpen(true)}
                >
                  <UserPlus /> Add customer
                </Button>
              </div>

              {lines.length === 0 ? (
                <p className="px-4 py-10 text-center text-sm text-muted-foreground">
                  Tap a dish to start the order.
                </p>
              ) : (
                <ul className="divide-y divide-border">
                  {lines.map((line) => (
                    <li key={line.key} className="flex items-center gap-3 px-4 py-3">
                      <div className="min-w-0 flex-1">
                        {/*
                          The dish, its choices and its price open that line's
                          own requirements — "one of those without onions" — so
                          a cashier can say it on the line in front of them
                          instead of deleting and re-ringing.

                          Only this part is the button. The discount control
                          below is its own, and a button inside a button is
                          invalid markup that browsers resolve by dropping one
                          of them.
                        */}
                        <button
                          type="button"
                          onClick={() => setSplitting(line)}
                          className="block w-full text-left"
                          aria-label={`Change or split ${line.item.name}`}
                        >
                        <p className="truncate text-sm font-medium">{line.item.name}</p>
                        {/*
                          The chosen size, named. Without it two lines of the
                          same dish at different prices look like a mistake.
                        */}
                        {line.options.length > 0 ? (
                          <p className="truncate text-xs text-primary">
                            {line.options.map((option) => option.name).join(' · ')}
                          </p>
                        ) : null}
                        <p className="text-xs text-muted-foreground">
                          {money(unitOf(line))} each
                          {line.quantity > 1 ? ' · tap to split' : ' · tap to change'}
                        </p>
                        {line.notes ? (
                          <p className="truncate text-xs text-muted-foreground">{line.notes}</p>
                        ) : null}
                        </button>
                        {/*
                          A discount on THIS dish (pro.A.md §10). "The burger
                          was cold, take 100 off it" is a fact about the
                          burger; recording it against the whole bill loses
                          which dish it belonged to.
                        */}
                        {line.discount > 0 ? (
                          <p className="text-xs text-success">
                            − {money(line.discount)}
                            {line.discountReason ? ` · ${line.discountReason}` : ''}
                          </p>
                        ) : null}
                        <button
                          type="button"
                          className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                          onClick={() => setDiscounting(line)}
                        >
                          {line.discount > 0 ? 'Change discount' : 'Discount this item'}
                        </button>
                      </div>

                      <div className="flex shrink-0 items-center gap-1">
                        <StepButton
                          label={`Remove one ${line.item.name}`}
                          onClick={() => setQty(line.key, line.quantity - 1)}
                        >
                          {line.quantity === 1 ? (
                            <Trash2 className="h-4 w-4" />
                          ) : (
                            <Minus className="h-4 w-4" />
                          )}
                        </StepButton>
                        <span className="w-7 text-center text-sm font-semibold tabular-nums">
                          {line.quantity}
                        </span>
                        <StepButton
                          label={`Add one ${line.item.name}`}
                          onClick={() => setQty(line.key, line.quantity + 1)}
                        >
                          <Plus className="h-4 w-4" />
                        </StepButton>
                      </div>

                      <span className="w-20 shrink-0 text-right text-sm font-semibold tabular-nums">
                        {line.discount > 0 ? (
                          <>
                            <span className="block text-xs font-normal text-muted-foreground line-through">
                              {money(unitOf(line) * line.quantity)}
                            </span>
                            {money(Math.max(0, unitOf(line) * line.quantity - line.discount))}
                          </>
                        ) : (
                          money(unitOf(line) * line.quantity)
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              )}

              <div className="space-y-3 border-t border-border p-4">
                <div className="flex items-center justify-between text-base font-semibold">
                  <span>Subtotal</span>
                  <span className="tabular-nums">{money(subtotal)}</span>
                </div>
                {couponOff > 0 ? (
                  <div className="-mt-2 flex items-center justify-between text-sm text-emerald-600 dark:text-emerald-400">
                    <span>Offer · {couponCode}</span>
                    <span className="tabular-nums">−{money(couponOff)}</span>
                  </div>
                ) : null}
                {pointsOff > 0 ? (
                  <div className="-mt-2 flex items-center justify-between text-sm text-emerald-600 dark:text-emerald-400">
                    <span>{redeemPoints.toLocaleString()} points</span>
                    <span className="tabular-nums">−{money(pointsOff)}</span>
                  </div>
                ) : null}
                {couponOff > 0 || pointsOff > 0 ? (
                  <div className="-mt-1 flex items-center justify-between border-t border-border pt-2 text-base font-semibold">
                    <span>To pay</span>
                    <span className="tabular-nums">{money(dueNow)}</span>
                  </div>
                ) : null}
                <p className="-mt-2 text-xs text-muted-foreground">
                  Tax and service charge are added on the bill.
                </p>

                <div className="grid gap-2">
                  {type === 'DINE_IN' && (
                    <div className="space-y-1">
                      <Label htmlFor="pos-table" className="text-xs">Table</Label>
                      <select
                        id="pos-table"
                        className="h-10 w-full rounded-lg border border-input bg-background px-2 text-sm"
                        value={tableId}
                        onChange={(e) => setTableId(e.target.value)}
                      >
                        <option value="">Choose a table…</option>
                        {tables.map((t) => (
                          <option key={t.id} value={t.id}>
                            Table {t.number}
                            {t.area ? ` · ${t.area}` : ''}
                            {t.status !== 'AVAILABLE' ? ` · ${t.status.toLowerCase()}` : ''}
                          </option>
                        ))}
                      </select>
                      {tables.length === 0 && (
                        <p className="text-xs text-amber-600 dark:text-amber-400">
                          No tables set up yet — add them under Tables.
                        </p>
                      )}
                    </div>
                  )}
                  {type === 'DINE_IN' && (
                    <div className="space-y-1">
                      <Label htmlFor="pos-guests" className="text-xs">
                        Guests <span className="text-muted-foreground">(optional)</span>
                      </Label>
                      <Input
                        id="pos-guests"
                        type="number"
                        min={1}
                        max={50}
                        inputMode="numeric"
                        placeholder="How many at the table?"
                        value={guests}
                        onChange={(e) => setGuests(e.target.value)}
                      />
                    </div>
                  )}

                  {servers.length > 0 && (
                    <div className="space-y-1">
                      <Label htmlFor="pos-server" className="text-xs">Served by</Label>
                      <select
                        id="pos-server"
                        className="h-10 w-full rounded-lg border border-input bg-background px-2 text-sm"
                        value={servedById}
                        onChange={(e) => setServedById(e.target.value)}
                      >
                        {servers.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.name} · {s.role.toLowerCase()}
                          </option>
                        ))}
                      </select>
                      <p className="text-xs text-muted-foreground">
                        Credited with the sale in staff reports.
                      </p>
                    </div>
                  )}

                  <div className="space-y-1">
                    <Label htmlFor="pos-notes" className="text-xs">
                      {type === 'DELIVERY' ? 'Address / notes' : 'Notes'}
                    </Label>
                    <Input
                      id="pos-notes"
                      placeholder={type === 'DELIVERY' ? 'Delivery address' : 'e.g. no chilli'}
                      value={notes}
                      onChange={(e) => setNotes(e.target.value)}
                    />
                  </div>
                </div>

                <Button className="w-full" size="lg" onClick={submit} disabled={busy || count === 0}>
                  {busy ? 'Sending…' : `Send to kitchen & bill · ${money(dueNow)}`}
                </Button>
              </div>
            </>
          )}
        </div>
      </aside>

      {splitting ? (
        <OptionDialog
          item={splitting.item}
          currency={currency}
          locale={restaurant.locale}
          money={money}
          title={
            splitting.quantity > 1 ? `One of these ${splitting.item.name}` : splitting.item.name
          }
          confirmLabel={splitting.quantity > 1 ? 'Split off' : 'Update'}
          initialOptionIds={splitting.options.map((option) => option.id)}
          initialNotes={splitting.notes}
          // One unit by default when there are several: the guest said one of
          // them is different, not all of them.
          initialQuantity={splitting.quantity > 1 ? 1 : splitting.quantity}
          onCancel={() => setSplitting(null)}
          onConfirm={(optionIds, quantity, itemNotes) => {
            applySplit(splitting, optionIds, quantity, itemNotes)
            setSplitting(null)
          }}
        />
      ) : null}

      {choosing ? (
        <OptionDialog
          item={choosing}
          currency={currency}
          locale={restaurant.locale}
          money={money}
          onCancel={() => setChoosing(null)}
          onConfirm={(optionIds, quantity, itemNotes) => {
            addLine(choosing, optionIds, quantity, itemNotes)
            setChoosing(null)
          }}
        />
      ) : null}

      {/* Mobile: a persistent bar so the running total is always visible. */}
      {count > 0 && !cartOpen && (
        <button
          type="button"
          onClick={() => setCartOpen(true)}
          className="fixed inset-x-3 bottom-3 z-40 flex items-center justify-between rounded-xl bg-primary px-4 py-3 text-primary-foreground shadow-lg lg:hidden"
        >
          <span className="flex items-center gap-2 text-sm font-medium">
            <ShoppingCart className="h-4 w-4" />
            {count} {count === 1 ? 'item' : 'items'}
          </span>
          <span className="font-semibold tabular-nums">
            {bill ? money(bill.grandTotal) : money(subtotal)}
          </span>
        </button>
      )}

      {/*
        Money off one dish, before the order is sent (pro.A.md §10). The same
        idea as the dialog on the Cashier tab, for a bill that does not exist
        yet — so the kitchen ticket and the first printed bill already carry
        the right figure.
      */}
      {/*
        The same customer form the CRM uses (pro.A.md §6), seeded with
        whatever is already in the boxes so nothing is typed twice.
      */}
      <CustomerFormDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        seed={{ phone, name }}
        categories={customerCategories}
        onSaved={(customer) => {
          setPicked(customer)
          setName(customer.name)
          setPhone(customer.phone)
        }}
      />

      <LineDiscountDialog
        line={discounting}
        currency={restaurant.currency}
        money={money}
        unitOf={unitOf}
        onClose={() => setDiscounting(null)}
        onApply={(key, discount, reason) => {
          setLines((current) =>
            current.map((l) => (l.key === key ? { ...l, discount, discountReason: reason } : l)),
          )
          setDiscounting(null)
        }}
      />
    </div>
  )
}

/**
 * Money off one line of a cart that has not been sent yet (pro.A.md §10).
 *
 * The amount is for the whole line, not per unit — "two burgers, 100 off" is
 * 100 — because that is how it is said out loud and how it reads on the bill.
 * Nothing is totalled here: the server re-prices the order from the menu and
 * clamps each discount to its own line.
 */
function LineDiscountDialog({
  line,
  currency,
  money,
  unitOf,
  onClose,
  onApply,
}: {
  line: Line | null
  currency: string
  money: (minor: number) => string
  unitOf: (line: Line) => number
  onClose: () => void
  onApply: (key: string, discount: number, reason: string) => void
}) {
  const [amount, setAmount] = React.useState('')
  const [reason, setReason] = React.useState('')
  const factor = minorUnitFactor(currency)

  React.useEffect(() => {
    if (!line) return
    setAmount(line.discount > 0 ? String(line.discount / factor) : '')
    setReason(line.discountReason)
  }, [line, factor])

  const gross = line ? unitOf(line) * line.quantity : 0
  const minor = amount.trim() && Number.isFinite(Number(amount)) ? Math.round(Number(amount) * factor) : 0
  const tooMuch = minor > gross

  return (
    <Dialog open={line !== null} onOpenChange={(next) => (next ? null : onClose())}>
      <DialogContent className="sm:max-w-md">
        {line ? (
          <>
            <DialogHeader>
              <DialogTitle>Discount {line.quantity} × {line.item.name}</DialogTitle>
            </DialogHeader>
            <div className="space-y-3">
              <div className="flex items-center justify-between rounded-lg border bg-muted/30 px-3 py-2 text-sm">
                <span className="text-muted-foreground">Line price</span>
                <span className="tabular-nums">{money(gross)}</span>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="pos-line-discount">Take off ({currency})</Label>
                <Input
                  id="pos-line-discount"
                  autoFocus
                  inputMode="decimal"
                  placeholder="0.00"
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  {tooMuch
                    ? 'That is more than the line is worth.'
                    : `The line becomes ${money(Math.max(0, gross - minor))}. Leave it empty to remove the discount.`}
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="pos-line-reason">Why (optional)</Label>
                <Input
                  id="pos-line-reason"
                  value={reason}
                  onChange={(event) => setReason(event.target.value.slice(0, 160))}
                  placeholder="e.g. served cold"
                />
              </div>
            </div>
            <div className="flex justify-end gap-2 border-t pt-3">
              <Button variant="ghost" onClick={onClose}>Cancel</Button>
              <Button disabled={tooMuch} onClick={() => onApply(line.key, minor, reason)}>
                {minor === 0 ? 'Remove discount' : 'Apply discount'}
              </Button>
            </div>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

/**
 * The finished bill.
 *
 * Every figure here was computed and stored by the server, so what the guest
 * is shown, what prints, and what the cashier later settles on `/cashier` are
 * one set of numbers.
 *
 * It is a BILL, not a receipt: nothing has been paid yet, and payment happens
 * at the till. Saying "unpaid" out loud saves a cashier handing it over and
 * assuming the money is in.
 */
function BillPanel({
  bill,
  restaurant,
  onPrint,
  onNew,
}: {
  bill: StaffOrderBill
  restaurant: ReceiptRestaurant
  onPrint: () => void
  onNew: () => void
}) {
  const money = (minor: number) => formatMoney(minor, restaurant.currency, restaurant.locale)

  const rows: Array<{ label: string; value: number; strong?: boolean }> = [
    { label: 'Subtotal', value: bill.subtotal },
    ...(bill.discountTotal ? [{ label: 'Discount', value: -bill.discountTotal }] : []),
    ...(bill.serviceCharge ? [{ label: 'Service', value: bill.serviceCharge }] : []),
    ...(bill.taxTotal ? [{ label: restaurant.taxLabel, value: bill.taxTotal }] : []),
  ]

  return (
    <>
      <ul className="divide-y divide-border">
        {bill.items.map((item, index) => (
          <li key={`${item.name}-${index}`} className="flex items-start gap-3 px-4 py-2.5">
            <span className="w-7 shrink-0 text-sm font-semibold tabular-nums">
              {item.quantity}×
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm">{item.name}</p>
              {item.optionsLabel ? (
                <p className="truncate text-xs text-muted-foreground">{item.optionsLabel}</p>
              ) : null}
            </div>
            <span className="shrink-0 text-sm tabular-nums">{money(item.lineTotal)}</span>
          </li>
        ))}
      </ul>

      <div className="space-y-1.5 border-t border-border p-4">
        {rows.map((row) => (
          <div key={row.label} className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">{row.label}</span>
            <span className="tabular-nums">{money(row.value)}</span>
          </div>
        ))}
        <div className="flex items-center justify-between border-t border-border pt-2 text-base font-semibold">
          <span>Total</span>
          <span className="tabular-nums">{money(bill.grandTotal)}</span>
        </div>
        <p className="pt-1 text-xs text-muted-foreground">
          Unpaid — take payment on the Cashier screen.
        </p>

        <div className="flex gap-2 pt-2">
          <Button className="flex-1" size="lg" onClick={onPrint}>
            <Printer /> Print bill
          </Button>
          <Button variant="outline" size="lg" onClick={onNew}>
            <Plus /> New
          </Button>
        </div>
      </div>
    </>
  )
}

/** A key for one cart. See `newRequestKey` for why it must survive a retry. */
function newKey(): string {
  return newRequestKey('pos')
}
