'use client'

import { useState } from 'react'
import {
  AlertTriangle,
  ArrowRight,
  BadgePercent,
  Boxes,
  Check,
  CheckCircle2,
  ClipboardList,
  Crown,
  Download,
  FileSpreadsheet,
  Heart,
  PackageCheck,
  Receipt,
  Repeat,
  RotateCcw,
  Search,
  ShieldCheck,
  Tag,
  TrendingUp,
  Truck,
  Undo2,
  Users,
  Wallet,
  X,
  XCircle,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

import { cn } from '@/lib/utils'

import {
  APPROVALS,
  BRANCHES,
  CATEGORY_SALES,
  CUSTOMERS,
  PAYMENT_MIX,
  REPORTS,
  STOCK,
  TOP_ITEMS,
  TRANSFERS,
  compact,
  rs,
  type Approval,
  type Customer,
  type ReportRange,
  type Transfer,
  type TransferStatus,
} from './data'
import { AreaChart, Card, CardTitle, Donut, Meter, Pill, Stat, useNotify, type Tone } from './ui'

// ── Stock ───────────────────────────────────────────────────────────────────

export function Stock() {
  const notify = useNotify()
  const [branch, setBranch] = useState(-1)
  const [query, setQuery] = useState('')
  const [onlyLow, setOnlyLow] = useState(false)

  const rows = STOCK.map((item) => {
    const qty = branch === -1 ? item.onHand.reduce((a, b) => a + b, 0) : item.onHand[branch]
    const par = branch === -1 ? item.par * BRANCHES.length : item.par
    const tone: Tone = qty <= par * 0.6 ? 'bad' : qty <= par ? 'warn' : 'ok'
    return { ...item, qty, par, tone, value: qty * item.cost }
  })
  const low = rows.filter((r) => r.tone !== 'ok')
  const shown = rows.filter((r) => (!onlyLow || r.tone !== 'ok') && r.name.toLowerCase().includes(query.trim().toLowerCase()))

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat icon={Boxes} label="Items tracked" value={String(rows.length)} tone="info" />
        <Stat icon={Wallet} label="Stock value" value={compact(rows.reduce((s, r) => s + r.value, 0))} />
        <Stat icon={AlertTriangle} label="Low or critical" value={String(low.length)} tone="bad" />
        <Stat icon={TrendingUp} label="Food cost this month" value="31.8%" delta={-2.1} lowerIsBetter hint="Down from 33.9%" tone="ok" />
      </div>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <label className="relative flex-1">
          <Search className="tfd-muted pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2" aria-hidden />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search stock items"
            aria-label="Search stock items"
            className="tfd-input w-full py-2 pl-9 pr-3 text-sm"
          />
        </label>
        <select value={branch} onChange={(e) => setBranch(Number(e.target.value))} aria-label="Location" className="tfd-input px-3 py-2 text-sm">
          <option value={-1}>All locations</option>
          {BRANCHES.map((b, i) => (
            <option key={b} value={i}>
              {b}
            </option>
          ))}
        </select>
        <button type="button" aria-pressed={onlyLow} onClick={() => setOnlyLow((v) => !v)} className={cn('tfd-btn tfd-btn-glass px-4 py-2 text-sm', onlyLow && 'tfd-selected')}>
          <AlertTriangle className="tfd-warn h-4 w-4" aria-hidden /> Low stock only
        </button>
      </div>

      <Card className="!p-0">
        <div className="tfd-muted tfd-line hidden grid-cols-12 gap-3 border-b px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wider sm:grid">
          <span className="col-span-3">Item</span>
          <span className="col-span-2 text-right">On hand</span>
          <span className="col-span-3">Level</span>
          <span className="col-span-2 text-right">Value</span>
          <span className="col-span-2 text-right">Status</span>
        </div>
        <ul>
          {shown.map((r) => (
            <li key={r.name} className="tfd-line grid grid-cols-12 items-center gap-x-3 gap-y-1.5 border-b px-4 py-2.5 text-sm last:border-b-0">
              <div className="col-span-8 min-w-0 sm:col-span-3">
                <p className="truncate font-semibold">{r.name}</p>
                <p className="tfd-muted text-[11px]">{r.group}</p>
              </div>
              <p className="col-span-4 text-right font-bold tabular-nums sm:col-span-2">
                {r.qty.toLocaleString('en-US')} <span className="tfd-muted text-xs font-normal">{r.unit}</span>
              </p>
              <div className="col-span-7 sm:col-span-3">
                <Meter value={(r.qty / (r.par * 2.5)) * 100} tone={r.tone} />
                <p className="tfd-muted mt-1 text-[11px]">
                  Reorder at {r.par} {r.unit}
                </p>
              </div>
              <p className="tfd-muted col-span-2 hidden text-right text-xs tabular-nums sm:block">{rs(r.value)}</p>
              <div className="col-span-5 flex justify-end sm:col-span-2">
                {r.tone === 'ok' ? (
                  <Pill tone="ok">OK</Pill>
                ) : (
                  <button type="button" onClick={() => notify(`Purchase order drafted for ${r.name}. It goes to Approvals before it is sent.`)}>
                    <Pill tone={r.tone}>{r.tone === 'bad' ? 'Critical' : 'Low'} · Reorder</Pill>
                  </button>
                )}
              </div>
            </li>
          ))}
          {shown.length === 0 ? <li className="tfd-muted px-4 py-8 text-center text-sm">No stock items match.</li> : null}
        </ul>
      </Card>
      <p className="tfd-muted text-xs">Every sale deducts its recipe from stock automatically. Purchases, transfers and wastage are all in one ledger.</p>
    </div>
  )
}

