'use client'

import { useState } from 'react'
import { Banknote, Bike, CheckCircle2, ChevronDown, Clock, KeyRound, Lock, Phone, Receipt, ShoppingBag, Timer, UserCheck, Wallet } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

import { cn } from '@/lib/utils'

import { rs } from './data'
import { PosCashier } from './pos-cashier'
import { PosOrders } from './pos-orders'
import { DESK_ACTIONS, DESK_ORDERS, DESK_STEPS, INCOMING, OPEN_BILLS, type Bill, type DeskOrder, type IncomingOrder } from './pos-data'
import { Card, CardTitle, Field, Pill, Stat, useNotify, type QrShape, type Tone } from './ui'

type Tab = 'Orders' | 'Delivery' | 'Cashier' | 'Drawer' | 'Shift'

const TABS: { id: Tab; icon: LucideIcon }[] = [
  { id: 'Orders', icon: ShoppingBag },
  { id: 'Delivery', icon: Bike },
  { id: 'Cashier', icon: Receipt },
  { id: 'Drawer', icon: Banknote },
  { id: 'Shift', icon: Clock },
]

/** Everything on this list is in the real till; the demo lets you try most of it. */
const FEATURES: { group: string; items: string[] }[] = [
  {
    group: 'Customer',
    items: [
      'Find a customer by phone as you type',
      'Name fills in automatically on a match',
      'Add a customer without leaving the till',
      'Category, birthday, anniversary, address and notes',
      'Points balance and what it is worth',
      'Offers checked for that customer and basket',
      'The reason shown when an offer does not apply',
      'Redeem points on the bill',
      'Rewards catalogue with points cost',
      'Block a customer from ordering',
    ],
  },
  {
    group: 'Taking the order',
    items: [
      'Dine in, Counter, Takeaway and Delivery',
      'Table picker with area and status',
      'Guest count per table',
      'Served-by for staff sales reports',
      'Order notes and delivery address',
      'Search by dish name or code',
      'Category chips',
      'Photo tiles with code and price',
      'Sizes that change the price',
      'Add-ons with a maximum',
      'Sold-out dishes and options handled',
      'Note for the kitchen on each dish',
      'Quantity stepper up to 50',
      'Change the options on a line',
      'Discount a single line with a reason',
      'Send to kitchen and bill in one tap',
      'Protection against double-sending',
    ],
  },
  {
    group: 'Bills',
    items: [
      'Live queue of open bills',
      'Filters: open, dine-in, takeaway, held',
      'Search by table, name, order number or phone',
      'Accept or reject QR and online orders',
      'Alert when a new order arrives',
      'Start a new order from the cashier tab',
      'Edit an order after it is sent',
      'Cancel a dish with a reason',
      'Split a bill between guests',
      'Merge bills for a group',
      'Hold a bill and resume it later',
      'Move the sitting to another table',
      'Call a waiter to the table',
      'Print the bill, every print logged',
      'Save the receipt as a file',
      'Automatic invoice numbers',
    ],
  },
  {
    group: 'Payment',
    items: [
      'Whole-bill discount by amount or percent',
      'Large discounts go to a manager for approval',
      'Cash, card, QR pay, online, wallet, bank transfer, other',
      'Cash tendered with quick-cash buttons',
      'Change due worked out for you',
      'Reference number for non-cash payments',
      'Split one bill across several payment methods',
      'Part payment with the balance left open',
      'Tips recorded separately',
      'Payment QR to show the guest',
      'Service charge and tax added automatically',
      'Rounding to your rule',
    ],
  },
  {
    group: 'Delivery, drawer and shift',
    items: [
      'Delivery desk with every stage',
      'Tap to call the customer',
      'Handover PIN for the rider',
      'Open the drawer with a float',
      'Cash in and cash out with a reason',
      'Expected cash always on screen',
      'Count the drawer when closing',
      'Short or over goes to a manager',
      'Hand the till to the next cashier',
      'Shift summary and history',
      'One counter per branch',
      'Each person sees only their tabs',
    ],
  },
]

const FEATURE_COUNT = FEATURES.reduce((n, g) => n + g.items.length, 0)

