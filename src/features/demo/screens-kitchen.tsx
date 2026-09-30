'use client'

import { useEffect, useRef, useState } from 'react'
import { BellRing, Check, ChevronLeft, Clock, Flame, Play, Printer, Search, Timer, Utensils } from 'lucide-react'

import { cn } from '@/lib/utils'

import { KDS_SECTIONS, KDS_TICKETS, type KdsItem, type KdsTicket } from './pos-data'
import { Card, Pill, Stat, VegMark, useNotify, useTick } from './ui'

type Ticket = KdsTicket & { addedAt: number; fresh?: boolean }

const ARRIVAL: KdsTicket = {
  no: 1048, table: 5, customer: 'Walk-in', age: 0, estimate: 15,
  items: [
    { id: 'g1', name: 'Chicken Biryani', qty: 3, prepared: 0, state: 'QUEUED', section: 'Hot kitchen', veg: false, options: 'Single · Raita' },
    { id: 'g2', name: 'Chicken Satay', qty: 1, prepared: 0, state: 'QUEUED', section: 'Grill', veg: false },
    { id: 'g3', name: 'Ceylon Tea', qty: 3, prepared: 0, state: 'QUEUED', section: 'Bar', veg: true },
  ],
}

const live = (t: KdsTicket) => t.items.filter((i) => !i.cancelled)
const isReady = (t: KdsTicket) => live(t).every((i) => i.state === 'READY')

