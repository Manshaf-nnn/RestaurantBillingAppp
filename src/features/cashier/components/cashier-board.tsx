'use client'

import * as React from 'react'
import { outstandingOn, derivePaymentStatus } from '@/features/orders/pricing'
import Image from 'next/image'
import { AnimatePresence, motion } from 'framer-motion'
import {
  Bell,
  Check,
  Download,
  ArrowRightLeft,
  Merge,
  PauseCircle,
  Percent,
  PlayCircle,
  Plus,
  Printer,
  QrCode,
  Receipt,
  Search,
  Split,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import { CustomerPhoneField } from '@/features/customers/components/customer-phone-field'

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
import { EmptyState } from '@/components/ui/feedback'
import { Field } from '@/components/ui/label'
import { Input, Textarea } from '@/components/ui/input'
import { Separator } from '@/components/ui/primitives'
import { OrderStatusBadge, PaymentStatusBadge } from '@/components/ui/status'
import { OpsShell, OpsStats } from '@/components/ops-shell'
import { AutoRefresh } from '@/components/auto-refresh'
import { EVENTS, type OrderSummaryPayload, type PaymentPayload } from '@/lib/realtime/events'
import { formatMoney, parseMoney, toMajor } from '@/lib/money'
import { formatDateTime } from '@/lib/datetime'
import { newRequestKey } from '@/lib/request-key'
import { cn } from '@/lib/utils'
import { useSocketEvent } from '@/hooks/use-socket'
import { downloadReceipt, printReceipt } from '@/features/printing/print'
import { buildReceipt, type ReceiptRestaurant } from '@/features/printing/receipt'
import { applyManualDiscount, createStaffOrder } from '@/features/orders/actions'
import { presentBill, collectPayment, createStaffPaymentQr } from '@/features/payments/actions'
import { recordPrint } from '@/features/printing/actions'
import { TillLoyalty } from '@/features/loyalty/components/till-loyalty'
import { addItemsToBillAction, voidItemAction } from '../actions'
import { useRouter } from 'next/navigation'

/** A reward as the till lists it, before this bill's balance is applied. */
export interface LoyaltyRewardOption {
  id: string
  name: string
  description: string | null
  pointsCost: number
  value: number
  minOrderAmount: number
  expiresAt: string | null
}
import {
  holdBillAction,
  mergeBillsAction,
  resumeBillAction,
  splitBillAction,
  acceptGuestOrderAction,
  rejectGuestOrderAction,
} from '@/features/cashier/actions'
import { awaitsCashier, channelLabel } from '@/features/orders/channels'
import { SwapTableDialog } from '@/features/floor/components/swap-table-dialog'
import { quickCash, TENDER_METHODS } from '@/features/payments/components/tender'
import { callWaiterAction } from '@/features/floor/actions'
import type { PublicMenu, PublicMenuItem } from '@/features/menu/queries'
import { callAction } from '@/lib/use-action'
import {
  MenuPicker,
  OrderTypeChips,
  type OrderType,
} from './menu-picker'
import { OptionDialog } from './option-dialog'

/** One line of a counter order: a dish, its chosen options, and a quantity. */
interface TakeawayLine {
  key: string
  foodId: string
  name: string
  quantity: number
  /** The dish's price plus whatever was chosen on it. */
  unitPrice: number
  options: Array<{ id: string; name: string; priceDelta: number }>
  notes: string
}

export interface CashierBill {
  id: string
  orderNumber: string
  type: 'DINE_IN' | 'TAKEAWAY' | 'DELIVERY'
  /** Where it came from: a QR / ONLINE order waits here for acceptance (abc.md §5). */
  channel: string
  status: 'PENDING' | 'ACCEPTED' | 'PREPARING' | 'READY' | 'SERVED' | 'COMPLETED'
  paymentStatus: 'UNPAID' | 'PARTIAL' | 'PAID' | 'REFUNDED' | 'FAILED'
  /** The table the sitting is at, so it can be moved (abc.md §3). */
  tableId: string | null
  tableNumber: string | null
  customerName: string
  customerPhone: string
  placedAt: string
  heldAt: string | null
  holdReason: string | null
  subtotal: number
  discountTotal: number
  serviceCharge: number
  taxTotal: number
  grandTotal: number
  tipAmount: number
  paidTotal: number
  items: Array<{ id: string; name: string; optionsLabel: string; quantity: number; lineTotal: number }>
  /** The loyalty account on this bill, when it has one (loyalty spec). */
  loyalty?: { customerId: string; customerName: string | null; points: number } | null
}

type BillFilter = 'ACTIVE' | 'DINE_IN' | 'TAKEAWAY' | 'HELD'

/** The same methods, order and icons as the orders screen's Take-payment dialog. */
const METHODS = TENDER_METHODS

export function CashierBoard({
  initialBills,
  todayTotal,
  todayCount,
  user,
  exit,
  restaurant,
  menu,
  startInTakeaway = false,
  branchIds,
  branchName,
  tables = [],
  canAccept = false,
  embedded = false,
  rewards = [],
}: {
  initialBills: CashierBill[]
  todayTotal: number
  todayCount: number
  user: { name: string; role: string }
  /** Holds order.accept: may say yes or no to a QR / online order (abc.md §5). */
  canAccept?: boolean
  /** Inside the POS shell (abc.md §8): no ops-shell header of its own. */
  embedded?: boolean
  /**
   * A way back to the dashboard, rendered by the page.
   *
   * A ReactNode rather than anything computed here: deciding whether this
   * person has somewhere to go needs their permissions, which live on the
   * server. The page renders `<StationExit>` and hands the element across —
   * elements serialize, functions do not.
   */
  exit?: React.ReactNode
  /** Locations this screen is showing. Null means all of them. */
  branchIds: string[] | null
  /** Which location this till is standing in (correctionA.md §6). */
  branchName?: string | null
  menu: PublicMenu
  startInTakeaway?: boolean
  /** Free tables, so the dialog can take a dine-in order. */
  tables?: Array<{ id: string; number: string; area: string | null }>
  restaurant: ReceiptRestaurant
  /** What guests can spend points on, loaded once for the screen. */
  rewards?: LoyaltyRewardOption[]
}) {

  /*
   * Whether a live event belongs on this screen.
   *
   * Socket rooms are keyed `r:<restaurantId>:<role>` with no branch segment, so
   * every board in the chain receives every event. The server render is
   * branch-scoped, so a stray row vanished on the next refresh — but not before
   * it had chimed, toasted, and here added another branch's money to this
   * till's day total.
   *
   * Filtering on arrival costs one comparison and needs no change to the socket
   * handshake. Null means "every location" — an owner watching the whole
   * business on purpose.
   */
  const isOurs = React.useCallback(
    (payload: { branchId?: string }) =>
      branchIds === null || !payload.branchId || branchIds.includes(payload.branchId),
    [branchIds],
  )

  const [bills, setBills] = React.useState(initialBills)
  const [search, setSearch] = React.useState('')
  const [selectedId, setSelectedId] = React.useState<string | null>(initialBills[0]?.id ?? null)
  const [filter, setFilter] = React.useState<BillFilter>('ACTIVE')
  const [collected, setCollected] = React.useState({ total: todayTotal, count: todayCount })
  const [takeawayOpen, setTakeawayOpen] = React.useState(startInTakeaway)
  /*
   * The dialog can ring up anything now, not only takeaway.
   *
   * It used to hard-code TAKEAWAY, so a cashier taking a delivery over the
   * phone had to leave the bill queue they were working in and go to the POS
   * tab. Same four types as the till, from the same component.
   */
  const [orderType, setOrderType] = React.useState<OrderType>('TAKEAWAY')
  const [tableId, setTableId] = React.useState('')

  /*
   * One key per order, so a double-click places one.
   *
   * `placeOrder` has honoured `idempotencyKey` since it was written and neither
   * order-entry screen ever sent one. It is minted per cart and only replaced
   * once an order actually lands, so a retry after a dropped connection
   * resolves to the same order rather than a second one.
   */
  const orderKey = React.useRef(newOrderKey())
  const [customerName, setCustomerName] = React.useState('')
  const [customerPhone, setCustomerPhone] = React.useState('')
  const [notes, setNotes] = React.useState('')
  /*
   * A list, not a `Record<foodId, qty>`.
   *
   * The map could only ever hold one entry per dish, which made a Normal and a
   * Full of the same rice impossible to put on one order — and it is why this
   * dialog sent `optionIds: []`. Same line shape and same collapse rule as the
   * till and the guest cart.
   */
  const [takeawayCart, setTakeawayCart] = React.useState<TakeawayLine[]>([])
  /** The dish whose sizes are being chosen, if any. */
  const [choosing, setChoosing] = React.useState<PublicMenuItem | null>(null)
  const [creatingTakeaway, setCreatingTakeaway] = React.useState(false)
  const [takeawayError, setTakeawayError] = React.useState<string | null>(null)

  // Re-sync when polling (realtime off / serverless).
  React.useEffect(() => setBills(initialBills), [initialBills])

  useSocketEvent(EVENTS.ORDER_CREATED, (payload: OrderSummaryPayload) => {
    if (!isOurs(payload)) return
    // A QR / online order is this screen's to accept (abc.md §5); the row
    // itself arrives with the next refresh, a few seconds at most.
    if (awaitsCashier(payload)) {
      toast.warning(`New ${channelLabel(payload.channel)} order ${payload.orderNumber} — accept it to send it to the kitchen`, {
        description: payload.tableNumber ? `Table ${payload.tableNumber}` : payload.customerName,
      })
      return
    }
    toast.info(`New order ${payload.orderNumber}`, {
      description: payload.tableNumber ? `Table ${payload.tableNumber}` : undefined,
    })
  })

  useSocketEvent(EVENTS.PAYMENT_RECEIVED, (payload: PaymentPayload) => {
    if (!isOurs(payload)) return
    setBills((current) => current.filter((bill) => bill.id !== payload.orderId))
    setCollected((current) => ({ total: current.total + payload.amount, count: current.count + 1 }))
  })

  const filtered = React.useMemo(() => {
    const query = search.trim().toLowerCase()
    const tableQuery = query.startsWith('t') ? query.slice(1).trim() : query
    const takeawayKeywords = ['takeaway', 'take away', 'pickup', 'pick up', 'collection', 'takeout']

    let result = bills.filter((bill) => {
      // Waiting for acceptance is its own list above; not a bill to settle yet.
      if (awaitsCashier(bill)) return false
      if (!query) return true
      const normalizedType = bill.type.toLowerCase()
      const normalizedName = bill.customerName.toLowerCase()
      const normalizedPhone = bill.customerPhone
      const tableNumber = bill.tableNumber?.toLowerCase() ?? ''

      return (
        bill.orderNumber.toLowerCase().includes(query) ||
        normalizedName.includes(query) ||
        normalizedPhone.includes(query) ||
        normalizedType.includes(query) ||
        (takeawayKeywords.some((keyword) => query.includes(keyword) || keyword.includes(query)) && bill.type === 'TAKEAWAY') ||
        (bill.tableNumber != null && tableNumber.includes(tableQuery))
      )
    })

    // Held bills are parked deliberately, so they stay out of every other view
    // and only appear under "Held" — otherwise the queue a cashier works from
    // fills up with bills they have already set aside.
    if (filter === 'HELD') result = result.filter((bill) => bill.heldAt)
    else {
      result = result.filter((bill) => !bill.heldAt)
      if (filter === 'DINE_IN') result = result.filter((bill) => bill.type === 'DINE_IN')
      if (filter === 'TAKEAWAY') result = result.filter((bill) => bill.type === 'TAKEAWAY')
    }

    return result
  }, [bills, search, filter])

  const heldCount = React.useMemo(() => bills.filter((bill) => bill.heldAt).length, [bills])

  /*
   * QR / online orders waiting for the till's yes or no (abc.md §5).
   *
   * Accept runs the ordinary ACCEPTED transition on the same order server-side
   * — routing, stock, the kitchen's chime — and the row simply moves down into
   * the bills below. Reject is a cancellation with a reason the guest reads.
   */
  const awaiting = React.useMemo(() => bills.filter((bill) => awaitsCashier(bill)), [bills])
  const [decidingId, setDecidingId] = React.useState<string | null>(null)
  const [rejecting, setRejecting] = React.useState<CashierBill | null>(null)
  const [rejectReason, setRejectReason] = React.useState('')

  const acceptGuest = async (bill: CashierBill) => {
    setDecidingId(bill.id)
    const result = await callAction(() => acceptGuestOrderAction({ orderId: bill.id }))
    setDecidingId(null)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    setBills((current) => current.map((b) => (b.id === bill.id ? { ...b, status: 'ACCEPTED' } : b)))
    toast.success(`Order ${bill.orderNumber} accepted — sent to the kitchen`)
  }

  const rejectGuest = async () => {
    if (!rejecting) return
    setDecidingId(rejecting.id)
    const result = await callAction(() => rejectGuestOrderAction({ orderId: rejecting.id, reason: rejectReason }))
    setDecidingId(null)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    setBills((current) => current.filter((b) => b.id !== rejecting.id))
    toast.success(`Order ${rejecting.orderNumber} rejected`)
    setRejecting(null)
    setRejectReason('')
  }

  const selected = filtered.find((bill) => bill.id === selectedId) ?? filtered[0] ?? null

  const takeawayLines = takeawayCart
  const takeawayTotal = React.useMemo(
    () => takeawayCart.reduce((sum, line) => sum + line.unitPrice * line.quantity, 0),
    [takeawayCart],
  )

  /** Ask when there is a size to pick; add straight away when there is not. */
  const addTakeawayItem = (item: PublicMenuItem) => {
    if (item.groups.length > 0) {
      setChoosing(item)
      return
    }
    pushTakeawayLine(item, [], 1, '')
  }

  const pushTakeawayLine = (
    item: PublicMenuItem,
    optionIds: string[],
    quantity: number,
    lineNotes: string,
  ) => {
    const chosen = item.groups.flatMap((group) =>
      group.options
        .filter((option) => optionIds.includes(option.id))
        .map((option) => ({ id: option.id, name: option.name, priceDelta: option.priceDelta })),
    )
    const key = `${item.id}::${[...optionIds].sort().join(',')}::${lineNotes.trim().toLowerCase()}`
    const unitPrice = item.price + chosen.reduce((sum, option) => sum + option.priceDelta, 0)

    setTakeawayCart((current) => {
      const found = current.find((line) => line.key === key)
      if (!found) {
        return [
          ...current,
          { key, foodId: item.id, name: item.name, quantity, unitPrice, options: chosen, notes: lineNotes },
        ]
      }
      return current.map((line) =>
        line.key === key ? { ...line, quantity: Math.min(50, line.quantity + quantity) } : line,
      )
    })
  }

  const changeTakeawayQty = (key: string, delta: number) => {
    setTakeawayCart((current) =>
      current
        .map((line) => (line.key === key ? { ...line, quantity: line.quantity + delta } : line))
        .filter((line) => line.quantity > 0),
    )
  }

  const submitTakeawayOrder = async () => {
    if (!customerName.trim() || !customerPhone.trim()) {
      setTakeawayError('Enter the customer name and phone number.')
      return
    }
    // Same rule the till enforces: the kitchen has nowhere to send a dine-in
    // order that names no table.
    if (orderType === 'DINE_IN' && !tableId) {
      setTakeawayError('Choose a table for a dine-in order.')
      return
    }

    const items = takeawayCart.map((line) => ({
      foodId: line.foodId,
      quantity: line.quantity,
      optionIds: line.options.map((option) => option.id),
      notes: line.notes,
    }))

    if (!items.length) {
      setTakeawayError('Add at least one menu item to the takeaway order.')
      return
    }

    setCreatingTakeaway(true)
    setTakeawayError(null)

    const result = await callAction(() => createStaffOrder({
      type: orderType,
      tableId: orderType === 'DINE_IN' ? tableId : '',
      customerName: customerName.trim(),
      customerPhone: customerPhone.trim(),
      customerEmail: '',
      notes,
      idempotencyKey: orderKey.current,
      items,
    }))

    setCreatingTakeaway(false)

    if (!result.ok) {
      setTakeawayError(result.error)
      return
    }

    setTakeawayOpen(false)
    setTakeawayCart([])
    setCustomerName('')
    setCustomerPhone('')
    setNotes('')
    setTableId('')
    orderKey.current = newOrderKey()

    const bill = result.data
    toast.success(`Order ${bill.orderNumber} is now in the kitchen`)

    /*
     * The optimistic row carries the SERVER's totals.
     *
     * It used to insert `serviceCharge: 0, taxTotal: 0, grandTotal:
     * takeawayTotal` — the naive line-sum — so the queue showed a total the
     * restaurant does not charge until the next poll quietly corrected it. A
     * cashier who settled in that window took the wrong money. The action now
     * returns what it wrote, so there is nothing to guess.
     */
    setBills((current) => [
      {
        id: bill.orderId,
        orderNumber: bill.orderNumber,
        type: orderType === 'COUNTER' ? 'TAKEAWAY' : orderType,
        // Typed in at the till: staff channel, accepted by being typed in and
        // already in the kitchen (aO.md §1).
        channel: 'STAFF',
        status: 'ACCEPTED',
        paymentStatus: 'UNPAID',
        // The closure still holds the table chosen for this order; the state
        // was cleared for the next one a few lines up.
        tableId: tableId || null,
        tableNumber: bill.tableNumber,
        customerName: bill.customerName,
        customerPhone: customerPhone.trim(),
        placedAt: bill.placedAt,
        heldAt: null,
        holdReason: null,
        subtotal: bill.subtotal,
        discountTotal: bill.discountTotal,
        serviceCharge: bill.serviceCharge,
        taxTotal: bill.taxTotal,
        grandTotal: bill.grandTotal,
        tipAmount: 0,
        paidTotal: 0,
        items: bill.items.map((entry, index) => ({
          id: `${bill.orderId}-${index}`,
          name: entry.name,
          optionsLabel: entry.optionsLabel ?? '',
          quantity: entry.quantity,
          lineTotal: entry.lineTotal,
        })),
      },
      ...current,
    ])
  }

  const onSettled = (billId: string, amount: number, tip: number, fullySettled: boolean) => {
    setCollected((current) => ({ total: current.total + amount, count: current.count + 1 }))
    setBills((current) =>
      fullySettled
        ? current.filter((bill) => bill.id !== billId)
        : current.map((bill) =>
            bill.id === billId
              ? {
                  ...bill,
                  paidTotal: bill.paidTotal + amount,
                  /*
                   * The tip rides on the bill as well as inside the payment:
                   * what is still due is grandTotal + tip − paid. Leaving the
                   * tip off understated the balance by exactly the tip until
                   * the next refresh — the window the second tender happens in.
                   * Status comes from the same derivation the server uses.
                   */
                  tipAmount: bill.tipAmount + tip,
                  paymentStatus: derivePaymentStatus({
                    paidTotal: bill.paidTotal + amount,
                    grandTotal: bill.grandTotal,
                    tipAmount: bill.tipAmount + tip,
                    current: bill.paymentStatus,
                  }),
                }
              : bill,
          ),
    )
    if (fullySettled) setSelectedId(null)
  }

  const outstanding = bills.reduce((sum, bill) => sum + outstandingOn(bill), 0)

  return (
    <Frame embedded={embedded} title="Cashier" subtitle={restaurant.name} branch={branchName} user={user} actions={exit}>
      <AutoRefresh intervalMs={3000} />
      <OpsStats
        items={[
          { label: 'Open bills', value: bills.length, tone: 'warning' },
          {
            label: 'Outstanding',
            value: formatMoney(outstanding, restaurant.currency, restaurant.locale),
            tone: 'primary',
          },
          {
            label: 'Collected today',
            value: formatMoney(collected.total, restaurant.currency, restaurant.locale),
            tone: 'success',
          },
          { label: 'Payments today', value: collected.count },
        ]}
      />

      {/*
        One control row, not two.
        There used to be a "Billing / Payments" toggle above a type filter, so
        collecting money meant knowing to switch tabs first. The bill panel now
        shows the items, the totals and the payment together, which leaves a
        single question here: which bills am I looking at?
      */}
      <div className="flex flex-wrap items-center justify-between gap-3 p-4 pb-0">
        <div className="inline-flex flex-wrap rounded-lg border bg-muted/40 p-1">
          {(
            [
              { key: 'ACTIVE', label: 'Open' },
              { key: 'DINE_IN', label: 'Dine-in' },
              { key: 'TAKEAWAY', label: 'Takeaway' },
              { key: 'HELD', label: heldCount > 0 ? `Held · ${heldCount}` : 'Held' },
            ] as const
          ).map((tab) => (
            <button
              key={tab.key}
              type="button"
              onClick={() => setFilter(tab.key)}
              className={cn(
                'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                filter === tab.key ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground',
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <Button size="sm" onClick={() => setTakeawayOpen(true)}>
          <Plus /> New order
        </Button>
      </div>

      <Dialog open={takeawayOpen} onOpenChange={setTakeawayOpen}>
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle>Create an order</DialogTitle>
            <DialogDescription>Tap a dish to add it, then send it straight to the kitchen.</DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 lg:grid-cols-[1.3fr_0.7fr]">
            <div className="space-y-3">
              <OrderTypeChips value={orderType} onChange={setOrderType} />

              {/*
                The same picker the till uses. This dialog used to draw its own
                list — text rows with no photograph, where the card was not
                clickable and the word "Add" beside the ± buttons was a span
                that did nothing. It was reading the same menu, `imageUrl` and
                all; it just never used it.
              */}
              <MenuPicker
                menu={menu}
                quantityOf={(id) =>
                  takeawayCart.reduce(
                    (total, line) => (line.foodId === id ? total + line.quantity : total),
                    0,
                  )
                }
                onAdd={addTakeawayItem}
                money={(minor) => formatMoney(minor, restaurant.currency, restaurant.locale)}
                compact
              />
            </div>

            <div className="space-y-3 rounded-xl border bg-muted/30 p-3">
              {orderType === 'DINE_IN' ? (
                <div>
                  <label className="mb-1 block text-sm font-medium" htmlFor="cb-table">Table</label>
                  <select
                    id="cb-table"
                    value={tableId}
                    onChange={(event) => setTableId(event.target.value)}
                    className="h-10 w-full rounded-md border bg-background px-2 text-sm"
                  >
                    <option value="">Choose a table…</option>
                    {tables.map((table) => (
                      <option key={table.id} value={table.id}>
                        Table {table.number}
                        {table.area ? ` · ${table.area}` : ''}
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}
              <div>
                <label className="mb-1 block text-sm font-medium">Customer name</label>
                <Input value={customerName} onChange={(event) => setCustomerName(event.target.value)} placeholder="John Doe" />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium">Phone</label>
                <CustomerPhoneField
                  phone={customerPhone}
                  name={customerName}
                  onPhoneChange={setCustomerPhone}
                  onPick={(customer) => {
                    setCustomerPhone(customer.phone)
                    setCustomerName(customer.name)
                  }}
                  placeholder="+91 98765 43210"
                />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium">Kitchen note</label>
                <textarea
                  value={notes}
                  onChange={(event) => setNotes(event.target.value)}
                  className="min-h-[90px] w-full rounded-md border bg-background px-3 py-2 text-sm"
                  placeholder="Any extra instruction?"
                />
              </div>

              <div className="rounded-lg border bg-background p-3">
                <p className="text-sm font-semibold">Order</p>
                {takeawayLines.length === 0 ? (
                  <p className="mt-2 text-xs text-muted-foreground">No items selected yet.</p>
                ) : (
                  <div className="mt-2 space-y-2 text-sm">
                    {/*
                      Editable, not a read-out. This was a list of text, so a
                      cashier who mis-tapped had to close the dialog and start
                      over. `changeTakeawayQty` existed and had no caller here.
                    */}
                    {takeawayLines.map((line) => (
                      <div key={line.key} className="flex items-center gap-2">
                        <div className="min-w-0 flex-1">
                          <p className="truncate">{line.name}</p>
                          {line.options.length > 0 ? (
                            <p className="truncate text-xs text-primary">
                              {line.options.map((option) => option.name).join(' · ')}
                            </p>
                          ) : null}
                          {line.notes ? (
                            <p className="truncate text-xs text-muted-foreground">{line.notes}</p>
                          ) : null}
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                          <Button
                            variant="outline"
                            size="icon-sm"
                            aria-label={`One fewer ${line.name}`}
                            onClick={() => changeTakeawayQty(line.key, -1)}
                          >
                            −
                          </Button>
                          <span className="w-5 text-center text-sm font-semibold tabular-nums">
                            {line.quantity}
                          </span>
                          <Button
                            variant="outline"
                            size="icon-sm"
                            aria-label={`One more ${line.name}`}
                            onClick={() => changeTakeawayQty(line.key, 1)}
                          >
                            +
                          </Button>
                        </div>
                        <span className="w-20 shrink-0 text-right tabular-nums">
                          {formatMoney(line.unitPrice * line.quantity, restaurant.currency, restaurant.locale)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
                <div className="mt-3 flex items-center justify-between border-t pt-2 font-semibold">
                  <span>Total</span>
                  <span className="tabular-nums">{formatMoney(takeawayTotal, restaurant.currency, restaurant.locale)}</span>
                </div>
              </div>

              {takeawayError ? <p className="text-sm font-medium text-destructive">{takeawayError}</p> : null}

              {choosing ? (
                <OptionDialog
                  item={choosing}
                  currency={restaurant.currency}
                  locale={restaurant.locale}
                  money={(minor) => formatMoney(minor, restaurant.currency, restaurant.locale)}
                  onCancel={() => setChoosing(null)}
                  onConfirm={(optionIds, quantity, lineNotes) => {
                    pushTakeawayLine(choosing, optionIds, quantity, lineNotes)
                    setChoosing(null)
                  }}
                />
              ) : null}

              <Button className="w-full" loading={creatingTakeaway} onClick={submitTakeawayOrder}>
                Send to kitchen and bill customer
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={rejecting !== null}
        onOpenChange={(open) => {
          if (!open) {
            setRejecting(null)
            setRejectReason('')
          }
        }}
      >
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>Reject order {rejecting?.orderNumber}</DialogTitle>
            <DialogDescription>
              The guest is told, with your reason. Nothing has been cooked or charged.
            </DialogDescription>
          </DialogHeader>
          <Field label="Reason" htmlFor="reject-reason" required>
            <Textarea
              id="reject-reason"
              value={rejectReason}
              onChange={(event) => setRejectReason(event.target.value)}
              rows={3}
              maxLength={200}
              placeholder="e.g. The kitchen is closing · That dish has run out"
            />
          </Field>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejecting(null)} disabled={decidingId !== null}>
              Keep it
            </Button>
            <Button
              variant="destructive"
              loading={rejecting !== null && decidingId === rejecting.id}
              disabled={rejectReason.trim().length < 2}
              onClick={rejectGuest}
            >
              <X /> Reject order
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className="grid gap-4 p-4 lg:grid-cols-[minmax(0,380px)_1fr]">
        {/* ── open bills ─────────────────────────────────────────── */}
        <section className="space-y-3">
          {/* ── New Orders: QR / online orders awaiting the till (abc.md §5, aO.md §1) ── */}
          {awaiting.length > 0 ? (
            <div className="rounded-xl border border-warning/40 bg-warning/5 p-3" data-testid="awaiting-acceptance">
              <div className="mb-2 flex items-center justify-between">
                <p className="text-sm font-semibold">New Orders</p>
                <Badge variant="warning">{awaiting.length}</Badge>
              </div>
              <ul className="space-y-2">
                {awaiting.map((bill) => (
                  <li key={bill.id} className="rounded-lg border bg-card p-3 shadow-soft">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-bold">#{bill.orderNumber}</span>
                      <div className="flex items-center gap-1.5">
                        <Badge variant="secondary">{channelLabel(bill.channel)}</Badge>
                        {bill.tableNumber ? (
                          <Badge variant="solid">T{bill.tableNumber}</Badge>
                        ) : (
                          <Badge variant="secondary">{bill.type === 'DELIVERY' ? 'Delivery' : 'Pickup'}</Badge>
                        )}
                      </div>
                    </div>
                    <p className="mt-1 truncate text-xs text-muted-foreground">
                      {bill.customerName}
                      {bill.customerPhone ? ` · ${bill.customerPhone}` : ''} ·{' '}
                      {bill.items.reduce((n, item) => n + item.quantity, 0)} item(s) ·{' '}
                      <span className="font-semibold text-foreground">
                        {formatMoney(bill.grandTotal, restaurant.currency, restaurant.locale)}
                      </span>
                    </p>
                    <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                      {bill.items.map((item) => `${item.quantity} × ${item.name}`).join(', ')}
                    </p>
                    {canAccept ? (
                      <div className="mt-2 flex gap-2">
                        <Button
                          size="sm"
                          className="flex-1"
                          loading={decidingId === bill.id}
                          onClick={() => acceptGuest(bill)}
                        >
                          <Check /> Accept
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="flex-1 text-destructive hover:text-destructive"
                          disabled={decidingId === bill.id}
                          onClick={() => setRejecting(bill)}
                        >
                          <X /> Reject
                        </Button>
                      </div>
                    ) : (
                      <p className="mt-2 text-xs text-muted-foreground">
                        Ask a cashier to accept or reject this order.
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search by table, name, order #, phone, or takeaway keyword"
            startIcon={<Search />}
          />

          {filtered.length === 0 ? (
            <EmptyState
              icon={<Receipt />}
              title={search ? 'No matching bills' : 'All settled'}
              description={
                search
                  ? 'Try a different order number, table or name.'
                  : 'Every bill is paid. New ones appear here automatically.'
              }
            />
          ) : (
            <div className="space-y-2">
              <AnimatePresence mode="popLayout">
                {filtered.map((bill) => (
                  <motion.button
                    key={bill.id}
                    layout
                    type="button"
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.98 }}
                    onClick={() => setSelectedId(bill.id)}
                    className={cn(
                      'w-full rounded-xl border bg-card p-3 text-left shadow-soft transition-colors',
                      selected?.id === bill.id ? 'border-primary ring-2 ring-primary/20' : 'hover:bg-muted/40',
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-bold">#{bill.orderNumber}</span>
                      {bill.tableNumber ? (
                        <Badge variant="solid">T{bill.tableNumber}</Badge>
                      ) : (
                        <Badge variant="secondary">Takeaway</Badge>
                      )}
                    </div>
                    <p className="mt-1 truncate text-xs text-muted-foreground">
                      {bill.customerName} · {bill.customerPhone}
                    </p>
                    <p className="mt-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/80">
                      {bill.type === 'TAKEAWAY' ? 'Pickup order' : bill.type.replace('_', ' ').toLowerCase()}
                    </p>
                    <div className="mt-2 flex items-center justify-between">
                      <div className="flex items-center gap-1.5">
                        <OrderStatusBadge status={bill.status} showIcon={false} />
                        <PaymentStatusBadge status={bill.paymentStatus} />
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="font-bold">
                          {formatMoney(outstandingOn(bill), restaurant.currency, restaurant.locale)}
                        </span>
                        {bill.type === 'TAKEAWAY' && (
                          <Button
                            variant="outline"
                            size="icon-sm"
                            onClick={(e) => {
                              e.stopPropagation()
                              try {
                                printReceipt(buildReceipt(bill, restaurant), restaurant.paper.receipt)
                              } catch (err) {
                                toast.error('Unable to print receipt')
                              }
                            }}
                          >
                            <Printer />
                          </Button>
                        )}
                      </div>
                    </div>
                  </motion.button>
                ))}
              </AnimatePresence>
            </div>
          )}
        </section>

        {/* ── bill detail + payment ──────────────────────────────── */}
        <section className="space-y-4">
          {selected ? (
            <>
              <BillingDetailPanel
                key={`detail-${selected.id}`}
                bill={selected}
                restaurant={restaurant}
                otherBills={bills.filter((bill) => bill.id !== selected.id && !bill.heldAt)}
                rewards={rewards}
                menu={menu}
              />
              <BillPanel
                key={`pay-${selected.id}`}
                bill={selected}
                restaurant={restaurant}
                onSettled={onSettled}
              />
            </>
          ) : (
            <EmptyState
              className="h-full"
              icon={<Receipt />}
              title="Select a bill"
              description="Choose an order on the left to view or collect payment."
            />
          )}
        </section>
      </div>
    </Frame>
  )
}

/**
 * The board on its own screen, or inside the POS (abc.md §8).
 *
 * Embedded, the POS shell already drew the header with the tab strip, so the
 * board renders its content bare; on its own it wraps itself in the ops shell
 * as it always did.
 */
function Frame({
  embedded,
  children,
  ...shell
}: {
  embedded: boolean
  children: React.ReactNode
} & Omit<React.ComponentProps<typeof OpsShell>, 'children'>) {
  if (embedded) return <div className="space-y-4">{children}</div>
  return <OpsShell {...shell}>{children}</OpsShell>
}


function BillingDetailPanel({
  bill,
  restaurant,
  otherBills,
  rewards,
  menu,
}: {
  bill: CashierBill
  restaurant: ReceiptRestaurant
  otherBills: CashierBill[]
  rewards: LoyaltyRewardOption[]
  menu: PublicMenu
}) {
  /*
   * Editing a bill after it was placed (order editing): another round for a
   * table, the drinks a takeaway forgot, a counter order corrected before it
   * is paid. Both doors are shut once money is on the bill — the shape of a
   * paid bill does not change — and the kitchen hears about either the
   * moment it happens, exactly as it hears about a guest's own edit.
   */
  const editable = bill.paidTotal === 0 && !bill.heldAt
  const [addOpen, setAddOpen] = React.useState(false)
  const [voiding, setVoiding] = React.useState<{ id: string; name: string } | null>(null)
  const [splitOpen, setSplitOpen] = React.useState(false)
  const [mergeOpen, setMergeOpen] = React.useState(false)
  const [swapOpen, setSwapOpen] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [calling, setCalling] = React.useState(false)

  // abc.md §7: one call per table — a repeat says a waiter is already coming.
  const callWaiter = async () => {
    if (!bill.tableId) return
    setCalling(true)
    const result = await callAction(() =>
      callWaiterAction({ tableId: bill.tableId, note: `From the till · bill ${bill.orderNumber}` }),
    )
    setCalling(false)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    toast.success(
      result.data.created
        ? `A waiter has been called to table ${result.data.tableNumber}`
        : `Table ${result.data.tableNumber} already has a waiter on the way`,
    )
  }

  const print = async () => {
    /*
     * Printing the bill is PRESENTING it: the invoice is finalised first so
     * the paper in the guest's hand carries its number (§57/§92). If minting
     * fails the bill still prints — a guest waiting to pay beats a number —
     * and the next print will try again.
     */
    let invoiceNumber: string | null = null
    const presented = await callAction(() => presentBill({ orderId: bill.id }))
    if (presented.ok) invoiceNumber = presented.data.invoiceNumber
    const receipt = buildReceipt({ ...bill, invoiceNumber }, restaurant)
    let ok = true
    try {
      printReceipt(receipt, restaurant.paper.receipt)
    } catch {
      ok = false
      toast.error('Unable to print receipt')
    }
    // On the record either way (§80) — and never in the way of the paper.
    void callAction(() => recordPrint({ orderId: bill.id, kind: 'BILL', ok, payload: receipt }))
  }

  const download = () => {
    try {
      downloadReceipt(buildReceipt(bill, restaurant), restaurant.paper.receipt)
      toast.success('Receipt saved')
    } catch {
      toast.error('Unable to save receipt')
    }
  }

  const toggleHold = async () => {
    setBusy(true)
    const result = bill.heldAt
      ? await callAction(() => resumeBillAction({ orderId: bill.id }))
      : await callAction(() => holdBillAction({ orderId: bill.id, reason: '' }))
    setBusy(false)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    toast.success(bill.heldAt ? 'Bill resumed' : 'Bill held — find it under Held')
  }

  const settled = bill.paymentStatus === 'PAID'

  return (
    <div className="rounded-xl border bg-card shadow-soft">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b p-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-xl font-bold leading-none">#{bill.orderNumber}</p>
            {bill.heldAt ? (
              <Badge variant="warning">
                <PauseCircle /> Held
              </Badge>
            ) : null}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {bill.customerName} · {bill.customerPhone}
            {bill.tableNumber ? ` · Table ${bill.tableNumber}` : ''}
          </p>
        </div>

        {/* Everything a cashier can do to this bill, in one place. */}
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={print}>
            <Printer /> Print
          </Button>
          <Button variant="outline" size="sm" onClick={download}>
            <Download /> Save
          </Button>
          {!settled ? (
            <>
              {editable ? (
                <Button variant="outline" size="sm" onClick={() => setAddOpen(true)}>
                  <Plus /> Add items
                </Button>
              ) : null}
              <Button variant="outline" size="sm" onClick={() => setSplitOpen(true)}>
                <Split /> Split
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={otherBills.length === 0}
                title={otherBills.length === 0 ? 'No other open bill to merge in' : undefined}
                onClick={() => setMergeOpen(true)}
              >
                <Merge /> Merge
              </Button>
              <Button variant="outline" size="sm" loading={busy} onClick={toggleHold}>
                {bill.heldAt ? <PlayCircle /> : <PauseCircle />}
                {bill.heldAt ? 'Resume' : 'Hold'}
              </Button>
              {bill.type === 'DINE_IN' && bill.tableId ? (
                <>
                  <Button variant="outline" size="sm" onClick={() => setSwapOpen(true)}>
                    <ArrowRightLeft /> Swap table
                  </Button>
                  {/* abc.md §7: the till sends a waiter to the table. */}
                  <Button variant="outline" size="sm" loading={calling} onClick={callWaiter}>
                    <Bell /> Call waiter
                  </Button>
                </>
              ) : null}
            </>
          ) : null}
        </div>
      </header>

      <SplitBillDialog
        open={splitOpen}
        onOpenChange={setSplitOpen}
        bill={bill}
        restaurant={restaurant}
      />
      <AddItemsDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        bill={bill}
        menu={menu}
        restaurant={restaurant}
      />
      <VoidLineDialog
        line={voiding}
        orderId={bill.id}
        onClose={() => setVoiding(null)}
      />
      <MergeBillsDialog
        open={mergeOpen}
        onOpenChange={setMergeOpen}
        bill={bill}
        otherBills={otherBills}
        restaurant={restaurant}
      />
      <SwapTableDialog
        open={swapOpen}
        onOpenChange={setSwapOpen}
        table={bill.tableId ? { id: bill.tableId, number: bill.tableNumber ?? '' } : null}
      />

      {/*
        Points and rewards for whoever this bill belongs to (loyalty spec).
        Only when a guest is on it — an anonymous walk-in has no account, and
        the cashier adds a phone at the door to give them one.
      */}
      {bill.loyalty && rewards.length > 0 ? (
        <div className="px-4 pt-4">
          <TillLoyalty
            orderId={bill.id}
            customerName={bill.loyalty.customerName}
            points={bill.loyalty.points}
            rewards={rewards.map((reward) => ({
              ...reward,
              affordable: bill.loyalty!.points >= reward.pointsCost,
              pointsNeeded: Math.max(0, reward.pointsCost - bill.loyalty!.points),
              meetsMinimum: bill.subtotal >= reward.minOrderAmount,
            }))}
            currency={restaurant.currency}
            locale={restaurant.locale}
          />
        </div>
      ) : null}

      <div className="grid gap-4 p-4 md:grid-cols-[1.1fr_0.9fr]">
        <div>
          <h3 className="mb-2 text-sm font-semibold">Live billing</h3>
          <ul className="space-y-2 text-sm">
            {bill.items.map((item) => (
              <li key={item.id} className="flex justify-between gap-3">
                <span className="min-w-0">
                  <span className="font-medium">
                    {item.quantity} × {item.name}
                  </span>
                  {item.optionsLabel ? (
                    <span className="block text-xs text-muted-foreground">{item.optionsLabel}</span>
                  ) : null}
                  {editable && bill.items.length > 1 ? (
                    <button
                      type="button"
                      className="block text-xs text-muted-foreground underline-offset-2 hover:text-destructive hover:underline"
                      onClick={() => setVoiding({ id: item.id, name: item.name })}
                    >
                      Cancel this item
                    </button>
                  ) : null}
                </span>
                <span className="shrink-0 tabular-nums">
                  {formatMoney(item.lineTotal, restaurant.currency, restaurant.locale)}
                </span>
              </li>
            ))}
          </ul>

          <Separator className="my-3" />

          <dl className="space-y-1 text-sm">
            <SummaryRow label="Subtotal" value={formatMoney(bill.subtotal, restaurant.currency, restaurant.locale)} />
            {bill.discountTotal > 0 ? (
              <SummaryRow
                label="Discount"
                value={`− ${formatMoney(bill.discountTotal, restaurant.currency, restaurant.locale)}`}
              />
            ) : null}
            {bill.serviceCharge > 0 ? (
              <SummaryRow
                label="Service charge"
                value={formatMoney(bill.serviceCharge, restaurant.currency, restaurant.locale)}
              />
            ) : null}
            {bill.taxTotal > 0 ? (
              <SummaryRow
                label={restaurant.taxLabel}
                value={formatMoney(bill.taxTotal, restaurant.currency, restaurant.locale)}
              />
            ) : null}
          </dl>

          <Separator className="my-3" />

          <div className="flex items-center justify-between text-lg font-bold">
            <span>Bill total</span>
            <span>{formatMoney(bill.grandTotal, restaurant.currency, restaurant.locale)}</span>
          </div>
        </div>

        <div className="space-y-3 rounded-lg border bg-muted/30 p-3 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Status</span>
            <OrderStatusBadge status={bill.status} showIcon={false} />
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Payment</span>
            <PaymentStatusBadge status={bill.paymentStatus} />
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Placed</span>
            <span>{formatDateTime(bill.placedAt, { locale: restaurant.locale, timeZone: restaurant.timeZone })}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Due now</span>
            <span className="font-semibold tabular-nums">
              {formatMoney(outstandingOn(bill), restaurant.currency, restaurant.locale)}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Paid</span>
            <span className="tabular-nums">{formatMoney(bill.paidTotal, restaurant.currency, restaurant.locale)}</span>
          </div>
        </div>
      </div>
    </div>
  )
}

function BillPanel({
  bill,
  restaurant,
  onSettled,
}: {
  bill: CashierBill
  restaurant: ReceiptRestaurant
  onSettled: (billId: string, amount: number, tip: number, fullySettled: boolean) => void
}) {
  const due = outstandingOn(bill)
  const [method, setMethod] = React.useState<(typeof METHODS)[number]['key']>('CASH')
  const [taking, setTaking] = React.useState('')
  const [tendered, setTendered] = React.useState('')
  const [reference, setReference] = React.useState('')
  const [tip, setTip] = React.useState('')
  const [pending, setPending] = React.useState(false)
  const [qr, setQr] = React.useState<string | null>(null)
  const [discountOpen, setDiscountOpen] = React.useState(false)

  const tipMinor = tip ? parseMoney(tip, restaurant.currency) : 0
  /*
   * How much of the bill THIS payment covers. Blank means all of it — the
   * common case — but a table paying "half now, half by card" types the half
   * here and settles twice. Partial payment always existed server-side; the
   * till just never offered a way to say it.
   */
  const takingMinor = Math.min(taking ? parseMoney(taking, restaurant.currency) : due, due)
  const amountDue = takingMinor + tipMinor
  const tenderedMinor = tendered ? parseMoney(tendered, restaurant.currency) : 0
  const change = method === 'CASH' && tenderedMinor > amountDue ? tenderedMinor - amountDue : 0

  /*
   * One key per tender attempt.
   *
   * `disabled={pending}` stops the second tap, but it cannot help across a
   * dropped connection: the request commits, the response never arrives, the
   * cashier presses Settle again and the bill is paid twice — right in the
   * drawer and wrong in the takings. The key deliberately SURVIVES a failed
   * attempt, so the retry resolves to the payment already taken; it is
   * regenerated only after a payment lands, because a bill settled in halves
   * is two genuine payments and each needs its own identity.
   */
  const tenderKey = React.useRef(newRequestKey('pay'))

  const settle = async () => {
    setPending(true)
    const result = await callAction(() => collectPayment({
      orderId: bill.id,
      method,
      amount: amountDue,
      tenderedAmount: method === 'CASH' ? tenderedMinor || amountDue : undefined,
      reference: reference || '',
      tipAmount: tipMinor,
      clientRequestId: tenderKey.current,
    }))
    setPending(false)

    if (!result.ok) {
      toast.error(result.error)
      return
    }

    tenderKey.current = newRequestKey('pay')
    toast.success(
      result.data.change > 0
        ? `Paid. Change due ${formatMoney(result.data.change, restaurant.currency, restaurant.locale)}`
        : 'Payment recorded',
    )
    onSettled(bill.id, amountDue, tipMinor, result.data.settled)
    setTaking('')
    setTendered('')
    setReference('')
    setTip('')
  }

  const showQr = async () => {
    const result = await callAction(() => createStaffPaymentQr({ orderId: bill.id, method: 'QR' }))
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    setQr(result.data.qrDataUrl)
  }

  const print = () => {
    const receipt = buildReceipt(bill, restaurant, { paymentMethod: method })
    let ok = true
    try {
      printReceipt(receipt, restaurant.paper.receipt)
    } catch {
      ok = false
    }
    void callAction(() => recordPrint({ orderId: bill.id, kind: 'RECEIPT', ok, payload: receipt }))
  }

  return (
    <div className="rounded-xl border bg-card shadow-soft">
      {/*
        Payment only.
        The itemised bill and its totals are shown once, in the panel directly
        above this one. Repeating them here made the cashier scroll past the
        same numbers twice to reach the keypad.
      */}
      <header className="flex flex-wrap items-center justify-between gap-3 border-b p-4">
        <div>
          <p className="text-sm font-semibold text-muted-foreground">Take payment</p>
          <p className="mt-0.5 text-2xl font-bold leading-none tabular-nums">
            {formatMoney(amountDue, restaurant.currency, restaurant.locale)}
            <span className="ml-2 text-sm font-medium text-muted-foreground">due</span>
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => setDiscountOpen(true)}>
          <Percent /> Discount
        </Button>
      </header>

      <div className="grid gap-4 p-4">
        <div className="space-y-4">
          <div>
            <h3 className="mb-2 text-sm font-semibold">Payment method</h3>
            <div className="grid grid-cols-3 gap-2">
              {METHODS.map((entry) => (
                <button
                  key={entry.key}
                  type="button"
                  onClick={() => setMethod(entry.key)}
                  className={cn(
                    'flex flex-col items-center gap-1.5 rounded-lg border p-3 text-xs font-medium transition-colors',
                    method === entry.key
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'hover:bg-muted/50',
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
              <Field label="Cash tendered" htmlFor="tendered">
                <Input
                  id="tendered"
                  inputMode="decimal"
                  value={tendered}
                  onChange={(event) => setTendered(event.target.value)}
                  placeholder={String(toMajor(amountDue, restaurant.currency))}
                />
              </Field>

              <div className="flex flex-wrap gap-2">
                {quickCash(amountDue, restaurant.currency).map((preset) => (
                  <Button
                    key={preset}
                    variant="outline"
                    size="sm"
                    onClick={() => setTendered(String(toMajor(preset, restaurant.currency)))}
                  >
                    {formatMoney(preset, restaurant.currency, restaurant.locale)}
                  </Button>
                ))}
              </div>

              {change > 0 ? (
                <div className="rounded-lg bg-success/10 px-3 py-2 text-sm font-semibold text-success">
                  Change due {formatMoney(change, restaurant.currency, restaurant.locale)}
                </div>
              ) : null}
            </>
          ) : (
            <Field label="Reference" htmlFor="reference" hint="Transaction id, last 4 digits, etc.">
              <Input
                id="reference"
                value={reference}
                onChange={(event) => setReference(event.target.value)}
                placeholder="Optional"
              />
            </Field>
          )}

          <Field label="Amount to take" htmlFor="taking" hint="Leave blank for the full bill — enter less to split the payment">
            <Input
              id="taking"
              inputMode="decimal"
              value={taking}
              onChange={(event) => setTaking(event.target.value)}
              placeholder={String(toMajor(due, restaurant.currency))}
            />
          </Field>

          <Field label="Tip" htmlFor="tip" hint="Optional">
            <Input
              id="tip"
              inputMode="decimal"
              value={tip}
              onChange={(event) => setTip(event.target.value)}
              placeholder="0"
            />
          </Field>

          {method === 'QR' ? (
            qr ? (
              <div className="flex flex-col items-center gap-2 rounded-lg border p-4">
                <Image src={qr} alt="Payment QR" width={180} height={180} unoptimized />
                <p className="text-xs text-muted-foreground">Show this to the guest</p>
              </div>
            ) : (
              <Button variant="outline" className="w-full" onClick={showQr}>
                <QrCode /> Show payment QR
              </Button>
            )
          ) : null}

          <Button size="lg" className="w-full" loading={pending} onClick={settle}>
            <Check /> Take {formatMoney(amountDue, restaurant.currency, restaurant.locale)}
          </Button>
        </div>
      </div>

      <DiscountDialog
        open={discountOpen}
        onOpenChange={setDiscountOpen}
        orderId={bill.id}
        currency={restaurant.currency}
        locale={restaurant.locale}
        currentDiscount={bill.discountTotal}
      />
    </div>
  )
}

/**
 * Move part of a bill onto a new one.
 *
 * The cashier picks how many of each line go across using the same stepper they
 * already use elsewhere, and the running totals for both sides are shown while
 * they choose — the question at the counter is always "how much does each
 * person owe", so answering it should not require doing the arithmetic.
 */
function SplitBillDialog({
  open,
  onOpenChange,
  bill,
  restaurant,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  bill: CashierBill
  restaurant: { currency: string; locale: string; timeZone?: string | null }
}) {
  const [moves, setMoves] = React.useState<Record<string, number>>({})
  const [pending, setPending] = React.useState(false)

  React.useEffect(() => {
    if (!open) setMoves({})
  }, [open])

  const change = (itemId: string, max: number, delta: number) => {
    setMoves((current) => {
      const next = Math.max(0, Math.min(max, (current[itemId] ?? 0) + delta))
      if (next === 0) {
        const { [itemId]: _dropped, ...rest } = current
        return rest
      }
      return { ...current, [itemId]: next }
    })
  }

  const movedTotal = bill.items.reduce((sum, item) => {
    const qty = moves[item.id] ?? 0
    if (!qty) return sum
    return sum + Math.round(item.lineTotal / item.quantity) * qty
  }, 0)
  const remainingTotal = bill.subtotal - movedTotal

  const movedUnits = Object.values(moves).reduce((sum, qty) => sum + qty, 0)
  const totalUnits = bill.items.reduce((sum, item) => sum + item.quantity, 0)
  const movesEverything = movedUnits > 0 && movedUnits === totalUnits

  const submit = async () => {
    const selections = Object.entries(moves).map(([itemId, quantity]) => ({ itemId, quantity }))
    setPending(true)
    const result = await callAction(() => splitBillAction({ orderId: bill.id, selections }))
    setPending(false)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    toast.success(`Split into ${result.data.targetNumber}`)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Split bill #{bill.orderNumber}</DialogTitle>
          <DialogDescription>
            Choose what moves to a new bill. Everything else stays on this one.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[50vh] space-y-2 overflow-y-auto pr-1">
          {bill.items.map((item) => {
            const moving = moves[item.id] ?? 0
            return (
              <div key={item.id} className="flex items-center gap-3 rounded-lg border p-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{item.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {item.quantity} on this bill ·{' '}
                    {formatMoney(
                      Math.round(item.lineTotal / item.quantity),
                      restaurant.currency,
                      restaurant.locale,
                    )}{' '}
                    each
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <Button
                    type="button"
                    variant="outline"
                    size="icon-sm"
                    disabled={moving === 0}
                    onClick={() => change(item.id, item.quantity, -1)}
                    aria-label={`Move one fewer ${item.name}`}
                  >
                    −
                  </Button>
                  <span className="w-6 text-center text-sm font-semibold tabular-nums">{moving}</span>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon-sm"
                    disabled={moving >= item.quantity}
                    onClick={() => change(item.id, item.quantity, 1)}
                    aria-label={`Move one more ${item.name}`}
                  >
                    +
                  </Button>
                </div>
              </div>
            )
          })}
        </div>

        <div className="grid grid-cols-2 gap-3 rounded-lg border bg-muted/30 p-3 text-sm">
          <div>
            <p className="text-xs text-muted-foreground">Stays on #{bill.orderNumber}</p>
            <p className="font-semibold tabular-nums">
              {formatMoney(remainingTotal, restaurant.currency, restaurant.locale)}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Moves to the new bill</p>
            <p className="font-semibold tabular-nums">
              {formatMoney(movedTotal, restaurant.currency, restaurant.locale)}
            </p>
          </div>
        </div>

        {movesEverything ? (
          <p className="text-sm font-medium text-destructive">
            That moves the whole bill. Leave at least one item behind.
          </p>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button loading={pending} disabled={movedUnits === 0 || movesEverything} onClick={submit}>
            Split bill
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Fold other open bills into this one — the usual "we'll pay together" case. */
function MergeBillsDialog({
  open,
  onOpenChange,
  bill,
  otherBills,
  restaurant,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  bill: CashierBill
  otherBills: CashierBill[]
  restaurant: { currency: string; locale: string; timeZone?: string | null }
}) {
  const [picked, setPicked] = React.useState<string[]>([])
  const [pending, setPending] = React.useState(false)

  React.useEffect(() => {
    if (!open) setPicked([])
  }, [open])

  // A bill with a payment against it cannot be folded away without losing that
  // payment's link to its items, so it is not offered.
  const mergeable = otherBills.filter((entry) => entry.paymentStatus === 'UNPAID')

  const combined =
    bill.grandTotal +
    mergeable
      .filter((entry) => picked.includes(entry.id))
      .reduce((sum, entry) => sum + entry.grandTotal, 0)

  const submit = async () => {
    setPending(true)
    const result = await callAction(() => mergeBillsAction({ targetId: bill.id, sourceIds: picked }))
    setPending(false)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    toast.success(`Merged into ${result.data.targetNumber}`)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Merge into #{bill.orderNumber}</DialogTitle>
          <DialogDescription>
            Pick the bills to fold in. Their items move here and they are closed.
          </DialogDescription>
        </DialogHeader>

        {mergeable.length === 0 ? (
          <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
            No other unpaid bill is open right now.
          </p>
        ) : (
          <div className="max-h-[50vh] space-y-2 overflow-y-auto pr-1">
            {mergeable.map((entry) => {
              const checked = picked.includes(entry.id)
              return (
                <button
                  key={entry.id}
                  type="button"
                  onClick={() =>
                    setPicked((current) =>
                      checked ? current.filter((id) => id !== entry.id) : [...current, entry.id],
                    )
                  }
                  className={cn(
                    'flex w-full items-center gap-3 rounded-lg border p-3 text-left transition-colors',
                    checked ? 'border-primary bg-primary/5 ring-1 ring-primary/20' : 'hover:bg-muted/40',
                  )}
                >
                  <span
                    className={cn(
                      'flex size-5 shrink-0 items-center justify-center rounded border',
                      checked ? 'border-primary bg-primary text-primary-foreground' : 'bg-background',
                    )}
                    aria-hidden="true"
                  >
                    {checked ? <Check className="size-3.5" /> : null}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-semibold">#{entry.orderNumber}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {entry.tableNumber ? `Table ${entry.tableNumber}` : 'Takeaway'} · {entry.customerName}
                    </span>
                  </span>
                  <span className="shrink-0 text-sm font-semibold tabular-nums">
                    {formatMoney(entry.grandTotal, restaurant.currency, restaurant.locale)}
                  </span>
                </button>
              )
            })}
          </div>
        )}

        {picked.length > 0 ? (
          <div className="flex items-center justify-between rounded-lg border bg-muted/30 p-3 text-sm">
            <span className="text-muted-foreground">Combined bill</span>
            <span className="font-semibold tabular-nums">
              {formatMoney(combined, restaurant.currency, restaurant.locale)}
            </span>
          </div>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button loading={pending} disabled={picked.length === 0} onClick={submit}>
            Merge {picked.length > 0 ? `${picked.length} bill${picked.length > 1 ? 's' : ''}` : ''}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  )
}

function DiscountDialog({
  open,
  onOpenChange,
  orderId,
  currency,
  locale,
  currentDiscount,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  orderId: string
  currency: string
  locale: string
  currentDiscount: number
}) {
  const [amount, setAmount] = React.useState(String(toMajor(currentDiscount, currency)))
  const [reason, setReason] = React.useState('')
  const [pending, setPending] = React.useState(false)

  const apply = async () => {
    setPending(true)
    const result = await callAction(() => applyManualDiscount({
      orderId,
      amount: parseMoney(amount, currency),
      reason,
    }))
    setPending(false)

    if (!result.ok) {
      toast.error(result.error)
      return
    }
    toast.success(`New total ${formatMoney(result.data.grandTotal, currency, locale)}`)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Apply a discount</DialogTitle>
          <DialogDescription>
            Recorded in the audit log against your account.
          </DialogDescription>
        </DialogHeader>

        <Field label="Discount amount" htmlFor="discount-amount">
          <Input
            id="discount-amount"
            inputMode="decimal"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
          />
        </Field>

        <Field label="Reason" htmlFor="discount-reason">
          <Input
            id="discount-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Loyal guest, service delay…"
          />
        </Field>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button loading={pending} onClick={apply}>
            Apply discount
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}


/**
 * A key for one order.
 *
 * `crypto.randomUUID` needs a secure context and a recent engine, which a
 * counter tablet may not have; the fallback only has to be unique among the
 * orders one till places.
 */
/**
 * More dishes for a bill that already exists.
 *
 * The same picker and the same option chooser the new-order dialog uses, so
 * a cashier learns one screen. The lines are kept here until "Add to bill",
 * then sent as one request: one round trip, one event on the order's history,
 * one message to the kitchen — not one of each per dish.
 */
function AddItemsDialog({
  open,
  onOpenChange,
  bill,
  menu,
  restaurant,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  bill: CashierBill
  menu: PublicMenu
  restaurant: ReceiptRestaurant
}) {
  const router = useRouter()
  const [cart, setCart] = React.useState<TakeawayLine[]>([])
  const [choosing, setChoosing] = React.useState<PublicMenuItem | null>(null)
  const [pending, setPending] = React.useState(false)
  const money = (minor: number) => formatMoney(minor, restaurant.currency, restaurant.locale)

  const push = (item: PublicMenuItem, optionIds: string[], quantity: number, notes: string) => {
    const chosen = item.groups
      .flatMap((group) => group.options)
      .filter((option) => optionIds.includes(option.id))
    setCart((current) => [
      ...current,
      {
        key: `${item.id}-${Date.now()}-${current.length}`,
        foodId: item.id,
        name: item.name,
        quantity,
        unitPrice: item.price + chosen.reduce((sum, option) => sum + option.priceDelta, 0),
        options: chosen.map((option) => ({ id: option.id, name: option.name, priceDelta: option.priceDelta })),
        notes,
      },
    ])
  }

  const add = (item: PublicMenuItem) => {
    if (item.groups.length > 0) {
      setChoosing(item)
      return
    }
    push(item, [], 1, '')
  }

  const close = () => {
    setCart([])
    setChoosing(null)
    onOpenChange(false)
  }

  const submit = async () => {
    if (cart.length === 0) return
    setPending(true)
    const result = await callAction(() =>
      addItemsToBillAction({
        orderId: bill.id,
        items: cart.map((line) => ({
          foodId: line.foodId,
          quantity: line.quantity,
          optionIds: line.options.map((option) => option.id),
          notes: line.notes || undefined,
        })),
      }),
    )
    setPending(false)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    toast.success(`${result.data.added} item${result.data.added === 1 ? '' : 's'} added to ${bill.orderNumber} — the kitchen has them`)
    close()
    router.refresh()
  }

  const total = cart.reduce((sum, line) => sum + line.unitPrice * line.quantity, 0)

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Add to {bill.orderNumber}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4 md:grid-cols-[1.2fr_0.8fr]">
          <MenuPicker
            menu={menu}
            quantityOf={(id) => cart.reduce((sum, line) => (line.foodId === id ? sum + line.quantity : sum), 0)}
            onAdd={add}
            money={money}
            compact
          />
          <div className="space-y-3 rounded-xl border bg-muted/30 p-3">
            <p className="text-sm font-semibold">Adding</p>
            {cart.length === 0 ? (
              <p className="text-sm text-muted-foreground">Tap a dish to add it.</p>
            ) : (
              <ul className="space-y-1.5 text-sm">
                {cart.map((line) => (
                  <li key={line.key} className="flex items-center justify-between gap-2">
                    <span className="min-w-0 truncate">
                      {line.quantity} × {line.name}
                      {line.options.length > 0 ? (
                        <span className="block text-xs text-muted-foreground">
                          {line.options.map((option) => option.name).join(', ')}
                        </span>
                      ) : null}
                    </span>
                    <span className="flex shrink-0 items-center gap-1">
                      <span className="tabular-nums">{money(line.unitPrice * line.quantity)}</span>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Remove ${line.name}`}
                        onClick={() => setCart((current) => current.filter((row) => row.key !== line.key))}
                      >
                        <X />
                      </Button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex items-center justify-between border-t pt-2 text-sm font-semibold">
              <span>Adds</span>
              <span className="tabular-nums">{money(total)}</span>
            </div>
            <Button className="w-full" disabled={cart.length === 0 || pending} loading={pending} onClick={submit}>
              Add to bill
            </Button>
            <p className="text-xs text-muted-foreground">
              These go straight to the kitchen and onto the bill.
            </p>
          </div>
        </div>
        {choosing ? (
          <OptionDialog
            item={choosing}
            currency={restaurant.currency}
            locale={restaurant.locale}
            money={money}
            onCancel={() => setChoosing(null)}
            onConfirm={(optionIds, quantity, lineNotes) => {
              push(choosing, optionIds, quantity, lineNotes)
              setChoosing(null)
            }}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

/**
 * Taking a dish off a bill after it was placed.
 *
 * A reason is required, always. The kitchen may already be cooking it and
 * its cost has to land somewhere visible; the line stays on the ticket
 * crossed out so nobody makes it, and the order's history says who took it
 * back and why. The last line on a bill cannot be cancelled this way — that
 * is cancelling the bill, which is its own act with its own guards.
 */
function VoidLineDialog({
  line,
  orderId,
  onClose,
}: {
  line: { id: string; name: string } | null
  orderId: string
  onClose: () => void
}) {
  const router = useRouter()
  const [reason, setReason] = React.useState('')
  const [pending, setPending] = React.useState(false)

  React.useEffect(() => {
    if (line) setReason('')
  }, [line])

  const confirm = async () => {
    if (!line || reason.trim().length < 2) return
    setPending(true)
    const result = await callAction(() => voidItemAction({ orderId, itemId: line.id, reason: reason.trim() }))
    setPending(false)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    toast.success(`${line.name} taken off the bill — the kitchen has been told`)
    onClose()
    router.refresh()
  }

  return (
    <Dialog open={line !== null} onOpenChange={(next) => (next ? null : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Cancel {line?.name}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            It comes off the bill and shows crossed out on the kitchen display so nobody makes it. Say why.
          </p>
          <Input
            autoFocus
            placeholder="Guest changed their mind"
            maxLength={200}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void confirm()
            }}
          />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>Keep it</Button>
            <Button variant="destructive" disabled={pending || reason.trim().length < 2} loading={pending} onClick={confirm}>
              Cancel item
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function newOrderKey(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `cb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}