// ── Transfers ───────────────────────────────────────────────────────────────

const TRANSFER_STEPS: TransferStatus[] = ['Requested', 'Approved', 'In transit', 'Received']
const TRANSFER_TONE: Record<TransferStatus, Tone> = { Requested: 'warn', Approved: 'info', 'In transit': 'violet', Received: 'ok' }
const TRANSFER_ACTION: Partial<Record<TransferStatus, string>> = {
  Requested: 'Approve',
  Approved: 'Dispatch',
  'In transit': 'Receive at destination',
}

export function Transfers() {
  const notify = useNotify()
  const [transfers, setTransfers] = useState<Transfer[]>(TRANSFERS)

  function advance(t: Transfer) {
    const next = TRANSFER_STEPS[TRANSFER_STEPS.indexOf(t.status) + 1]
    setTransfers((current) => current.map((x) => (x.ref === t.ref ? { ...x, status: next } : x)))
    notify(
      next === 'Received'
        ? `${t.ref} received. Stock moved from ${t.from} to ${t.to} in the ledger.`
        : `${t.ref} is now ${next.toLowerCase()}.`,
    )
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat icon={ClipboardList} label="Waiting for approval" value={String(transfers.filter((t) => t.status === 'Requested').length)} tone="warn" />
        <Stat icon={Truck} label="On the road" value={String(transfers.filter((t) => t.status === 'In transit').length)} tone="violet" />
        <Stat icon={PackageCheck} label="Received this week" value={String(11 + transfers.filter((t) => t.status === 'Received').length)} tone="ok" />
        <Stat icon={Wallet} label="Value moved this week" value={compact(284600)} />
      </div>

      <div className="grid gap-3 xl:grid-cols-2">
        {transfers.map((t) => {
          const at = TRANSFER_STEPS.indexOf(t.status)
          const action = TRANSFER_ACTION[t.status]
          return (
            <Card key={t.ref}>
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="tfd-muted text-[11px] font-semibold">{t.ref} · {t.when}</p>
                  <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-sm font-bold">
                    {t.from} <ArrowRight className="tfd-brand h-4 w-4" aria-hidden /> {t.to}
                  </p>
                </div>
                <Pill tone={TRANSFER_TONE[t.status]}>{t.status}</Pill>
              </div>

              <ul className="mt-2 flex flex-wrap gap-1.5">
                {t.items.map((i) => (
                  <li key={i.name}>
                    <Pill>{i.name} · {i.qty}</Pill>
                  </li>
                ))}
              </ul>

              <ol className="mt-4 flex items-center">
                {TRANSFER_STEPS.map((s, i) => (
                  <li key={s} className={cn('flex items-center', i > 0 && 'flex-1')}>
                    {i > 0 ? <span className="mx-1 h-0.5 flex-1 rounded-full transition-colors duration-500" style={{ background: i <= at ? 'var(--ok)' : 'var(--track)' }} /> : null}
                    <span
                      className={cn('flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-bold transition-colors duration-500', i <= at ? 'text-white' : 'tfd-track tfd-muted')}
                      style={i <= at ? { background: 'var(--ok)' } : undefined}
                      title={s}
                    >
                      {i <= at ? <Check className="h-3.5 w-3.5" aria-hidden /> : i + 1}
                    </span>
                  </li>
                ))}
              </ol>
              <div className="tfd-muted mt-1 flex justify-between text-[10px]">
                {TRANSFER_STEPS.map((s) => (
                  <span key={s}>{s}</span>
                ))}
              </div>

              <div className="tfd-line mt-3 flex items-center justify-between gap-2 border-t pt-3 text-xs">
                <span className="tfd-muted">
                  {t.by} · <span className="font-semibold tabular-nums">{rs(t.value)}</span>
                </span>
                {action ? (
                  <button type="button" className="tfd-btn tfd-btn-primary px-3.5 py-1.5 text-xs" onClick={() => advance(t)}>
                    {action}
                  </button>
                ) : (
                  <span className="tfd-ok flex items-center gap-1 font-semibold">
                    <CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> Completed
                  </span>
                )}
              </div>
            </Card>
          )
        })}
      </div>
    </div>
  )
}

