'use client'

import { useEffect, useRef, useState } from 'react'
import {
  AlertTriangle,
  BellRing,
  Star,
  Armchair,
  Clock,
  Receipt,
  ShoppingBag,
  Store,
  TrendingUp,
  Users,
  Utensils,
  Wallet,
} from 'lucide-react'

import { cn } from '@/lib/utils'

import {
  BRANCH_SALES,
  CHANNEL_MIX,
  FEED_POOL,
  FLOOR,
  SALES_BY_HOUR,
  compact,
  menuById,
  rs,
  type Channel,
  type FeedOrder,
  type FloorGuest,
  type FloorTable,
    type TableStatus,
} from './data'
import { AreaChart, Card, CardTitle, Donut, Meter, Pill, Stat, clock, useNotify, useTick, type Tone } from './ui'

const CHANNEL_TONE: Record<Channel, Tone> = {
  'Dine-in': 'brand',
  'QR order': 'violet',
  Delivery: 'ok',
  Takeaway: 'warn',
}

// ── Command center ──────────────────────────────────────────────────────────

export function CommandCenter() {
  const [feed, setFeed] = useState<FeedOrder[]>(() => FEED_POOL.slice(0, 5).map((o, i) => ({ ...o, no: 1045 - i })))
  const [sales, setSales] = useState(486250)
  const [orders, setOrders] = useState(142)
  const next = useRef(5)

  // A new order lands every few seconds, and the day's figures move with it.
  useEffect(() => {
    const timer = setInterval(() => {
      const incoming = FEED_POOL[next.current % FEED_POOL.length]
      next.current += 1
      setFeed((current) => [{ ...incoming, no: current[0].no + 1 }, ...current].slice(0, 6))
      setSales((s) => s + incoming.total)
      setOrders((n) => n + 1)
    }, 4200)
    return () => clearInterval(timer)
  }, [])

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat icon={Wallet} label="Sales today, all branches" value={rs(sales)} delta={12.4} />
        <Stat icon={Receipt} label="Orders today" value={String(orders)} delta={8.1} tone="violet" />
        <Stat icon={TrendingUp} label="Average bill" value={rs(sales / orders)} delta={3.9} tone="ok" />
        <Stat icon={Armchair} label="Tables occupied" value="31 / 46" hint="67% of the floor" tone="info" />
      </div>

      <div className="grid gap-4 lg:grid-cols-5">
        <Card className="lg:col-span-3">
          <CardTitle icon={TrendingUp} right={<Pill tone="ok">▲ 12.4% vs last Wed</Pill>}>
            Sales by hour
          </CardTitle>
          <AreaChart data={SALES_BY_HOUR} format={compact} height={250} />
        </Card>

        <Card className="lg:col-span-2">
          <CardTitle
            icon={ShoppingBag}
            right={
              <span className="tfd-ok flex items-center gap-2 text-xs font-semibold">
                <span className="tfd-live-dot" /> Live
              </span>
            }
          >
            Orders coming in
          </CardTitle>
          <ul className="space-y-2">
            {feed.map((order, index) => (
              <li
                key={order.no}
                className={cn('tfd-line flex items-center gap-3 rounded-xl border px-3 py-2', index === 0 && 'tfd-pop')}
              >
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2 text-xs font-semibold">
                    #{order.no} · {order.where}
                    <Pill tone={CHANNEL_TONE[order.channel]}>{order.channel}</Pill>
                  </p>
                  <p className="tfd-muted truncate text-[11px]">
                    {order.branch} · {order.items}
                  </p>
                </div>
                <span className="text-xs font-bold tabular-nums">{rs(order.total)}</span>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardTitle icon={Store}>Branches today</CardTitle>
          <ul className="space-y-3">
            {BRANCH_SALES.map((b) => {
              const pct = Math.round((b.sales / b.target) * 100)
              return (
                <li key={b.branch}>
                  <div className="mb-1 flex items-baseline justify-between text-xs">
                    <span className="font-semibold">{b.branch}</span>
                    <span className="tabular-nums">
                      {rs(b.sales)} <span className="tfd-muted">· {b.orders} orders</span>
                    </span>
                  </div>
                  <Meter value={pct} tone={pct >= 85 ? 'ok' : pct >= 70 ? 'brand' : 'warn'} />
                  <p className="tfd-muted mt-1 text-[11px]">{pct}% of the daily target</p>
                </li>
              )
            })}
          </ul>
        </Card>

        <Card>
          <CardTitle icon={Utensils}>Where orders come from</CardTitle>
          <Donut
            center={String(orders)}
            caption="orders"
            segments={CHANNEL_MIX.map((c) => ({ label: c.channel, share: c.share, color: c.color }))}
          />
        </Card>

        <Card>
          <CardTitle icon={AlertTriangle}>Needs your attention</CardTitle>
          <ul className="space-y-2 text-xs">
            <li className="flex items-start gap-2">
              <Pill tone="bad">Stock</Pill>
              <span>Garlic and Prawns are below reorder level in Galle Fort.</span>
            </li>
            <li className="flex items-start gap-2">
              <Pill tone="warn">Approvals</Pill>
              <span>6 requests are waiting: 1 discount, 1 refund, 1 purchase order.</span>
            </li>
            <li className="flex items-start gap-2">
              <Pill tone="info">Transfer</Pill>
              <span>TR-0148 left Colombo 03 for Galle Fort at 10:20 am.</span>
            </li>
            <li className="flex items-start gap-2">
              <Pill tone="violet">Kitchen</Pill>
              <span>Ticket #1039 has been on the board for over 13 minutes.</span>
            </li>
          </ul>
        </Card>
      </div>
    </div>
  )
}

// ── Live floor ──────────────────────────────────────────────────────────────

const STATUS_TONE: Record<TableStatus, Tone> = {
  Free: 'neutral',
  Seated: 'info',
  Ordered: 'warn',
  Served: 'ok',
  'Bill requested': 'brand',
  Reserved: 'violet',
}

const NEXT_STEP: Record<TableStatus, { label: string; to: TableStatus }> = {
  Free: { label: 'Seat guests', to: 'Seated' },
  Reserved: { label: 'Seat the reservation', to: 'Seated' },
  Seated: { label: 'Take the order', to: 'Ordered' },
  Ordered: { label: 'Mark as served', to: 'Served' },
  Served: { label: 'Request the bill', to: 'Bill requested' },
  'Bill requested': { label: 'Take payment and free the table', to: 'Free' },
}

type LiveTable = FloorTable & { startedAt?: number }

function tableTotal(table: FloorTable) {
  return (table.lines ?? []).reduce((sum, line) => sum + menuById(line.id).price * line.qty, 0)
}

export function LiveFloor() {
  const tick = useTick()
  const notify = useNotify()
  const [tables, setTables] = useState<LiveTable[]>(FLOOR)
  const [selectedId, setSelectedId] = useState('T4')
  const selected = tables.find((t) => t.id === selectedId)!

  const seconds = (t: LiveTable) => (t.minutes ?? 0) * 60 + tick - (t.startedAt ?? 0)
  const busy = tables.filter((t) => t.status !== 'Free' && t.status !== 'Reserved')
  const guests = busy.reduce((sum, t) => sum + (t.guests ?? 0), 0)
  const open = busy.reduce((sum, t) => sum + tableTotal(t), 0)

  function advance(table: LiveTable) {
    const step = NEXT_STEP[table.status]
    setTables((current) =>
      current.map((t) => {
        if (t.id !== table.id) return t
        if (step.to === 'Free') return { id: t.id, seats: t.seats, zone: t.zone, status: 'Free' as const }
        if (step.to === 'Seated') {
          return { ...t, status: 'Seated', guests: Math.min(t.seats, 2 + (t.seats > 4 ? 3 : 0)), waiter: 'Dev', minutes: 0, startedAt: tick, reservedFor: undefined, guest: step.to === 'Seated' && t.reservedFor ? { name: 'Fernando', tier: 'Returning', visits: 6, lastVisit: '2 Aug 2026', gapDays: 59, spent: 48200, points: 482, phone: '077 890 1122' } : undefined }
        }
        if (step.to === 'Ordered') {
          return { ...t, status: 'Ordered', lines: [{ id: 'm07', qty: 2 }, { id: 'm01', qty: 1 }, { id: 'm26', qty: 2 }] }
        }
        return { ...t, status: step.to }
      }),
    )
    if (step.to === 'Free') notify(`${table.id} paid ${rs(tableTotal(table) * 1.1)}. Receipt printed, table is free again.`)
    if (step.to === 'Ordered') notify(`Order for ${table.id} sent to the kitchen screen.`)
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat icon={Armchair} label="Tables in use" value={`${busy.length} / ${tables.length}`} tone="info" />
        <Stat icon={Users} label="Guests seated" value={String(guests)} tone="violet" />
        <Stat icon={Wallet} label="Open bills" value={rs(open)} />
        <Stat icon={Receipt} label="Waiting to pay" value={String(tables.filter((t) => t.status === 'Bill requested').length)} tone="warn" />
      </div>

      <div className="flex flex-wrap gap-1.5">
        {(Object.keys(STATUS_TONE) as TableStatus[]).map((s) => (
          <Pill key={s} tone={STATUS_TONE[s]}>
            {s} · {tables.filter((t) => t.status === s).length}
          </Pill>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          {(['Indoor', 'Terrace'] as const).map((zone) => (
            <div key={zone}>
              <p className="tfd-muted mb-2 text-xs font-semibold uppercase tracking-wider">{zone}</p>
              <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
                {tables
                  .filter((t) => t.zone === zone)
                  .map((t) => {
                    const total = tableTotal(t)
                    const active = t.id === selectedId
                    return (
                      <button
                        key={t.id}
                        type="button"
                        onClick={() => setSelectedId(t.id)}
                        aria-pressed={active}
                        className={cn(
                          'tfd-card rounded-2xl p-3 text-left transition-transform hover:-translate-y-0.5',
                          t.status === 'Bill requested' && 'tfd-pulse-ring',
                          active && 'tfd-selected',
                        )}
                      >
                        <div className="flex items-center justify-between">
                          <span className="text-lg font-bold">{t.id}</span>
                          <span className="tfd-muted flex items-center gap-1 text-[11px]">
                            <Users className="h-3 w-3" aria-hidden />
                            {t.guests ?? 0}/{t.seats}
                          </span>
                        </div>
                        <Pill tone={STATUS_TONE[t.status]} className="mt-1.5">
                          {t.status}
                        </Pill>
                        {t.status !== 'Free' && t.status !== 'Reserved' ? (
                          <p className={cn('mt-1.5 truncate text-[10px] font-semibold', t.guest ? tierTone(t.guest.tier) : 'tfd-muted')}>
                            {t.guest ? tierLabel(t.guest) : 'Guest — not identified'}
                          </p>
                        ) : null}
                        <div className="mt-2 flex items-center justify-between text-[11px]">
                          {t.status === 'Free' || t.status === 'Reserved' ? (
                            <span className="tfd-muted">{t.status === 'Reserved' ? '8:00 pm' : 'Ready'}</span>
                          ) : (
                            <>
                              <span className="tfd-muted flex items-center gap-1 tabular-nums">
                                <Clock className="h-3 w-3" aria-hidden />
                                {clock(seconds(t))}
                              </span>
                              <span className="font-semibold tabular-nums">{total ? rs(total) : '—'}</span>
                            </>
                          )}
                        </div>
                      </button>
                    )
                  })}
              </div>
            </div>
          ))}
        </div>

        <Card className="h-fit lg:sticky lg:top-28">
          <div className="mb-3 flex items-start justify-between">
            <div>
              <h3 className="text-lg font-bold">Table {selected.id.slice(1)}</h3>
              <p className="tfd-muted text-xs">
                {selected.zone} · {selected.seats} seats
                {selected.waiter ? ` · ${selected.waiter === 'QR' ? 'Ordered by QR' : `Waiter ${selected.waiter}`}` : ''}
              </p>
            </div>
            <Pill tone={STATUS_TONE[selected.status]}>{selected.status}</Pill>
          </div>

          {selected.status !== 'Free' && selected.status !== 'Reserved' ? <GuestBlock guest={selected.guest} /> : null}

          {selected.reservedFor ? <p className="mb-3 text-sm">Reserved for {selected.reservedFor}.</p> : null}

          {selected.lines?.length ? (
            <>
              <ul className="tfd-line space-y-1.5 border-b pb-3 text-xs">
                {selected.lines.map((line) => {
                  const item = menuById(line.id)
                  return (
                    <li key={line.id} className="flex items-center justify-between gap-2">
                      <span className="truncate">
                        {item.emoji} {line.qty} × {item.name}
                      </span>
                      <span className="tabular-nums">{rs(item.price * line.qty)}</span>
                    </li>
                  )
                })}
              </ul>
              <dl className="mt-3 space-y-1 text-xs">
                <div className="tfd-muted flex justify-between">
                  <dt>Service charge 10%</dt>
                  <dd className="tabular-nums">{rs(tableTotal(selected) * 0.1)}</dd>
                </div>
                <div className="flex justify-between text-base font-bold">
                  <dt>Total</dt>
                  <dd className="tabular-nums">{rs(tableTotal(selected) * 1.1)}</dd>
                </div>
              </dl>
            </>
          ) : selected.status === 'Seated' ? (
            <p className="tfd-muted text-sm">Guests are looking at the menu. Seated {clock(seconds(selected))} ago.</p>
          ) : selected.status === 'Free' ? (
            <p className="tfd-muted text-sm">This table is clean and ready for the next guests.</p>
          ) : null}

          <button type="button" className="tfd-btn tfd-btn-primary mt-4 w-full px-4 py-2.5 text-sm" onClick={() => advance(selected)}>
            {NEXT_STEP[selected.status].label}
          </button>
          {selected.status !== 'Free' ? (
            <button type="button" className="tfd-btn tfd-btn-glass mt-2 w-full px-4 py-2 text-sm" onClick={() => notify(`A waiter has been called to table ${selected.id.slice(1)}`)}>
              <BellRing className="h-4 w-4" aria-hidden /> Call a waiter
            </button>
          ) : null}
          <p className="tfd-muted mt-2 text-center text-[11px]">Try it. The floor updates for every device at once.</p>
        </Card>
      </div>
    </div>
  )
}

// ── Who is sitting there (mirrors the real live floor's customer block) ─────

function tierLabel(g: FloorGuest) {
  return g.tier === 'Returning' ? `Returning · ${g.visits}` : g.tier
}

function tierTone(tier: FloorGuest['tier']) {
  return tier === 'VIP' ? 'tfd-brand' : tier === 'Regular' ? 'tfd-info' : tier === 'Returning' ? 'tfd-violet' : 'tfd-ok'
}

function gapBadge(g: FloorGuest) {
  if (g.tier === 'First visit' || !g.gapDays) return null
  return g.gapDays >= 30 ? `back after ${g.gapDays}d` : 'welcome back'
}

function GuestBlock({ guest }: { guest?: FloorGuest }) {
  const initials = guest ? guest.name.split(' ').map((p) => p[0]).slice(0, 2).join('').toUpperCase() : '—'
  const gap = guest ? gapBadge(guest) : null
  return (
    <div className="tfd-line mb-3 border-b pb-3">
      <div className="flex items-center gap-2.5">
        <span className="tfd-btn-primary flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-bold">{initials}</span>
        <div className="min-w-0">
          <p className="truncate text-sm font-bold">{guest?.name ?? 'Walk-in'}</p>
          <p className="flex flex-wrap items-center gap-1">
            {guest ? (
              <>
                <Pill tone={guest.tier === 'VIP' ? 'brand' : guest.tier === 'Regular' ? 'info' : guest.tier === 'Returning' ? 'violet' : 'ok'}>
                  {guest.tier === 'First visit' ? <Star className="h-3 w-3" aria-hidden /> : null}
                  {tierLabel(guest)}
                </Pill>
                {gap ? <Pill tone="warn">{gap}</Pill> : null}
              </>
            ) : (
              <Pill>Not identified</Pill>
            )}
          </p>
        </div>
      </div>
      {guest ? (
        <dl className="mt-2.5 space-y-1 text-xs">
          <div className="flex justify-between gap-2"><dt className="tfd-muted">Visits before this</dt><dd className="font-semibold tabular-nums">{guest.visits}</dd></div>
          <div className="flex justify-between gap-2"><dt className="tfd-muted">Last visit</dt><dd className="font-semibold">{guest.lastVisit ?? '—'}</dd></div>
          <div className="flex justify-between gap-2"><dt className="tfd-muted">Came back after</dt><dd className="font-semibold">{guest.gapDays ? `${guest.gapDays} days` : '—'}</dd></div>
          {guest.spent > 0 ? <div className="flex justify-between gap-2"><dt className="tfd-muted">Spent with you</dt><dd className="font-semibold tabular-nums">{rs(guest.spent)}</dd></div> : null}
          <div className="flex justify-between gap-2"><dt className="tfd-muted">Points</dt><dd className="font-semibold tabular-nums">{guest.points.toLocaleString('en-US')}</dd></div>
          <div className="flex justify-between gap-2"><dt className="tfd-muted">Phone</dt><dd className="font-semibold tabular-nums">{guest.phone}</dd></div>
        </dl>
      ) : (
        <p className="tfd-muted mt-2 text-xs">No phone number was taken, so there is no history to show. This is not the same person as other walk-ins.</p>
      )}
    </div>
  )
}
