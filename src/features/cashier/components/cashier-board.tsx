'use client'

import * as React from 'react'
import Image from 'next/image'
import { AnimatePresence, motion } from 'framer-motion'
import {
  Banknote,
  Check,
  CreditCard,
  Download,
  Merge,
  PauseCircle,
  Percent,
  PlayCircle,
  Plus,
  Printer,
  QrCode,
  Receipt,
  Search,
  Smartphone,
  Split,
  Wallet,
} from 'lucide-react'
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
import { EmptyState } from '@/components/ui/feedback'
import { Field } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Separator } from '@/components/ui/primitives'
import { OrderStatusBadge, PaymentStatusBadge } from '@/components/ui/status'
import { OpsShell, OpsStats } from '@/components/ops-shell'
import { AutoRefresh } from '@/components/auto-refresh'
import { EVENTS, type OrderSummaryPayload, type PaymentPayload } from '@/lib/realtime/events'
import { formatMoney, parseMoney, toMajor } from '@/lib/money'
import { cn } from '@/lib/utils'
import { useSocketEvent } from '@/hooks/use-socket'
import { downloadReceipt, printReceipt } from '@/features/printing/print'
import { applyManualDiscount, createStaffOrder } from '@/features/orders/actions'
import { collectPayment, createStaffPaymentQr } from '@/features/payments/actions'
import {
  holdBillAction,
  mergeBillsAction,
  resumeBillAction,
  splitBillAction,
} from '@/features/cashier/actions'
import type { PublicMenu, PublicMenuItem } from '@/features/menu/queries'

export interface CashierBill {
  id: string
  orderNumber: string
  type: 'DINE_IN' | 'TAKEAWAY' | 'DELIVERY'
  status: 'PENDING' | 'ACCEPTED' | 'PREPARING' | 'READY' | 'SERVED' | 'COMPLETED'
  paymentStatus: 'UNPAID' | 'PARTIAL' | 'PAID' | 'REFUNDED' | 'FAILED'
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
  paidTotal: number
  items: Array<{ id: string; name: string; optionsLabel: string; quantity: number; lineTotal: number }>
}

type BillFilter = 'ACTIVE' | 'DINE_IN' | 'TAKEAWAY' | 'HELD'

const METHODS = [
  { key: 'CASH' as const, label: 'Cash', icon: Banknote },
  { key: 'CARD' as const, label: 'Card', icon: CreditCard },
  { key: 'QR' as const, label: 'QR / UPI', icon: QrCode },
  { key: 'ONLINE' as const, label: 'Online', icon: Smartphone },
  { key: 'WALLET' as const, label: 'Wallet', icon: Wallet },
]

