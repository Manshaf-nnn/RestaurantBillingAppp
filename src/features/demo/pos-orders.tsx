'use client'

import { useMemo, useRef, useState } from 'react'
import { BadgePercent, Check, Gift, Minus, Plus, Printer, Search, Send, ShoppingBag, Star, Trash2, UserPlus } from 'lucide-react'

import { cn } from '@/lib/utils'

import { MENU, MENU_CATEGORIES, menuById, rs, type MenuCategory, type MenuItem } from './data'
import {
  OPTION_GROUPS,
  POS_CUSTOMERS,
  POS_TABLES,
  SERVICE_RATE,
  SOLD_OUT,
  STAFF,
  codeOf,
  fromPrice,
  offersFor,
  prettyPhone,
  type Bill,
  type OrderKind,
  type PosCustomer,
} from './pos-data'
import { Field, Modal, Pill, useNotify } from './ui'

const KINDS: { kind: OrderKind; hint: string }[] = [
  { kind: 'Dine in', hint: 'Seated at a table' },
  { kind: 'Counter', hint: 'Walk-in paying at the till' },
  { kind: 'Takeaway', hint: 'Packed to collect' },
  { kind: 'Delivery', hint: 'Sent out with a rider' },
]

export interface CartLine {
  key: number
  id: string
  qty: number
  unit: number
  options: string
  note: string
  discount?: number
  reason?: string
}

// ── Sizes, add-ons, quantity and a note for one dish ────────────────────────

export function OptionDialog({
  item,
  initial,
  onDone,
  onClose,
}: {
  item: MenuItem
  initial?: CartLine
  onDone: (result: { unit: number; options: string; qty: number; note: string }) => void
  onClose: () => void
}) {
  const groups = OPTION_GROUPS[item.id] ?? []
  const [picked, setPicked] = useState<Record<string, string[]>>(() => {
    const already = initial?.options ? initial.options.split(' · ') : []
    return Object.fromEntries(
      groups.map((g) => [
        g.name,
        initial ? g.choices.filter((c) => already.includes(c.name)).map((c) => c.name) : g.kind === 'single' ? [g.choices[0].name] : [],
      ]),
    )
  })
  const [qty, setQty] = useState(initial?.qty ?? 1)
  const [note, setNote] = useState(initial?.note ?? '')

  const missing = groups.find((g) => g.required && (picked[g.name]?.length ?? 0) === 0)
  const size = groups.find((g) => g.kind === 'single')
  const base = size ? (size.choices.find((c) => picked[size.name]?.includes(c.name))?.price ?? item.price) : item.price
  const extras = groups
    .filter((g) => g.kind === 'multi')
    .flatMap((g) => g.choices.filter((c) => picked[g.name]?.includes(c.name)))
    .reduce((sum, c) => sum + c.price, 0)
  const unit = base + extras

  function toggle(group: (typeof groups)[number], choice: string) {
    setPicked((current) => {
      const mine = current[group.name] ?? []
      if (group.kind === 'single') return { ...current, [group.name]: [choice] }
      if (mine.includes(choice)) return { ...current, [group.name]: mine.filter((c) => c !== choice) }
      if (group.max && mine.length >= group.max) return current
      return { ...current, [group.name]: [...mine, choice] }
    })
  }

  return (
    <Modal title={item.name} subtitle={`${codeOf(item.id)} · ${rs(item.price)}`} onClose={onClose}>
      <div className="space-y-4">
        {groups.map((g) => (
          <fieldset key={g.name}>
            <legend className="mb-1.5 flex w-full items-center justify-between text-xs font-bold">
              {g.name}
              <span className="tfd-muted font-medium">{g.required ? 'Required' : `Optional${g.max ? ` · up to ${g.max}` : ''}`}</span>
            </legend>
            <div className="space-y-1.5">
              {g.choices.map((c) => {
                const on = picked[g.name]?.includes(c.name)
                return (
                  <button
                    key={c.name}
                    type="button"
                    role={g.kind === 'single' ? 'radio' : 'checkbox'}
                    aria-checked={on}
                    disabled={c.soldOut}
                    onClick={() => toggle(g, c.name)}
                    className={cn('tfd-card flex w-full items-center justify-between rounded-xl px-3 py-2 text-sm disabled:opacity-45', on && 'tfd-selected')}
                  >
                    <span className="flex items-center gap-2">
                      <span className={cn('flex h-4 w-4 items-center justify-center border', g.kind === 'single' ? 'rounded-full' : 'rounded', on ? 'tfd-btn-primary border-transparent' : 'tfd-line')}>
                        {on ? <Check className="h-3 w-3" aria-hidden /> : null}
                      </span>
                      {c.name}
                      {c.soldOut ? <Pill tone="bad">sold out</Pill> : null}
                    </span>
                    <span className="tabular-nums">{g.kind === 'single' ? rs(c.price) : `+ ${rs(c.price)}`}</span>
                  </button>
                )
              })}
            </div>
          </fieldset>
        ))}

        <div className="flex items-center justify-between">
          <span className="text-xs font-bold">Quantity</span>
          <span className="tfd-track flex items-center gap-2 rounded-full p-1">
            <button type="button" aria-label="Decrease quantity" className="tfd-btn tfd-btn-glass h-8 w-8" onClick={() => setQty((q) => Math.max(1, q - 1))}>
              <Minus className="h-3.5 w-3.5" aria-hidden />
            </button>
            <span className="w-6 text-center text-sm font-bold tabular-nums">{qty}</span>
            <button type="button" aria-label="Increase quantity" className="tfd-btn tfd-btn-glass h-8 w-8" onClick={() => setQty((q) => Math.min(50, q + 1))}>
              <Plus className="h-3.5 w-3.5" aria-hidden />
            </button>
          </span>
        </div>

        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Note for the kitchen — e.g. no chilli"
          aria-label="Note for the kitchen"
          className="tfd-input w-full px-3 py-2 text-sm"
        />

        <button
          type="button"
          disabled={Boolean(missing)}
          className="tfd-btn tfd-btn-primary w-full px-4 py-3 text-sm"
          onClick={() =>
            onDone({
              unit,
              qty,
              note: note.trim(),
              options: groups.flatMap((g) => g.choices.filter((c) => picked[g.name]?.includes(c.name)).map((c) => c.name)).join(' · '),
            })
          }
        >
          {missing ? `Choose ${missing.name}` : `${initial ? 'Update' : 'Add'} · ${rs(unit * qty)}`}
        </button>
      </div>
    </Modal>
  )
}