export function Kitchen() {
  const tick = useTick()
  const notify = useNotify()
  const [tickets, setTickets] = useState<Ticket[]>(() => KDS_TICKETS.map((t) => ({ ...t, addedAt: 0 })))
  const [section, setSection] = useState<KdsItem['section'] | null>(null)
  const [query, setQuery] = useState('')
  const tickRef = useRef(0)

  useEffect(() => {
    tickRef.current = tick
  }, [tick])

  // One order lands while the visitor is looking, the way it would mid-service.
  useEffect(() => {
    const timer = setTimeout(() => {
      setTickets((current) => (current.some((t) => t.no === ARRIVAL.no) ? current : [...current, { ...ARRIVAL, addedAt: tickRef.current, fresh: true }]))
      notify('New order #1048 · Table 5. It rings in the kitchen the moment the waiter sends it.')
    }, 14000)
    return () => clearTimeout(timer)
  }, [notify])

  const open = tickets.filter((t) => !t.handedOver)
  const q = query.trim().toLowerCase()
  const shown = open.filter((t) => !q || String(t.no).includes(q) || t.customer.toLowerCase().includes(q) || (t.table != null && `table ${t.table}`.includes(q)) || (t.pickup && 'takeaway pickup'.includes(q)))
  const cooking = shown.filter((t) => !isReady(t))
  const ready = shown.filter(isReady)

  const changeItem = (no: number, id: string, change: (item: KdsItem) => KdsItem) =>
    setTickets((current) => current.map((t) => (t.no !== no ? t : { ...t, fresh: false, items: t.items.map((i) => (i.id === id ? change(i) : i)) })))

  const start = (no: number, item: KdsItem) => changeItem(no, item.id, (i) => ({ ...i, state: 'PREPARING' }))
  const finish = (no: number, item: KdsItem) => changeItem(no, item.id, (i) => ({ ...i, state: 'READY', prepared: i.qty }))
  const plusOne = (no: number, item: KdsItem) =>
    changeItem(no, item.id, (i) => {
      const prepared = Math.min(i.qty, i.prepared + 1)
      return { ...i, prepared, state: prepared === i.qty ? 'READY' : 'PREPARING' }
    })

  function markReady(ticket: Ticket) {
    setTickets((current) => current.map((t) => (t.no !== ticket.no ? t : { ...t, fresh: false, items: t.items.map((i) => (i.cancelled ? i : { ...i, state: 'READY', prepared: i.qty })) })))
    notify(`Order #${ticket.no} is ready. ${ticket.table ? `The waiter for table ${ticket.table} hears a chime` : ticket.deliverTo ? 'The delivery desk sees it' : 'The counter sees it'} and the guest's tracker updates.`)
  }

  function handOver(ticket: Ticket) {
    setTickets((current) => current.map((t) => (t.no === ticket.no ? { ...t, handedOver: true } : t)))
    notify(`Order #${ticket.no} handed over.`)
  }

  const workload = (name: KdsItem['section']) => {
    const items = open.flatMap((t) => live(t)).filter((i) => i.section === name)
    return {
      waiting: items.filter((i) => i.state !== 'READY').reduce((n, i) => n + i.qty - i.prepared, 0),
      up: items.filter((i) => i.state === 'READY').reduce((n, i) => n + i.qty, 0),
    }
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-3">
        <Stat icon={Flame} label="Cooking" value={String(open.filter((t) => !isReady(t)).length)} />
        <Stat icon={Check} label="Ready" value={String(open.filter(isReady).length)} tone="ok" />
        <Stat icon={Timer} label="Avg cook time" value="12 min" tone="info" />
      </div>

      <div className="tfd-scroll -mx-1 flex gap-1.5 overflow-x-auto px-1">
        <button type="button" role="tab" aria-selected={section === null} onClick={() => setSection(null)} className="tfd-tab shrink-0 rounded-full px-3.5 py-1.5 text-xs font-semibold">
          All orders
        </button>
        {KDS_SECTIONS.map((s) => {
          const w = workload(s)
          return (
            <button key={s} type="button" role="tab" aria-selected={section === s} onClick={() => setSection(s)} className="tfd-tab flex shrink-0 items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-semibold">
              {s}
              <span className="rounded-full bg-black/10 px-1.5 tabular-nums">{w.waiting}</span>
              {w.up > 0 ? <span className="tabular-nums opacity-80">{w.up} up</span> : null}
            </button>
          )
        })}
      </div>

      {section ? (
        <SectionBoard
          section={section}
          tickets={open}
          tick={tick}
          onBack={() => setSection(null)}
          onStart={start}
          onReady={(no, item) => {
            finish(no, item)
            notify(`${item.qty} × ${item.name} ready. It is waiting for the floor.`)
          }}
        />
      ) : (
        <>
          <label className="relative block">
            <Search className="tfd-muted pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2" aria-hidden />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search orders by name, table or order #" aria-label="Search kitchen orders" className="tfd-input w-full py-2 pl-9 pr-3 text-sm" />
          </label>

          <div className="grid gap-4 lg:grid-cols-2">
            {(
              [
                ['Kitchen', Flame, cooking, 'Orders land here the moment they are placed at the till or accepted by the cashier.'],
                ['Ready to serve', Check, ready, 'Finished dishes will land here.'],
              ] as const
            ).map(([title, Icon, list, empty]) => (
              <div key={title} className="min-w-0 space-y-3">
                <p className="flex items-center gap-2 text-sm font-bold">
                  <Icon className={cn('h-4 w-4', title === 'Kitchen' ? 'tfd-brand' : 'tfd-ok')} aria-hidden /> {title} <Pill>{list.length}</Pill>
                </p>
                {list.length === 0 ? (
                  <Card className="py-8 text-center">
                    <p className="text-sm font-semibold">Nothing here</p>
                    <p className="tfd-muted text-xs">{empty}</p>
                  </Card>
                ) : (
                  list.map((t) => (
                    <TicketCard
                      key={t.no}
                      ticket={t}
                      elapsed={t.age + tick - t.addedAt}
                      onStart={(item) => start(t.no, item)}
                      onFinish={(item) => finish(t.no, item)}
                      onPlusOne={(item) => plusOne(t.no, item)}
                      onMarkReady={() => markReady(t)}
                      onHandOver={() => handOver(t)}
                      onUrgent={() => setTickets((current) => current.map((x) => (x.no === t.no ? { ...x, urgent: !x.urgent } : x)))}
                    />
                  ))
                )}
              </div>
            ))}
          </div>
        </>
      )}
      <p className="tfd-muted text-xs">Each dish has its own steps. Tap “Start preparing” when it goes on the heat, tick it when it is plated. The guest’s phone and the waiter follow along live.</p>
    </div>
  )
}