export function CashierBoard({
  initialBills,
  todayTotal,
  todayCount,
  user,
  restaurant,
  menu,
  startInTakeaway = false,
}: {
  initialBills: CashierBill[]
  todayTotal: number
  todayCount: number
  user: { name: string; role: string }
  menu: PublicMenu
  startInTakeaway?: boolean
  restaurant: {
    name: string
    currency: string
    locale: string
    taxLabel: string
    addressLine: string | null
    phone: string | null
  }
}) {
  const [bills, setBills] = React.useState(initialBills)
  const [search, setSearch] = React.useState('')
  const [selectedId, setSelectedId] = React.useState<string | null>(initialBills[0]?.id ?? null)
  const [filter, setFilter] = React.useState<BillFilter>('ACTIVE')
  const [collected, setCollected] = React.useState({ total: todayTotal, count: todayCount })
  const [takeawayOpen, setTakeawayOpen] = React.useState(startInTakeaway)
  const [menuSearch, setMenuSearch] = React.useState('')
  const [customerName, setCustomerName] = React.useState('')
  const [customerPhone, setCustomerPhone] = React.useState('')
  const [notes, setNotes] = React.useState('')
  const [takeawayCart, setTakeawayCart] = React.useState<Record<string, number>>({})
  const [creatingTakeaway, setCreatingTakeaway] = React.useState(false)
  const [takeawayError, setTakeawayError] = React.useState<string | null>(null)

  // Re-sync when polling (realtime off / serverless).
  React.useEffect(() => setBills(initialBills), [initialBills])

  useSocketEvent(EVENTS.ORDER_CREATED, (payload: OrderSummaryPayload) => {
    toast.info(`New order ${payload.orderNumber}`, {
      description: payload.tableNumber ? `Table ${payload.tableNumber}` : undefined,
    })
  })

  useSocketEvent(EVENTS.PAYMENT_RECEIVED, (payload: PaymentPayload) => {
    setBills((current) => current.filter((bill) => bill.id !== payload.orderId))
    setCollected((current) => ({ total: current.total + payload.amount, count: current.count + 1 }))
  })

  const filtered = React.useMemo(() => {
    const query = search.trim().toLowerCase()
    const tableQuery = query.startsWith('t') ? query.slice(1).trim() : query
    const takeawayKeywords = ['takeaway', 'take away', 'pickup', 'pick up', 'collection', 'takeout']

    let result = bills.filter((bill) => {
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

  const selected = filtered.find((bill) => bill.id === selectedId) ?? filtered[0] ?? null

  const availableMenu = React.useMemo(
    () =>
      menu.items.filter(
        (item) => item.isAvailable && (menuSearch.trim() === '' || item.name.toLowerCase().includes(menuSearch.trim().toLowerCase())),
      ),
    [menu.items, menuSearch],
  )

  const takeawayLines = React.useMemo(
    () =>
      menu.items
        .filter((item) => takeawayCart[item.id])
        .map((item) => ({ id: item.id, name: item.name, quantity: takeawayCart[item.id], price: item.price })),
    [menu.items, takeawayCart],
  )

  const takeawayTotal = React.useMemo(
    () => takeawayLines.reduce((sum, item) => sum + item.price * item.quantity, 0),
    [takeawayLines],
  )

  const addTakeawayItem = (item: PublicMenuItem) => {
    setTakeawayCart((current) => ({ ...current, [item.id]: (current[item.id] ?? 0) + 1 }))
  }

  const changeTakeawayQty = (itemId: string, delta: number) => {
    setTakeawayCart((current) => {
      const next = (current[itemId] ?? 0) + delta
      if (next <= 0) {
        const { [itemId]: _removed, ...rest } = current
        return rest
      }
      return { ...current, [itemId]: next }
    })
  }

  const submitTakeawayOrder = async () => {
    if (!customerName.trim() || !customerPhone.trim()) {
      setTakeawayError('Enter the customer name and phone number.')
      return
    }

    const items = menu.items
      .filter((item) => takeawayCart[item.id])
      .map((item) => ({
        foodId: item.id,
        quantity: takeawayCart[item.id],
        optionIds: [],
        notes: '',
      }))

    if (!items.length) {
      setTakeawayError('Add at least one menu item to the takeaway order.')
      return
    }

    setCreatingTakeaway(true)
    setTakeawayError(null)

    const result = await createStaffOrder({
      type: 'TAKEAWAY',
      tableId: '',
      customerName: customerName.trim(),
      customerPhone: customerPhone.trim(),
      customerEmail: '',
      notes,
      items,
    })

    setCreatingTakeaway(false)

    if (!result.ok) {
      setTakeawayError(result.error)
      return
    }

    setTakeawayOpen(false)
    setTakeawayCart({})
    setCustomerName('')
    setCustomerPhone('')
    setNotes('')
    setMenuSearch('')
    const next = { ...result.data, orderNumber: result.data.orderNumber }
    toast.success(`Takeaway order ${result.data.orderNumber} is now in the kitchen`)
    setBills((current) => [
      {
        id: next.orderId,
        orderNumber: next.orderNumber,
        type: 'TAKEAWAY',
        status: 'PENDING',
        paymentStatus: 'UNPAID',
        tableNumber: null,
        customerName: customerName.trim(),
        customerPhone: customerPhone.trim(),
        placedAt: new Date().toISOString(),
        heldAt: null,
        holdReason: null,
        subtotal: takeawayTotal,
        discountTotal: 0,
        serviceCharge: 0,
        taxTotal: 0,
        grandTotal: takeawayTotal,
        paidTotal: 0,
        items: takeawayLines.map((entry) => ({
          id: `${entry.id}-takeaway`,
          name: entry.name,
          optionsLabel: '',
          quantity: entry.quantity,
          lineTotal: entry.price * entry.quantity,
        })),
      },
      ...current,
    ])
  }

  const onSettled = (billId: string, amount: number, fullySettled: boolean) => {
    setCollected((current) => ({ total: current.total + amount, count: current.count + 1 }))
    setBills((current) =>
      fullySettled
        ? current.filter((bill) => bill.id !== billId)
        : current.map((bill) =>
            bill.id === billId ? { ...bill, paidTotal: bill.paidTotal + amount, paymentStatus: 'PARTIAL' } : bill,
          ),
    )
    if (fullySettled) setSelectedId(null)
  }

  const outstanding = bills.reduce((sum, bill) => sum + (bill.grandTotal - bill.paidTotal), 0)

  return (
    <OpsShell title="Cashier" subtitle={restaurant.name} user={user}>
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
          <Plus /> New takeaway
        </Button>
      </div>

      <Dialog open={takeawayOpen} onOpenChange={setTakeawayOpen}>
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle>Create takeaway order</DialogTitle>
            <DialogDescription>Pick menu items, add customer details, and send it straight to the kitchen.</DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 lg:grid-cols-[1.3fr_0.7fr]">
            <div className="space-y-3">
              <Input
                value={menuSearch}
                onChange={(event) => setMenuSearch(event.target.value)}
                placeholder="Search menu items…"
              />

              <div className="grid max-h-[420px] gap-3 overflow-y-auto pr-1 md:grid-cols-2">
                {availableMenu.length === 0 ? (
                  <div className="rounded-xl border border-dashed p-6 text-sm text-muted-foreground md:col-span-2">
                    No menu items match this search.
                  </div>
                ) : (
                  availableMenu.map((item) => (
                    <div key={item.id} className="rounded-xl border bg-card p-3">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="font-semibold">{item.name}</p>
                          {item.description ? (
                            <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{item.description}</p>
                          ) : null}
                        </div>
                        <Badge variant="secondary">{formatMoney(item.price, restaurant.currency, restaurant.locale)}</Badge>
                      </div>

                      <div className="mt-3 flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <Button variant="outline" size="icon-sm" onClick={() => changeTakeawayQty(item.id, -1)}>
                            −
                          </Button>
                          <span className="w-5 text-center text-sm font-semibold tabular-nums">
                            {takeawayCart[item.id] ?? 0}
                          </span>
                          <Button variant="outline" size="icon-sm" onClick={() => addTakeawayItem(item)}>
                            +
                          </Button>
                        </div>
                        <span className="text-xs text-muted-foreground">
                          {takeawayCart[item.id] ? `${takeawayCart[item.id]} selected` : 'Add'}
                        </span>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>

            <div className="space-y-3 rounded-xl border bg-muted/30 p-3">
              <div>
                <label className="mb-1 block text-sm font-medium">Customer name</label>
                <Input value={customerName} onChange={(event) => setCustomerName(event.target.value)} placeholder="John Doe" />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium">Phone</label>
                <Input value={customerPhone} onChange={(event) => setCustomerPhone(event.target.value)} placeholder="+91 98765 43210" />
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
                <p className="text-sm font-semibold">Takeaway bill</p>
                {takeawayLines.length === 0 ? (
                  <p className="mt-2 text-xs text-muted-foreground">No items selected yet.</p>
                ) : (
                  <div className="mt-2 space-y-2 text-sm">
                    {takeawayLines.map((item) => (
                      <div key={item.id} className="flex items-center justify-between gap-3">
                        <span>
                          {item.quantity} × {item.name}
                        </span>
                        <span className="tabular-nums">
                          {formatMoney(item.price * item.quantity, restaurant.currency, restaurant.locale)}
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

              <Button className="w-full" loading={creatingTakeaway} onClick={submitTakeawayOrder}>
                Send to kitchen and bill customer
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <div className="grid gap-4 p-4 lg:grid-cols-[minmax(0,380px)_1fr]">
        {/* ── open bills ─────────────────────────────────────────── */}
        <section className="space-y-3">
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
                          {formatMoney(bill.grandTotal - bill.paidTotal, restaurant.currency, restaurant.locale)}
                        </span>
                        {bill.type === 'TAKEAWAY' && (
                          <Button
                            variant="outline"
                            size="icon-sm"
                            onClick={(e) => {
                              e.stopPropagation()
                              try {
                                printReceipt(buildReceiptForBill(bill, restaurant))
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
    </OpsShell>
  )
}

function buildReceiptForBill(
  bill: CashierBill,
  restaurant: {
    name: string
    currency: string
    locale: string
    taxLabel: string
    addressLine: string | null
    phone: string | null
  },
  paymentMethod?: string | null,
) {
  return {
    restaurantName: restaurant.name,
    addressLine: restaurant.addressLine,
    phone: restaurant.phone,
    orderNumber: bill.orderNumber,
    tableNumber: bill.tableNumber,
    customerName: bill.customerName,
    placedAt: bill.placedAt,
    paymentMethod,
    lines: bill.items.map((item) => ({
      name: item.name,
      optionsLabel: item.optionsLabel,
      quantity: item.quantity,
      lineTotal: formatMoney(item.lineTotal, restaurant.currency, restaurant.locale),
    })),
    totals: [
      { label: 'Subtotal', value: formatMoney(bill.subtotal, restaurant.currency, restaurant.locale) },
      ...(bill.discountTotal
        ? [{ label: 'Discount', value: `-${formatMoney(bill.discountTotal, restaurant.currency, restaurant.locale)}` }]
        : []),
      ...(bill.serviceCharge
        ? [{ label: 'Service', value: formatMoney(bill.serviceCharge, restaurant.currency, restaurant.locale) }]
        : []),
      ...(bill.taxTotal
        ? [{ label: restaurant.taxLabel, value: formatMoney(bill.taxTotal, restaurant.currency, restaurant.locale) }]
        : []),
      {
        label: 'TOTAL',
        value: formatMoney(bill.grandTotal, restaurant.currency, restaurant.locale),
        strong: true,
      },
    ],
  }
}

function BillingDetailPanel({
  bill,
  restaurant,
  otherBills,
}: {
  bill: CashierBill
  restaurant: {
    name: string
    currency: string
    locale: string
    taxLabel: string
    addressLine: string | null
    phone: string | null
  }
  otherBills: CashierBill[]
}) {
  const [splitOpen, setSplitOpen] = React.useState(false)
  const [mergeOpen, setMergeOpen] = React.useState(false)
  const [busy, setBusy] = React.useState(false)

  const print = () => {
    try {
      printReceipt(buildReceiptForBill(bill, restaurant))
    } catch {
      toast.error('Unable to print receipt')
    }
  }

  const download = () => {
    try {
      downloadReceipt(buildReceiptForBill(bill, restaurant))
      toast.success('Receipt saved')
    } catch {
      toast.error('Unable to save receipt')
    }
  }

  const toggleHold = async () => {
    setBusy(true)
    const result = bill.heldAt
      ? await resumeBillAction({ orderId: bill.id })
      : await holdBillAction({ orderId: bill.id, reason: '' })
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
      <MergeBillsDialog
        open={mergeOpen}
        onOpenChange={setMergeOpen}
        bill={bill}
        otherBills={otherBills}
        restaurant={restaurant}
      />

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
            <span>{new Date(bill.placedAt).toLocaleString(restaurant.locale)}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Due now</span>
            <span className="font-semibold tabular-nums">
              {formatMoney(Math.max(0, bill.grandTotal - bill.paidTotal), restaurant.currency, restaurant.locale)}
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
  restaurant: {
    name: string
    currency: string
    locale: string
    taxLabel: string
    addressLine: string | null
    phone: string | null
  }
  onSettled: (billId: string, amount: number, fullySettled: boolean) => void
}) {
  const due = Math.max(0, bill.grandTotal - bill.paidTotal)
  const [method, setMethod] = React.useState<(typeof METHODS)[number]['key']>('CASH')
  const [tendered, setTendered] = React.useState('')
  const [reference, setReference] = React.useState('')
  const [tip, setTip] = React.useState('')
  const [pending, setPending] = React.useState(false)
  const [qr, setQr] = React.useState<string | null>(null)
  const [discountOpen, setDiscountOpen] = React.useState(false)

  const tipMinor = tip ? parseMoney(tip, restaurant.currency) : 0
  const amountDue = due + tipMinor
  const tenderedMinor = tendered ? parseMoney(tendered, restaurant.currency) : 0
  const change = method === 'CASH' && tenderedMinor > amountDue ? tenderedMinor - amountDue : 0

  const settle = async () => {
    setPending(true)
    const result = await collectPayment({
      orderId: bill.id,
      method,
      amount: amountDue,
      tenderedAmount: method === 'CASH' ? tenderedMinor || amountDue : undefined,
      reference: reference || '',
      tipAmount: tipMinor,
    })
    setPending(false)

    if (!result.ok) {
      toast.error(result.error)
      return
    }

    toast.success(
      result.data.change > 0
        ? `Paid. Change due ${formatMoney(result.data.change, restaurant.currency, restaurant.locale)}`
        : 'Payment recorded',
    )
    onSettled(bill.id, amountDue, result.data.settled)
    setTendered('')
    setReference('')
    setTip('')
  }

  const showQr = async () => {
    const result = await createStaffPaymentQr({ orderId: bill.id, method: 'QR' })
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    setQr(result.data.qrDataUrl)
  }

  const print = () => {
    printReceipt(buildReceiptForBill(bill, restaurant, method))
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
  restaurant: { currency: string; locale: string }
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
    const result = await splitBillAction({ orderId: bill.id, selections })
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
  restaurant: { currency: string; locale: string }
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
    const result = await mergeBillsAction({ targetId: bill.id, sourceIds: picked })
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
    const result = await applyManualDiscount({
      orderId,
      amount: parseMoney(amount, currency),
      reason,
    })
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

/** Cash-drawer style presets: exact, then the next sensible round notes. */
function quickCash(amountMinor: number, currency: string): number[] {
  const factor = currency.toUpperCase() === 'JPY' ? 1 : 100
  const major = amountMinor / factor
  const rounds = [50, 100, 200, 500, 1000, 2000]
  const presets = rounds.filter((value) => value > major).slice(0, 3)
  return [amountMinor, ...presets.map((value) => value * factor)]
}