export function Pos({ qr }: { qr: QrShape }) {
  const [tab, setTab] = useState<Tab>('Orders')
  const [bills, setBills] = useState<Bill[]>(OPEN_BILLS)
  const [incoming, setIncoming] = useState<IncomingOrder[]>(INCOMING)
  const [nextNo, setNextNo] = useState(1048)
  const [showAll, setShowAll] = useState(false)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-base font-bold">POS</p>
          <p className="tfd-muted text-xs">Spice Garden · Colombo 03 · Sara (Cashier)</p>
        </div>
        <div role="tablist" aria-label="POS tabs" className="tfd-track tfd-scroll flex max-w-full gap-1 overflow-x-auto rounded-full p-1">
          {TABS.map(({ id, icon: Icon }) => (
            <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)} className="tfd-tab flex shrink-0 items-center gap-1.5 rounded-full px-3.5 py-2 text-xs font-semibold">
              <Icon className="h-3.5 w-3.5" aria-hidden />
              {id}
              {id === 'Cashier' && incoming.length > 0 ? <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-white px-1 text-[10px] font-bold text-orange-600">{incoming.length}</span> : null}
            </button>
          ))}
        </div>
      </div>

      {/* Tabs stay mounted so an order in progress survives a look at another tab. */}
      <div className={cn(tab !== 'Orders' && 'hidden')}>
        <PosOrders
          nextNo={nextNo}
          onSend={(bill) => {
            setBills((current) => [...current, bill])
            setNextNo((n) => n + 1)
          }}
        />
      </div>
      <div className={cn(tab !== 'Cashier' && 'hidden')}>
        <PosCashier bills={bills} setBills={setBills} incoming={incoming} setIncoming={setIncoming} nextNo={nextNo} bumpNo={() => setNextNo((n) => n + 1)} qr={qr} onNewOrder={() => setTab('Orders')} />
      </div>
      {tab === 'Delivery' ? <DeliveryDesk /> : null}
      {tab === 'Drawer' ? <Drawer /> : null}
      {tab === 'Shift' ? <Shift /> : null}

      <Card>
        <button type="button" aria-expanded={showAll} onClick={() => setShowAll((v) => !v)} className="flex w-full items-center justify-between gap-3 text-left">
          <span>
            <span className="block text-sm font-bold">
              <span className="tfd-gradient-text">{FEATURE_COUNT} things</span> this till does
            </span>
            <span className="tfd-muted block text-xs">The full list, grouped. Tap to {showAll ? 'hide' : 'see'} it.</span>
          </span>
          <ChevronDown className={cn('h-5 w-5 shrink-0 transition-transform', showAll && 'rotate-180')} aria-hidden />
        </button>
        {showAll ? (
          <div className="tfd-fade tfd-line mt-4 grid gap-5 border-t pt-4 sm:grid-cols-2 xl:grid-cols-3">
            {FEATURES.map((g) => (
              <div key={g.group}>
                <p className="mb-2 flex items-center gap-2 text-xs font-bold uppercase tracking-wider">
                  {g.group} <Pill tone="brand">{g.items.length}</Pill>
                </p>
                <ul className="space-y-1.5 text-xs">
                  {g.items.map((item) => (
                    <li key={item} className="flex items-start gap-2">
                      <CheckCircle2 className="tfd-ok mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                      {item}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        ) : null}
      </Card>
    </div>
  )
}

// ── Delivery desk ───────────────────────────────────────────────────────────

const DESK_TONE: Tone[] = ['info', 'violet', 'warn', 'ok']

export function DeliveryDesk() {
  const notify = useNotify()
  const [orders, setOrders] = useState<DeskOrder[]>(DESK_ORDERS)

  function advance(order: DeskOrder) {
    if (order.step >= 3) {
      setOrders((current) => current.filter((o) => o.no !== order.no))
      return notify(`#${order.no} handed to the rider. The guest reads out PIN ${order.pin} at the door to confirm delivery.`)
    }
    setOrders((current) => current.map((o) => (o.no === order.no ? { ...o, step: o.step + 1 } : o)))
    notify(`#${order.no}: ${DESK_STEPS[order.step + 1].toLowerCase()}. The guest's tracker updated.`)
  }

  if (orders.length === 0) {
    return (
      <Card className="py-10 text-center">
        <CheckCircle2 className="tfd-ok mx-auto h-8 w-8" aria-hidden />
        <p className="mt-2 text-sm font-semibold">No deliveries waiting</p>
        <button type="button" className="tfd-btn tfd-btn-glass mt-3 px-4 py-2 text-xs" onClick={() => setOrders(DESK_ORDERS)}>
          Show the sample deliveries again
        </button>
      </Card>
    )
  }

  return (
    <div className="grid gap-3 md:grid-cols-2">
      {orders.map((o) => (
        <Card key={o.no}>
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="text-sm font-bold">#{o.no}</p>
              <p className="truncate text-sm">{o.place}</p>
              <p className="tfd-muted text-[11px]">{o.source}</p>
            </div>
            <div className="flex shrink-0 flex-col items-end gap-1">
              <Pill tone={DESK_TONE[o.step]}>{DESK_STEPS[o.step]}</Pill>
              <Pill tone={o.paid ? 'ok' : 'warn'}>{o.paid ? 'Paid' : `${rs(o.total)} due`}</Pill>
            </div>
          </div>
          <p className="mt-2 text-xs">{o.items}</p>
          {o.note ? <p className="tfd-warn text-xs">Note: {o.note}</p> : null}
          <div className="tfd-line mt-3 flex flex-wrap items-center justify-between gap-2 border-t pt-3">
            <button type="button" className="tfd-btn tfd-btn-glass px-3 py-1.5 text-xs" onClick={() => notify(`Calling ${o.phone}.`)}>
              <Phone className="h-3.5 w-3.5" aria-hidden /> {o.phone}
            </button>
            <button type="button" className="tfd-btn tfd-btn-primary px-3.5 py-1.5 text-xs" onClick={() => advance(o)}>
              {o.step >= 3 ? (
                <>
                  <KeyRound className="h-3.5 w-3.5" aria-hidden /> Hand to rider
                </>
              ) : (
                DESK_ACTIONS[o.step]
              )}
            </button>
          </div>
        </Card>
      ))}
    </div>
  )
}

// ── Cash drawer ─────────────────────────────────────────────────────────────

const MOVEMENT_TYPES = ['Cash in', 'Additional float', 'Cash out', 'Paid out', 'Expense paid'] as const

interface Movement {
  type: (typeof MOVEMENT_TYPES)[number]
  amount: number
  reason: string
  time: string
}

export function Drawer() {
  const notify = useNotify()
  const [movements, setMovements] = useState<Movement[]>([
    { type: 'Paid out', amount: 1200, reason: 'Gas cylinder delivery', time: '2:15 pm' },
    { type: 'Cash in', amount: 5000, reason: 'Change from the bank', time: '11:40 am' },
  ])
  const [type, setType] = useState<Movement['type']>('Cash out')
  const [amount, setAmount] = useState('')
  const [reason, setReason] = useState('')
  const [counted, setCounted] = useState('')
  const [closed, setClosed] = useState<number | null>(null)

  const float = 10000
  const cashSales = 68450
  const cashIn = movements.filter((m) => m.type === 'Cash in' || m.type === 'Additional float').reduce((s, m) => s + m.amount, 0)
  const cashOut = movements.filter((m) => m.type !== 'Cash in' && m.type !== 'Additional float').reduce((s, m) => s + m.amount, 0)
  const expected = float + cashSales + cashIn - cashOut

  if (closed != null) {
    const gap = closed - expected
    return (
      <Card className="tfd-fade py-8 text-center">
        <Lock className={cn('mx-auto h-9 w-9', gap === 0 ? 'tfd-ok' : 'tfd-warn')} aria-hidden />
        <p className="mt-2 text-lg font-bold">Drawer closed</p>
        <p className="text-sm">{gap === 0 ? 'Balanced exactly' : `${gap < 0 ? 'Short' : 'Over'} by ${rs(Math.abs(gap))}`}</p>
        <p className="tfd-muted mx-auto mt-1 max-w-sm text-xs">
          {gap === 0 ? 'The closing summary is saved under Past drawers.' : 'Waiting for a manager. The difference is on the approvals screen with your count.'}
        </p>
        <button type="button" className="tfd-btn tfd-btn-glass mt-4 px-4 py-2 text-xs" onClick={() => setClosed(null)}>
          Open the drawer again
        </button>
      </Card>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Pill tone="ok">
          <span className="tfd-live-dot" /> Drawer open
        </Pill>
        <span className="tfd-muted text-xs">Till 1 · opened 9:02 am by Sara</span>
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat icon={Wallet} label="Opening float" value={rs(float)} tone="info" />
        <Stat icon={Banknote} label="Cash sales" value={rs(cashSales)} tone="ok" />
        <Stat icon={Receipt} label="Card takings" value={rs(186200)} tone="violet" />
        <Stat icon={Lock} label="Expected in drawer" value={rs(expected)} hint={`Cash in ${rs(cashIn)} · cash out ${rs(cashOut)}`} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardTitle icon={Banknote}>Cash in / cash out</CardTitle>
          <div className="space-y-2">
            <Field label="What happened">
              <select value={type} onChange={(e) => setType(e.target.value as Movement['type'])} className="tfd-input w-full px-2 py-2 text-sm">
                {MOVEMENT_TYPES.map((t) => (
                  <option key={t}>{t}</option>
                ))}
              </select>
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Amount">
                <input value={amount} onChange={(e) => setAmount(e.target.value.replace(/\D/g, ''))} inputMode="numeric" placeholder="0" className="tfd-input w-full px-3 py-2 text-sm" />
              </Field>
              <Field label="Reason">
                <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. vegetables from the market" className="tfd-input w-full px-3 py-2 text-sm" />
              </Field>
            </div>
            <button
              type="button"
              disabled={!Number(amount) || reason.trim().length < 3}
              className="tfd-btn tfd-btn-primary w-full px-4 py-2.5 text-sm"
              onClick={() => {
                setMovements((current) => [{ type, amount: Number(amount), reason: reason.trim(), time: 'Just now' }, ...current])
                notify(`${type} of ${rs(Number(amount))} recorded against your name.`)
                setAmount('')
                setReason('')
              }}
            >
              Record movement
            </button>
          </div>
          <p className="mb-1.5 mt-4 text-xs font-bold">Cash movements</p>
          <ul className="space-y-1.5 text-xs">
            {movements.map((m, i) => {
              const incoming = m.type === 'Cash in' || m.type === 'Additional float'
              return (
                <li key={i} className="flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate">
                    <Pill tone={incoming ? 'ok' : 'bad'}>{m.type}</Pill> {m.reason} <span className="tfd-muted">· {m.time}</span>
                  </span>
                  <span className={cn('shrink-0 font-bold tabular-nums', incoming ? 'tfd-ok' : 'tfd-bad')}>
                    {incoming ? '+' : '−'} {rs(m.amount)}
                  </span>
                </li>
              )
            })}
          </ul>
        </Card>

        <Card>
          <CardTitle icon={Lock}>Close drawer</CardTitle>
          <p className="tfd-muted mb-3 text-xs">Count the cash and type what is there. The system compares it with what should be in the drawer.</p>
          <Field label="Cash counted" hint={`Expected ${rs(expected)}. Try a different figure to see what a shortage looks like.`}>
            <input value={counted} onChange={(e) => setCounted(e.target.value.replace(/\D/g, ''))} inputMode="numeric" placeholder={String(expected)} className="tfd-input w-full px-3 py-2 text-sm" />
          </Field>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <button type="button" className="tfd-btn tfd-btn-glass px-3 py-1.5 text-xs" onClick={() => setCounted(String(expected))}>
              Exact
            </button>
            <button type="button" className="tfd-btn tfd-btn-glass px-3 py-1.5 text-xs" onClick={() => setCounted(String(expected - 350))}>
              Rs 350 short
            </button>
          </div>
          <button type="button" disabled={!counted} className="tfd-btn tfd-btn-primary mt-3 w-full px-4 py-3 text-sm" onClick={() => setClosed(Number(counted))}>
            Close drawer
          </button>
        </Card>
      </div>
    </div>
  )
}

// ── Shift ───────────────────────────────────────────────────────────────────

export function Shift() {
  const notify = useNotify()
  const [handed, setHanded] = useState(false)
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat icon={Clock} label="Shift" value="Evening" hint="Scheduled 3:00 pm – 11:00 pm" tone="info" />
        <Stat icon={Timer} label="Started" value="2:56 pm" hint="4 minutes early" tone="ok" />
        <Stat icon={Banknote} label="Cash drawer" value="Open" hint="Till 1 · Rs 82,250 expected" />
        <Stat icon={UserCheck} label="Handover" value={handed ? 'Pending' : 'Not started'} hint={handed ? 'Waiting on Dilshan to accept' : 'Due at 11:00 pm'} tone="violet" />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardTitle icon={UserCheck}>Hand over the till</CardTitle>
          <p className="tfd-muted text-xs">The next cashier counts the drawer and accepts it, or says it does not match. Either way it is on record who held the cash and when.</p>
          <ul className="my-3 space-y-1.5 text-xs">
            <li className="flex justify-between"><span className="tfd-muted">Open bills to pass on</span><span className="font-bold">4</span></li>
            <li className="flex justify-between"><span className="tfd-muted">Held bills</span><span className="font-bold">1</span></li>
            <li className="flex justify-between"><span className="tfd-muted">Cash in the drawer</span><span className="font-bold tabular-nums">{rs(82250)}</span></li>
          </ul>
          <button
            type="button"
            disabled={handed}
            className="tfd-btn tfd-btn-primary w-full px-4 py-2.5 text-sm"
            onClick={() => {
              setHanded(true)
              notify('Handover sent to Dilshan. They see "Take it on" or "It does not match" when they sign in.')
            }}
          >
            {handed ? 'Waiting for Dilshan to accept' : 'Hand over to Dilshan'}
          </button>
        </Card>

        <Card>
          <CardTitle icon={Clock}>History</CardTitle>
          <ul className="space-y-2 text-xs">
            {[
              ['Today · Morning', 'Priya', 'Balanced exactly', 'ok'],
              ['Yesterday · Evening', 'Sara', 'Balanced exactly', 'ok'],
              ['Yesterday · Morning', 'Dilshan', 'Short by Rs 150 · approved', 'warn'],
              ['28 Sep · Evening', 'Sara', 'Over by Rs 50 · approved', 'warn'],
            ].map(([when, by, result, tone]) => (
              <li key={when} className="flex items-center justify-between gap-2">
                <span>
                  <span className="font-semibold">{when}</span> <span className="tfd-muted">· {by}</span>
                </span>
                <Pill tone={tone as Tone}>{result}</Pill>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  )
}