function TicketCard({
  ticket,
  elapsed,
  onStart,
  onFinish,
  onPlusOne,
  onMarkReady,
  onHandOver,
  onUrgent,
}: {
  ticket: Ticket
  elapsed: number
  onStart: (item: KdsItem) => void
  onFinish: (item: KdsItem) => void
  onPlusOne: (item: KdsItem) => void
  onMarkReady: () => void
  onHandOver: () => void
  onUrgent: () => void
}) {
  const notify = useNotify()
  const ready = isReady(ticket)
  const items = live(ticket)
  const minutes = Math.floor(elapsed / 60)
  const late = !ready && minutes > ticket.estimate
  const close = !ready && !late && minutes > ticket.estimate * 0.7
  const plates = items.reduce((n, i) => n + i.qty, 0)
  const prepared = items.reduce((n, i) => n + (i.state === 'READY' ? i.qty : i.prepared), 0)

  return (
    <div
      className={cn('tfd-card tfd-fade overflow-hidden rounded-2xl border-t-4', ticket.fresh && 'tfd-pulse-ring', ticket.urgent && 'tfd-selected')}
      style={{ borderTopColor: ready ? 'var(--ok)' : 'var(--brand)' }}
    >
      <div className="flex items-center gap-3 p-3">
        {ticket.table ? (
          <div className="tfd-btn-primary flex h-14 w-14 shrink-0 flex-col items-center justify-center rounded-xl">
            <span className="text-[9px] font-semibold uppercase tracking-wider opacity-90">Table</span>
            <span className="text-xl font-extrabold leading-none">{ticket.table}</span>
          </div>
        ) : (
          <div className="tfd-track flex h-14 w-14 shrink-0 flex-col items-center justify-center rounded-xl">
            <Utensils className="h-4 w-4" aria-hidden />
            <span className="text-[9px] font-semibold">Takeaway</span>
          </div>
        )}
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1.5 text-sm font-bold">
            #{ticket.no} {ticket.urgent ? <Pill tone="bad">urgent</Pill> : null}
          </p>
          <p className="tfd-muted truncate text-xs">
            {ticket.customer}
            {ticket.pickup ? ' · Pickup' : ''}
          </p>
          {ticket.deliverTo ? <p className="tfd-muted truncate text-xs">→ {ticket.deliverTo}</p> : null}
        </div>
        <span className={cn('flex shrink-0 items-center gap-1 text-sm font-bold tabular-nums', late ? 'tfd-bad' : close ? 'tfd-warn' : 'tfd-muted')}>
          <Clock className="h-3.5 w-3.5" aria-hidden />
          {minutes}m{late ? ' late' : ''}
        </span>
      </div>

      <div className="tfd-line flex items-center justify-between border-y px-3 py-1.5 text-xs">
        <button type="button" disabled={ready} className="flex items-center gap-2 font-semibold disabled:opacity-60" onClick={onMarkReady}>
          <Tick on={ready} /> Select all
        </button>
        <span className="tfd-muted tabular-nums">
          {prepared} of {plates} prepared
        </span>
      </div>

      <ul className="space-y-2.5 p-3">
        {ticket.items.map((item) => (
          <li key={item.id} className={cn('text-sm', item.cancelled && 'opacity-55')}>
            <div className="flex items-center gap-2">
              <button type="button" disabled={item.cancelled || item.state === 'READY'} aria-label={`${item.name} prepared`} onClick={() => onFinish(item)}>
                <Tick on={item.state === 'READY' && !item.cancelled} />
              </button>
              <span className="tfd-track flex h-6 min-w-6 shrink-0 items-center justify-center rounded-md px-1 text-xs font-bold tabular-nums">{item.qty}</span>
              <VegMark veg={item.veg} />
              <span className={cn('min-w-0 flex-1 truncate font-semibold', item.cancelled && 'line-through')}>{item.name}</span>

              {item.cancelled ? null : item.state === 'QUEUED' ? (
                <button type="button" title="On the heat — the guest sees this straight away" aria-label={`Start preparing ${item.name}`} className="tfd-btn tfd-btn-glass shrink-0 px-2.5 py-1 text-[11px]" onClick={() => onStart(item)}>
                  <Flame className="tfd-brand h-3 w-3" aria-hidden /> Start preparing
                </button>
              ) : item.state === 'PREPARING' && item.qty > 1 ? (
                <button type="button" title="One more plate prepared" aria-label={`One more ${item.name} prepared`} className="tfd-btn tfd-btn-glass shrink-0 px-2.5 py-1 text-[11px] tabular-nums" onClick={() => onPlusOne(item)}>
                  {item.prepared} of {item.qty} · +1
                </button>
              ) : item.state === 'PREPARING' ? (
                <Pill tone="warn">
                  <Flame className="h-3 w-3" aria-hidden /> Preparing
                </Pill>
              ) : (
                <Pill tone="ok">
                  <Check className="h-3 w-3" aria-hidden /> Ready
                </Pill>
              )}
            </div>
            {item.cancelled ? <p className="tfd-bad ml-8 text-[11px] font-bold">Cancelled — do not prepare</p> : null}
            {item.options ? <p className="tfd-muted ml-8 text-xs">{item.options}</p> : null}
            {item.note ? <p className="tfd-pill tfd-pill-warn ml-8 mt-0.5 !rounded-md">{item.note}</p> : null}
          </li>
        ))}
      </ul>

      {ticket.note ? <p className="tfd-pill tfd-pill-warn mx-3 mb-3 !block !whitespace-normal !rounded-lg !py-1.5">Order note: {ticket.note}</p> : null}

      <div className="tfd-line flex items-center gap-1.5 border-t p-3">
        <button type="button" aria-label="Print ticket" title="Print ticket" className="tfd-btn tfd-btn-glass h-9 w-9 shrink-0" onClick={() => notify(`Kitchen ticket #${ticket.no} printed.`)}>
          <Printer className="h-4 w-4" aria-hidden />
        </button>
        {ticket.table ? (
          <button type="button" aria-label="Call a waiter to this table" title="Call a waiter to this table" className="tfd-btn tfd-btn-glass h-9 w-9 shrink-0" onClick={() => notify(`A waiter has been called to table ${ticket.table}.`)}>
            <BellRing className="h-4 w-4" aria-hidden />
          </button>
        ) : null}
        {ready ? (
          <button type="button" className="tfd-btn tfd-btn-glass flex-1 px-3 py-2 text-sm" onClick={onHandOver}>
            <Utensils className="h-4 w-4" aria-hidden /> Handed over
          </button>
        ) : (
          <button type="button" className="tfd-btn flex-1 px-3 py-2 text-sm text-white" style={{ background: 'linear-gradient(135deg,#22c55e,#0f9d58)' }} onClick={onMarkReady}>
            <Check className="h-4 w-4" aria-hidden /> Mark ready
          </button>
        )}
        <button type="button" aria-pressed={Boolean(ticket.urgent)} aria-label={ticket.urgent ? 'Back to normal priority' : 'Mark urgent'} title={ticket.urgent ? 'Back to normal priority' : 'Mark urgent'} className={cn('tfd-btn h-9 w-9 shrink-0', ticket.urgent ? 'tfd-btn-primary' : 'tfd-btn-glass')} onClick={onUrgent}>
          <Flame className="h-4 w-4" aria-hidden />
        </button>
        <Pill>
          <Timer className="h-3 w-3" aria-hidden /> {ticket.estimate}m
        </Pill>
      </div>
    </div>
  )
}