// ── Approvals ───────────────────────────────────────────────────────────────

const APPROVAL_ICON: Record<Approval['kind'], LucideIcon> = {
  Discount: BadgePercent,
  'Void item': XCircle,
  Refund: Undo2,
  'Stock transfer': Truck,
  'Purchase order': ClipboardList,
  'Price change': Tag,
}
const APPROVAL_TONE: Record<Approval['kind'], Tone> = {
  Discount: 'brand',
  'Void item': 'bad',
  Refund: 'warn',
  'Stock transfer': 'violet',
  'Purchase order': 'info',
  'Price change': 'ok',
}

export function Approvals() {
  const notify = useNotify()
  const [decided, setDecided] = useState<Record<string, 'Approved' | 'Rejected'>>({})
  const pending = APPROVALS.filter((a) => !decided[a.id])
  const history = APPROVALS.filter((a) => decided[a.id])

  function decide(a: Approval, verdict: 'Approved' | 'Rejected') {
    setDecided((d) => ({ ...d, [a.id]: verdict }))
    notify(`${verdict}: ${a.title}. ${a.by.split(' ')[0]} is notified instantly.`)
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat icon={ShieldCheck} label="Waiting for you" value={String(pending.length)} tone="warn" />
        <Stat icon={CheckCircle2} label="Approved today" value={String(14 + Object.values(decided).filter((v) => v === 'Approved').length)} tone="ok" />
        <Stat icon={XCircle} label="Rejected today" value={String(2 + Object.values(decided).filter((v) => v === 'Rejected').length)} tone="bad" />
        <Stat icon={BadgePercent} label="Discounts given today" value={rs(8420)} hint="1.7% of sales" />
      </div>

      {pending.length === 0 ? (
        <Card className="py-10 text-center">
          <CheckCircle2 className="tfd-ok mx-auto h-10 w-10" aria-hidden />
          <p className="mt-2 font-semibold">All clear. Nothing is waiting for you.</p>
          <button type="button" className="tfd-btn tfd-btn-glass mt-4 px-4 py-2 text-xs" onClick={() => setDecided({})}>
            <RotateCcw className="h-3.5 w-3.5" aria-hidden /> Show the requests again
          </button>
        </Card>
      ) : (
        <div className="grid gap-3 xl:grid-cols-2">
          {pending.map((a) => {
            const Icon = APPROVAL_ICON[a.kind]
            return (
              <Card key={a.id} className="tfd-fade">
                <div className="flex items-start gap-3">
                  <span className={cn('tfd-pill !p-2.5', `tfd-pill-${APPROVAL_TONE[a.kind]}`)}>
                    <Icon className="h-4 w-4" aria-hidden />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Pill tone={APPROVAL_TONE[a.kind]}>{a.kind}</Pill>
                      <span className="tfd-muted text-[11px]">{a.branch} · {a.ago}</span>
                    </div>
                    <p className="mt-1 text-sm font-bold">{a.title}</p>
                    <p className="tfd-muted text-xs">{a.detail}</p>
                  </div>
                </div>
                <div className="tfd-line mt-3 flex flex-wrap items-center justify-between gap-2 border-t pt-3">
                  <p className="text-xs">
                    <span className="tfd-muted">Asked by</span> <span className="font-semibold">{a.by}</span>
                    <span className="tfd-muted"> · </span>
                    <span className="font-bold tabular-nums">{rs(a.amount)}</span>
                  </p>
                  <div className="flex gap-2">
                    <button type="button" className="tfd-btn tfd-btn-glass px-3.5 py-1.5 text-xs" onClick={() => decide(a, 'Rejected')}>
                      <X className="tfd-bad h-3.5 w-3.5" aria-hidden /> Reject
                    </button>
                    <button type="button" className="tfd-btn tfd-btn-primary px-3.5 py-1.5 text-xs" onClick={() => decide(a, 'Approved')}>
                      <Check className="h-3.5 w-3.5" aria-hidden /> Approve
                    </button>
                  </div>
                </div>
              </Card>
            )
          })}
        </div>
      )}

      {history.length > 0 ? (
        <Card>
          <CardTitle icon={ClipboardList}>Decided just now</CardTitle>
          <ul className="space-y-1.5 text-xs">
            {history.map((a) => (
              <li key={a.id} className="flex items-center justify-between gap-2">
                <span className="truncate">{a.title}</span>
                <Pill tone={decided[a.id] === 'Approved' ? 'ok' : 'bad'}>{decided[a.id]}</Pill>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
      <p className="tfd-muted text-xs">Staff cannot give a discount, void a dish or refund a bill on their own. You approve it from your phone, wherever you are.</p>
    </div>
  )
}

// ── Reports ─────────────────────────────────────────────────────────────────

const RANGES: ReportRange[] = ['Today', '7 days', '30 days']
const RANGE_SCALE: Record<ReportRange, number> = { Today: 0.038, '7 days': 0.25, '30 days': 1 }

export function Reports() {
  const notify = useNotify()
  const [range, setRange] = useState<ReportRange>('7 days')
  const report = REPORTS[range]
  const scale = RANGE_SCALE[range]
  const topMax = Math.max(...TOP_ITEMS.map((i) => i.revenue))

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="tfd-track inline-flex rounded-full p-1 text-xs font-semibold">
          {RANGES.map((r) => (
            <button key={r} type="button" role="tab" aria-selected={range === r} onClick={() => setRange(r)} className="tfd-tab rounded-full px-4 py-1.5">
              {r}
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          <button type="button" className="tfd-btn tfd-btn-glass px-3.5 py-1.5 text-xs" onClick={() => notify('In the real system this downloads the report as an Excel file.')}>
            <FileSpreadsheet className="tfd-ok h-3.5 w-3.5" aria-hidden /> Excel
          </button>
          <button type="button" className="tfd-btn tfd-btn-glass px-3.5 py-1.5 text-xs" onClick={() => notify('In the real system this downloads the report as a CSV file.')}>
            <Download className="h-3.5 w-3.5" aria-hidden /> CSV
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat icon={Wallet} label="Revenue" value={compact(report.revenue)} delta={report.delta.revenue} />
        <Stat icon={TrendingUp} label="Gross profit" value={compact(report.profit)} delta={report.delta.profit} hint={`${Math.round((report.profit / report.revenue) * 100)}% margin`} tone="ok" />
        <Stat icon={Receipt} label="Orders" value={report.orders.toLocaleString('en-US')} delta={report.delta.orders} tone="violet" />
        <Stat icon={Users} label="Guests served" value={report.guests.toLocaleString('en-US')} delta={report.delta.guests} tone="info" />
      </div>

      <Card>
        <CardTitle icon={TrendingUp} right={<span className="tfd-muted text-xs">Tap the chart</span>}>
          Revenue · {range === 'Today' ? 'by hour' : range === '7 days' ? 'by day' : 'by week'}
        </CardTitle>
        <AreaChart key={range} data={report.trend} format={compact} height={200} />
      </Card>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-1">
          <CardTitle icon={Crown}>Best sellers</CardTitle>
          <ul className="space-y-2.5">
            {TOP_ITEMS.map((item) => (
              <li key={item.name}>
                <div className="mb-1 flex items-baseline justify-between gap-2 text-xs">
                  <span className="truncate font-semibold">
                    {item.emoji} {item.name}
                  </span>
                  <span className="tfd-muted shrink-0 tabular-nums">
                    {Math.max(1, Math.round(item.sold * scale))} sold · {compact(item.revenue * scale)}
                  </span>
                </div>
                <Meter value={(item.revenue / topMax) * 100} />
              </li>
            ))}
          </ul>
        </Card>

        <Card>
          <CardTitle icon={Wallet}>How guests paid</CardTitle>
          <Donut center={compact(report.revenue).replace('Rs ', '')} caption="LKR" segments={PAYMENT_MIX} />
          <div className="tfd-line mt-4 space-y-2 border-t pt-3">
            {CATEGORY_SALES.map((c) => (
              <div key={c.label} className="flex items-center gap-2 text-xs">
                <span className="w-16 shrink-0">{c.label}</span>
                <Meter value={c.share} tone="violet" />
                <span className="w-8 shrink-0 text-right font-semibold tabular-nums">{c.share}%</span>
              </div>
            ))}
          </div>
        </Card>

        <Card>
          <CardTitle icon={ClipboardList}>Profit and loss</CardTitle>
          <dl className="space-y-2 text-xs">
            {(
              [
                ['Revenue', report.revenue, ''],
                ['Cost of food', -report.revenue * 0.318, 'tfd-bad'],
                ['Staff', -report.revenue * 0.21, 'tfd-bad'],
                ['Rent and utilities', -report.revenue * 0.09, 'tfd-bad'],
                ['Discounts and refunds', -report.revenue * 0.021, 'tfd-bad'],
              ] as const
            ).map(([label, value, tone]) => (
              <div key={label} className="flex justify-between">
                <dt className="tfd-muted">{label}</dt>
                <dd className={cn('font-semibold tabular-nums', tone)}>{value < 0 ? `− ${compact(-value)}` : compact(value)}</dd>
              </div>
            ))}
            <div className="tfd-line flex justify-between border-t pt-2 text-sm font-bold">
              <dt>Net profit</dt>
              <dd className="tfd-ok tabular-nums">{compact(report.revenue * 0.361)}</dd>
            </div>
          </dl>
          <p className="tfd-muted mt-3 text-[11px]">Sales, purchasing, stock, staff and tax reports are all included, per branch or combined.</p>
        </Card>
      </div>
    </div>
  )
}

// ── Customers ───────────────────────────────────────────────────────────────

const TIER_TONE: Record<Customer['tier'], Tone> = { VIP: 'brand', Regular: 'info', New: 'ok' }
const TIERS = ['All', 'VIP', 'Regular', 'New'] as const

export function Customers() {
  const notify = useNotify()
  const [tier, setTier] = useState<(typeof TIERS)[number]>('All')
  const [query, setQuery] = useState('')
  const shown = CUSTOMERS.filter((c) => (tier === 'All' || c.tier === tier) && c.name.toLowerCase().includes(query.trim().toLowerCase()))

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat icon={Users} label="Customers on file" value="2,846" delta={9.2} tone="info" />
        <Stat icon={Crown} label="VIP guests" value="184" tone="brand" />
        <Stat icon={Repeat} label="Come back again" value="64%" delta={4.8} tone="ok" />
        <Stat icon={Heart} label="Average spend per visit" value={rs(4180)} delta={3.1} tone="violet" />
      </div>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <label className="relative flex-1">
          <Search className="tfd-muted pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2" aria-hidden />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search customers"
            aria-label="Search customers"
            className="tfd-input w-full py-2 pl-9 pr-3 text-sm"
          />
        </label>
        <div className="tfd-scroll flex gap-1.5 overflow-x-auto">
          {TIERS.map((t) => (
            <button key={t} type="button" role="tab" aria-selected={tier === t} onClick={() => setTier(t)} className="tfd-tab shrink-0 rounded-full px-3.5 py-1.5 text-xs font-semibold">
              {t}
            </button>
          ))}
        </div>
        <button type="button" className="tfd-btn tfd-btn-glass px-4 py-2 text-sm" onClick={() => notify('In the real system this exports the mobile numbers for an SMS or WhatsApp campaign.')}>
          <Download className="h-4 w-4" aria-hidden /> Export numbers
        </button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {shown.map((c) => (
          <Card key={c.name}>
            <div className="flex items-center gap-3">
              <span className="tfd-btn-primary flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-sm font-bold">
                {c.name
                  .split(' ')
                  .map((p) => p[0])
                  .slice(0, 2)
                  .join('')
                  .toUpperCase()}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-bold">{c.name}</p>
                <p className="tfd-muted text-xs tabular-nums">{c.phone}</p>
              </div>
              <Pill tone={TIER_TONE[c.tier]}>{c.tier}</Pill>
            </div>
            <dl className="tfd-line mt-3 grid grid-cols-3 gap-2 border-t pt-3 text-center text-xs">
              <div>
                <dd className="font-bold tabular-nums">{c.visits}</dd>
                <dt className="tfd-muted text-[11px]">visits</dt>
              </div>
              <div>
                <dd className="font-bold tabular-nums">{compact(c.spend)}</dd>
                <dt className="tfd-muted text-[11px]">spent</dt>
              </div>
              <div>
                <dd className="font-bold tabular-nums">{c.points.toLocaleString('en-US')}</dd>
                <dt className="tfd-muted text-[11px]">points</dt>
              </div>
            </dl>
            <p className="tfd-muted mt-2 text-[11px]">
              Loves {c.favourite} · last visit {c.last.toLowerCase()}
            </p>
          </Card>
        ))}
        {shown.length === 0 ? <p className="tfd-muted col-span-full py-8 text-center text-sm">No customers match.</p> : null}
      </div>
    </div>
  )
}