// ── The dish picker (shared by the Orders tab and "New order") ──────────────

export function MenuPicker({ counts, onPick }: { counts: Record<string, number>; onPick: (item: MenuItem) => void }) {
  const [category, setCategory] = useState<'All' | MenuCategory>('All')
  const [query, setQuery] = useState('')
  const q = query.trim().toLowerCase()
  const items = MENU.filter(
    (m) =>
      !SOLD_OUT.has(m.id) &&
      (category === 'All' || m.category === category) &&
      (q === '' || m.name.toLowerCase().includes(q) || codeOf(m.id).toLowerCase().startsWith(q)),
  )

  return (
    <div className="space-y-3">
      <label className="relative block">
        <Search className="tfd-muted pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2" aria-hidden />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by name or code"
          aria-label="Search by name or code"
          className="tfd-input w-full py-2 pl-9 pr-3 text-sm"
        />
      </label>
      <div className="tfd-scroll flex gap-1.5 overflow-x-auto">
        {(['All', ...MENU_CATEGORIES] as const).map((c) => (
          <button key={c} type="button" role="tab" aria-selected={category === c} onClick={() => setCategory(c)} className="tfd-tab shrink-0 rounded-full px-3.5 py-1.5 text-xs font-semibold">
            {c}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
        {items.map((m) => {
          const from = fromPrice(m)
          const qty = counts[m.id] ?? 0
          return (
            <button
              key={m.id}
              type="button"
              onClick={() => onPick(m)}
              className={cn('tfd-card relative rounded-2xl p-2.5 text-left transition-transform hover:-translate-y-0.5', qty > 0 && 'tfd-selected')}
            >
              <div className="relative flex h-16 items-center justify-center rounded-xl text-4xl" style={{ background: 'linear-gradient(135deg, rgba(255,171,77,.3), rgba(232,64,138,.14))' }}>
                <span aria-hidden>{m.emoji}</span>
                <span className="tfd-modal absolute left-1.5 top-1.5 rounded-md px-1.5 text-[10px] font-bold">{codeOf(m.id)}</span>
              </div>
              <p className="mt-2 line-clamp-1 text-xs font-semibold">{m.name}</p>
              <p className="text-xs font-bold tabular-nums">
                {from.sizes ? <span className="tfd-muted font-medium">from </span> : null}
                {rs(from.price)}
                {from.sizes ? <span className="tfd-muted font-medium"> · {from.sizes} sizes</span> : null}
              </p>
              {qty > 0 ? (
                <span className="tfd-btn-primary absolute -right-1.5 -top-1.5 flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold">{qty}</span>
              ) : null}
            </button>
          )
        })}
        {items.length === 0 ? <p className="tfd-muted col-span-full py-8 text-center text-sm">Nothing matches that.</p> : null}
      </div>
    </div>
  )
}

// ── What the till knows about the guest: points and the offers they can use ─

export function GuestPanel({
  customer,
  subtotal,
  offerCode,
  onOffer,
  points,
  onPoints,
}: {
  customer: PosCustomer
  subtotal: number
  offerCode: string | null
  onOffer: (code: string | null) => void
  points: number
  onPoints: (points: number) => void
}) {
  const offers = offersFor(customer, subtotal)
  const applied = offers.find((o) => o.code === offerCode && !o.reason)
  const max = Math.max(0, Math.min(customer.points, Math.floor(subtotal - (applied?.amount ?? 0))))

  return (
    <div className="tfd-card space-y-3 rounded-2xl p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Pill tone="ok">
          <Star className="h-3 w-3" aria-hidden /> {customer.name}
        </Pill>
        <Pill tone="info">{customer.category}</Pill>
        <span className="tfd-muted text-xs">
          {customer.points > 0 ? `${customer.points.toLocaleString('en-US')} points · worth ${rs(customer.points)}` : 'No points yet'}
        </span>
      </div>

      <div>
        <p className="mb-1.5 flex items-center gap-1.5 text-xs font-bold">
          <BadgePercent className="tfd-brand h-3.5 w-3.5" aria-hidden /> Offers for this customer
        </p>
        <ul className="space-y-1.5">
          {offers.map((o) => {
            const on = o.code === offerCode && !o.reason
            return (
              <li key={o.code}>
                <button
                  type="button"
                  disabled={Boolean(o.reason) || subtotal === 0}
                  aria-pressed={on}
                  onClick={() => onOffer(on ? null : o.code)}
                  className={cn('tfd-card flex w-full items-center justify-between gap-2 rounded-xl px-3 py-2 text-left text-xs disabled:opacity-55', on && 'tfd-selected')}
                >
                  <span className="min-w-0">
                    <span className="block font-semibold">{o.title}</span>
                    <span className={cn('block text-[11px]', o.reason ? 'tfd-warn' : 'tfd-muted')}>{o.reason ?? (on ? 'Applied. It is checked again when the order is sent.' : `Code ${o.code} · tap to apply`)}</span>
                  </span>
                  {!o.reason && subtotal > 0 ? <span className="tfd-ok shrink-0 font-bold tabular-nums">− {rs(o.amount)}</span> : null}
                </button>
              </li>
            )
          })}
        </ul>
      </div>

      {customer.points > 0 ? (
        <div>
          <p className="mb-1.5 flex items-center gap-1.5 text-xs font-bold">
            <Gift className="tfd-brand h-3.5 w-3.5" aria-hidden /> Use points
          </p>
          <div className="flex gap-1.5">
            <input
              value={points || ''}
              onChange={(e) => onPoints(Math.max(0, Math.min(max, Number(e.target.value.replace(/\D/g, '')) || 0)))}
              inputMode="numeric"
              placeholder="Points"
              aria-label="Points to use"
              className="tfd-input w-full min-w-0 px-3 py-1.5 text-sm"
            />
            <button type="button" disabled={max === 0} className="tfd-btn tfd-btn-glass shrink-0 px-3 py-1.5 text-xs" onClick={() => onPoints(max)}>
              Use {max.toLocaleString('en-US')}
            </button>
            <button type="button" className="tfd-btn tfd-btn-glass shrink-0 px-3 py-1.5 text-xs" onClick={() => onPoints(0)}>
              Clear
            </button>
          </div>
          <p className="tfd-muted mt-1 text-[11px]">
            {points > 0
              ? `Takes ${rs(points)} off. ${(customer.points - points).toLocaleString('en-US')} points left.`
              : `Up to ${max.toLocaleString('en-US')} points on this bill · ${rs(max)}`}
          </p>
        </div>
      ) : null}
    </div>
  )
}

// ── Orders tab ──────────────────────────────────────────────────────────────

export function PosOrders({ nextNo, onSend }: { nextNo: number; onSend: (bill: Bill) => void }) {
  const notify = useNotify()
  const orderRef = useRef<HTMLDivElement>(null)
  const serial = useRef(1)

  const [kind, setKind] = useState<OrderKind>('Dine in')
  const [cart, setCart] = useState<CartLine[]>([])
  const [phone, setPhone] = useState('')
  const [name, setName] = useState('')
  const [customer, setCustomer] = useState<PosCustomer | null>(null)
  const [offerCode, setOfferCode] = useState<string | null>(null)
  const [points, setPoints] = useState(0)
  const [table, setTable] = useState('')
  const [guests, setGuests] = useState('')
  const [servedBy, setServedBy] = useState(STAFF[0])
  const [notes, setNotes] = useState('')
  const [error, setError] = useState('')
  const [sent, setSent] = useState<Bill | null>(null)

  const [picking, setPicking] = useState<MenuItem | null>(null)
  const [editing, setEditing] = useState<CartLine | null>(null)
  const [discounting, setDiscounting] = useState<CartLine | null>(null)
  const [adding, setAdding] = useState(false)

  const digits = phone.replace(/\D/g, '')
  const suggestions = !customer && digits.length >= 3 ? POS_CUSTOMERS.filter((c) => c.phone.includes(digits)) : []

  const subtotal = cart.reduce((sum, l) => sum + l.unit * l.qty - (l.discount ?? 0), 0)
  const offer = customer ? offersFor(customer, subtotal).find((o) => o.code === offerCode && !o.reason) : undefined
  const offerOff = offer?.amount ?? 0
  const pointsOff = Math.min(points, Math.max(0, subtotal - offerOff))
  const toPay = Math.max(0, subtotal - offerOff - pointsOff)
  const count = cart.reduce((n, l) => n + l.qty, 0)
  const counts = useMemo(() => cart.reduce<Record<string, number>>((acc, l) => ({ ...acc, [l.id]: (acc[l.id] ?? 0) + l.qty }), {}), [cart])

  function choose(found: PosCustomer) {
    setCustomer(found)
    setPhone(prettyPhone(found.phone))
    setName(found.name)
    setOfferCode(null)
    setPoints(0)
  }

  function typePhone(value: string) {
    setPhone(value)
    setCustomer(null)
    setOfferCode(null)
    setPoints(0)
    const exact = POS_CUSTOMERS.find((c) => c.phone === value.replace(/\D/g, ''))
    if (exact) choose(exact)
  }

  function add(item: MenuItem, result: { unit: number; options: string; qty: number; note: string }) {
    setSent(null)
    setError('')
    setCart((current) => {
      const same = current.find((l) => l.id === item.id && l.options === result.options && l.note === result.note && !l.discount)
      if (same) return current.map((l) => (l === same ? { ...l, qty: Math.min(50, l.qty + result.qty) } : l))
      return [...current, { key: serial.current++, id: item.id, ...result }]
    })
  }

  function pick(item: MenuItem) {
    if (OPTION_GROUPS[item.id]) setPicking(item)
    else add(item, { unit: item.price, options: '', qty: 1, note: '' })
  }

  function step(line: CartLine, by: number) {
    setCart((current) => current.flatMap((l) => (l.key !== line.key ? [l] : l.qty + by <= 0 ? [] : [{ ...l, qty: Math.min(50, l.qty + by) }])))
  }

  function send() {
    if (cart.length === 0) return setError('Tap a dish to start the order.')
    if (kind === 'Dine in' && !table) return setError('Choose a table for a dine-in order')
    if (kind === 'Delivery' && digits.length < 9) return setError('A delivery needs a phone number')
    const bill: Bill = {
      no: nextNo,
      kind,
      table: kind === 'Dine in' ? Number(table) : undefined,
      customer,
      walkIn: customer ? undefined : name.trim() || (kind === 'Counter' ? 'Walk-in' : undefined),
      lines: cart.map((l) => ({
        name: menuById(l.id).name,
        qty: l.qty,
        unit: l.unit,
        options: l.options || undefined,
        note: l.note || undefined,
        discount: l.discount,
        discountReason: l.reason,
      })),
      discount: offerOff,
      discountNote: offer?.code,
      pointsUsed: pointsOff,
      tip: 0,
      payments: [],
      held: false,
      status: 'Accepted',
      placed: 'Just now',
    }
    onSend(bill)
    setSent(bill)
    setCart([])
    setOfferCode(null)
    setPoints(0)
    setError('')
    notify(`#${bill.no} sent to the kitchen. The bill is waiting on the Cashier tab.`)
  }

  function reset() {
    setSent(null)
    setPhone('')
    setName('')
    setCustomer(null)
    setTable('')
    setGuests('')
    setNotes('')
  }

  const sentSubtotal = sent ? sent.lines.reduce((s, l) => s + l.unit * l.qty - (l.discount ?? 0), 0) : 0
  const sentOff = sent ? sent.discount + sent.pointsUsed : 0
  const sentService = sent?.kind === 'Dine in' ? (sentSubtotal - sentOff) * SERVICE_RATE : 0

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
      <div className="min-w-0 space-y-3">
        <p className="tfd-muted text-xs">Tap a dish to add it. Adjust quantity with − and +, then send it to the kitchen and print the bill.</p>
        <div className="tfd-scroll flex gap-1.5 overflow-x-auto">
          {KINDS.map((k) => (
            <button key={k.kind} type="button" role="tab" aria-selected={kind === k.kind} title={k.hint} onClick={() => setKind(k.kind)} className="tfd-tab shrink-0 rounded-full px-4 py-2 text-xs font-semibold">
              {k.kind}
            </button>
          ))}
        </div>
        <MenuPicker counts={counts} onPick={pick} />
        {count > 0 ? (
          <div className="sticky bottom-24 z-10 lg:hidden">
            <button
              type="button"
              className="tfd-btn tfd-btn-primary w-full justify-between px-5 py-3 text-sm"
              onClick={() => orderRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
            >
              <span className="flex items-center gap-2">
                <ShoppingBag className="h-4 w-4" aria-hidden /> {count} item{count === 1 ? '' : 's'} · view order
              </span>
              <span className="tabular-nums">{rs(toPay)}</span>
            </button>
          </div>
        ) : null}
      </div>

      <div ref={orderRef} className="tfd-card h-fit min-w-0 scroll-mt-40 space-y-3 rounded-2xl p-4 lg:sticky lg:top-24">
        {sent ? (
          <div className="tfd-fade space-y-3">
            <div className="flex items-center justify-between">
              <h4 className="text-sm font-bold">Bill · #{sent.no}</h4>
              <Pill tone="ok">Sent</Pill>
            </div>
            <ul className="space-y-1 text-xs">
              {sent.lines.map((l, i) => (
                <li key={i} className="flex justify-between gap-2">
                  <span className="min-w-0 truncate">
                    {l.qty} × {l.name}
                    {l.options ? <span className="tfd-muted"> · {l.options}</span> : null}
                  </span>
                  <span className="tabular-nums">{rs(l.unit * l.qty - (l.discount ?? 0))}</span>
                </li>
              ))}
            </ul>
            <dl className="tfd-line space-y-1 border-t pt-2 text-xs">
              <div className="tfd-muted flex justify-between"><dt>Subtotal</dt><dd className="tabular-nums">{rs(sentSubtotal)}</dd></div>
              {sentOff > 0 ? <div className="tfd-ok flex justify-between"><dt>Discount</dt><dd className="tabular-nums">− {rs(sentOff)}</dd></div> : null}
              <div className="tfd-muted flex justify-between"><dt>Service</dt><dd className="tabular-nums">{rs(sentService)}</dd></div>
              <div className="flex justify-between text-base font-bold"><dt>Total</dt><dd className="tabular-nums">{rs(sentSubtotal - sentOff + sentService)}</dd></div>
            </dl>
            <p className="tfd-muted text-[11px]">Unpaid — take payment on the Cashier screen.</p>
            <div className="grid grid-cols-2 gap-2">
              <button type="button" className="tfd-btn tfd-btn-glass px-3 py-2.5 text-sm" onClick={() => notify(`Bill #${sent.no} sent to the receipt printer.`)}>
                <Printer className="h-4 w-4" aria-hidden /> Print bill
              </button>
              <button type="button" className="tfd-btn tfd-btn-primary px-3 py-2.5 text-sm" onClick={reset}>
                <Plus className="h-4 w-4" aria-hidden /> New
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between">
              <h4 className="text-sm font-bold">Order</h4>
              <Pill tone="brand">{count} item{count === 1 ? '' : 's'}</Pill>
            </div>

            {customer ? <GuestPanel customer={customer} subtotal={subtotal} offerCode={offerCode} onOffer={setOfferCode} points={points} onPoints={setPoints} /> : null}

            <div className="grid grid-cols-2 gap-2">
              <div className="relative">
                <Field label={kind === 'Delivery' ? 'Phone' : 'Phone (optional)'}>
                  <input value={phone} onChange={(e) => typePhone(e.target.value)} inputMode="tel" placeholder="07X XXX XXXX" className="tfd-input w-full px-3 py-2 text-sm" />
                </Field>
                {suggestions.length > 0 ? (
                  <div className="tfd-modal absolute left-0 top-full z-20 mt-1 w-[min(19rem,80vw)] rounded-xl p-1.5">
                    {suggestions.map((c) => (
                      <button key={c.phone} type="button" onClick={() => choose(c)} className="tfd-tab flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs">
                        <span>
                          <span className="block font-semibold" style={{ color: 'var(--fg)' }}>{c.name}</span>
                          <span className="tabular-nums">{prettyPhone(c.phone)}</span>
                        </span>
                        <Pill tone="brand">{c.points.toLocaleString('en-US')} pts</Pill>
                      </button>
                    ))}
                    <p className="tfd-muted px-2.5 pb-1 pt-1.5 text-[10px]">Choosing one replaces the name you have typed.</p>
                  </div>
                ) : null}
              </div>
              <Field label={kind === 'Counter' ? 'Customer (optional)' : 'Customer'}>
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder={kind === 'Counter' ? 'Walk-in' : 'Name'} className="tfd-input w-full px-3 py-2 text-sm" />
              </Field>
            </div>
            <div className="flex items-center justify-between gap-2">
              <p className="tfd-muted text-[11px]">{customer ? 'Points are earned on this bill.' : 'Try typing 077 to find a saved customer.'}</p>
              <button type="button" className="tfd-btn tfd-btn-glass shrink-0 px-3 py-1.5 text-xs" onClick={() => setAdding(true)}>
                <UserPlus className="h-3.5 w-3.5" aria-hidden /> Add customer
              </button>
            </div>

            <div className="tfd-line border-t pt-3">
              {cart.length === 0 ? (
                <p className="tfd-muted py-4 text-center text-sm">Tap a dish to start the order.</p>
              ) : (
                <ul className="space-y-2.5">
                  {cart.map((l) => {
                    const item = menuById(l.id)
                    return (
                      <li key={l.key} className="text-xs">
                        <div className="flex items-start gap-2">
                          <button type="button" className="min-w-0 flex-1 text-left" onClick={() => (OPTION_GROUPS[l.id] ? setEditing(l) : setDiscounting(l))}>
                            <span className="block truncate font-semibold">
                              {item.emoji} {item.name}
                            </span>
                            {l.options ? <span className="tfd-muted block truncate">{l.options}</span> : null}
                            <span className="tfd-muted block">
                              {rs(l.unit)} each{OPTION_GROUPS[l.id] ? ' · tap to change' : ''}
                            </span>
                            {l.note ? <span className="tfd-warn block">“{l.note}”</span> : null}
                          </button>
                          <span className="tfd-track flex shrink-0 items-center gap-1 rounded-full p-0.5">
                            <button type="button" aria-label={`One less ${item.name}`} onClick={() => step(l, -1)} className="tfd-btn tfd-btn-glass h-6 w-6">
                              {l.qty === 1 ? <Trash2 className="h-3 w-3" aria-hidden /> : <Minus className="h-3 w-3" aria-hidden />}
                            </button>
                            <span className="w-4 text-center font-bold tabular-nums">{l.qty}</span>
                            <button type="button" aria-label={`One more ${item.name}`} onClick={() => step(l, 1)} className="tfd-btn tfd-btn-glass h-6 w-6">
                              <Plus className="h-3 w-3" aria-hidden />
                            </button>
                          </span>
                        </div>
                        <div className="mt-0.5 flex items-center justify-between">
                          <button type="button" className="tfd-brand font-semibold hover:underline" onClick={() => setDiscounting(l)}>
                            {l.discount ? 'Change discount' : 'Discount this item'}
                          </button>
                          <span className="tabular-nums">
                            {l.discount ? <span className="tfd-muted mr-1.5 line-through">{rs(l.unit * l.qty)}</span> : null}
                            <span className="font-bold">{rs(l.unit * l.qty - (l.discount ?? 0))}</span>
                          </span>
                        </div>
                        {l.discount ? <p className="tfd-ok">− {rs(l.discount)}{l.reason ? ` · ${l.reason}` : ''}</p> : null}
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>

            <dl className="tfd-line space-y-1 border-t pt-3 text-xs">
              <div className="tfd-muted flex justify-between"><dt>Subtotal</dt><dd className="tabular-nums">{rs(subtotal)}</dd></div>
              {offer ? <div className="tfd-ok flex justify-between"><dt>Offer · {offer.code}</dt><dd className="tabular-nums">− {rs(offerOff)}</dd></div> : null}
              {pointsOff > 0 ? <div className="tfd-ok flex justify-between"><dt>{pointsOff.toLocaleString('en-US')} points</dt><dd className="tabular-nums">− {rs(pointsOff)}</dd></div> : null}
              <div className="flex justify-between text-lg font-bold"><dt>To pay</dt><dd className="tabular-nums">{rs(toPay)}</dd></div>
            </dl>
            <p className="tfd-muted text-[11px]">Tax and service charge are added on the bill.</p>

            <div className="grid grid-cols-2 gap-2">
              {kind === 'Dine in' ? (
                <>
                  <Field label="Table">
                    <select value={table} onChange={(e) => setTable(e.target.value)} className="tfd-input w-full px-2 py-2 text-sm">
                      <option value="">Choose a table…</option>
                      {POS_TABLES.map((t) => (
                        <option key={t.n} value={t.n} disabled={t.status !== 'free'}>
                          Table {t.n} · {t.area} · {t.status}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Guests (optional)">
                    <input value={guests} onChange={(e) => setGuests(e.target.value.replace(/\D/g, '').slice(0, 2))} inputMode="numeric" placeholder="How many?" className="tfd-input w-full px-3 py-2 text-sm" />
                  </Field>
                </>
              ) : null}
              <div className="col-span-2">
                <Field label="Served by" hint="Credited with the sale in staff reports.">
                  <select value={servedBy} onChange={(e) => setServedBy(e.target.value)} className="tfd-input w-full px-2 py-2 text-sm">
                    {STAFF.map((s) => (
                      <option key={s}>{s}</option>
                    ))}
                  </select>
                </Field>
              </div>
              <div className="col-span-2">
                <Field label={kind === 'Delivery' ? 'Address / notes' : 'Notes'}>
                  <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={kind === 'Delivery' ? 'Delivery address' : 'e.g. no chilli'} className="tfd-input w-full px-3 py-2 text-sm" />
                </Field>
              </div>
            </div>

            {error ? <p className="tfd-bad text-xs font-semibold" role="alert">{error}</p> : null}
            <button type="button" className="tfd-btn tfd-btn-primary w-full px-4 py-3 text-sm" onClick={send}>
              <Send className="h-4 w-4" aria-hidden /> Send to kitchen & bill · {rs(toPay)}
            </button>
          </>
        )}
      </div>

      {picking ? (
        <OptionDialog
          item={picking}
          onClose={() => setPicking(null)}
          onDone={(result) => {
            add(picking, result)
            setPicking(null)
          }}
        />
      ) : null}

      {editing ? (
        <OptionDialog
          item={menuById(editing.id)}
          initial={editing}
          onClose={() => setEditing(null)}
          onDone={(result) => {
            setCart((current) => current.map((l) => (l.key === editing.key ? { ...l, ...result } : l)))
            setEditing(null)
          }}
        />
      ) : null}

      {discounting ? (
        <LineDiscountDialog
          title={`Discount ${discounting.qty} × ${menuById(discounting.id).name}`}
          linePrice={discounting.unit * discounting.qty}
          current={discounting.discount}
          currentReason={discounting.reason}
          onClose={() => setDiscounting(null)}
          onApply={(amount, reason) => {
            setCart((current) => current.map((l) => (l.key === discounting.key ? { ...l, discount: amount || undefined, reason: amount ? reason : undefined } : l)))
            setDiscounting(null)
          }}
        />
      ) : null}

      {adding ? (
        <AddCustomerDialog
          phone={phone}
          name={name}
          onClose={() => setAdding(false)}
          onUse={(found) => {
            choose(found)
            setAdding(false)
          }}
        />
      ) : null}
    </div>
  )
}

// ── Dialogs shared with the Cashier tab ─────────────────────────────────────

export function LineDiscountDialog({
  title,
  linePrice,
  current,
  currentReason,
  onApply,
  onClose,
}: {
  title: string
  linePrice: number
  current?: number
  currentReason?: string
  onApply: (amount: number, reason: string) => void
  onClose: () => void
}) {
  const [amount, setAmount] = useState(current ? String(current) : '')
  const [reason, setReason] = useState(currentReason ?? '')
  const off = Math.min(linePrice, Number(amount) || 0)
  return (
    <Modal title={title} onClose={onClose}>
      <div className="space-y-3">
        <p className="flex justify-between text-sm">
          <span className="tfd-muted">Line price</span>
          <span className="font-bold tabular-nums">{rs(linePrice)}</span>
        </p>
        <Field label="Take off (Rs)" hint={off > 0 ? `The line becomes ${rs(linePrice - off)}` : undefined}>
          <input value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))} inputMode="decimal" placeholder="0.00" className="tfd-input w-full px-3 py-2 text-sm" />
        </Field>
        <Field label="Why (optional)">
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. served cold" className="tfd-input w-full px-3 py-2 text-sm" />
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <button type="button" disabled={!current} className="tfd-btn tfd-btn-glass px-3 py-2.5 text-sm" onClick={() => onApply(0, '')}>
            Remove discount
          </button>
          <button type="button" disabled={off <= 0} className="tfd-btn tfd-btn-primary px-3 py-2.5 text-sm" onClick={() => onApply(off, reason.trim())}>
            Apply discount
          </button>
        </div>
      </div>
    </Modal>
  )
}

export function AddCustomerDialog({
  phone,
  name,
  onUse,
  onClose,
}: {
  phone: string
  name: string
  onUse: (customer: PosCustomer) => void
  onClose: () => void
}) {
  const [number, setNumber] = useState(phone)
  const [fullName, setFullName] = useState(name)
  const [category, setCategory] = useState('')
  const existing = POS_CUSTOMERS.find((c) => c.phone === number.replace(/\D/g, ''))
  const valid = number.replace(/\D/g, '').length >= 9

  return (
    <Modal title="Add customer" subtitle="Saved once, recognised at every branch." onClose={onClose}>
      <div className="space-y-3">
        <Field label="Phone number">
          <input value={number} onChange={(e) => setNumber(e.target.value)} inputMode="tel" placeholder="07X XXX XXXX" className="tfd-input w-full px-3 py-2 text-sm" />
        </Field>
        {existing ? (
          <div className="tfd-card flex items-center justify-between gap-2 rounded-xl p-3 text-xs">
            <span>
              <span className="font-bold">{existing.name}</span> · {existing.points.toLocaleString('en-US')} points already has this number.
            </span>
            <button type="button" className="tfd-btn tfd-btn-primary shrink-0 px-3 py-1.5 text-xs" onClick={() => onUse(existing)}>
              Use them
            </button>
          </div>
        ) : null}
        <Field label="Name">
          <input value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="Optional" className="tfd-input w-full px-3 py-2 text-sm" />
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Category">
            <select value={category} onChange={(e) => setCategory(e.target.value)} className="tfd-input w-full px-2 py-2 text-sm">
              <option value="">No category</option>
              <option>VIP</option>
              <option>Regular</option>
              <option>New</option>
            </select>
          </Field>
          <Field label="Email">
            <input type="email" placeholder="Optional" className="tfd-input w-full px-3 py-2 text-sm" />
          </Field>
          <Field label="Date of birth">
            <input type="date" className="tfd-input w-full px-3 py-2 text-sm" />
          </Field>
          <Field label="Anniversary">
            <input type="date" className="tfd-input w-full px-3 py-2 text-sm" />
          </Field>
        </div>
        <Field label="Address">
          <input placeholder="Optional" className="tfd-input w-full px-3 py-2 text-sm" />
        </Field>
        <Field label="Notes">
          <input placeholder="e.g. allergic to peanuts" className="tfd-input w-full px-3 py-2 text-sm" />
        </Field>
        <button
          type="button"
          disabled={!valid || Boolean(existing)}
          className="tfd-btn tfd-btn-primary w-full px-4 py-3 text-sm"
          onClick={() =>
            onUse({
              name: fullName.trim() || 'Guest',
              phone: number.replace(/\D/g, ''),
              points: 0,
              category: (category || 'New') as PosCustomer['category'],
            })
          }
        >
          <UserPlus className="h-4 w-4" aria-hidden /> Add customer
        </button>
      </div>
    </Modal>
  )
}