function Tick({ on }: { on: boolean }) {
  return (
    <span className={cn('flex h-5 w-5 shrink-0 items-center justify-center rounded-md border-2 text-white', on ? 'border-transparent' : 'tfd-line')} style={on ? { background: 'var(--ok)' } : { borderColor: 'var(--muted)' }}>
      {on ? <Check className="h-3.5 w-3.5" aria-hidden /> : null}
    </span>
  )
}

// ── One section's screen: every dish on its own card ────────────────────────

function SectionBoard({
  section,
  tickets,
  tick,
  onBack,
  onStart,
  onReady,
}: {
  section: KdsItem['section']
  tickets: Ticket[]
  tick: number
  onBack: () => void
  onStart: (no: number, item: KdsItem) => void
  onReady: (no: number, item: KdsItem) => void
}) {
  const rows = tickets.flatMap((t) => live(t).filter((i) => i.section === section).map((item) => ({ ticket: t, item })))
  const columns = [
    { title: 'To cook', state: 'QUEUED' as const },
    { title: 'Cooking', state: 'PREPARING' as const },
    { title: 'Ready', state: 'READY' as const },
  ]
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <button type="button" className="tfd-btn tfd-btn-glass px-3 py-1.5 text-xs" onClick={onBack}>
          <ChevronLeft className="h-3.5 w-3.5" aria-hidden /> Kitchen
        </button>
        <h4 className="text-base font-bold">{section}</h4>
        <Pill tone="brand">{rows.filter((r) => r.item.state !== 'READY').length} on</Pill>
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        {columns.map((col) => {
          const list = rows.filter((r) => r.item.state === col.state)
          return (
            <div key={col.title} className="min-w-0 space-y-2">
              <p className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider">
                {col.title} <Pill>{list.length}</Pill>
              </p>
              {list.length === 0 ? <p className="tfd-muted tfd-line rounded-xl border border-dashed p-4 text-center text-xs">Nothing here</p> : null}
              {list.map(({ ticket, item }) => (
                <Card key={item.id} className={cn('tfd-fade !p-3', ticket.urgent && 'tfd-selected')}>
                  <div className="flex items-start gap-2">
                    <span className="tfd-btn-primary flex h-7 min-w-7 shrink-0 items-center justify-center rounded-lg px-1 text-sm font-bold">{item.qty}</span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-bold">{item.name}</p>
                      {item.prepared > 0 && item.state !== 'READY' ? <p className="tfd-muted text-[11px]">{item.prepared} of {item.qty} ready</p> : null}
                      {item.options ? <p className="tfd-muted text-xs">{item.options}</p> : null}
                      {item.note ? <p className="tfd-warn text-xs font-semibold">{item.note}</p> : null}
                    </div>
                    <div className="shrink-0 text-right text-[11px]">
                      <p className="font-bold">#{ticket.no}</p>
                      <p className="tfd-muted">{ticket.table ? `Table ${ticket.table}` : ticket.deliverTo ? 'delivery' : 'take away'}</p>
                    </div>
                  </div>
                  <div className="mt-2 flex items-center justify-between gap-2">
                    <span className="tfd-muted flex items-center gap-1 text-[11px] tabular-nums">
                      <Clock className="h-3 w-3" aria-hidden /> {Math.floor((ticket.age + tick - ticket.addedAt) / 60)}m
                      {ticket.urgent ? <Pill tone="bad">urgent</Pill> : null}
                    </span>
                    {col.state === 'QUEUED' ? (
                      <button type="button" className="tfd-btn tfd-btn-primary px-3 py-1.5 text-xs" onClick={() => onStart(ticket.no, item)}>
                        <Play className="h-3 w-3" aria-hidden /> Start
                      </button>
                    ) : col.state === 'PREPARING' ? (
                      <button type="button" className="tfd-btn px-3 py-1.5 text-xs text-white" style={{ background: 'linear-gradient(135deg,#22c55e,#0f9d58)' }} onClick={() => onReady(ticket.no, item)}>
                        <Check className="h-3 w-3" aria-hidden /> Ready
                      </button>
                    ) : (
                      <span className="tfd-muted text-[11px]">waiting for the floor</span>
                    )}
                  </div>
                </Card>
              ))}
            </div>
          )
        })}
      </div>
    </div>
  )
}
