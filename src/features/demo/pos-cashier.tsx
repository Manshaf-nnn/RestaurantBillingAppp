'use client'

import { useState } from 'react'
import {
  ArrowLeftRight,
  BadgePercent,
  Banknote,
  BellRing,
  Building2,
  Check,
  CreditCard,
  Download,
  Gift,
  Globe,
  Merge,
  Minus,
  MoreHorizontal,
  Pause,
  Pencil,
  Play,
  Plus,
  Printer,
  QrCode as QrIcon,
  Search,
  Split,
  UserPlus,
  Wallet,
  X,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

import { cn } from '@/lib/utils'

import { MENU, compact, rs } from './data'
import { LineDiscountDialog } from './pos-orders'
import { POS_CUSTOMERS, POS_TABLES, billTotals, prettyPhone, type Bill, type BillLine, type IncomingOrder, type PosCustomer } from './pos-data'
import { Card, Field, Modal, Pill, QrCode, Stat, useNotify, type QrShape, type Tone } from './ui'

const METHODS: { name: string; icon: LucideIcon }[] = [
  { name: 'Cash', icon: Banknote },
  { name: 'Card', icon: CreditCard },
  { name: 'QR pay', icon: QrIcon },
  { name: 'Online', icon: Globe },
  { name: 'Wallet', icon: Wallet },
  { name: 'Bank transfer', icon: Building2 },
  { name: 'Other', icon: MoreHorizontal },
]

const STATUS_TONE: Record<Bill['status'], Tone> = { Accepted: 'info', Preparing: 'warn', Ready: 'violet', Served: 'ok' }

/** Discounts above this share of the bill need a manager's approval. */
const DISCOUNT_LIMIT = 0.1

const REWARDS = [
  { name: 'Free Watalappan', off: 550, cost: 500, over: 0 },
  { name: 'Rs 1,000 off', off: 1000, cost: 1000, over: 5000 },
  { name: 'Rs 2,500 off', off: 2500, cost: 2400, over: 10000 },
]

type Filter = 'Open' | 'Dine-in' | 'Takeaway' | 'Held'
type Dialog = 'edit' | 'split' | 'merge' | 'swap' | 'customer' | 'discount' | null

function quickCash(due: number) {
  const rounded = [50, 100, 200, 500, 1000, 2000, 5000].map((d) => Math.ceil(due / d) * d).filter((v) => v > due)
  return [due, ...[...new Set(rounded)].sort((a, b) => a - b).slice(0, 3)]
}

function who(bill: Bill) {
  return bill.customer?.name ?? bill.walkIn ?? 'Walk-in'
}

export function PosCashier({
  bills,
  setBills,
  incoming,
  setIncoming,
  nextNo,
  bumpNo,
  qr,
  onNewOrder,
}: {
  bills: Bill[]
  setBills: React.Dispatch<React.SetStateAction<Bill[]>>
  incoming: IncomingOrder[]
  setIncoming: React.Dispatch<React.SetStateAction<IncomingOrder[]>>
  nextNo: number
  bumpNo: () => void
  qr: QrShape
  onNewOrder: () => void
}) {
  const notify = useNotify()
  const [filter, setFilter] = useState<Filter>('Open')
  const [query, setQuery] = useState('')
  const [selectedNo, setSelectedNo] = useState<number | null>(bills[0]?.no ?? null)
  const [dialog, setDialog] = useState<Dialog>(null)
  const [rejecting, setRejecting] = useState<IncomingOrder | null>(null)
  const [discounting, setDiscounting] = useState<number | null>(null)
  const [collected, setCollected] = useState({ amount: 412300, count: 118 })

  const [method, setMethod] = useState('Cash')
  const [tendered, setTendered] = useState('')
  const [reference, setReference] = useState('')
  const [part, setPart] = useState('')
  const [tip, setTip] = useState('')
  const [showQr, setShowQr] = useState(false)

  const q = query.trim().toLowerCase()
  const visible = bills.filter((b) => {
    if (filter === 'Held' ? !b.held : b.held) return false
    if (filter === 'Dine-in' && b.kind !== 'Dine in') return false
    if (filter === 'Takeaway' && b.kind !== 'Takeaway') return false
    if (!q) return true
    return (
      String(b.no).includes(q) ||
      who(b).toLowerCase().includes(q) ||
      (b.customer?.phone ?? '').includes(q) ||
      (b.table != null && (`t${b.table}` === q || `table ${b.table}`.includes(q))) ||
      b.kind.toLowerCase().includes(q)
    )
  })
  const bill = bills.find((b) => b.no === selectedNo) ?? null
  const totals = bill ? billTotals(bill) : null
  const outstanding = bills.filter((b) => !b.held).reduce((sum, b) => sum + billTotals(b).due, 0)

  const update = (no: number, change: (b: Bill) => Bill) => setBills((current) => current.map((b) => (b.no === no ? change(b) : b)))

  function resetPayment() {
    setTendered('')
    setReference('')
    setPart('')
    setTip('')
    setShowQr(false)
  }

  function select(no: number) {
    setSelectedNo(no)
    resetPayment()
  }

  function accept(order: IncomingOrder) {
    setIncoming((current) => current.filter((o) => o.no !== order.no))
    setBills((current) => [
      ...current,
      { no: order.no, kind: order.table ? 'Dine in' : 'Takeaway', table: order.table, walkIn: order.table ? 'QR guest' : 'Online pickup', customer: null, lines: order.lines, discount: 0, pointsUsed: 0, tip: 0, payments: [], held: false, status: 'Accepted', placed: 'Just now' },
    ])
    select(order.no)
    notify(`#${order.no} accepted and sent to the kitchen screen.`)
  }

  function take() {
    if (!bill || !totals) return
    const tipAmount = Number(tip) || 0
    const due = totals.due + tipAmount
    const amount = Math.min(due, Number(part) || due)
    const given = Number(tendered) || amount
    if (method === 'Cash' && given < amount) return notify(`Cash tendered is less than ${rs(amount)}.`)
    const change = method === 'Cash' ? given - amount : 0
    const settled = amount >= due
    if (settled) {
      setBills((current) => current.filter((b) => b.no !== bill.no))
      setSelectedNo(bills.find((b) => b.no !== bill.no && !b.held)?.no ?? null)
      notify(`#${bill.no} paid by ${method}.${change > 0 ? ` Change due ${rs(change)}.` : ''} Receipt printed${bill.customer ? `, ${Math.floor(amount / 100)} points earned` : ''}.`)
    } else {
      update(bill.no, (b) => ({ ...b, tip: b.tip + tipAmount, payments: [...b.payments, { method, amount }] }))
      notify(`Payment recorded: ${rs(amount)} by ${method}. ${rs(due - amount)} still due.`)
    }
    setCollected((c) => ({ amount: c.amount + amount, count: c.count + 1 }))
    resetPayment()
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat icon={Wallet} label="Open bills" value={String(bills.filter((b) => !b.held).length)} tone="info" />
        <Stat icon={Banknote} label="Outstanding" value={rs(outstanding)} tone="warn" />
        <Stat icon={Check} label="Collected today" value={compact(collected.amount)} tone="ok" />
        <Stat icon={CreditCard} label="Payments today" value={String(collected.count)} tone="violet" />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="tfd-scroll flex flex-1 gap-1.5 overflow-x-auto">
          {(['Open', 'Dine-in', 'Takeaway', 'Held'] as const).map((f) => (
            <button key={f} type="button" role="tab" aria-selected={filter === f} onClick={() => setFilter(f)} className="tfd-tab shrink-0 rounded-full px-3.5 py-1.5 text-xs font-semibold">
              {f === 'Held' ? `Held · ${bills.filter((b) => b.held).length}` : f}
            </button>
          ))}
        </div>
        <button type="button" className="tfd-btn tfd-btn-primary px-4 py-2 text-xs" onClick={onNewOrder}>
          <Plus className="h-3.5 w-3.5" aria-hidden /> New order
        </button>
      </div>

      <div className="grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
        {/* Queue */}
        <div className="min-w-0 space-y-3">
          {incoming.length > 0 ? (
            <Card className="tfd-pulse-ring">
              <p className="mb-2 flex items-center justify-between text-sm font-bold">
                New Orders <Pill tone="brand">{incoming.length} waiting</Pill>
              </p>
              <ul className="space-y-2">
                {incoming.map((o) => (
                  <li key={o.no} className="tfd-line rounded-xl border p-2.5 text-xs">
                    <p className="flex items-center gap-1.5 font-bold">
                      #{o.no} <Pill tone="violet">{o.channel}</Pill> <Pill>{o.where}</Pill>
                    </p>
                    <p className="tfd-muted mt-1">{o.lines.map((l) => `${l.qty} × ${l.name}`).join(' · ')}</p>
                    <div className="mt-2 flex items-center justify-between gap-2">
                      <span className="font-bold tabular-nums">{rs(o.lines.reduce((s, l) => s + l.unit * l.qty, 0))}</span>
                      <span className="flex gap-1.5">
                        <button type="button" className="tfd-btn tfd-btn-glass px-3 py-1.5" onClick={() => setRejecting(o)}>
                          Reject
                        </button>
                        <button type="button" className="tfd-btn tfd-btn-primary px-3 py-1.5" onClick={() => accept(o)}>
                          Accept
                        </button>
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}

          <label className="relative block">
            <Search className="tfd-muted pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2" aria-hidden />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by table, name, order # or phone" aria-label="Search bills" className="tfd-input w-full py-2 pl-9 pr-3 text-sm" />
          </label>

          <ul className="space-y-2">
            {visible.map((b) => {
              const t = billTotals(b)
              return (
                <li key={b.no}>
                  <button type="button" aria-pressed={b.no === selectedNo} onClick={() => select(b.no)} className={cn('tfd-card block w-full rounded-2xl p-3 text-left', b.no === selectedNo && 'tfd-selected')}>
                    <div className="flex items-center justify-between gap-2">
                      <p className="flex items-center gap-1.5 text-sm font-bold">
                        #{b.no} <Pill tone="brand">{b.table ? `T${b.table}` : b.kind}</Pill>
                      </p>
                      <span className="text-sm font-bold tabular-nums">{rs(t.due)}</span>
                    </div>
                    <p className="tfd-muted mt-0.5 truncate text-xs">
                      {who(b)}
                      {b.customer ? ` · ${prettyPhone(b.customer.phone)}` : ''}
                    </p>
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      <Pill tone={STATUS_TONE[b.status]}>{b.status}</Pill>
                      <Pill tone={t.paid > 0 ? 'warn' : 'neutral'}>{t.paid > 0 ? 'Part paid' : 'Unpaid'}</Pill>
                      {b.held ? <Pill tone="violet">Held</Pill> : null}
                    </div>
                  </button>
                </li>
              )
            })}
            {visible.length === 0 ? (
              <Card className="py-8 text-center">
                <p className="text-sm font-semibold">{q ? 'No matching bills' : filter === 'Held' ? 'No held bills' : 'All settled'}</p>
                <p className="tfd-muted text-xs">{q ? 'Try a table, a name or an order number.' : 'New ones appear here automatically.'}</p>
              </Card>
            ) : null}
          </ul>
        </div>

        {/* Bill + payment */}
        {bill && totals ? (
          <div className="min-w-0 space-y-3">
            <Card>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="flex items-center gap-2 text-lg font-bold">
                    #{bill.no} {bill.held ? <Pill tone="violet">Held</Pill> : null}
                  </p>
                  <p className="tfd-muted text-xs">
                    {who(bill)} · {bill.table ? `Table ${bill.table}` : bill.kind} · placed {bill.placed}
                  </p>
                </div>
                <div className="flex gap-1">
                  <Pill tone={STATUS_TONE[bill.status]}>{bill.status}</Pill>
                  <Pill tone={totals.paid > 0 ? 'warn' : 'neutral'}>{totals.paid > 0 ? 'Part paid' : 'Unpaid'}</Pill>
                </div>
              </div>

              <div className="tfd-scroll -mx-1 mt-3 flex gap-1.5 overflow-x-auto px-1 pb-1">
                {(
                  [
                    ['Print', Printer, () => notify(`Bill #${bill.no} printed. Every print is logged against your name.`)],
                    ['Save', Download, () => notify('Receipt saved.')],
                    ['Edit order', Pencil, () => setDialog('edit')],
                    ['Split', Split, () => setDialog('split')],
                    ['Merge', Merge, () => setDialog('merge')],
                    [
                      bill.held ? 'Resume' : 'Hold',
                      bill.held ? Play : Pause,
                      () => {
                        if (!bill.held && !bill.customer) return notify('Add a customer first. A held bill needs a name to find it again.')
                        update(bill.no, (b) => ({ ...b, held: !b.held }))
                        notify(bill.held ? 'Bill resumed.' : 'Bill held — find it under Held.')
                        if (!bill.held) setFilter('Held')
                        else setFilter('Open')
                      },
                    ],
                    ...(bill.table
                      ? ([
                          ['Swap table', ArrowLeftRight, () => setDialog('swap')],
                          ['Call waiter', BellRing, () => notify(`A waiter has been called to table ${bill.table}.`)],
                        ] as const)
                      : []),
                  ] as [string, LucideIcon, () => void][]
                ).map(([label, Icon, run]) => (
                  <button key={label} type="button" className="tfd-btn tfd-btn-glass shrink-0 px-3 py-1.5 text-xs" onClick={run}>
                    <Icon className="h-3.5 w-3.5" aria-hidden /> {label}
                  </button>
                ))}
              </div>

              {/* Customer on the bill */}
              <div className="tfd-line mt-3 flex flex-wrap items-center justify-between gap-2 border-t pt-3 text-xs">
                {bill.customer ? (
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span className="font-bold">{bill.customer.name}</span>
                    <span className="tfd-muted tabular-nums">{prettyPhone(bill.customer.phone)}</span>
                    <Pill tone="info">{bill.customer.category}</Pill>
                    <Pill tone="brand">{bill.customer.points.toLocaleString('en-US')} pts</Pill>
                  </span>
                ) : (
                  <span className="tfd-muted">No customer on this bill — needed to hold it, and to earn points.</span>
                )}
                <button type="button" className="tfd-btn tfd-btn-glass px-3 py-1.5 text-xs" onClick={() => setDialog('customer')}>
                  <UserPlus className="h-3.5 w-3.5" aria-hidden /> {bill.customer ? 'Change' : 'Add customer'}
                </button>
              </div>

              {bill.customer && bill.customer.points > 0 ? (
                <div className="tfd-line mt-3 border-t pt-3">
                  <p className="mb-1.5 flex items-center gap-1.5 text-xs font-bold">
                    <Gift className="tfd-brand h-3.5 w-3.5" aria-hidden /> Rewards
                  </p>
                  <ul className="grid gap-1.5 sm:grid-cols-3">
                    {REWARDS.map((r) => {
                      const short = r.cost - (bill.customer!.points - bill.pointsUsed)
                      const blocked = short > 0 ? `${short} more points needed` : totals.subtotal < r.over ? `Needs a bill over ${rs(r.over)}` : ''
                      return (
                        <li key={r.name} className="tfd-line flex items-center justify-between gap-2 rounded-xl border px-2.5 py-1.5 text-xs">
                          <span className="min-w-0">
                            <span className="block truncate font-semibold">{r.name}</span>
                            <span className="tfd-muted block text-[11px]">{blocked || `${r.cost} pts`}</span>
                          </span>
                          <button
                            type="button"
                            disabled={Boolean(blocked)}
                            className="tfd-btn tfd-btn-primary shrink-0 px-2.5 py-1 text-[11px]"
                            onClick={() => {
                              update(bill.no, (b) => ({ ...b, pointsUsed: b.pointsUsed + r.off }))
                              notify(`${r.name} applied. ${r.cost} points used.`)
                            }}
                          >
                            Apply
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                </div>
              ) : null}

              {/* Live billing */}
              <ul className="tfd-line mt-3 space-y-2 border-t pt-3 text-xs">
                {bill.lines.map((l, i) => (
                  <li key={i} className={cn(l.cancelled && 'opacity-50')}>
                    <div className="flex justify-between gap-2">
                      <span className={cn('min-w-0 truncate', l.cancelled && 'line-through')}>
                        <span className="font-bold">{l.qty} ×</span> {l.name}
                        {l.options ? <span className="tfd-muted"> · {l.options}</span> : null}
                      </span>
                      <span className="shrink-0 tabular-nums">{rs(l.unit * l.qty - (l.discount ?? 0))}</span>
                    </div>
                    {l.cancelled ? (
                      <span className="tfd-bad">Cancelled</span>
                    ) : (
                      <span className="flex items-center gap-2">
                        <button type="button" className="tfd-brand font-semibold hover:underline" onClick={() => setDiscounting(i)}>
                          {l.discount ? 'Change discount' : 'Discount this item'}
                        </button>
                        {l.discount ? <span className="tfd-ok">− {rs(l.discount)}{l.discountReason ? ` · ${l.discountReason}` : ''}</span> : null}
                      </span>
                    )}
                  </li>
                ))}
              </ul>

              <div className="tfd-line mt-3 grid gap-4 border-t pt-3 sm:grid-cols-2">
                <dl className="space-y-1 text-xs">
                  <div className="tfd-muted flex justify-between"><dt>Subtotal</dt><dd className="tabular-nums">{rs(totals.subtotal)}</dd></div>
                  {bill.discount > 0 ? <div className="tfd-ok flex justify-between"><dt>Discount{bill.discountNote ? ` · ${bill.discountNote}` : ''}</dt><dd className="tabular-nums">− {rs(bill.discount)}</dd></div> : null}
                  {bill.pointsUsed > 0 ? <div className="tfd-ok flex justify-between"><dt>Points used</dt><dd className="tabular-nums">− {rs(bill.pointsUsed)}</dd></div> : null}
                  <div className="tfd-muted flex justify-between"><dt>Service charge</dt><dd className="tabular-nums">{rs(totals.service)}</dd></div>
                  {bill.tip > 0 ? <div className="tfd-muted flex justify-between"><dt>Tip</dt><dd className="tabular-nums">{rs(bill.tip)}</dd></div> : null}
                  <div className="flex justify-between text-base font-bold"><dt>Bill total</dt><dd className="tabular-nums">{rs(totals.total)}</dd></div>
                </dl>
                <dl className="space-y-1 text-xs">
                  <dt className="font-bold">Payments ({bill.payments.length})</dt>
                  {bill.payments.map((p, i) => (
                    <dd key={i} className="tfd-muted flex justify-between"><span>{p.method}</span><span className="tabular-nums">{rs(p.amount)}</span></dd>
                  ))}
                  {bill.payments.length === 0 ? <dd className="tfd-muted">Nothing taken yet.</dd> : null}
                  <div className="flex justify-between"><dt className="tfd-muted">Paid</dt><dd className="tabular-nums">{rs(totals.paid)}</dd></div>
                  <div className="tfd-brand flex justify-between text-base font-bold"><dt>Due now</dt><dd className="tabular-nums">{rs(totals.due)}</dd></div>
                </dl>
              </div>
            </Card>

            {bill.held ? (
              <Card className="text-center text-sm">
                <p className="tfd-muted">This bill is on hold. Resume it to take payment.</p>
              </Card>
            ) : (
              <Card>
                <div className="mb-3 flex items-center justify-between gap-2">
                  <h4 className="text-sm font-bold">
                    Take payment <span className="tfd-muted font-medium">· {rs(totals.due + (Number(tip) || 0))} due</span>
                  </h4>
                  <button type="button" className="tfd-btn tfd-btn-glass px-3 py-1.5 text-xs" onClick={() => setDialog('discount')}>
                    <BadgePercent className="tfd-brand h-3.5 w-3.5" aria-hidden /> Discount
                  </button>
                </div>

                <p className="mb-1.5 text-xs font-semibold">Payment method</p>
                <div className="grid grid-cols-4 gap-1.5 text-[11px] font-semibold sm:grid-cols-7">
                  {METHODS.map(({ name, icon: Icon }) => (
                    <button
                      key={name}
                      type="button"
                      aria-pressed={method === name}
                      onClick={() => {
                        setMethod(name)
                        setShowQr(false)
                      }}
                      className={cn('tfd-card flex flex-col items-center gap-1 rounded-xl px-1 py-2', method === name && 'tfd-selected')}
                    >
                      <Icon className="h-4 w-4" aria-hidden />
                      {name}
                    </button>
                  ))}
                </div>

                <div className="mt-3 grid gap-2 sm:grid-cols-3">
                  {method === 'Cash' ? (
                    <Field label="Cash tendered">
                      <input value={tendered} onChange={(e) => setTendered(e.target.value.replace(/\D/g, ''))} inputMode="numeric" placeholder={String(Number(part) || totals.due)} className="tfd-input w-full px-3 py-2 text-sm" />
                    </Field>
                  ) : (
                    <Field label="Reference" hint="Transaction id, last 4 digits, etc.">
                      <input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Optional" className="tfd-input w-full px-3 py-2 text-sm" />
                    </Field>
                  )}
                  <Field label="Amount to take" hint="Leave blank for the full bill — enter less to split the payment">
                    <input value={part} onChange={(e) => setPart(e.target.value.replace(/\D/g, ''))} inputMode="numeric" placeholder={String(totals.due)} className="tfd-input w-full px-3 py-2 text-sm" />
                  </Field>
                  <Field label="Tip">
                    <input value={tip} onChange={(e) => setTip(e.target.value.replace(/\D/g, ''))} inputMode="numeric" placeholder="Optional" className="tfd-input w-full px-3 py-2 text-sm" />
                  </Field>
                </div>

                {method === 'Cash' ? (
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    {quickCash(Number(part) || totals.due + (Number(tip) || 0)).map((v, i) => (
                      <button key={v} type="button" className="tfd-btn tfd-btn-glass px-3 py-1.5 text-xs tabular-nums" onClick={() => setTendered(String(v))}>
                        {i === 0 ? 'Exact' : rs(v)}
                      </button>
                    ))}
                    {Number(tendered) > (Number(part) || totals.due + (Number(tip) || 0)) ? (
                      <Pill tone="ok" className="!text-xs">Change due {rs(Number(tendered) - (Number(part) || totals.due + (Number(tip) || 0)))}</Pill>
                    ) : null}
                  </div>
                ) : null}

                {method === 'QR pay' ? (
                  <div className="mt-2">
                    <button type="button" className="tfd-btn tfd-btn-glass px-3 py-1.5 text-xs" onClick={() => setShowQr((v) => !v)}>
                      <QrIcon className="h-3.5 w-3.5" aria-hidden /> {showQr ? 'Hide payment QR' : 'Show payment QR'}
                    </button>
                    {showQr ? (
                      <div className="tfd-fade mt-2 flex items-center gap-3">
                        <div className="rounded-xl bg-white p-2">
                          <QrCode qr={qr} className="h-24 w-24" />
                        </div>
                        <p className="tfd-muted text-xs">Show this to the guest. They scan it with their banking app to pay {rs(totals.due)}.</p>
                      </div>
                    ) : null}
                  </div>
                ) : null}

                <button type="button" disabled={totals.due + (Number(tip) || 0) <= 0} className="tfd-btn tfd-btn-primary mt-3 w-full px-4 py-3 text-sm" onClick={take}>
                  Take {rs(Math.min(totals.due + (Number(tip) || 0), Number(part) || totals.due + (Number(tip) || 0)))}
                </button>
              </Card>
            )}
          </div>
        ) : (
          <Card className="flex min-h-40 items-center justify-center text-center">
            <p className="tfd-muted text-sm">Choose a bill on the left, or accept a new order.</p>
          </Card>
        )}
      </div>

      {/* ── Dialogs ─────────────────────────────────────────────────────────── */}

      {rejecting ? <RejectDialog order={rejecting} onClose={() => setRejecting(null)} onReject={() => {
        setIncoming((current) => current.filter((o) => o.no !== rejecting.no))
        notify(`#${rejecting.no} rejected. The guest sees the reason on their phone.`)
        setRejecting(null)
      }} /> : null}

      {bill && discounting != null ? (
        <LineDiscountDialog
          title={`Discount ${bill.lines[discounting].qty} × ${bill.lines[discounting].name}`}
          linePrice={bill.lines[discounting].unit * bill.lines[discounting].qty}
          current={bill.lines[discounting].discount}
          currentReason={bill.lines[discounting].discountReason}
          onClose={() => setDiscounting(null)}
          onApply={(amount, reason) => {
            const price = bill.lines[discounting].unit * bill.lines[discounting].qty
            if (amount > price * 0.5) notify('That discount needs a manager to sign it off. It has been sent for approval.')
            else update(bill.no, (b) => ({ ...b, lines: b.lines.map((l, i) => (i === discounting ? { ...l, discount: amount || undefined, discountReason: amount ? reason : undefined } : l)) }))
            setDiscounting(null)
          }}
        />
      ) : null}

      {bill && totals && dialog === 'discount' ? (
        <BillDiscountDialog
          bill={bill}
          due={totals.due}
          onClose={() => setDialog(null)}
          onApply={(amount, overLimit) => {
            if (overLimit) notify('Sent for approval. A discount this size needs a manager to sign off — they can do that from the approvals screen.')
            else {
              update(bill.no, (b) => ({ ...b, discount: b.discount + amount }))
              notify(`Discount applied. New total ${rs(totals.total - amount * (bill.kind === 'Dine in' ? 1.1 : 1))}.`)
            }
            setDialog(null)
          }}
        />
      ) : null}

      {bill && dialog === 'edit' ? (
        <EditDialog
          bill={bill}
          onClose={() => setDialog(null)}
          onCancelLine={(index) => {
            if (bill.lines.filter((l) => !l.cancelled).length <= 1) return notify('The last dish cannot be cancelled here — cancel the whole bill instead.')
            update(bill.no, (b) => ({ ...b, lines: b.lines.map((l, i) => (i === index ? { ...l, cancelled: true } : l)) }))
            notify('Item cancelled. The kitchen sees it crossed out on the ticket.')
          }}
          onAdd={(line) => {
            update(bill.no, (b) => ({ ...b, lines: [...b.lines, line] }))
            notify(`${line.name} added. It went straight to the kitchen and onto the bill.`)
          }}
        />
      ) : null}

      {bill && dialog === 'split' ? (
        <SplitDialog
          bill={bill}
          onClose={() => setDialog(null)}
          onSplit={(moves) => {
            const stay: BillLine[] = []
            const go: BillLine[] = []
            bill.lines.forEach((l, i) => {
              const moving = moves[i] ?? 0
              if (l.qty - moving > 0) stay.push({ ...l, qty: l.qty - moving })
              if (moving > 0) go.push({ ...l, qty: moving, discount: undefined })
            })
            setBills((current) => [...current.map((b) => (b.no === bill.no ? { ...b, lines: stay } : b)), { ...bill, no: nextNo, lines: go, payments: [], discount: 0, pointsUsed: 0, tip: 0 }])
            bumpNo()
            notify(`Bill split. The moved items are now on #${nextNo}.`)
            setDialog(null)
          }}
        />
      ) : null}

      {bill && dialog === 'merge' ? (
        <MergeDialog
          bill={bill}
          others={bills.filter((b) => b.no !== bill.no && !b.held && billTotals(b).paid === 0)}
          onClose={() => setDialog(null)}
          onMerge={(numbers) => {
            const merged = bills.filter((b) => numbers.includes(b.no)).flatMap((b) => b.lines)
            setBills((current) => current.filter((b) => !numbers.includes(b.no)).map((b) => (b.no === bill.no ? { ...b, lines: [...b.lines, ...merged] } : b)))
            notify(`${numbers.length + 1} bills merged into #${bill.no}.`)
            setDialog(null)
          }}
        />
      ) : null}

      {bill && dialog === 'swap' ? (
        <SwapDialog
          bill={bill}
          onClose={() => setDialog(null)}
          onMove={(table) => {
            update(bill.no, (b) => ({ ...b, table }))
            notify(`Sitting moved to table ${table}. Orders, bill and payments went with it.`)
            setDialog(null)
          }}
        />
      ) : null}

      {bill && dialog === 'customer' ? (
        <BillCustomerDialog
          onClose={() => setDialog(null)}
          onUse={(customer) => {
            update(bill.no, (b) => ({ ...b, customer, walkIn: undefined }))
            notify(`${customer.name} is now on bill #${bill.no}.`)
            setDialog(null)
          }}
        />
      ) : null}
    </div>
  )
}

// ── Dialogs ─────────────────────────────────────────────────────────────────

function RejectDialog({ order, onReject, onClose }: { order: IncomingOrder; onReject: () => void; onClose: () => void }) {
  const [reason, setReason] = useState('')
  return (
    <Modal title={`Reject order ${order.no}`} subtitle="The guest is told why." onClose={onClose}>
      <div className="space-y-3">
        <Field label="Reason">
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. The kitchen is closing · That dish has run out" className="tfd-input w-full px-3 py-2 text-sm" />
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <button type="button" className="tfd-btn tfd-btn-glass px-3 py-2.5 text-sm" onClick={onClose}>Keep it</button>
          <button type="button" disabled={reason.trim().length < 3} className="tfd-btn tfd-btn-primary px-3 py-2.5 text-sm" onClick={onReject}>Reject order</button>
        </div>
      </div>
    </Modal>
  )
}

function BillDiscountDialog({ bill, due, onApply, onClose }: { bill: Bill; due: number; onApply: (amount: number, overLimit: boolean) => void; onClose: () => void }) {
  const [mode, setMode] = useState<'fixed' | 'percent'>('percent')
  const [value, setValue] = useState('')
  const [reason, setReason] = useState('')
  const base = billTotals(bill).subtotal - bill.discount - bill.pointsUsed
  const amount = Math.min(base, mode === 'fixed' ? Number(value) || 0 : (base * (Number(value) || 0)) / 100)
  const share = base > 0 ? amount / base : 0
  return (
    <Modal title="Apply a discount" subtitle="A fixed amount or a percentage of the bill. Recorded in the audit log against your account." onClose={onClose}>
      <div className="space-y-3">
        <div className="tfd-track grid grid-cols-2 rounded-full p-1 text-xs font-semibold">
          {(['fixed', 'percent'] as const).map((m) => (
            <button key={m} type="button" role="tab" aria-selected={mode === m} onClick={() => setMode(m)} className="tfd-tab rounded-full py-1.5">
              {m === 'fixed' ? 'Fixed amount (Rs)' : 'Percentage (%)'}
            </button>
          ))}
        </div>
        <Field
          label={mode === 'fixed' ? 'Discount amount' : 'Discount percentage'}
          hint={amount > 0 ? `${rs(amount)} off — ${Math.round(share * 100)}% of ${rs(base)}. Due becomes about ${rs(Math.max(0, due - amount))}.` : bill.discount > 0 ? `Already off this bill: ${rs(bill.discount)}. This is added on top.` : undefined}
        >
          <input value={value} onChange={(e) => setValue(e.target.value.replace(/[^\d.]/g, ''))} inputMode="decimal" placeholder={mode === 'fixed' ? 'e.g. 100' : 'e.g. 10'} className="tfd-input w-full px-3 py-2 text-sm" />
        </Field>
        <Field label="Reason">
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Loyal guest, service delay…" className="tfd-input w-full px-3 py-2 text-sm" />
        </Field>
        {share > DISCOUNT_LIMIT ? <p className="tfd-warn text-xs font-semibold">Over {DISCOUNT_LIMIT * 100}% of the bill: this will go to a manager for approval instead of applying now.</p> : null}
        <button type="button" disabled={amount <= 0} className="tfd-btn tfd-btn-primary w-full px-4 py-3 text-sm" onClick={() => onApply(amount, share > DISCOUNT_LIMIT)}>
          Apply discount
        </button>
      </div>
    </Modal>
  )
}

function EditDialog({ bill, onCancelLine, onAdd, onClose }: { bill: Bill; onCancelLine: (index: number) => void; onAdd: (line: BillLine) => void; onClose: () => void }) {
  const quick = MENU.filter((m) => ['m06', 'm21', 'm25', 'm28', 'm29', 'm24'].includes(m.id))
  return (
    <Modal title={`Edit #${bill.no}`} onClose={onClose}>
      <div className="space-y-4">
        <div>
          <p className="mb-1.5 text-xs font-bold">On the bill</p>
          <ul className="space-y-1.5 text-xs">
            {bill.lines.map((l, i) => (
              <li key={i} className={cn('flex items-center justify-between gap-2', l.cancelled && 'opacity-50')}>
                <span className={cn(l.cancelled && 'line-through')}>
                  {l.qty} × {l.name}
                </span>
                {l.cancelled ? (
                  <span className="tfd-bad">Cancelled</span>
                ) : (
                  <button type="button" className="tfd-bad flex items-center gap-1 font-semibold hover:underline" onClick={() => onCancelLine(i)}>
                    <X className="h-3 w-3" aria-hidden /> Cancel
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
        <div>
          <p className="mb-1.5 text-xs font-bold">Add more</p>
          <div className="grid grid-cols-2 gap-1.5">
            {quick.map((m) => (
              <button key={m.id} type="button" className="tfd-card flex items-center justify-between gap-2 rounded-xl px-2.5 py-2 text-left text-xs" onClick={() => onAdd({ name: m.name, qty: 1, unit: m.price })}>
                <span className="truncate">
                  {m.emoji} {m.name}
                </span>
                <Plus className="tfd-brand h-3.5 w-3.5 shrink-0" aria-hidden />
              </button>
            ))}
          </div>
          <p className="tfd-muted mt-1.5 text-[11px]">These go straight to the kitchen and onto the bill.</p>
        </div>
      </div>
    </Modal>
  )
}

function SplitDialog({ bill, onSplit, onClose }: { bill: Bill; onSplit: (moves: Record<number, number>) => void; onClose: () => void }) {
  const [moves, setMoves] = useState<Record<number, number>>({})
  const moved = bill.lines.reduce((s, l, i) => s + (moves[i] ?? 0) * l.unit, 0)
  const all = bill.lines.reduce((s, l) => s + l.qty * l.unit, 0)
  const movedCount = Object.values(moves).reduce((a, b) => a + b, 0)
  const everything = movedCount === bill.lines.reduce((n, l) => n + l.qty, 0)
  return (
    <Modal title={`Split bill #${bill.no}`} subtitle="Choose what moves to a new bill. Handy when friends pay separately." onClose={onClose}>
      <ul className="space-y-2 text-xs">
        {bill.lines.map((l, i) =>
          l.cancelled ? null : (
            <li key={i} className="flex items-center justify-between gap-2">
              <span className="min-w-0 truncate">
                {l.name} <span className="tfd-muted">· {l.qty} on the bill</span>
              </span>
              <span className="tfd-track flex shrink-0 items-center gap-1 rounded-full p-0.5">
                <button type="button" aria-label={`Move one less ${l.name}`} className="tfd-btn tfd-btn-glass h-6 w-6" onClick={() => setMoves((m) => ({ ...m, [i]: Math.max(0, (m[i] ?? 0) - 1) }))}>
                  <Minus className="h-3 w-3" aria-hidden />
                </button>
                <span className="w-4 text-center font-bold tabular-nums">{moves[i] ?? 0}</span>
                <button type="button" aria-label={`Move one more ${l.name}`} className="tfd-btn tfd-btn-glass h-6 w-6" onClick={() => setMoves((m) => ({ ...m, [i]: Math.min(l.qty, (m[i] ?? 0) + 1) }))}>
                  <Plus className="h-3 w-3" aria-hidden />
                </button>
              </span>
            </li>
          ),
        )}
      </ul>
      <dl className="tfd-line mt-3 space-y-1 border-t pt-3 text-xs">
        <div className="flex justify-between"><dt className="tfd-muted">Stays on #{bill.no}</dt><dd className="font-bold tabular-nums">{rs(all - moved)}</dd></div>
        <div className="flex justify-between"><dt className="tfd-muted">Moves to the new bill</dt><dd className="font-bold tabular-nums">{rs(moved)}</dd></div>
      </dl>
      {everything ? <p className="tfd-warn mt-2 text-xs font-semibold">That moves the whole bill. Leave at least one item behind.</p> : null}
      <button type="button" disabled={movedCount === 0 || everything} className="tfd-btn tfd-btn-primary mt-3 w-full px-4 py-3 text-sm" onClick={() => onSplit(moves)}>
        Split bill
      </button>
    </Modal>
  )
}

function MergeDialog({ bill, others, onMerge, onClose }: { bill: Bill; others: Bill[]; onMerge: (numbers: number[]) => void; onClose: () => void }) {
  const [picked, setPicked] = useState<number[]>([])
  const combined = billTotals(bill).total + others.filter((b) => picked.includes(b.no)).reduce((s, b) => s + billTotals(b).total, 0)
  return (
    <Modal title={`Merge into #${bill.no}`} subtitle="Fold other unpaid bills into this one, for a group paying together." onClose={onClose}>
      {others.length === 0 ? (
        <p className="tfd-muted text-sm">No other open bill to merge in.</p>
      ) : (
        <ul className="space-y-1.5">
          {others.map((b) => {
            const on = picked.includes(b.no)
            return (
              <li key={b.no}>
                <button type="button" role="checkbox" aria-checked={on} onClick={() => setPicked((p) => (on ? p.filter((n) => n !== b.no) : [...p, b.no]))} className={cn('tfd-card flex w-full items-center justify-between rounded-xl px-3 py-2 text-xs', on && 'tfd-selected')}>
                  <span>
                    <span className="font-bold">#{b.no}</span> · {b.table ? `Table ${b.table}` : b.kind} · {who(b)}
                  </span>
                  <span className="tabular-nums">{rs(billTotals(b).total)}</span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
      <p className="tfd-line mt-3 flex justify-between border-t pt-3 text-sm">
        <span className="tfd-muted">Combined bill</span>
        <span className="font-bold tabular-nums">{rs(combined)}</span>
      </p>
      <button type="button" disabled={picked.length === 0} className="tfd-btn tfd-btn-primary mt-3 w-full px-4 py-3 text-sm" onClick={() => onMerge(picked)}>
        Merge {picked.length + 1} bills
      </button>
    </Modal>
  )
}

function SwapDialog({ bill, onMove, onClose }: { bill: Bill; onMove: (table: number) => void; onClose: () => void }) {
  const [to, setTo] = useState('')
  return (
    <Modal title={`Move table ${bill.table}`} subtitle="The whole sitting moves: orders, bill, payments and customer." onClose={onClose}>
      <Field label="Move to">
        <select value={to} onChange={(e) => setTo(e.target.value)} className="tfd-input w-full px-2 py-2 text-sm">
          <option value="">Choose an empty table…</option>
          {POS_TABLES.filter((t) => t.status === 'free').map((t) => (
            <option key={t.n} value={t.n}>
              Table {t.n} · {t.area}
            </option>
          ))}
        </select>
      </Field>
      <button type="button" disabled={!to} className="tfd-btn tfd-btn-primary mt-3 w-full px-4 py-3 text-sm" onClick={() => onMove(Number(to))}>
        Move sitting
      </button>
    </Modal>
  )
}

function BillCustomerDialog({ onUse, onClose }: { onUse: (customer: PosCustomer) => void; onClose: () => void }) {
  const [phone, setPhone] = useState('')
  const [name, setName] = useState('')
  const [looked, setLooked] = useState(false)
  const digits = phone.replace(/\D/g, '')
  const found = POS_CUSTOMERS.find((c) => c.phone === digits)
  return (
    <Modal title="Who is this bill for?" subtitle="Try 0771234521 to see a saved customer." onClose={onClose}>
      <div className="space-y-3">
        <Field label="Phone number">
          <input
            value={phone}
            onChange={(e) => {
              setPhone(e.target.value)
              setLooked(false)
            }}
            inputMode="tel"
            placeholder="07X XXX XXXX"
            className="tfd-input w-full px-3 py-2 text-sm"
          />
        </Field>
        {!looked ? (
          <button type="button" disabled={digits.length < 9} className="tfd-btn tfd-btn-primary w-full px-4 py-3 text-sm" onClick={() => setLooked(true)}>
            Look them up
          </button>
        ) : found ? (
          <div className="tfd-card space-y-2 rounded-xl p-3 text-sm">
            <p>
              <span className="font-bold">{found.name}</span> already has this number · {found.points.toLocaleString('en-US')} points.
            </p>
            <button type="button" className="tfd-btn tfd-btn-primary w-full px-4 py-2.5 text-sm" onClick={() => onUse(found)}>
              Use this customer
            </button>
          </div>
        ) : (
          <div className="space-y-2">
            <p className="tfd-muted text-xs">Nobody has that number yet. Add them now and they start earning points on this bill.</p>
            <Field label="Name (optional)">
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Priya" className="tfd-input w-full px-3 py-2 text-sm" />
            </Field>
            <button type="button" className="tfd-btn tfd-btn-primary w-full px-4 py-2.5 text-sm" onClick={() => onUse({ name: name.trim() || 'Guest', phone: digits, points: 0, category: 'New' })}>
              Add and use
            </button>
          </div>
        )}
      </div>
    </Modal>
  )
}
