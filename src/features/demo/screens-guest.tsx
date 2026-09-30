'use client'

import { useEffect, useState } from 'react'
import {
  ArrowRight,
  Bell,
  Check,
  ChefHat,
  ChevronLeft,
  ChevronRight,
  Clock,
  Flame,
  Minus,
  Percent,
  Plus,
  QrCode as QrIcon,
  Receipt,
  ScanLine,
  Search,
  ShoppingBag,
  Star,
  Trash2,
  Utensils,
  X,
} from 'lucide-react'

import { cn } from '@/lib/utils'

import { MENU, MENU_CATEGORIES, menuById, rs, type MenuCategory, type MenuItem } from './data'
import { OPTION_GROUPS, POS_CUSTOMERS, SOLD_OUT, detailOf, fromPrice, isVeg } from './pos-data'
import { Card, CardTitle, Meter, Pill, QrCode, useNotify, type QrShape } from './ui'

type Page = 'welcome' | 'menu' | 'cart' | 'track' | 'bill'

const PAGES: { id: Page; label: string; what: string }[] = [
  { id: 'welcome', label: 'Welcome', what: 'The guest scans the QR on the table. Your logo, cover photo, colours and opening hours are on the first screen.' },
  { id: 'menu', label: 'Menu', what: 'Search, veg filter, offers, chef’s picks and every dish with its photo, price, spice level and rating. Sold-out dishes are greyed out the moment the kitchen runs out.' },
  { id: 'cart', label: 'Cart', what: 'The guest checks the order, enters a coupon, adds a mobile number for points and sends it. Service charge is worked out before they confirm.' },
  { id: 'track', label: 'Food tracker', what: 'Each dish shows Pending, Preparing, Ready or Done as the kitchen taps it. The guest can call a waiter, add more dishes or open the bill.' },
  { id: 'bill', label: 'Bill', what: 'The guest sees the full bill and chooses how to pay: scan and pay, bank transfer, card at the table or cash. The receipt can be emailed.' },
]

const STEPS = [
  { title: 'Order received', text: 'Waiting to be confirmed' },
  { title: 'Accepted', text: 'Confirmed and sent to the kitchen' },
  { title: 'Preparing', text: 'Your food is being cooked' },
  { title: 'Ready', text: 'Freshly plated' },
  { title: 'Served', text: 'Enjoy your meal' },
]

interface Line {
  key: number
  id: string
  qty: number
  unit: number
  options: string
  note: string
}

const SAMPLE: Line[] = [
  { key: 9001, id: 'm07', qty: 2, unit: 1550, options: 'Regular · Extra cheese', note: 'Less spicy' },
  { key: 9002, id: 'm25', qty: 2, unit: 390, options: '', note: '' },
  { key: 9003, id: 'm21', qty: 1, unit: 550, options: '', note: '' },
]

const SERVICE = 0.1
const sum = (lines: Line[]) => lines.reduce((s, l) => s + l.unit * l.qty, 0)

