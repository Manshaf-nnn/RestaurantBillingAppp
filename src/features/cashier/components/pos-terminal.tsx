'use client'

import * as React from 'react'
import { Check, Minus, Plus, Printer, ShoppingCart, Trash2, X } from 'lucide-react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { formatMoney } from '@/lib/money'
import { createStaffOrder, type StaffOrderBill } from '@/features/orders/actions'
import type { PublicMenu, PublicMenuItem } from '@/features/menu/queries'
import { callAction } from '@/lib/use-action'
import { printReceipt } from '@/features/printing/print'
import { buildReceipt, type ReceiptRestaurant } from '@/features/printing/receipt'

import {
  MenuPicker,
  OrderTypeChips,
  StepButton,
  type OrderType,
} from './menu-picker'
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
  tables = [],
  servers = [],
  currentUserId,
}: {
  menu: PublicMenu
  currency: string
  /** Everything a printed bill needs in its header. */
  restaurant: ReceiptRestaurant
  initialType?: OrderType
  /** Free tables, so a counter order can be seated. */
  tables?: Array<{ id: string; number: string; area: string | null; status: string }>
  /** Who can be credited with serving it. */
  servers?: Array<{ id: string; name: string; role: string }>
  currentUserId?: string
}) {
  const [type, setType] = React.useState<OrderType>(initialType)
  const [lines, setLines] = React.useState<Line[]>([])
  const [name, setName] = React.useState('')
  const [phone, setPhone] = React.useState('')
  const [notes, setNotes] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [cartOpen, setCartOpen] = React.useState(false)
  const [tableId, setTableId] = React.useState('')
  // Defaults to whoever is signed in: a waiter taking their own order should
  // not have to find themselves in a list before they can start.
  const [servedById, setServedById] = React.useState(currentUserId ?? '')
  /** The finished bill, once the order has gone. */
  const [bill, setBill] = React.useState<StaffOrderBill | null>(null)
  /** The dish whose sizes are being chosen, if any. */
  const [choosing, setChoosing] = React.useState<PublicMenuItem | null>(null)

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
      if (!found) return [...current, { key, item, quantity, options: chosen, notes }]
      return current.map((l) =>
        l.key === key ? { ...l, quantity: Math.min(50, l.quantity + quantity) } : l,
      )
    })
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

  const subtotal = lines.reduce((total, l) => total + unitOf(l) * l.quantity, 0)
  const count = lines.reduce((total, l) => total + l.quantity, 0)

  /** Clear the till for the next guest. */
  const startNew = () => {
    setBill(null)
    setLines([])
    setName('')
    setPhone('')
    setNotes('')
    setTableId('')
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
        tableId: type === 'DINE_IN' ? tableId : '',
        servedById,
        customerName: name,
        customerPhone: phone,
        notes,
        idempotencyKey: idempotencyKey.current,
        items: lines.map((l) => ({
          foodId: l.item.id,
          quantity: l.quantity,
          optionIds: l.options.map((option) => option.id),
          notes: l.notes,
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
    <div className="grid gap-4 lg:grid-cols-[1fr_22rem] lg:items-start">
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
              {lines.length === 0 ? (
                <p className="px-4 py-10 text-center text-sm text-muted-foreground">
                  Tap a dish to start the order.
                </p>
              ) : (
                <ul className="divide-y divide-border">
                  {lines.map((line) => (
                    <li key={line.key} className="flex items-center gap-3 px-4 py-3">
                      <div className="min-w-0 flex-1">
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
                        <p className="text-xs text-muted-foreground">{money(unitOf(line))} each</p>
                        {line.notes ? (
                          <p className="truncate text-xs text-muted-foreground">{line.notes}</p>
                        ) : null}
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
                        {money(unitOf(line) * line.quantity)}
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
                  <div className="space-y-1">
                    <Label htmlFor="pos-phone" className="text-xs">
                      Phone {type === 'DELIVERY' ? '' : <span className="text-muted-foreground">(optional)</span>}
                    </Label>
                    <Input
                      id="pos-phone"
                      inputMode="tel"
                      placeholder="07X XXX XXXX"
                      value={phone}
                      onChange={(e) => setPhone(e.target.value)}
                    />
                  </div>
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
                  {busy ? 'Sending…' : `Send to kitchen & bill · ${money(subtotal)}`}
                </Button>
              </div>
            </>
          )}
        </div>
      </aside>

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
    </div>
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

/**
 * A key for one cart.
 *
 * `crypto.randomUUID` is not in every browser a counter tablet might be running
 * — it needs a secure context and a recent engine — and the fallback only has
 * to be unique among the handful of orders one till places, not globally.
 */
function newKey(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `pos-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}