function VegTag({ id }: { id: string }) {
  const veg = isVeg(id)
  return <span className={cn('rounded px-1 text-[8px] font-bold tracking-wider', veg ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700')}>{veg ? 'VEG' : 'NON-VEG'}</span>
}

function Spice({ level }: { level: number }) {
  if (!level) return null
  return (
    <span className="flex items-center text-red-500" title={['', 'Mild', 'Medium', 'Hot'][level]}>
      {Array.from({ length: level }, (_, i) => (
        <Flame key={i} className="h-3 w-3" aria-hidden />
      ))}
    </span>
  )
}

export function GuestPreview({ qr }: { qr: QrShape }) {
  const notify = useNotify()
  const [page, setPage] = useState<Page>('welcome')
  const [table, setTable] = useState('7')
  const [cart, setCart] = useState<Line[]>([])
  const [serial, setSerial] = useState(1)
  const [sheet, setSheet] = useState<MenuItem | null>(null)
  const [calling, setCalling] = useState(false)
  const [flash, setFlash] = useState('')

  const [query, setQuery] = useState('')
  const [diet, setDiet] = useState<'all' | 'veg' | 'nonveg'>('all')
  const [category, setCategory] = useState<'All' | MenuCategory>('All')

  const [coupon, setCoupon] = useState('')
  const [applied, setApplied] = useState<{ code: string; off: number } | null>(null)
  const [couponError, setCouponError] = useState('')
  const [guestPhone, setGuestPhone] = useState('')

  const [order, setOrder] = useState<{ lines: Line[]; off: number; code?: string } | null>(null)
  const [stage, setStage] = useState(0)
  const [pay, setPay] = useState<'choose' | 'qr' | 'bank' | 'waiting' | 'paid'>('choose')
  const [feedback, setFeedback] = useState<'ask' | 'done' | null>(null)

  const count = cart.reduce((n, l) => n + l.qty, 0)
  const subtotal = sum(cart)
  const known = POS_CUSTOMERS.find((c) => c.phone === guestPhone.replace(/\D/g, ''))

  // In-phone notices fade on their own, like the toasts a guest would see.
  useEffect(() => {
    if (!flash) return
    const timer = setTimeout(() => setFlash(''), 2600)
    return () => clearTimeout(timer)
  }, [flash])

  // The kitchen "works" on the order by itself so the tracker is alive.
  useEffect(() => {
    if (!order || stage >= STEPS.length - 1) return
    const timer = setTimeout(() => setStage((s) => s + 1), 4200)
    return () => clearTimeout(timer)
  }, [order, stage])

  function go(target: Page) {
    // Jumping straight to a late page fills in a sample order so there is something to look at.
    if (target === 'cart' && cart.length === 0) setCart(SAMPLE)
    if ((target === 'track' || target === 'bill') && !order) {
      setOrder({ lines: cart.length ? cart : SAMPLE, off: 0 })
      setStage(target === 'bill' ? 4 : 0)
      setCart([])
    }
    setSheet(null)
    setCalling(false)
    setPage(target)
  }

  function addLine(item: MenuItem, line: Omit<Line, 'key' | 'id'>) {
    setCart((current) => {
      const same = current.find((l) => l.id === item.id && l.options === line.options && l.note === line.note)
      if (same) return current.map((l) => (l === same ? { ...l, qty: l.qty + line.qty } : l))
      return [...current, { key: serial, id: item.id, ...line }]
    })
    setSerial((n) => n + 1)
  }

  function applyCoupon() {
    const code = coupon.trim().toUpperCase()
    if (code === 'WELCOME10') {
      setApplied({ code, off: Math.round(subtotal * 0.1) })
      setCouponError('')
    } else if (code === 'FEAST500' && subtotal >= 3000) {
      setApplied({ code, off: 500 })
      setCouponError('')
    } else {
      setApplied(null)
      setCouponError(code === 'FEAST500' ? `Spend ${rs(3000 - subtotal)} more to use that code` : 'That code is not valid')
    }
  }

  function place() {
    const off = applied?.off ?? 0
    setOrder({ lines: cart, off, code: applied?.code })
    setCart([])
    setApplied(null)
    setCoupon('')
    setStage(0)
    setPay('choose')
    setFeedback(null)
    setPage('track')
    setFlash('Order #1049 sent to the kitchen')
    notify('The order is on the kitchen screen, the live floor and the cashier’s queue at the same moment.')
  }

  const itemState = (index: number) => {
    // Dishes finish one after another, so the pills do not all flip together.
    if (stage >= 4) return 'Done ✓'
    if (stage === 3) return 'Ready to serve'
    if (stage === 2) return index === 0 ? 'Ready to serve' : 'Preparing'
    return 'Pending'
  }

  const orderSubtotal = order ? sum(order.lines) : 0
  const orderService = order ? Math.round((orderSubtotal - order.off) * SERVICE) : 0
  const orderTotal = order ? orderSubtotal - order.off + orderService : 0
  const info = PAGES.find((p) => p.id === page)!

  const q = query.trim().toLowerCase()
  const menu = MENU.filter(
    (m) =>
      (category === 'All' || m.category === category) &&
      (diet === 'all' || (diet === 'veg') === isVeg(m.id)) &&
      (q === '' || m.name.toLowerCase().includes(q)),
  )
  const browsing = q === '' && diet === 'all' && category === 'All'

  return (
    <div className="grid items-start gap-6 lg:grid-cols-[340px_minmax(0,1fr)]">
      {/* ── The guest's phone ─────────────────────────────────────────────── */}
      <div className="mx-auto w-full max-w-[340px]">
        <div className="rounded-[2.6rem] p-2.5 shadow-2xl" style={{ background: 'var(--phone)' }}>
          <div className="relative flex h-[640px] flex-col overflow-hidden rounded-[2rem] bg-white text-slate-900">
            <div className="pointer-events-none absolute left-1/2 top-2 z-30 h-5 w-24 -translate-x-1/2 rounded-full" style={{ background: 'var(--phone)' }} />

            {flash ? (
              <div className="tfd-pop absolute inset-x-3 top-9 z-40 rounded-xl bg-slate-900 px-3 py-2 text-center text-xs font-semibold text-white shadow-lg">{flash}</div>
            ) : null}

            {/* Welcome */}
            {page === 'welcome' ? (
              <div className="relative flex flex-1 flex-col justify-between bg-cover bg-center px-4 pb-4 pt-10 text-white" style={{ backgroundImage: "linear-gradient(rgba(15,12,30,.62), rgba(15,12,30,.9)), url('/default-cover.jpg')" }}>
                <div className="flex items-center gap-3">
                  <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-orange-400 to-rose-500 shadow-lg">
                    <Utensils className="h-7 w-7" aria-hidden />
                  </span>
                  <div>
                    <p className="text-xl font-extrabold leading-tight">Spice Garden</p>
                    <p className="text-xs text-white/75">Authentic Sri Lankan kitchen</p>
                    <p className="mt-1 inline-flex items-center gap-1.5 rounded-full bg-white/15 px-2 py-0.5 text-[10px]">
                      <Clock className="h-3 w-3" aria-hidden /> 11:00 – 23:30 <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" /> Open
                    </p>
                  </div>
                </div>

                <div className="rounded-3xl border border-white/25 bg-white/15 p-4 backdrop-blur-md">
                  <p className="text-center text-[9px] uppercase tracking-[0.2em] text-white/60">Powered by TableFlow</p>
                  <p className="mt-2 text-center text-lg font-bold">What is your table number?</p>
                  <p className="text-center text-xs text-white/70">You will find it on the stand or card on your table.</p>
                  <input
                    value={table}
                    onChange={(e) => setTable(e.target.value.toUpperCase().slice(0, 4))}
                    inputMode="numeric"
                    aria-label="Table number"
                    placeholder="5"
                    className="mt-3 w-full rounded-2xl border border-white/30 bg-white/90 py-2.5 text-center text-2xl font-extrabold text-slate-900 outline-none"
                  />
                  <button type="button" disabled={!table} className="tfd-btn tfd-btn-primary mt-3 w-full px-4 py-3 text-sm" onClick={() => { setFlash(`Table ${table} — welcome!`); setPage('menu') }}>
                    Continue to the menu <ArrowRight className="h-4 w-4" aria-hidden />
                  </button>
                  <div className="mt-3 grid grid-cols-4 gap-1.5 text-center text-[10px]">
                    {[['Scan', ScanLine], ['Order', ShoppingBag], ['Track', ChefHat], ['Pay', Receipt]].map(([label, Icon]) => {
                      const I = Icon as typeof ScanLine
                      return (
                        <span key={label as string} className="rounded-xl bg-white/10 py-2">
                          <I className="mx-auto mb-0.5 h-4 w-4" aria-hidden />
                          {label as string}
                        </span>
                      )
                    })}
                  </div>
                  <p className="mt-2 text-center text-[10px] text-white/60">No app, no sign-up. Order straight from your phone.</p>
                </div>
              </div>
            ) : null}

            {/* Menu */}
            {page === 'menu' ? (
              <>
                <div className="border-b border-slate-100 bg-white px-3 pb-2 pt-8">
                  <div className="flex items-center gap-2">
                    <button type="button" aria-label="Back" onClick={() => setPage('welcome')} className="flex h-8 w-8 items-center justify-center rounded-full bg-slate-100">
                      <ChevronLeft className="h-4 w-4" aria-hidden />
                    </button>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-bold leading-tight">Spice Garden</p>
                      <p className="text-[10px] text-slate-500">Colombo 03 · Table {table}</p>
                    </div>
                    <button type="button" onClick={() => setCalling(true)} className="flex items-center gap-1 rounded-full bg-orange-50 px-2.5 py-1.5 text-[11px] font-bold text-orange-600">
                      <Bell className="h-3.5 w-3.5" aria-hidden /> Call
                    </button>
                  </div>
                  <label className="relative mt-2 block">
                    <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" aria-hidden />
                    <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search the menu…" aria-label="Search the menu" className="w-full rounded-full bg-slate-100 py-1.5 pl-8 pr-3 text-xs outline-none" />
                  </label>
                  <div className="tfd-scroll mt-2 flex gap-1.5 overflow-x-auto text-[11px] font-semibold">
                    <button type="button" aria-pressed={diet === 'veg'} onClick={() => setDiet((d) => (d === 'veg' ? 'all' : 'veg'))} className={cn('shrink-0 rounded-full border px-2.5 py-1', diet === 'veg' ? 'border-emerald-500 bg-emerald-50 text-emerald-700' : 'border-slate-200 text-slate-600')}>
                      <span className="text-emerald-600">●</span> Veg
                    </button>
                    <button type="button" aria-pressed={diet === 'nonveg'} onClick={() => setDiet((d) => (d === 'nonveg' ? 'all' : 'nonveg'))} className={cn('shrink-0 rounded-full border px-2.5 py-1', diet === 'nonveg' ? 'border-red-500 bg-red-50 text-red-700' : 'border-slate-200 text-slate-600')}>
                      <span className="text-red-600">●</span> Non-veg
                    </button>
                    <span className="w-px shrink-0 bg-slate-200" />
                    {(['All', ...MENU_CATEGORIES] as const).map((c) => (
                      <button key={c} type="button" onClick={() => setCategory(c)} className={cn('shrink-0 rounded-full px-2.5 py-1', category === c ? 'bg-orange-500 text-white' : 'bg-slate-100 text-slate-600')}>
                        {c}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="tfd-thin-scroll flex-1 space-y-3 overflow-y-auto bg-slate-50 px-3 py-3">
                  {order ? (
                    <button type="button" onClick={() => setPage('track')} className="flex w-full items-center justify-between rounded-xl bg-emerald-50 px-3 py-2 text-xs font-bold text-emerald-700">
                      <span>📡 Live order #1049</span> <ChevronRight className="h-4 w-4" aria-hidden />
                    </button>
                  ) : null}

                  {browsing ? (
                    <>
                      <div className="rounded-2xl border border-orange-100 bg-orange-50 p-3">
                        <p className="flex items-center gap-1.5 text-xs font-bold text-orange-700">
                          <Percent className="h-3.5 w-3.5" aria-hidden /> Offers
                        </p>
                        {[['10% off your first order', 'WELCOME10'], ['Rs 500 off on orders over Rs 3,000', 'FEAST500']].map(([text, code]) => (
                          <p key={code} className="mt-1.5 flex items-center justify-between gap-2 text-[11px]">
                            {text} <span className="rounded bg-white px-1.5 py-0.5 font-mono text-[10px] font-bold text-orange-700">{code}</span>
                          </p>
                        ))}
                        <p className="mt-1.5 text-[10px] text-orange-700/70">Enter the code at checkout to apply it.</p>
                      </div>

                      <div>
                        <p className="text-xs font-bold">Chef’s picks & favourites</p>
                        <p className="text-[10px] text-slate-500">Our guests love these — tap to add</p>
                        <div className="tfd-scroll -mx-3 mt-1.5 flex gap-2 overflow-x-auto px-3">
                          {MENU.filter((m) => m.tag === 'Popular').map((m) => (
                            <button key={m.id} type="button" onClick={() => setSheet(m)} className="w-28 shrink-0 overflow-hidden rounded-2xl border border-slate-100 bg-white text-left shadow-sm">
                              <span className="relative flex h-16 items-center justify-center bg-gradient-to-br from-orange-100 to-rose-100 text-3xl">
                                <span aria-hidden>{m.emoji}</span>
                                <span className="absolute left-1 top-1 rounded-full bg-white/90 px-1.5 text-[8px] font-bold">🔥 Popular</span>
                              </span>
                              <span className="block px-2 py-1.5">
                                <span className="block truncate text-[11px] font-semibold">{m.name}</span>
                                <span className="text-[11px] font-bold text-orange-600">{rs(fromPrice(m).price)}</span>
                              </span>
                            </button>
                          ))}
                        </div>
                      </div>
                    </>
                  ) : null}

                  {MENU_CATEGORIES.filter((c) => menu.some((m) => m.category === c)).map((c) => (
                    <div key={c}>
                      <p className="mb-1.5 flex items-center justify-between text-[10px] font-bold uppercase tracking-wider text-slate-500">
                        {c} <span>{menu.filter((m) => m.category === c).length}</span>
                      </p>
                      <ul className="space-y-2">
                        {menu.filter((m) => m.category === c).map((m) => {
                          const d = detailOf(m.id)
                          const from = fromPrice(m)
                          const out = SOLD_OUT.has(m.id)
                          return (
                            <li key={m.id}>
                              <button type="button" disabled={out} onClick={() => setSheet(m)} className={cn('flex w-full gap-2.5 rounded-2xl border border-slate-100 bg-white p-2.5 text-left shadow-sm', out && 'opacity-45')}>
                                <span className="min-w-0 flex-1">
                                  <span className="flex flex-wrap items-center gap-1">
                                    <VegTag id={m.id} />
                                    {m.tag === 'Popular' ? <span className="text-[9px] font-bold text-amber-600">★ Popular</span> : null}
                                    {m.tag === 'New' ? <span className="text-[9px] font-bold text-violet-600">New</span> : null}
                                  </span>
                                  <span className="mt-0.5 block text-xs font-bold">{m.name}</span>
                                  <span className="block text-xs font-bold text-orange-600">
                                    {from.sizes ? <span className="font-medium text-slate-500">from </span> : null}
                                    {rs(from.price)}
                                    {from.sizes ? <span className="font-medium text-slate-500"> · {from.sizes} sizes</span> : null}
                                  </span>
                                  <span className="mt-0.5 line-clamp-2 block text-[10px] leading-snug text-slate-500">{d.description}</span>
                                  <span className="mt-1 flex items-center gap-2 text-[10px] text-slate-500">
                                    <span>⏱ {d.minutes} min</span>
                                    <Spice level={d.spice} />
                                    <span>★ {d.rating}</span>
                                    {out ? <span className="font-bold text-red-600">Sold out</span> : null}
                                  </span>
                                </span>
                                <span className="relative flex h-20 w-20 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-orange-50 to-amber-100 text-4xl">
                                  <span aria-hidden>{m.emoji}</span>
                                  {out ? null : <span className="absolute -bottom-1.5 rounded-full bg-white px-2 py-0.5 text-[9px] font-extrabold text-orange-600 shadow">ADD</span>}
                                </span>
                              </button>
                            </li>
                          )
                        })}
                      </ul>
                    </div>
                  ))}
                  {menu.length === 0 ? (
                    <div className="py-8 text-center">
                      <p className="text-sm font-bold">Nothing matched</p>
                      <p className="text-xs text-slate-500">Try a different word.</p>
                      <button type="button" className="mt-2 rounded-full bg-slate-200 px-3 py-1 text-xs font-semibold" onClick={() => { setQuery(''); setDiet('all'); setCategory('All') }}>
                        Clear filters
                      </button>
                    </div>
                  ) : null}
                </div>

                {count > 0 ? (
                  <div className="border-t border-slate-100 bg-white p-2.5">
                    <button type="button" onClick={() => setPage('cart')} className="tfd-btn tfd-btn-primary w-full justify-between px-4 py-3 text-xs">
                      <span className="flex items-center gap-2">
                        <ShoppingBag className="h-4 w-4" aria-hidden /> {count} item{count === 1 ? '' : 's'} in your order
                      </span>
                      <span className="flex items-center gap-1 tabular-nums">
                        {rs(subtotal)} · View cart <ChevronRight className="h-3.5 w-3.5" aria-hidden />
                      </span>
                    </button>
                  </div>
                ) : null}
              </>
            ) : null}

            {/* Cart */}
            {page === 'cart' ? (
              <>
                <div className="flex items-center gap-2 border-b border-slate-100 px-3 pb-2.5 pt-8">
                  <button type="button" aria-label="Back to menu" onClick={() => setPage('menu')} className="flex h-8 w-8 items-center justify-center rounded-full bg-slate-100">
                    <ChevronLeft className="h-4 w-4" aria-hidden />
                  </button>
                  <p className="flex-1 text-sm font-bold">Your order</p>
                  <span className="rounded-full bg-orange-50 px-2 py-0.5 text-[10px] font-bold text-orange-600">Table {table}</span>
                </div>
                {cart.length === 0 ? (
                  <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
                    <ShoppingBag className="h-8 w-8 text-slate-300" aria-hidden />
                    <p className="text-sm font-bold">Your cart is empty</p>
                    <p className="text-xs text-slate-500">Add something from the menu and it will show up here.</p>
                    <button type="button" className="tfd-btn tfd-btn-primary mt-1 px-4 py-2 text-xs" onClick={() => setPage('menu')}>Browse the menu</button>
                  </div>
                ) : (
                  <>
                    <div className="tfd-thin-scroll flex-1 space-y-3 overflow-y-auto bg-slate-50 px-3 py-3">
                      <ul className="space-y-2 rounded-2xl bg-white p-2.5 shadow-sm">
                        {cart.map((l) => {
                          const m = menuById(l.id)
                          return (
                            <li key={l.key} className="flex items-center gap-2">
                              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-orange-50 text-2xl" aria-hidden>{m.emoji}</span>
                              <span className="min-w-0 flex-1 text-[11px]">
                                <span className="block truncate font-bold">{m.name}</span>
                                {l.options ? <span className="block truncate text-slate-500">{l.options}</span> : null}
                                {l.note ? <span className="block truncate italic text-slate-500">“{l.note}”</span> : null}
                                <span className="font-bold tabular-nums">{rs(l.unit * l.qty)}</span>
                              </span>
                              <span className="flex shrink-0 items-center gap-1">
                                <button type="button" aria-label={l.qty === 1 ? `Remove ${m.name}` : `One less ${m.name}`} className="flex h-6 w-6 items-center justify-center rounded-full bg-slate-100" onClick={() => setCart((c) => c.flatMap((x) => (x.key !== l.key ? [x] : x.qty > 1 ? [{ ...x, qty: x.qty - 1 }] : [])))}>
                                  {l.qty === 1 ? <Trash2 className="h-3 w-3" aria-hidden /> : <Minus className="h-3 w-3" aria-hidden />}
                                </button>
                                <span className="w-3 text-center text-xs font-bold">{l.qty}</span>
                                <button type="button" aria-label={`One more ${m.name}`} className="flex h-6 w-6 items-center justify-center rounded-full bg-orange-500 text-white" onClick={() => setCart((c) => c.map((x) => (x.key === l.key ? { ...x, qty: x.qty + 1 } : x)))}>
                                  <Plus className="h-3 w-3" aria-hidden />
                                </button>
                              </span>
                            </li>
                          )
                        })}
                        <li>
                          <button type="button" className="text-[11px] font-bold text-orange-600" onClick={() => setPage('menu')}>+ Add more items</button>
                        </li>
                      </ul>

                      <div className="rounded-2xl bg-white p-2.5 shadow-sm">
                        <p className="text-xs font-bold">Have a coupon?</p>
                        <div className="mt-1.5 flex gap-1.5">
                          <input value={coupon} onChange={(e) => setCoupon(e.target.value.toUpperCase())} placeholder="WELCOME10" aria-label="Coupon code" className="w-full min-w-0 rounded-lg bg-slate-100 px-2.5 py-1.5 font-mono text-xs outline-none" />
                          <button type="button" className="shrink-0 rounded-lg bg-slate-900 px-3 text-xs font-bold text-white" onClick={applyCoupon}>Apply</button>
                        </div>
                        {applied ? <p className="mt-1 text-[11px] font-semibold text-emerald-600">{applied.code} applied — you saved {rs(applied.off)}</p> : null}
                        {couponError ? <p className="mt-1 text-[11px] font-semibold text-red-600">{couponError}</p> : null}
                      </div>

                      <div className="space-y-1.5 rounded-2xl bg-white p-2.5 shadow-sm">
                        <p className="text-xs font-bold">Your details</p>
                        <input placeholder="Your name (optional)" aria-label="Your name" className="w-full rounded-lg bg-slate-100 px-2.5 py-1.5 text-xs outline-none" />
                        <input value={guestPhone} onChange={(e) => setGuestPhone(e.target.value)} inputMode="tel" placeholder="Mobile number (optional)" aria-label="Mobile number" className="w-full rounded-lg bg-slate-100 px-2.5 py-1.5 text-xs outline-none" />
                        <p className="text-[10px] text-slate-500">{known ? `Welcome back, ${known.name.split(' ')[0]}. You have ${known.points.toLocaleString('en-US')} points.` : 'Add it to collect loyalty points on this order. Try 0771234521.'}</p>
                        <input placeholder="Note for the kitchen" aria-label="Note for the kitchen" className="w-full rounded-lg bg-slate-100 px-2.5 py-1.5 text-xs outline-none" />
                      </div>

                      <dl className="space-y-1 rounded-2xl bg-white p-2.5 text-[11px] shadow-sm">
                        <dt className="text-xs font-bold">Bill summary</dt>
                        <div className="flex justify-between text-slate-500"><dt>Item total</dt><dd className="tabular-nums">{rs(subtotal)}</dd></div>
                        {applied ? <div className="flex justify-between text-emerald-600"><dt>Coupon discount</dt><dd className="tabular-nums">− {rs(applied.off)}</dd></div> : null}
                        <div className="flex justify-between text-slate-500"><dt>Service charge</dt><dd className="tabular-nums">{rs(Math.round((subtotal - (applied?.off ?? 0)) * SERVICE))}</dd></div>
                        <div className="flex justify-between border-t border-slate-100 pt-1 text-sm font-extrabold"><dt>To pay</dt><dd className="tabular-nums">{rs(Math.round((subtotal - (applied?.off ?? 0)) * (1 + SERVICE)))}</dd></div>
                        <dd className="text-emerald-600">You’ll earn {Math.floor(subtotal / 100)} points on this order</dd>
                        <dd className="text-slate-500">Estimated preparation time · about 15 minutes</dd>
                      </dl>
                    </div>
                    <div className="border-t border-slate-100 bg-white p-2.5">
                      <button type="button" className="tfd-btn tfd-btn-primary w-full px-4 py-3 text-sm" onClick={place}>
                        Place order · {rs(Math.round((subtotal - (applied?.off ?? 0)) * (1 + SERVICE)))}
                      </button>
                    </div>
                  </>
                )}
              </>
            ) : null}

            {/* Tracker */}
            {page === 'track' && order ? (
              <>
                <div className="flex items-center gap-2 border-b border-slate-100 px-3 pb-2.5 pt-8">
                  <button type="button" aria-label="Back" onClick={() => setPage('menu')} className="flex h-8 w-8 items-center justify-center rounded-full bg-slate-100">
                    <ChevronLeft className="h-4 w-4" aria-hidden />
                  </button>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-bold leading-tight">Order #1049</p>
                    <p className="text-[10px] text-slate-500">Spice Garden · Table {table}</p>
                  </div>
                  <button type="button" className="rounded-full bg-orange-50 px-2.5 py-1.5 text-[11px] font-bold text-orange-600" onClick={() => setFlash('A waiter is on the way')}>
                    🔔 Call waiter
                  </button>
                </div>
                <div className="tfd-thin-scroll flex-1 space-y-3 overflow-y-auto bg-slate-50 px-3 py-3">
                  <div className={cn('rounded-2xl bg-gradient-to-br p-4 text-white transition-colors duration-700', stage >= 3 ? 'from-emerald-500 to-teal-500' : 'from-orange-500 to-rose-500')}>
                    <p className="text-lg font-extrabold">{stage >= 4 ? 'Your food has been served' : STEPS[stage].title}</p>
                    <p className="text-xs text-white/85">{stage >= 4 ? 'Enjoy your meal' : stage === 3 ? 'A waiter is bringing it over' : `About ${15 - stage * 5} minutes to go`}</p>
                  </div>

                  <ol className="space-y-2.5 rounded-2xl bg-white p-3 shadow-sm">
                    {STEPS.map((s, i) => (
                      <li key={s.title} className="flex items-center gap-2.5">
                        <span className={cn('flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-white transition-colors duration-500', i < stage || stage === 4 ? 'bg-emerald-500' : i === stage ? 'animate-pulse bg-orange-500' : 'bg-slate-200')}>
                          {i < stage || stage === 4 ? <Check className="h-3.5 w-3.5" aria-hidden /> : i + 1}
                        </span>
                        <span className={cn('text-[11px]', i > stage && 'text-slate-400')}>
                          <span className="block font-bold">{s.title}</span>
                          <span className="text-slate-500">{s.text}</span>
                        </span>
                      </li>
                    ))}
                  </ol>

                  <div className="rounded-2xl bg-white p-3 shadow-sm">
                    <p className="mb-1.5 flex items-center justify-between text-xs font-bold">
                      Your items <span className="rounded-full bg-slate-100 px-2 text-[10px]">{order.lines.length} items</span>
                    </p>
                    <ul className="space-y-2">
                      {order.lines.map((l, i) => {
                        const state = itemState(i)
                        return (
                          <li key={l.key} className="flex items-center justify-between gap-2 text-[11px]">
                            <span className="min-w-0">
                              <span className="flex items-center gap-1">
                                <VegTag id={l.id} />
                                <span className="truncate font-bold">{menuById(l.id).name} × {l.qty}</span>
                              </span>
                              {l.options ? <span className="block truncate text-slate-500">{l.options}</span> : null}
                            </span>
                            <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold', state === 'Pending' ? 'bg-slate-100 text-slate-500' : state === 'Preparing' ? 'bg-amber-100 text-amber-700' : 'bg-emerald-100 text-emerald-700')}>{state}</span>
                          </li>
                        )
                      })}
                    </ul>
                    <p className="mt-2 flex justify-between border-t border-slate-100 pt-2 text-xs font-extrabold">
                      Total <span className="tabular-nums">{rs(orderTotal)}</span>
                    </p>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2 border-t border-slate-100 bg-white p-2.5 text-xs font-bold">
                  <button type="button" className="rounded-full bg-slate-100 py-2.5" onClick={() => setPage('bill')}>🧾 View bill</button>
                  <button type="button" className="rounded-full bg-orange-500 py-2.5 text-white" onClick={() => setPage('menu')}>Add more items</button>
                </div>
              </>
            ) : null}

            {/* Bill */}
            {page === 'bill' && order ? (
              <>
                <div className="flex items-center gap-2 border-b border-slate-100 px-3 pb-2.5 pt-8">
                  <button type="button" aria-label="Back to the order" onClick={() => setPage('track')} className="flex h-8 w-8 items-center justify-center rounded-full bg-slate-100">
                    <ChevronLeft className="h-4 w-4" aria-hidden />
                  </button>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-bold leading-tight">Your bill</p>
                    <p className="text-[10px] text-slate-500">Order #1049</p>
                  </div>
                  <span className={cn('rounded-full px-2 py-0.5 text-[10px] font-bold', pay === 'paid' ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700')}>{pay === 'paid' ? 'Paid' : 'Unpaid'}</span>
                </div>
                <div className="tfd-thin-scroll flex-1 space-y-3 overflow-y-auto bg-slate-50 px-3 py-3">
                  {pay === 'paid' ? (
                    <div className="rounded-2xl bg-emerald-50 p-3 text-center text-emerald-700">
                      <p className="text-sm font-extrabold">Paid in full</p>
                      <p className="text-[11px]">Thank you! Your bill for {rs(orderTotal)} is settled.</p>
                    </div>
                  ) : null}

                  <div className="rounded-2xl bg-white p-3 font-mono text-[11px] shadow-sm">
                    <p className="text-center font-sans text-sm font-extrabold">Spice Garden</p>
                    <p className="text-center font-sans text-[10px] text-slate-500">12 Galle Road, Colombo 03</p>
                    <p className="mt-2 flex justify-between border-y border-dashed border-slate-200 py-1 text-[10px] text-slate-500">
                      <span>Order #1049</span><span>Table {table}</span><span>30 Sep 2026</span>
                    </p>
                    <ul className="mt-2 space-y-1">
                      {order.lines.map((l) => (
                        <li key={l.key} className="flex justify-between gap-2">
                          <span className="min-w-0 truncate">{menuById(l.id).name} × {l.qty}</span>
                          <span className="tabular-nums">{rs(l.unit * l.qty)}</span>
                        </li>
                      ))}
                    </ul>
                    <dl className="mt-2 space-y-0.5 border-t border-dashed border-slate-200 pt-2">
                      <div className="flex justify-between"><dt>Subtotal</dt><dd>{rs(orderSubtotal)}</dd></div>
                      {order.off ? <div className="flex justify-between"><dt>Discount ({order.code})</dt><dd>− {rs(order.off)}</dd></div> : null}
                      <div className="flex justify-between"><dt>Service charge</dt><dd>{rs(orderService)}</dd></div>
                      <div className="flex justify-between font-sans text-sm font-extrabold"><dt>Grand total</dt><dd>{rs(orderTotal)}</dd></div>
                      <div className="flex justify-between"><dt>Amount due</dt><dd>{rs(pay === 'paid' ? 0 : orderTotal)}</dd></div>
                    </dl>
                    <p className="mt-2 text-center font-sans text-[9px] text-slate-400">Thank you for dining with us · Powered by TableFlow</p>
                  </div>

                  {pay !== 'paid' ? (
                    <div className="rounded-2xl bg-white p-3 shadow-sm">
                      <p className="text-xs font-bold">Pay your bill</p>
                      {pay === 'choose' ? (
                        <>
                          <p className="text-[10px] text-slate-500">Pay from your phone, or call a waiter to pay by card or cash at the table.</p>
                          <div className="mt-2 grid grid-cols-2 gap-1.5 text-[11px]">
                            {[
                              ['Scan & pay', 'Wallets and banking apps', () => setPay('qr')],
                              ['Online / bank transfer', 'Transfer and send the receipt', () => setPay('bank')],
                              ['Card at the table', 'Our waiter brings the terminal', () => { setPay('waiting'); setFlash('Our cashier will confirm shortly') }],
                              ['Cash', 'Pay our cashier directly', () => { setPay('waiting'); setFlash('Our cashier will confirm shortly') }],
                            ].map(([title, text, run]) => (
                              <button key={title as string} type="button" onClick={run as () => void} className="rounded-xl border border-slate-200 p-2 text-left">
                                <span className="block font-bold">{title as string}</span>
                                <span className="block text-[10px] leading-tight text-slate-500">{text as string}</span>
                              </button>
                            ))}
                          </div>
                        </>
                      ) : pay === 'qr' ? (
                        <div className="mt-2 text-center">
                          <QrCode qr={qr} className="mx-auto h-28 w-28" />
                          <p className="mt-1 text-[10px] text-slate-500">Scan with any payment app to pay {rs(orderTotal)}</p>
                          <button type="button" className="tfd-btn tfd-btn-primary mt-2 w-full px-3 py-2 text-xs" onClick={() => { setPay('paid'); setFeedback('ask') }}>I have completed the payment</button>
                          <button type="button" className="mt-1 text-[10px] font-semibold text-slate-500" onClick={() => setPay('choose')}>Choose another method</button>
                        </div>
                      ) : pay === 'bank' ? (
                        <div className="mt-2 space-y-0.5 text-[11px]">
                          <p className="flex justify-between"><span className="text-slate-500">Bank</span><span className="font-bold">Sample Bank PLC</span></p>
                          <p className="flex justify-between"><span className="text-slate-500">Account name</span><span className="font-bold">Spice Garden (Pvt) Ltd</span></p>
                          <p className="flex justify-between"><span className="text-slate-500">Account no.</span><span className="font-bold">0000 1234 5678</span></p>
                          <p className="flex justify-between"><span className="text-slate-500">Amount to transfer</span><span className="font-bold">{rs(orderTotal)}</span></p>
                          <button type="button" className="tfd-btn tfd-btn-wa mt-2 w-full px-3 py-2 text-xs" onClick={() => setFlash('Receipt sent on WhatsApp')}>Send your receipt on WhatsApp</button>
                          <button type="button" className="tfd-btn tfd-btn-primary mt-1.5 w-full px-3 py-2 text-xs" onClick={() => { setPay('paid'); setFeedback('ask') }}>I have completed the transfer</button>
                          <button type="button" className="mt-1 block w-full text-center text-[10px] font-semibold text-slate-500" onClick={() => setPay('choose')}>Choose another method</button>
                        </div>
                      ) : (
                        <div className="mt-2 text-center">
                          <p className="text-[11px] text-slate-500">Our cashier will confirm shortly.</p>
                          <button type="button" className="tfd-btn tfd-btn-primary mt-2 w-full px-3 py-2 text-xs" onClick={() => { setPay('paid'); setFeedback('ask'); setFlash('Payment confirmed — thank you!') }}>Play the cashier: confirm payment</button>
                        </div>
                      )}
                    </div>
                  ) : null}

                  <div className="rounded-2xl bg-white p-3 shadow-sm">
                    <p className="text-xs font-bold">Receipt</p>
                    <div className="mt-1.5 flex gap-1.5">
                      <input type="email" placeholder="you@example.com" aria-label="Email for the receipt" className="w-full min-w-0 rounded-lg bg-slate-100 px-2.5 py-1.5 text-xs outline-none" />
                      <button type="button" className="shrink-0 rounded-lg bg-slate-900 px-3 text-xs font-bold text-white" onClick={() => setFlash('Receipt sent')}>Send</button>
                    </div>
                    <button type="button" className="mt-2 text-[11px] font-bold text-orange-600" onClick={() => setFlash('Saved as PDF')}>Print or save as PDF</button>
                  </div>
                </div>
              </>
            ) : null}

            {/* Item sheet */}
            {sheet ? <ItemSheet item={sheet} onClose={() => setSheet(null)} onAdd={(line) => { addLine(sheet, line); setSheet(null) }} /> : null}

            {/* Call staff */}
            {calling ? (
              <div className="absolute inset-0 z-20 flex items-end bg-black/45">
                <div className="tfd-pop w-full rounded-t-3xl bg-white p-4">
                  <div className="flex items-start justify-between">
                    <div>
                      <p className="text-sm font-bold">How can we help?</p>
                      <p className="text-[11px] text-slate-500">A team member will be with you shortly.</p>
                    </div>
                    <button type="button" aria-label="Close" onClick={() => setCalling(false)} className="flex h-7 w-7 items-center justify-center rounded-full bg-slate-100">
                      <X className="h-3.5 w-3.5" aria-hidden />
                    </button>
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-2 text-xs font-bold">
                    {[['💧', 'Water'], ['🍽️', 'Extra plates'], ['🧾', 'Bring the bill'], ['🙋', 'Call a waiter']].map(([icon, label]) => (
                      <button key={label} type="button" className="rounded-2xl border border-slate-200 py-3" onClick={() => { setCalling(false); setFlash('Our staff have been notified'); notify(`Table ${table}: “${label}”. It pops up on the waiter’s phone and the live floor.`) }}>
                        <span className="block text-xl" aria-hidden>{icon}</span>
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            ) : null}

            {/* Feedback */}
            {feedback === 'ask' ? (
              <div className="absolute inset-0 z-20 flex items-center bg-black/45 p-4">
                <div className="tfd-pop w-full rounded-3xl bg-white p-4 text-center">
                  <p className="text-sm font-bold">How was the system?</p>
                  <p className="text-[11px] text-slate-500">Quick feedback about the ordering and payment experience.</p>
                  <div className="mt-3 grid grid-cols-4 gap-1.5 text-[10px] font-semibold">
                    {[['😞', 'Bad'], ['😐', 'Okay'], ['🙂', 'Good'], ['😍', 'Great']].map(([face, label]) => (
                      <button key={label} type="button" className="rounded-xl border border-slate-200 py-2" onClick={() => { setFeedback('done'); setFlash('Thanks for the feedback!') }}>
                        <span className="block text-2xl" aria-hidden>{face}</span>
                        {label}
                      </button>
                    ))}
                  </div>
                  <button type="button" className="mt-3 text-[11px] font-semibold text-slate-500" onClick={() => setFeedback('done')}>Skip</button>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {/* ── Around the phone ──────────────────────────────────────────────── */}
      <div className="min-w-0 space-y-4">
        <Card>
          <CardTitle icon={QrIcon}>See every page the guest sees</CardTitle>
          <div role="tablist" aria-label="Guest pages" className="flex flex-wrap gap-1.5">
            {PAGES.map((p, i) => (
              <button key={p.id} type="button" role="tab" aria-selected={page === p.id} onClick={() => go(p.id)} className="tfd-tab rounded-full px-3.5 py-1.5 text-xs font-semibold">
                {i + 1}. {p.label}
              </button>
            ))}
            <button type="button" className="tfd-tab rounded-full px-3.5 py-1.5 text-xs font-semibold" onClick={() => { go('menu'); setSheet(menuById('m07')) }}>
              Dish details
            </button>
          </div>
          <p className="mt-3 text-sm">
            <span className="font-bold">{info.label}.</span> <span className="tfd-muted">{info.what}</span>
          </p>
        </Card>

        <Card>
          <CardTitle icon={Utensils} right={<Pill tone={order ? 'ok' : 'neutral'}>{order ? 'Live' : 'Waiting for an order'}</Pill>}>
            What your kitchen sees
          </CardTitle>
          {order ? (
            <div className="tfd-fade text-sm">
              <p className="font-bold">#1049 · Table {table} · QR order</p>
              <ul className="mt-1.5 space-y-1 text-xs">
                {order.lines.map((l, i) => (
                  <li key={l.key} className="flex items-center justify-between gap-2">
                    <span className="min-w-0 truncate">
                      <span className="font-bold">{l.qty} ×</span> {menuById(l.id).name}
                      {l.note ? <span className="tfd-warn"> · {l.note}</span> : null}
                    </span>
                    <Pill tone={itemState(i) === 'Pending' ? 'neutral' : itemState(i) === 'Preparing' ? 'warn' : 'ok'}>{itemState(i)}</Pill>
                  </li>
                ))}
              </ul>
              <Meter value={((stage + 1) / STEPS.length) * 100} tone="ok" className="mt-3" />
              <div className="mt-2 flex items-center justify-between gap-2">
                <p className="tfd-muted text-xs">{STEPS[stage].title}</p>
                <button type="button" className="tfd-btn tfd-btn-glass px-3 py-1.5 text-xs" onClick={() => setStage(0)}>
                  Replay the tracker
                </button>
              </div>
            </div>
          ) : (
            <p className="tfd-muted text-sm">Place an order on the phone and watch it arrive here in real time.</p>
          )}
        </Card>

        <div className="grid gap-3 sm:grid-cols-2">
          <Card className="flex items-center gap-3">
            <div className="shrink-0 rounded-xl bg-white p-2">
              <QrCode qr={qr} className="h-20 w-20" />
            </div>
            <div className="text-xs">
              <p className="text-sm font-bold">A QR for every table</p>
              <p className="tfd-muted">Print them from the dashboard. Separate QRs for takeaway, delivery and a menu-only view.</p>
            </div>
          </Card>
          <Card>
            <p className="text-sm font-bold">Yours to customise</p>
            <ul className="tfd-muted mt-1 space-y-0.5 text-xs">
              <li>Logo, cover photo and brand colour</li>
              <li>Show or hide prices, photos, offers and ratings</li>
              <li>Ask for name, phone or customer type before ordering</li>
            </ul>
          </Card>
        </div>
      </div>
    </div>
  )
}

// ── Dish details inside the phone ───────────────────────────────────────────

function ItemSheet({ item, onAdd, onClose }: { item: MenuItem; onAdd: (line: Omit<Line, 'key' | 'id'>) => void; onClose: () => void }) {
  const groups = OPTION_GROUPS[item.id] ?? []
  const d = detailOf(item.id)
  const [picked, setPicked] = useState<Record<string, string[]>>(() => Object.fromEntries(groups.map((g) => [g.name, g.kind === 'single' ? [g.choices[0].name] : []])))
  const [qty, setQty] = useState(1)
  const [note, setNote] = useState('')

  const size = groups.find((g) => g.kind === 'single')
  const base = size ? (size.choices.find((c) => picked[size.name]?.includes(c.name))?.price ?? item.price) : item.price
  const extras = groups.filter((g) => g.kind === 'multi').flatMap((g) => g.choices.filter((c) => picked[g.name]?.includes(c.name))).reduce((s, c) => s + c.price, 0)
  const unit = base + extras

  return (
    <div className="absolute inset-0 z-20 flex items-end bg-black/45">
      <div className="tfd-pop flex max-h-[92%] w-full flex-col overflow-hidden rounded-t-3xl bg-white">
        <div className="relative flex h-28 shrink-0 items-center justify-center bg-gradient-to-br from-orange-100 to-rose-100 text-6xl">
          <span aria-hidden>{item.emoji}</span>
          <button type="button" aria-label="Close" onClick={onClose} className="absolute right-3 top-3 flex h-7 w-7 items-center justify-center rounded-full bg-white/90">
            <X className="h-3.5 w-3.5" aria-hidden />
          </button>
        </div>
        <div className="tfd-thin-scroll flex-1 space-y-3 overflow-y-auto p-3">
          <div>
            <VegTag id={item.id} />
            <p className="mt-0.5 text-base font-extrabold leading-tight">{item.name}</p>
            <p className="text-sm font-bold text-orange-600">{rs(unit)}</p>
            <p className="mt-1 text-[11px] leading-snug text-slate-500">{d.description}</p>
            <p className="mt-1.5 flex flex-wrap items-center gap-2 text-[10px] text-slate-500">
              <span>⏱ {d.minutes} min</span>
              <Spice level={d.spice} />
              {d.spice ? <span>{['', 'Mild', 'Medium', 'Hot'][d.spice]}</span> : null}
              <span>{d.kcal} kcal</span>
              <span className="flex items-center gap-0.5"><Star className="h-3 w-3 fill-amber-400 text-amber-400" aria-hidden /> {d.rating}</span>
            </p>
            {d.allergens ? <p className="mt-1.5 rounded-lg bg-amber-50 px-2 py-1 text-[10px] text-amber-800"><span className="font-bold">Allergens:</span> {d.allergens}</p> : null}
          </div>

          {groups.map((g) => (
            <div key={g.name}>
              <p className="flex items-center justify-between text-xs font-bold">
                {g.name} <span className="text-[10px] font-medium text-slate-500">{g.required ? 'Required' : `Optional${g.max ? ` · up to ${g.max}` : ''}`}</span>
              </p>
              <div className="mt-1 space-y-1">
                {g.choices.map((c) => {
                  const on = picked[g.name]?.includes(c.name)
                  return (
                    <button
                      key={c.name}
                      type="button"
                      disabled={c.soldOut}
                      onClick={() =>
                        setPicked((current) => {
                          const mine = current[g.name] ?? []
                          if (g.kind === 'single') return { ...current, [g.name]: [c.name] }
                          if (on) return { ...current, [g.name]: mine.filter((x) => x !== c.name) }
                          if (g.max && mine.length >= g.max) return current
                          return { ...current, [g.name]: [...mine, c.name] }
                        })
                      }
                      className={cn('flex w-full items-center justify-between rounded-xl border px-2.5 py-1.5 text-[11px] disabled:opacity-40', on ? 'border-orange-500 bg-orange-50' : 'border-slate-200')}
                    >
                      <span className="flex items-center gap-2">
                        <span className={cn('flex h-3.5 w-3.5 items-center justify-center border text-white', g.kind === 'single' ? 'rounded-full' : 'rounded', on ? 'border-orange-500 bg-orange-500' : 'border-slate-300')}>
                          {on ? <Check className="h-2.5 w-2.5" aria-hidden /> : null}
                        </span>
                        {c.name}
                      </span>
                      <span className="tabular-nums text-slate-600">{g.kind === 'single' ? rs(c.price) : `+${rs(c.price)}`}</span>
                    </button>
                  )
                })}
              </div>
            </div>
          ))}

          <div>
            <p className="text-xs font-bold">Special instructions</p>
            <p className="text-[10px] text-slate-500">Allergies, spice level, anything the kitchen should know.</p>
            <textarea value={note} onChange={(e) => setNote(e.target.value.slice(0, 200))} rows={2} placeholder="e.g. no onions, extra spicy" aria-label="Special instructions" className="mt-1 w-full resize-none rounded-xl bg-slate-100 px-2.5 py-1.5 text-xs outline-none" />
            <p className="text-right text-[9px] text-slate-400">{note.length}/200</p>
          </div>
        </div>
        <div className="flex items-center gap-2 border-t border-slate-100 p-2.5">
          <span className="flex items-center gap-1.5 rounded-full bg-slate-100 p-1">
            <button type="button" aria-label="Decrease quantity" className="flex h-7 w-7 items-center justify-center rounded-full bg-white" onClick={() => setQty((n) => Math.max(1, n - 1))}>
              <Minus className="h-3.5 w-3.5" aria-hidden />
            </button>
            <span className="w-4 text-center text-xs font-bold">{qty}</span>
            <button type="button" aria-label="Increase quantity" className="flex h-7 w-7 items-center justify-center rounded-full bg-white" onClick={() => setQty((n) => Math.min(50, n + 1))}>
              <Plus className="h-3.5 w-3.5" aria-hidden />
            </button>
          </span>
          <button
            type="button"
            className="tfd-btn tfd-btn-primary flex-1 px-3 py-2.5 text-xs"
            onClick={() => onAdd({ qty, unit, note: note.trim(), options: groups.flatMap((g) => g.choices.filter((c) => picked[g.name]?.includes(c.name)).map((c) => c.name)).join(' · ') })}
          >
            Add · {rs(unit * qty)}
          </button>
        </div>
      </div>
    </div>
  )
}
