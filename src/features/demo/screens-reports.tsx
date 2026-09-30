'use client'

import { useState } from 'react'
import {
  AlertTriangle,
  ArrowDown,
  ArrowDownRight,
  ArrowDownToLine,
  ArrowLeftRight,
  ArrowRight,
  ArrowUpRight,
  Ban,
  BarChart3,
  Bike,
  CalendarClock,
  CalendarX2,
  CheckCircle2,
  Clock,
  Coins,
  Download,
  FileSpreadsheet,
  FileText,
  Info,
  Landmark,
  MapPin,
  Package,
  Printer,
  Receipt,
  RotateCcw,
  ShoppingCart,
  SlidersHorizontal,
  Tag,
  Target,
  Undo2,
  Users,
  Wallet,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

import { cn } from '@/lib/utils'

import { BRANCHES, compact, rs } from './data'
import { AreaChart, Donut, Pill, useNotify, type Tone } from './ui'

/*
 * The ten report pages, laid out the way the real ones are: the same filter
 * bar, the same tiles in the same order, the same tabs, charts and table
 * columns (see app/dashboard/reports/**). The figures are invented and scale
 * with the period and location chosen, so the filters do something.
 */

// ── Period and location ─────────────────────────────────────────────────────

const PRESETS = ['Today', 'Yesterday', 'This week', 'This month', 'Last month', 'Last 7 days', 'Last 30 days'] as const
type Preset = (typeof PRESETS)[number] | 'Custom range'

/** Share of a 30-day month each period stands for. */
const PERIOD: Record<Preset, number> = {
  Today: 0.038,
  Yesterday: 0.024,
  'This week': 0.16,
  'This month': 1,
  'Last month': 0.93,
  'Last 7 days': 0.248,
  'Last 30 days': 1,
  'Custom range': 0.4,
}
const LOCATION = [1, 0.51, 0.29, 0.2]

/** Category colours, fixed order, as the real charts assign them. */
const VIZ = ['hsl(217 91% 56%)', 'hsl(142 69% 36%)', 'hsl(262 83% 62%)', 'hsl(175 84% 34%)', 'hsl(32 94% 46%)', 'hsl(333 74% 50%)']
const BLUE = VIZ[0]

const SHAPES: Record<'hours' | 'week' | 'month', { labels: string[]; weights: number[] }> = {
  hours: { labels: ['9am', '10', '11', '12pm', '1', '2', '3', '4', '5', '6', '7', '8'], weights: [2.5, 3.9, 5.7, 12, 15.3, 10.6, 5.4, 4.5, 6.5, 10, 14.4, 9.2] },
  week: { labels: ['24 Sep', '25 Sep', '26 Sep', '27 Sep', '28 Sep', '29 Sep', '30 Sep'], weights: [12.5, 16.1, 19, 17.9, 9.5, 9.7, 15.3] },
  month: { labels: ['1 Sep', '4 Sep', '7 Sep', '10 Sep', '13 Sep', '16 Sep', '19 Sep', '22 Sep', '25 Sep', '28 Sep'], weights: [8.2, 9.1, 11.4, 8.8, 10.9, 9.6, 12.2, 9.4, 11.3, 9.1] },
}

interface Filters {
  preset: Preset
  setPreset: (p: Preset) => void
  branch: number
  setBranch: (b: number) => void
  /** Multiplier applied to every 30-day, all-locations figure. */
  f: number
  branchLabel: string
  /** Money, a count, and a trend series for a 30-day total. */
  m: (base: number) => string
  c: (base: number) => string
  n: (base: number) => number
  trend: (base: number) => { label: string; value: number }[]
}

function useFilters(initial: Preset): Filters {
  const [preset, setPreset] = useState<Preset>(initial)
  const [branch, setBranch] = useState(0)
  const f = PERIOD[preset] * LOCATION[branch]
  const shape = SHAPES[preset === 'Today' || preset === 'Yesterday' ? 'hours' : preset === 'This week' || preset === 'Last 7 days' ? 'week' : 'month']
  return {
    preset,
    setPreset,
    branch,
    setBranch,
    f,
    branchLabel: branch === 0 ? 'All branches' : BRANCHES[branch - 1],
    m: (base) => rs(base * f),
    c: (base) => compact(base * f),
    n: (base) => Math.max(0, Math.round(base * f)),
    trend: (base) => shape.labels.map((label, i) => ({ label, value: Math.max(1, Math.round((base * f * shape.weights[i]) / 100)) })),
  }
}

function ReportFilters({ filters }: { filters: Filters }) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {PRESETS.map((p) => (
          <button
            key={p}
            type="button"
            aria-pressed={filters.preset === p}
            onClick={() => filters.setPreset(p)}
            className={cn('tfd-line rounded-lg border px-3 py-1.5 text-sm transition-colors', filters.preset === p ? 'tfd-btn-primary border-transparent font-semibold' : 'hover:bg-[var(--glass-soft)]')}
          >
            {p}
          </button>
        ))}
        {filters.preset === 'Custom range' ? <span className="tfd-btn-primary rounded-lg px-3 py-1.5 text-sm font-semibold">Custom range</span> : null}
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-xs">
          <span className="tfd-muted mb-1 block">From</span>
          <input type="date" defaultValue="2026-09-01" onChange={() => filters.setPreset('Custom range')} className="tfd-input w-40 px-3 py-1.5 text-sm" />
        </label>
        <label className="text-xs">
          <span className="tfd-muted mb-1 block">To</span>
          <input type="date" defaultValue="2026-09-30" onChange={() => filters.setPreset('Custom range')} className="tfd-input w-40 px-3 py-1.5 text-sm" />
        </label>
        <label className="text-xs">
          <span className="tfd-muted mb-1 block">Location</span>
          <select value={filters.branch} onChange={(e) => filters.setBranch(Number(e.target.value))} className="tfd-input px-3 py-1.5 text-sm">
            <option value={0}>All locations</option>
            {BRANCHES.map((b, i) => (
              <option key={b} value={i + 1}>
                {b}
              </option>
            ))}
          </select>
        </label>
      </div>
    </div>
  )
}

// ── Shared pieces ───────────────────────────────────────────────────────────

function ExportMenu({ label = 'Export' }: { label?: string }) {
  const notify = useNotify()
  const [open, setOpen] = useState(false)
  return (
    <div className="relative">
      <button type="button" aria-expanded={open} className="tfd-btn tfd-btn-glass !rounded-lg px-3 py-1.5 text-sm" onClick={() => setOpen((v) => !v)}>
        <Download className="h-4 w-4" aria-hidden /> {label}
      </button>
      {open ? (
        <div className="tfd-modal tfd-pop absolute right-0 top-full z-20 mt-1 w-52 rounded-xl p-1.5 text-sm">
          <p className="px-2 pt-1 font-bold">Download</p>
          <p className="tfd-muted tfd-line border-b px-2 pb-2 text-[11px]">Exactly what is on screen, with the same filters.</p>
          {(
            [
              ['CSV', FileText],
              ['Excel', FileSpreadsheet],
            ] as const
          ).map(([kind, Icon]) => (
            <button
              key={kind}
              type="button"
              className="tfd-tab flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left"
              onClick={() => {
                setOpen(false)
                notify(`In the real system this downloads the report as ${kind === 'CSV' ? 'a CSV' : 'an Excel'} file.`)
              }}
            >
              <Icon className="h-4 w-4" aria-hidden /> {kind}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

/** Title, description and actions: the top of every real report page. */
function Head({ title, description, children }: { title: string; description: string; children?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h4 className="text-xl font-bold tracking-tight">{title}</h4>
        <p className="tfd-muted mt-0.5 text-sm">{description}</p>
      </div>
      {children ? <div className="flex flex-wrap items-center gap-2">{children}</div> : null}
    </div>
  )
}

function Panel({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cn('tfd-card min-w-0 rounded-xl p-4 sm:p-5', className)}>{children}</div>
}

function PanelTitle({ title, sub, link, right }: { title: string; sub?: string; link?: string; right?: React.ReactNode }) {
  return (
    <div className="mb-3 flex items-start justify-between gap-3">
      <div className="min-w-0">
        <h5 className="text-sm font-semibold">{title}</h5>
        {sub ? <p className="tfd-muted mt-0.5 text-xs">{sub}</p> : null}
      </div>
      {right ?? (link ? <span className="tfd-brand flex shrink-0 items-center gap-1 text-xs font-medium">{link} <ArrowRight className="h-3 w-3" aria-hidden /></span> : null)}
    </div>
  )
}

function Change({ value, caption }: { value?: number; caption?: string }) {
  if (value == null && !caption) return null
  return (
    <p className="mt-1.5 flex flex-wrap items-center gap-1 text-xs">
      {value != null ? (
        <span className={cn('flex items-center font-semibold', value >= 0 ? 'tfd-ok' : 'tfd-bad')}>
          {value >= 0 ? <ArrowUpRight className="h-3.5 w-3.5" aria-hidden /> : <ArrowDownRight className="h-3.5 w-3.5" aria-hidden />}
          {Math.abs(value).toFixed(1)}%
        </span>
      ) : null}
      {caption ? <span className="tfd-muted">{caption}</span> : null}
    </p>
  )
}

function StatCard({ label, value, hint, change, icon: Icon, tone = 'neutral', small }: { label: string; value: string; hint?: string; change?: number; icon?: LucideIcon; tone?: Tone; small?: boolean }) {
  return (
    <div className={cn('tfd-card min-w-0 rounded-xl', small ? 'p-4' : 'p-4 sm:p-5')}>
      <div className="flex items-start justify-between gap-2">
        <p className={cn('tfd-muted font-medium', small ? 'text-xs' : 'text-sm')}>{label}</p>
        {Icon ? (
          <span className={cn('tfd-pill !rounded-lg !p-2', `tfd-pill-${tone}`)}>
            <Icon className="h-4 w-4" aria-hidden />
          </span>
        ) : null}
      </div>
      <p className={cn('whitespace-nowrap font-bold tabular-nums tracking-tight', small ? 'text-lg sm:text-xl' : 'text-xl sm:text-2xl', Icon ? 'mt-1' : 'mt-3')}>{value}</p>
      <Change value={change} caption={hint} />
    </div>
  )
}

const looksNumeric = (cell: string) => /^(Rs |[−+-]? ?Rs |[\d+−-])|%$|^—$/.test(cell)

function ReportTable({
  title,
  description,
  columns,
  rows,
  empty = 'Nothing in this period.',
  action = 'csv',
  footer,
  wide,
}: {
  title: string
  description?: string
  columns: string[]
  rows: React.ReactNode[][]
  empty?: string
  action?: 'csv' | 'export' | 'none'
  footer?: React.ReactNode
  wide?: boolean
}) {
  const notify = useNotify()
  const right = columns.map((_, i) => i > 0 && rows.length > 0 && typeof rows[0][i] === 'string' && looksNumeric(rows[0][i] as string))
  return (
    <div className="tfd-card min-w-0 rounded-xl">
      <div className="tfd-line flex flex-wrap items-start justify-between gap-3 border-b px-4 py-3.5 sm:px-5">
        <div className="min-w-0">
          <h5 className="text-sm font-semibold">{title}</h5>
          {description ? <p className="tfd-muted mt-0.5 text-xs">{description}</p> : null}
        </div>
        {action === 'export' ? (
          <ExportMenu />
        ) : action === 'csv' && rows.length > 0 ? (
          <button type="button" className="tfd-btn tfd-btn-glass !rounded-lg px-3 py-1.5 text-xs" onClick={() => notify('In the real system this downloads the table as a CSV file.')}>
            <Download className="h-3.5 w-3.5" aria-hidden /> CSV
          </button>
        ) : null}
      </div>
      {footer ? <div className="tfd-line tfd-track flex flex-wrap gap-x-5 gap-y-1 border-b px-4 py-2.5 text-sm sm:px-5">{footer}</div> : null}
      {rows.length === 0 ? (
        <p className="tfd-muted py-8 text-center text-sm">{empty}</p>
      ) : (
        <div className="tfd-thin-scroll overflow-x-auto px-4 pb-2 sm:px-5">
          <table className={cn('w-full text-left text-sm', wide ? 'min-w-[72rem]' : 'min-w-[32rem]')}>
            <thead>
              <tr className="tfd-muted text-xs uppercase tracking-wide">
                {columns.map((c, i) => (
                  <th key={c} className={cn('tfd-line whitespace-nowrap border-b py-2.5 pr-3 font-medium', right[i] && 'text-right')}>
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, i) => (
                    <td key={i} className={cn('tfd-line whitespace-nowrap py-2.5 pr-3', r < rows.length - 1 && 'border-b', right[i] && 'text-right tabular-nums', i === 0 && 'font-medium')}>
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function Pager({ shown, total }: { shown: number; total: number }) {
  return (
    <div className="tfd-muted flex items-center justify-between gap-3 px-1 text-sm">
      <span>
        1–{shown} of {total}
      </span>
      <span className="flex gap-1">
        {[1, 2, 3].map((page) => (
          <span key={page} className={cn('flex h-8 w-8 items-center justify-center rounded-md text-xs font-semibold', page === 1 ? 'tfd-btn-primary' : 'tfd-track')}>
            {page}
          </span>
        ))}
      </span>
    </div>
  )
}

function Callout({ tone = 'neutral', children }: { tone?: 'neutral' | 'warn'; children: React.ReactNode }) {
  return (
    <div className={cn('tfd-pill !flex !items-start !gap-2 !whitespace-normal !rounded-xl !px-4 !py-3 !text-sm !font-normal', tone === 'warn' ? 'tfd-pill-warn' : 'tfd-pill-neutral')}>
      {tone === 'warn' ? <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> : <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />}
      <span style={{ color: 'var(--fg)' }}>{children}</span>
    </div>
  )
}

function MiniTable({ columns, rows }: { columns: string[]; rows: React.ReactNode[][] }) {
  return (
    <div className="tfd-thin-scroll overflow-x-auto">
    <table className="w-full text-left text-sm">
      <thead>
        <tr className="tfd-muted text-xs">
          {columns.map((c, i) => (
            <th key={c} className={cn('whitespace-nowrap pb-2 font-medium', i > 0 && 'pl-2 text-right')}>
              {c}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, r) => (
          <tr key={r}>
            {row.map((cell, i) => (
              <td key={i} className={cn('tfd-line py-2', r > 0 && 'border-t', i > 0 && 'whitespace-nowrap pl-2 text-right tabular-nums', i === 0 && 'max-w-[9rem] truncate')}>
                {cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
    </div>
  )
}

function Bars({ data, highlight }: { data: { label: string; value: number }[]; highlight?: boolean }) {
  const max = Math.max(...data.map((d) => d.value))
  return (
    <div>
      <div className="flex h-40 items-end gap-1">
        {data.map((d) => (
          <div key={d.label} title={`${d.label}: ${d.value} orders`} className="flex-1 rounded-t-md transition-[height] duration-500" style={{ height: `${Math.max(4, (d.value / max) * 100)}%`, background: highlight && d.value === max ? 'var(--brand)' : 'hsl(199 89% 48%)' }} />
        ))}
      </div>
      <div className="tfd-muted mt-1.5 flex gap-1 text-[9px]">
        {data.map((d) => (
          <span key={d.label} className="flex-1 text-center">
            {d.label}
          </span>
        ))}
      </div>
    </div>
  )
}

function Shares({ rows, colors }: { rows: { label: string; share: number; value: string }[]; colors?: string[] }) {
  return (
    <ul className="space-y-3">
      {rows.map((row, i) => (
        <li key={row.label}>
          <div className="mb-1 flex items-baseline justify-between gap-2 text-sm">
            <span className="truncate">{row.label}</span>
            <span className="tfd-muted shrink-0 text-xs tabular-nums">{row.share.toFixed(1)}%</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="tfd-track h-1.5 flex-1 overflow-hidden rounded-full">
              <div className="h-full rounded-full transition-[width] duration-500" style={{ width: `${row.share}%`, background: colors ? colors[i % colors.length] : 'var(--brand)' }} />
            </div>
            <span className="w-20 shrink-0 text-right text-xs font-semibold tabular-nums">{row.value}</span>
          </div>
        </li>
      ))}
    </ul>
  )
}

/** Tiles, then a trend beside a donut, then three cards: the layout four of the reports share. */
function Dashboard({ tiles, trend, donut, cards }: { tiles: React.ReactNode; trend: React.ReactNode; donut: React.ReactNode; cards: React.ReactNode }) {
  return (
    <>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-5">{tiles}</div>
      <div className="grid gap-4 lg:grid-cols-[1.6fr_1fr]">
        {trend}
        {donut}
      </div>
      <div className="grid gap-4 lg:grid-cols-3">{cards}</div>
    </>
  )
}

const donutOf = (rows: [string, number, string?][]) => rows.map(([label, share, value], i) => ({ label, share, value, color: VIZ[i % VIZ.length] }))

// ── 1. Reports (the hub) ────────────────────────────────────────────────────

const HUB_RANGES: [string, number][] = [['Today', 0.038], ['Yesterday', 0.024], ['Last 7 days', 0.248], ['Last 30 days', 1], ['Last 90 days', 2.86], ['Last 12 months', 10.9]]

export function ReportsHub() {
  const notify = useNotify()
  const [range, setRange] = useState(2)
  const f = HUB_RANGES[range][1]
  const m = (v: number) => rs(v * f)
  const n = (v: number) => Math.round(v * f).toLocaleString('en-US')
  return (
    <div className="space-y-5">
      <Head title="Reports" description="Sales, revenue, profit and more — export anytime">
        <select value={range} onChange={(e) => setRange(Number(e.target.value))} aria-label="Period" className="tfd-input w-40 px-3 py-1.5 text-sm">
          {HUB_RANGES.map(([label], i) => (
            <option key={label} value={i}>
              {label}
            </option>
          ))}
        </select>
        <button type="button" className="tfd-btn tfd-btn-glass !rounded-lg px-3 py-1.5 text-sm" onClick={() => notify('In the real system this downloads the whole report as an Excel workbook.')}>
          <FileSpreadsheet className="h-4 w-4" aria-hidden /> Excel
        </button>
        <button type="button" className="tfd-btn tfd-btn-glass !rounded-lg px-3 py-1.5 text-sm" onClick={() => notify('In the real system this downloads every order in the period as a CSV file.')}>
          <FileText className="h-4 w-4" aria-hidden /> Orders CSV
        </button>
      </Head>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Net sales" value={m(12846300)} hint={`${n(3812)} orders · after discounts & refunds`} />
        <StatCard label="Collected" value={m(13912400)} hint="payments in, refunds out" />
        <StatCard label="Gross profit" value={m(8761300)} hint={`cost ${m(4085000)}`} />
        <StatCard label="Average order" value={rs(3370)} hint={`${n(2846)} customers`} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="tfd-card rounded-xl">
          <h5 className="tfd-line border-b px-5 py-3.5 text-sm font-semibold">Breakdown</h5>
          <dl>
            {[
              ['Tax collected', m(0)],
              ['Service charge', m(1066100)],
              ['Discounts given', `− ${m(214600)}`],
              ['Refunds', `− ${m(55200)}`],
              ['Tips', m(86400)],
              ['Cancelled orders', n(41)],
            ].map(([label, value], i) => (
              <div key={label} className={cn('tfd-line flex items-center justify-between px-5 py-3 text-sm', i > 0 && 'border-t')}>
                <dt className="tfd-muted">{label}</dt>
                <dd className="font-bold tabular-nums">{value}</dd>
              </div>
            ))}
          </dl>
        </div>
        <div className="tfd-card rounded-xl">
          <div className="tfd-line flex items-center justify-between border-b px-5 py-3">
            <h5 className="text-sm font-semibold">Payment methods</h5>
            <button type="button" className="tfd-btn !rounded-lg px-2.5 py-1 text-xs" onClick={() => notify('In the real system this downloads the payment breakdown as a CSV file.')}>
              <Download className="h-3.5 w-3.5" aria-hidden /> CSV
            </button>
          </div>
          <dl>
            {[
              ['Card', 1754, 6399700],
              ['Cash', 1182, 4312800],
              ['QR', 572, 2086900],
              ['Online', 228, 834700],
              ['Bank transfer', 76, 278300],
            ].map(([label, count, amount], i) => (
              <div key={label} className={cn('tfd-line flex items-center justify-between px-5 py-3 text-sm', i > 0 && 'border-t')}>
                <dt>
                  {label} <span className="tfd-muted">· {n(count as number)}</span>
                </dt>
                <dd className="font-bold tabular-nums">{m(amount as number)}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>

      <ReportTable
        title="Top selling items"
        action="none"
        columns={['Item', 'Quantity', 'Revenue']}
        rows={[
          ['Chicken Biryani', n(356), <b key="1">{m(587400)}</b>],
          ['Chicken Kottu', n(412), <b key="2">{m(515000)}</b>],
          ['Cheese Kottu', n(298), <b key="3">{m(432100)}</b>],
          ['Jaffna Crab Curry', n(121), <b key="4">{m(350900)}</b>],
          ['Mango Smoothie', n(274), <b key="5">{m(161660)}</b>],
          ['Watalappan', n(233), <b key="6">{m(128150)}</b>],
        ]}
      />
    </div>
  )
}

// ── 2. Sales ────────────────────────────────────────────────────────────────

const SALES_VIEWS = ['Summary', 'By item', 'By category', 'By date', 'By time', 'By payment method', 'By employee', 'By location'] as const

const SALES_ITEMS: [string, string, number, number, number][] = [
  ['Chicken Biryani', 'Mains', 356, 601800, 14400],
  ['Chicken Kottu', 'Mains', 412, 528200, 13200],
  ['Cheese Kottu', 'Mains', 298, 441500, 9400],
  ['Jaffna Crab Curry', 'Mains', 121, 358600, 7700],
  ['Margherita Pizza', 'Mains', 168, 322400, 6100],
  ['Mango Smoothie', 'Drinks', 274, 164900, 3240],
  ['Watalappan', 'Desserts', 233, 130200, 2050],
  ['Chicken Satay', 'Starters', 142, 136900, 2000],
]

export function SalesReport() {
  const filters = useFilters('Today')
  const { m, c, n } = filters
  const [view, setView] = useState<(typeof SALES_VIEWS)[number]>('Summary')
  const count = (v: number) => n(v).toLocaleString('en-US')

  return (
    <div className="space-y-5">
      <Head title="Sales" description={`${filters.preset} · Spice Garden`} />
      <ReportFilters filters={filters} />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Gross sales" value={m(13116100)} />
        <StatCard label="Net sales" value={m(12846300)} hint="after discounts and refunds, before tax" />
        <StatCard label="Orders" value={count(3812)} />
        <StatCard label="Average order" value={rs(3370)} />
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Discounts" value={m(214600)} />
        <StatCard label="Refunds" value={m(55200)} />
        <StatCard label="Tax collected" value={m(0)} hint="not the restaurant's money" />
        <StatCard label="Service charge" value={m(1066100)} />
      </div>

      {view === 'Summary' || view === 'By payment method' ? (
        <Callout tone="warn">
          Cash drawers over this period were short by <b>{m(650)}</b> across {Math.max(1, n(58))} closed drawers. This is reported separately from takings — a till that was short still took what it took.
        </Callout>
      ) : null}

      <div role="tablist" aria-label="Sales views" className="flex flex-wrap gap-2">
        {SALES_VIEWS.map((v) => (
          <button key={v} type="button" role="tab" aria-selected={view === v} onClick={() => setView(v)} className={cn('tfd-line rounded-lg border px-3 py-1.5 text-sm transition-colors', view === v ? 'tfd-btn-primary border-transparent font-semibold' : 'hover:bg-[var(--glass-soft)]')}>
            {v}
          </button>
        ))}
      </div>

      {view === 'Summary' ? (
        <div className="tfd-fade space-y-4">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <StatCard small label="Total Sales" value={c(13116100)} change={12.4} icon={BarChart3} tone="brand" />
            <StatCard small label="Total Orders" value={count(3812)} change={8.1} icon={ShoppingCart} tone="info" />
            <StatCard small label="Average Order Value" value={rs(3370)} change={3.9} icon={Wallet} tone="ok" />
            <StatCard small label="Total Items Sold" value={count(11240)} change={9.7} icon={Package} tone="violet" />
            <StatCard small label="Total Discounts" value={c(214600)} change={-4.2} icon={Tag} tone="warn" />
            <StatCard small label="Net Sales (After Discounts)" value={c(12846300)} change={12.9} icon={Receipt} tone="brand" />
          </div>
          <div className="grid gap-4 lg:grid-cols-3">
            <Panel className="lg:col-span-2">
              <PanelTitle title="Sales Trend" />
              <AreaChart data={filters.trend(13116100)} format={compact} height={230} />
            </Panel>
            <Panel>
              <PanelTitle title="Sales by Category" link="View details" />
              <Donut stacked center={c(13116100).replace('Rs ', '')} caption="Sales" segments={donutOf([['Mains', 58, c(7607300)], ['Drinks', 17, c(2229700)], ['Starters', 15, c(1967400)], ['Desserts', 10, c(1311700)]])} />
            </Panel>
          </div>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <Panel>
              <PanelTitle title="Top Selling Items" link="View all" />
              <ol className="space-y-2.5">
                {SALES_ITEMS.slice(0, 5).map(([name, , qty, gross], i) => (
                  <li key={name} className="flex items-center gap-2.5 text-sm">
                    <span className="tfd-track flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-xs font-bold">{i + 1}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium leading-tight">{name}</span>
                      <span className="tfd-muted block text-xs">{count(qty)} sold</span>
                    </span>
                    <span className="shrink-0 text-xs font-semibold tabular-nums">{c(gross)}</span>
                  </li>
                ))}
              </ol>
            </Panel>
            <Panel>
              <PanelTitle title="Sales by Time" link="View details" />
              <Bars highlight data={SHAPES.hours.labels.map((label, i) => ({ label: `${(i + 9) % 24}`.padStart(2, '0'), value: Math.max(1, Math.round(SHAPES.hours.weights[i] * 38 * filters.f)) }))} />
            </Panel>
            <Panel>
              <PanelTitle title="Sales by Payment Method" link="View details" />
              <Shares colors={['hsl(152 62% 38%)']} rows={[{ label: 'Card', share: 46, value: c(6399700) }, { label: 'Cash', share: 31, value: c(4312800) }, { label: 'QR', share: 15, value: c(2086900) }, { label: 'Online', share: 6, value: c(834700) }, { label: 'Bank transfer', share: 2, value: c(278300) }]} />
            </Panel>
            <Panel>
              <PanelTitle title="Sales by Branch" link="View details" />
              <Shares rows={filters.branch === 0 ? [{ label: 'Colombo 03', share: 51, value: c(6689200) }, { label: 'Kandy City', share: 29, value: c(3803700) }, { label: 'Galle Fort', share: 20, value: c(2623200) }] : [{ label: filters.branchLabel, share: 100, value: c(13116100) }]} />
            </Panel>
          </div>
        </div>
      ) : null}

      {view === 'By item' ? (
        <ReportTable
          title="Sales by Item"
          description="Detailed breakdown of sales for each item. Open one to see the bills it was on and what was paid."
          columns={['Item', 'Category', 'Qty Sold', 'Gross Sales', 'Discount', 'Net Sales']}
          rows={SALES_ITEMS.map(([name, category, qty, gross, discount]) => [<span key="n" className="tfd-brand">{name}</span>, category, count(qty), m(gross), m(discount), m(gross - discount)])}
        />
      ) : null}
      {view === 'By category' ? (
        <ReportTable title="By category" columns={['Category', 'Lines', 'Revenue']} rows={[['Mains', count(6420), m(7607300)], ['Drinks', count(2610), m(2229700)], ['Starters', count(1340), m(1967400)], ['Desserts', count(870), m(1311700)]]} />
      ) : null}
      {view === 'By date' ? (
        <ReportTable title="By date" description="Each day in the period." columns={['Day', 'Orders', 'Revenue']} rows={[['2026-09-30', '142', rs(486250)], ['2026-09-29', '94', rs(309850)], ['2026-09-28', '91', rs(301900)], ['2026-09-27', '168', rs(571300)], ['2026-09-26', '177', rs(604800)], ['2026-09-25', '151', rs(512600)]].slice(0, filters.preset === 'Today' || filters.preset === 'Yesterday' ? 1 : 6)} />
      ) : null}
      {view === 'By time' ? (
        <ReportTable
          title="Sales by Time"
          description="Detailed sales breakdown by hour, added up across the whole period — useful for rostering."
          columns={['Time', 'Orders', 'Items Sold', 'Gross Sales', 'Discount', 'Net Sales']}
          rows={[['12:00 PM', 12], ['01:00 PM', 15.3], ['02:00 PM', 10.6], ['06:00 PM', 10], ['07:00 PM', 14.4], ['08:00 PM', 9.2]].map(([time, w]) => {
            const share = (w as number) / 100
            return [time as string, count(3812 * share), count(11240 * share), m(13116100 * share), m(214600 * share), m(12901500 * share)]
          })}
        />
      ) : null}
      {view === 'By payment method' ? (
        <ReportTable
          title="Sales by Payment Method"
          description="Detailed breakdown of sales by payment method."
          columns={['Payment Method', 'Orders', 'Gross Sales', 'Discount', 'Net Sales', '% of Total']}
          rows={[['Card', 0.46], ['Cash', 0.31], ['QR', 0.15], ['Online', 0.06], ['Bank transfer', 0.02]].map(([method, share]) => [method as string, count(3812 * (share as number)), m(13116100 * (share as number)), m(214600 * (share as number)), m(12901500 * (share as number)), `${((share as number) * 100).toFixed(1)}%`])}
        />
      ) : null}
      {view === 'By employee' ? (
        <ReportTable title="By employee" description="Orders entered by each member of staff." columns={['Employee', 'Orders', 'Revenue']} rows={[['Sara', count(1180), m(4012000)], ['Dev', count(860), m(2966000)], ['Nimal', count(742), m(2486000)], ['Priya', count(318), m(1104000)], ['QR and online', count(712), m(2548100)]]} />
      ) : null}
      {view === 'By location' ? (
        <ReportTable title="By location" columns={['Location', 'Orders', 'Revenue']} empty="Only one location sold anything in this period." rows={filters.branch === 0 ? [['Colombo 03', count(1944), m(6689200)], ['Kandy City', count(1105), m(3803700)], ['Galle Fort', count(763), m(2623200)]] : []} />
      ) : null}
    </div>
  )
}

// ── 3. Delivery ─────────────────────────────────────────────────────────────

export function DeliveryReport() {
  const filters = useFilters('Last 30 days')
  const { c, n } = filters
  return (
    <div className="space-y-5">
      <Head title="Delivery Report" description="Track your deliveries, sales, time to the door and cash collected across all branches.">
        <ExportMenu />
      </Head>
      <ReportFilters filters={filters} />
      <Dashboard
        tiles={
          <>
            <StatCard small label="Deliveries" value={String(n(684))} change={15.6} hint="vs last period" icon={Bike} tone="brand" />
            <StatCard small label="Delivery Sales" value={c(2312000)} hint={`avg ${rs(3380)} per order`} icon={Wallet} tone="ok" />
            <StatCard small label="Average Time" value="26 min" hint="order to door · ride 11 min" icon={Clock} tone="info" />
            <StatCard small label="Cash at the Door" value={c(798400)} hint={`${n(238)} collected on delivery`} icon={Coins} tone="warn" />
            <StatCard small label="Cancelled" value={String(n(17))} hint="3 out for delivery now" icon={Ban} tone="bad" />
          </>
        }
        trend={
          <Panel>
            <PanelTitle title="Deliveries by Day" sub={`Orders handed over at the door each day · ${filters.preset}`} right={<span className="tfd-muted shrink-0 text-xs">{filters.branchLabel}</span>} />
            <AreaChart data={filters.trend(684)} format={(v) => `${v} deliveries`} height={230} color={BLUE} />
          </Panel>
        }
        donut={
          <Panel>
            <PanelTitle title="Deliveries by Area" link="Places" />
            <Donut stacked center={String(n(684))} caption="Delivered" segments={donutOf([['Wellawatte', 28, String(n(192))], ['Bambalapitiya', 22, String(n(150))], ['Colombo 07', 18, String(n(123))], ['Peradeniya Road', 14, String(n(96))], ['Havelock Town', 10, String(n(68))], ['Others', 8, String(n(55))]])} />
          </Panel>
        }
        cards={
          <>
            <Panel>
              <PanelTitle title="Top Places" link="View All" />
              <MiniTable columns={['Place', 'Orders', 'Avg Time', 'Sales']} rows={[['Wellawatte', 192, '22 min', 655000], ['Bambalapitiya', 150, '24 min', 498000], ['Colombo 07', 123, '27 min', 431000], ['Peradeniya Road', 96, '29 min', 312000], ['Havelock Town', 68, '31 min', 229000]].map(([place, orders, time, sales]) => [<span key="p" className="flex items-center gap-1"><MapPin className="tfd-muted h-3 w-3 shrink-0" aria-hidden />{place}</span>, n(orders as number), time, c(sales as number)])} />
            </Panel>
            <Panel>
              <PanelTitle title="Handed Over By" link="Staff" />
              <MiniTable columns={['Staff', 'Orders', 'Ride', 'Cash']} rows={[['Kasun', 248, '10 min', 301000], ['Imran', 221, '12 min', 268400], ['Suresh', 164, '11 min', 229000], ['Counter', 51, '—', 0]].map(([who, orders, ride, cash]) => [who, n(orders as number), ride, cash ? c(cash as number) : '—'])} />
            </Panel>
            <Panel>
              <PanelTitle title="Recent Deliveries" link="Orders" />
              <ul className="space-y-2.5">
                {[['#2207', 'Wellawatte', '30 Sep, 7:42 pm · 24 min · Cash on delivery', 6050], ['#2206', 'Havelock Town', '30 Sep, 7:18 pm · 31 min · Card', 5200], ['#2205', 'Colombo 02', '30 Sep, 6:55 pm · 22 min · Online', 4160], ['#2204', 'Bambalapitiya', '30 Sep, 6:31 pm · 25 min · Online', 3340]].map(([no, place, meta, total]) => (
                  <li key={no} className="flex items-center gap-2.5 text-sm">
                    <span className="tfd-pill tfd-pill-ok !rounded-lg !p-2"><Bike className="h-4 w-4" aria-hidden /></span>
                    <span className="min-w-0 flex-1">
                      <span className="tfd-brand block truncate font-medium">{no} · {place}</span>
                      <span className="tfd-muted block truncate text-xs">{meta}</span>
                    </span>
                    <span className="shrink-0 font-semibold tabular-nums">{rs(total as number)}</span>
                  </li>
                ))}
              </ul>
            </Panel>
          </>
        }
      />
    </div>
  )
}

// ── 4. Gross profit ─────────────────────────────────────────────────────────

export function ProfitReport() {
  const filters = useFilters('This month')
  const { m } = filters
  const item = (name: string, sold: number, revenue: number, cost: number) => [name, String(filters.n(sold)), m(revenue), m(cost), m(revenue - cost), `${((cost / revenue) * 100).toFixed(1)}%`]
  return (
    <div className="space-y-5">
      <Head title="Gross profit" description={`${filters.preset} · Spice Garden`} />
      <ReportFilters filters={filters} />
      <Callout>Gross profit only — revenue less the cost of ingredients. It does not include rent, wages, utilities or any other operating cost.</Callout>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Revenue" value={m(12846300)} />
        <StatCard label="Cost of ingredients" value={m(4085000)} />
        <StatCard label="Gross profit" value={m(8761300)} />
        <StatCard label="Food cost" value="31.8%" hint="68.2% gross margin" />
      </div>
      <Callout tone="warn">
        96% of sold lines have a known ingredient cost. <b>{m(513800)}</b> of revenue came from dishes with no recipe, so the real food cost is higher than shown. Add recipes to those dishes to close the gap.
      </Callout>
      {filters.branch === 0 ? (
        <ReportTable
          title="Branch comparison"
          description="Every location side by side, best gross profit first."
          columns={['Location', 'Orders', 'Sales', 'Ingredients', 'Gross profit', 'Margin', 'Wastage']}
          rows={[['Colombo 03', 1944, 6551600, 2050000, 19400], ['Kandy City', 1105, 3725400, 1196000, 11200], ['Galle Fort', 763, 2569300, 839000, 7800]].map(([name, orders, sales, cost, waste]) => [name as string, String(filters.n(orders as number)), m(sales as number), m(cost as number), m((sales as number) - (cost as number)), `${((1 - (cost as number) / (sales as number)) * 100).toFixed(1)}%`, m(waste as number)])}
        />
      ) : null}
      <ReportTable
        title="Gross profit by item"
        description="Worst margin sits at the bottom — those are the dishes to reprice or re-cost."
        columns={['Item', 'Sold', 'Revenue', 'Cost', 'Gross profit', 'Food cost']}
        rows={[item('Mango Smoothie', 274, 161660, 35600), item('Chicken Kottu', 412, 515000, 144200), item('Cheese Kottu', 298, 432100, 129600), item('Chicken Biryani', 356, 587400, 181600), item('Mutton Biryani', 96, 201600, 82700), item('Grilled Seer Fish', 88, 198000, 83200), item('Jaffna Crab Curry', 121, 350900, 157900)]}
      />
      <ReportTable
        title="Gross profit by category"
        columns={['Category', 'Revenue', 'Cost', 'Gross profit', 'Margin']}
        rows={[['Drinks', 2183900, 502300], ['Desserts', 1284600, 346800], ['Starters', 1926900, 597300], ['Mains', 7450900, 2638600]].map(([name, revenue, cost]) => [name as string, m(revenue as number), m(cost as number), m((revenue as number) - (cost as number)), `${((1 - (cost as number) / (revenue as number)) * 100).toFixed(1)}%`])}
      />
    </div>
  )
}

// ── 5. Inventory ────────────────────────────────────────────────────────────

export function InventoryReport() {
  const filters = useFilters('Last 30 days')
  const { c, n } = filters
  const held = LOCATION[filters.branch]
  return (
    <div className="space-y-5">
      <Head title="Inventory Reports" description="Track your stock usage, movement, and value across all branches.">
        <ExportMenu />
      </Head>
      <ReportFilters filters={filters} />
      <Dashboard
        tiles={
          <>
            <StatCard small label="Total Inventory Value" value={compact(1020000 * held)} change={-3.1} hint="vs period start" icon={Coins} tone="brand" />
            <StatCard small label="Total Items" value="25" hint="6 categories" icon={Package} tone="ok" />
            <StatCard small label="Low Stock Items" value="4" hint="need attention" icon={AlertTriangle} tone="warn" />
            <StatCard small label="Out of Stock Items" value="1" hint="take action" icon={Ban} tone="bad" />
            <StatCard small label="Stock Usage Value" value={c(4085000)} change={9.4} hint="vs last period" icon={BarChart3} tone="info" />
          </>
        }
        trend={
          <Panel>
            <PanelTitle title="Inventory Value Trend" sub={`What the stock on hand was worth at the close of each day · ${filters.preset}`} right={<span className="tfd-muted shrink-0 text-xs">{filters.branchLabel}</span>} />
            <AreaChart data={[1052, 1118, 1006, 1094, 1041, 987, 1076, 1033, 998, 1020].map((v, i) => ({ label: SHAPES.month.labels[i], value: Math.round(v * 1000 * held) }))} format={compact} height={230} color={BLUE} />
          </Panel>
        }
        donut={
          <Panel>
            <PanelTitle title="Stock Value by Category" link="View Details" />
            <Donut stacked center={compact(1020000 * held).replace('Rs ', '')} caption="Total Value" segments={donutOf([['Meat & fish', 38, compact(387600 * held)], ['Dry goods', 23, compact(234600 * held)], ['Dairy', 17, compact(173400 * held)], ['Vegetables', 12, compact(122400 * held)], ['Beverages', 7, compact(71400 * held)], ['Bakery', 3, compact(30600 * held)]])} />
          </Panel>
        }
        cards={
          <>
            <Panel>
              <PanelTitle title="Top Consumed Items (by Cost)" link="View Details" />
              <MiniTable columns={['Item', 'Qty Used', 'Cost Value']} rows={[['Chicken (whole)', 318, 'kg', 397500], ['Seer Fish', 72, 'kg', 230400], ['Prawns', 61, 'kg', 170800], ['Mutton', 44, 'kg', 158400], ['Basmati Rice', 235, 'kg', 98700]].map(([name, qty, unit, cost], i) => [<span key="n"><span className="tfd-muted mr-1.5">{i + 1}</span><span className="tfd-brand">{name}</span></span>, `${n(qty as number)} ${unit}`, c(cost as number)])} />
            </Panel>
            <Panel>
              <PanelTitle title="Low Stock Items" link="View All" />
              <MiniTable columns={['Item', 'Current Stock', 'Reorder Level']} rows={[[<span key="g">Garlic <Pill tone="bad">out</Pill></span>, <b key="v" className="tfd-bad">0 kg</b>, '3 kg'], ['Prawns', <span key="v" className="tfd-warn">4 kg</span>, '8 kg'], ['Mozzarella', <span key="v" className="tfd-warn">3 kg</span>, '5 kg'], ['Coffee Beans', <span key="v" className="tfd-warn">2 kg</span>, '4 kg'], ['Tomatoes', <span key="v" className="tfd-warn">8 kg</span>, '10 kg']]} />
            </Panel>
            <Panel>
              <PanelTitle title="Stock Movements Summary" link="View Details" />
              <ul className="space-y-3">
                {(
                  [
                    ['Stock In', ArrowDown, 'ok', 2140, 2140000],
                    ['Stock Out', ArrowRight, 'warn', 2310, 4085000],
                    ['Stock Transfers', ArrowLeftRight, 'brand', 186, 284600],
                    ['Stock Adjustments', SlidersHorizontal, 'neutral', 24, 6200],
                  ] as const
                ).map(([label, Icon, tone, units, value]) => (
                  <li key={label} className="flex items-center gap-3 text-sm">
                    <span className={cn('tfd-pill !rounded-lg !p-2', `tfd-pill-${tone}`)}><Icon className="h-4 w-4" aria-hidden /></span>
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium">{label}</span>
                      <span className="tfd-muted block text-xs">{n(units).toLocaleString('en-US')} units</span>
                    </span>
                    <span className="font-semibold tabular-nums">{c(value)}</span>
                  </li>
                ))}
              </ul>
            </Panel>
          </>
        }
      />
    </div>
  )
}

// ── 6. Purchasing ───────────────────────────────────────────────────────────

const BOUGHT: [string, string, string, number, number, number, number, number, string, string][] = [
  ['Chicken (whole)', 'CHK-001', 'Meat & fish', 8, 310, 387500, 1250, 1280, 'Hill Country Produce', '—'],
  ['Seer Fish', 'FSH-004', 'Meat & fish', 5, 75, 240000, 3200, 3350, 'Lanka Seafood Suppliers', '—'],
  ['Prawns', 'FSH-002', 'Meat & fish', 4, 60, 168000, 2800, 2800, 'Lanka Seafood Suppliers', 'Rs 8,400'],
  ['Mutton', 'MEA-003', 'Meat & fish', 3, 44, 158400, 3600, 3600, 'Hill Country Produce', '—'],
  ['Mozzarella', 'DRY-011', 'Dairy', 4, 28, 109200, 3900, 4050, 'Highland Dairy', '—'],
  ['Basmati Rice', 'DRG-001', 'Dry goods', 2, 200, 84000, 420, 420, 'Ceylon Dry Goods', '—'],
  ['Cooking Oil', 'DRG-006', 'Dry goods', 2, 90, 62100, 690, 705, 'Ceylon Dry Goods', 'Rs 10,000'],
]

export function PurchasingReport() {
  const filters = useFilters('This month')
  const { m, c, n } = filters
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const thisYear = [1.62, 1.71, 1.84, 1.78, 1.93, 1.88, 2.02, 2.09, 2.14, 0, 0, 0]
  const lastYear = [1.31, 1.38, 1.44, 1.52, 1.49, 1.6, 1.66, 1.71, 1.74, 1.83, 1.95, 2.21]
  return (
    <div className="space-y-5">
      <Head title="Purchasing Reports" description="Analyse your procurement data, supplier performance, and purchasing costs." />
      <ReportFilters filters={filters} />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <StatCard small label="Total Purchase Value" value={c(2140000)} change={6.8} icon={ShoppingCart} tone="brand" />
        <StatCard small label="Total Purchase Orders" value={String(n(34))} change={9.7} icon={FileText} tone="info" />
        <StatCard small label="Total Suppliers" value="9" hint="1 new supplier" icon={Users} tone="violet" />
        <StatCard small label="Average Order Value" value={rs(62940)} change={-2.6} icon={BarChart3} tone="ok" />
        <StatCard small label="Purchase Returns" value={c(18400)} change={-11.2} icon={RotateCcw} tone="warn" />
        <StatCard small label="Variance vs Ordered" value="+1.4%" hint={`${m(29900)} over what was ordered`} icon={Target} tone="warn" />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Panel className="lg:col-span-2">
          <PanelTitle title="Purchase Value Trend" link="View details" />
          <AreaChart data={filters.trend(2140000)} format={compact} height={230} color={BLUE} />
        </Panel>
        <Panel>
          <PanelTitle title="Purchases by Category" link="View details" />
          <Donut stacked center={c(2140000).replace('Rs ', '')} caption="Total Purchases" segments={donutOf([['Meat & fish', 45, c(963000)], ['Dry goods', 21, c(449400)], ['Dairy', 15, c(321000)], ['Vegetables', 12, c(256800)], ['Beverages', 5, c(107000)], ['Bakery', 2, c(42800)]])} />
        </Panel>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Panel>
          <PanelTitle title="Purchases by Supplier (Top 5)" link="View all" />
          <Shares colors={VIZ} rows={[{ label: 'Lanka Seafood Suppliers', share: 31, value: c(663400) }, { label: 'Hill Country Produce', share: 27, value: c(577800) }, { label: 'Ceylon Dry Goods', share: 21, value: c(449400) }, { label: 'Highland Dairy', share: 15, value: c(321000) }, { label: 'Island Beverages', share: 6, value: c(128400) }]} />
        </Panel>
        <Panel>
          <PanelTitle title="Purchase Orders by Status" link="View details" />
          <Donut stacked center={String(n(34))} caption="Total POs" segments={donutOf([['Received', 68, String(n(23))], ['Pending', 18, String(n(6))], ['Partial', 9, String(n(3))], ['Cancelled', 5, String(n(2))]])} />
          <p className="tfd-muted mt-3 text-xs">1 request not yet approved — not counted above.</p>
        </Panel>
        <Panel>
          <PanelTitle title="Monthly Purchase Comparison" />
          <div className="flex h-36 items-end gap-1">
            {months.map((month, i) => (
              <div key={month} className="flex h-full flex-1 items-end gap-px" title={`${month}: this year ${thisYear[i] ? `Rs ${thisYear[i]}M` : 'not yet'}, last year Rs ${lastYear[i]}M`}>
                <div className="flex-1 rounded-t-sm" style={{ height: `${(thisYear[i] / 2.3) * 100}%`, background: BLUE }} />
                <div className="tfd-track flex-1 rounded-t-sm" style={{ height: `${(lastYear[i] / 2.3) * 100}%` }} />
              </div>
            ))}
          </div>
          <div className="tfd-muted mt-1.5 flex gap-1 text-[9px]">
            {months.map((month) => (
              <span key={month} className="flex-1 text-center">{month}</span>
            ))}
          </div>
          <p className="mt-2 flex justify-center gap-4 text-xs">
            <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full" style={{ background: BLUE }} /> This Year</span>
            <span className="tfd-muted flex items-center gap-1.5"><span className="tfd-track h-2.5 w-2.5 rounded-full" /> Last Year</span>
          </p>
        </Panel>
      </div>

      <ReportTable
        wide
        action="export"
        title="Purchased items"
        description="Every item bought in this period — what came in, what it cost and who supplied it. Biggest spend first."
        footer={
          <>
            <span><b>38</b> items</span>
            <span><b>{n(31)}</b> deliveries</span>
            <span>Spent <b>{m(2140000)}</b></span>
            <span>Returned to suppliers <b>{m(18400)}</b></span>
          </>
        }
        columns={['#', 'Item', 'Category', 'Qty bought', 'Spend', 'Avg / unit', 'Last paid', 'Last bought', 'Supplier', ...(filters.branch === 0 ? ['Location'] : []), 'Returned']}
        rows={BOUGHT.map(([name, sku, category, deliveries, qty, spend, avg, last, supplier, returned], i) => [
          String(i + 1),
          <span key="n">
            <span className="tfd-brand block">{name}</span>
            <span className="tfd-muted block text-xs font-normal">{Math.max(1, n(deliveries))} deliveries · {sku}</span>
          </span>,
          category,
          `${n(qty)} ${name === 'Cooking Oil' ? 'L' : 'kg'}`,
          m(spend),
          rs(avg),
          rs(last),
          `${28 - i * 2} Sep`,
          supplier,
          ...(filters.branch === 0 ? [i % 3 === 0 ? 'Colombo 03, Kandy City' : 'Colombo 03'] : []),
          returned,
        ])}
      />
      <Pager shown={7} total={38} />

      <ReportTable
        title="Price movement"
        description="Items bought more than once in this period, biggest rise first. Prices are per base unit, so a box and a kilo compare fairly."
        columns={['Item', 'Supplier', 'First paid', 'Last paid', 'Change']}
        rows={[['Seer Fish', 'Lanka Seafood Suppliers', rs(3200), rs(3350), '+4.7%'], ['Mozzarella', 'Highland Dairy', rs(3900), rs(4050), '+3.8%'], ['Chicken (whole)', 'Hill Country Produce', rs(1250), rs(1280), '+2.4%'], ['Cooking Oil', 'Ceylon Dry Goods', rs(690), rs(705), '+2.2%']]}
      />
      <ReportTable
        title="Outstanding orders"
        description="Approved or sent, not yet fully received."
        columns={['Order', 'Supplier', 'Status', 'Received', 'Value']}
        rows={[['PO-0311', 'Lanka Seafood Suppliers', 'approved', '0%', rs(64000)], ['PO-0310', 'Hill Country Produce', 'sent', '0%', rs(38200)], ['PO-0308', 'Highland Dairy', 'partially received', '83%', rs(46000)]]}
      />
      <ReportTable
        title="Needs ordering"
        columns={['Item', 'In stock', 'Suggested', 'Supplier', 'Est. cost']}
        rows={[['Garlic', '0 kg', '6 kg', 'Hill Country Produce', rs(4680)], ['Prawns', '4 kg', '12 kg', 'Lanka Seafood Suppliers', rs(33600)], ['Mozzarella', '3 kg', '6 kg', 'Highland Dairy', rs(24300)], ['Coffee Beans', '2 kg', '6 kg', 'Island Beverages', rs(31200)]]}
      />
    </div>
  )
}

// ── 7 & 8. Cash reports ─────────────────────────────────────────────────────

function CashToolbar({ selects }: { selects: [label: string, options: string[]][] }) {
  const notify = useNotify()
  return (
    <div className="flex flex-wrap items-end gap-3">
      {selects.map(([label, options]) => (
        <label key={label} className="text-xs">
          <span className="tfd-muted mb-1 block">{label}</span>
          <select className="tfd-input px-3 py-1.5 text-sm">
            {options.map((o) => (
              <option key={o}>{o}</option>
            ))}
          </select>
        </label>
      ))}
      <div className="ml-auto flex flex-wrap gap-2">
        {(
          [
            ['Print / PDF', Printer],
            ['CSV', Download],
            ['Excel', Download],
          ] as const
        ).map(([label, Icon]) => (
          <button key={label} type="button" className="tfd-btn tfd-btn-glass !rounded-lg px-3 py-1.5 text-sm" onClick={() => notify(`In the real system “${label}” produces this report with the same filters.`)}>
            <Icon className="h-4 w-4" aria-hidden /> {label}
          </button>
        ))}
      </div>
    </div>
  )
}

export function CashDrawerReport() {
  const filters = useFilters('Today')
  const { m } = filters
  const session = (id: string, branch: string, till: string, open: string, close: string, status: string, tone: Tone, opening: number, sales: number, inn: number, out: number, refunds: number, drops: number, counted: number | null, why: string) => {
    const expected = opening + sales + inn - out - refunds - drops
    const gap = counted == null ? null : counted - expected
    return [<span key="s" className="tfd-brand">{id}</span>, branch, till, open, close, <Pill key="p" tone={tone}>{status}</Pill>, rs(opening), rs(sales), rs(inn), rs(out), rs(refunds), rs(drops), rs(expected), counted == null ? '—' : rs(counted), gap == null ? '—' : gap === 0 ? rs(0) : <span key="g" className={gap < 0 ? 'tfd-bad' : 'tfd-warn'}>{gap < 0 ? '− ' : '+ '}{rs(Math.abs(gap))}</span>, why]
  }
  return (
    <div className="space-y-5">
      <Head title="Cash drawer" description={`${filters.preset} · Spice Garden`} />
      <ReportFilters filters={filters} />
      <CashToolbar selects={[['Cashier', ['Everyone', 'Sara', 'Priya', 'Dilshan']], ['Till', ['Every till', 'Till 1', 'Till 2']], ['Status', ['Any status', 'Open', 'In review', 'Closed']]]} />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Floats issued" value={m(789000)} hint="summed per session, so a handover counts the same notes twice" />
        <StatCard label="Cash sales" value={m(3984000)} />
        <StatCard label="Non-cash payments" value={m(8862300)} hint="card, QR, online — never in the drawer" />
        <StatCard label="Expected closing" value={m(2164000)} />
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Cash in" value={m(131000)} />
        <StatCard label="Cash out" value={m(42600)} />
        <StatCard label="Refunds" value={m(18400)} />
        <StatCard label="Petty cash paid" value={m(31500)} />
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Cash drops" value={m(1840000)} />
        <StatCard label="Bank deposits" value={m(1790000)} />
        <StatCard label="Actual closing" value={m(2163350)} hint="counted, closed tills only" />
        <StatCard label="Short / over" value={`${m(900)} / ${m(250)}`} hint="never netted — a short till and an over one are two problems" />
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard label="Open now" value="2" />
        <StatCard label="Waiting for review" value="1" />
        <StatCard label="Closed" value={String(Math.max(1, filters.n(58)))} />
      </div>

      <Callout tone="warn">
        <b>{rs(2400)}</b> of cash was taken across 2 payments while no drawer was open, so it belongs to no session above and no till can be counted against it. It is almost always somebody ringing up without starting a shift.
      </Callout>

      <ReportTable
        wide
        title="Drawer sessions"
        description="One row per shift — open the session number for every movement in it. Expected cash for an open till is live; for a closed one it is what was recorded at close. A blank variance means nobody counted."
        columns={['Session', 'Branch', 'Till', 'Opened by', 'Closed by', 'Status', 'Opening', 'Cash sales', 'In', 'Out', 'Refunds', 'Drops', 'Expected', 'Counted', 'Variance', 'Why']}
        rows={[
          session('CD-0412', 'Colombo 03', 'Till 1', 'Sara', '—', 'Open', 'ok', 10000, 68450, 5000, 1200, 0, 0, null, ''),
          session('CD-0411', 'Kandy City', 'Till 1', 'Dilshan', '—', 'In review', 'warn', 10000, 41200, 0, 800, 650, 30000, 19400, 'Counted twice, still short'),
          session('CD-0410', 'Colombo 03', 'Till 1', 'Priya', 'Priya', 'Closed', 'neutral', 10000, 54200, 0, 0, 0, 40000, 24200, ''),
          session('CD-0409', 'Galle Fort', 'Till 1', 'Malik', 'Malik', 'Closed', 'neutral', 8000, 29650, 2000, 600, 0, 20000, 19100, 'Gave wrong change'),
          session('CD-0408', 'Colombo 03', 'Till 2', 'Sara', 'Owner', 'Closed by manager', 'violet', 10000, 61200, 0, 2350, 1200, 45000, 22650, ''),
        ]}
      />
    </div>
  )
}

export function PettyCashReport() {
  const filters = useFilters('This month')
  const { m, n } = filters
  return (
    <div className="space-y-5">
      <Head title="Petty cash" description={`${filters.preset} · Spice Garden`} />
      <ReportFilters filters={filters} />
      <CashToolbar selects={[['Status', ['Any status', 'Draft', 'Waiting', 'Approved', 'Paid', 'Rejected', 'Withdrawn']], ['Category', ['Every category', 'Supplies', 'Transport', 'Repairs', 'Utilities', 'Staff']]]} />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Opening fund" value={m(50000)} hint="every shift's starting tin in this period" />
        <StatCard label="Topped up" value={m(20000)} hint="moved in from the drawer" />
        <StatCard label="Spent from the tin" value={m(42600)} />
        <StatCard label="Remaining" value={m(27400)} />
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Waiting" value={`2 · ${rs(6400)}`} />
        <StatCard label="Approved" value={`3 · ${rs(9100)}`} />
        <StatCard label="Paid" value={String(Math.max(1, n(37)))} />
        <StatCard label="Rejected" value="1" />
      </div>

      <Callout>
        A further <b>{m(31500)}</b> of petty cash was paid straight out of the till drawer rather than the tin. That money never entered the fund, so it is not in “spent from the tin” above — it comes off the drawer’s expected cash on the <u>cash drawer report</u> instead.
      </Callout>

      <ReportTable
        wide
        title="Petty cash ledger"
        description="Every request in this period, whatever happened to it."
        columns={['Date', 'Branch', 'Category', 'Description', 'Amount', 'Paid from', 'Requested by', 'Approved by', 'Status', 'Reference']}
        rows={[
          ['2026-09-30', 'Colombo 03', 'Utilities', 'Gas cylinder delivery', rs(1200), 'Drawer', 'Sara', 'Priya', <Pill key="p" tone="ok">Paid</Pill>, 'PC-0188'],
          ['2026-09-30', 'Colombo 03', 'Repairs', 'Blender repair', rs(4800), 'Tin', 'Anura', '—', <Pill key="p" tone="warn">Waiting</Pill>, 'PC-0187'],
          ['2026-09-29', 'Kandy City', 'Supplies', 'Vegetables from the market', rs(2350), 'Tin', 'Anura', 'Priya', <Pill key="p" tone="ok">Paid</Pill>, 'PC-0186'],
          ['2026-09-29', 'Colombo 03', 'Transport', 'Three-wheeler for a delivery', rs(600), 'Drawer', 'Dev', 'Priya', <Pill key="p" tone="ok">Paid</Pill>, 'PC-0185'],
          ['2026-09-28', 'Galle Fort', 'Supplies', 'Printer paper rolls', rs(1800), 'Tin', 'Malik', 'Owner', <Pill key="p" tone="info">Approved</Pill>, 'PC-0184'],
          ['2026-09-27', 'Colombo 03', 'Staff', 'Staff meal allowance', rs(3000), 'Tin', 'Sara', 'Owner', <Pill key="p" tone="bad">Rejected</Pill>, 'PC-0183'],
        ]}
      />
    </div>
  )
}

// ── 9. Payment details ──────────────────────────────────────────────────────

export function PaymentDetailsReport() {
  const filters = useFilters('Last 30 days')
  const { c, n } = filters
  return (
    <div className="space-y-5">
      <Head title="Payment Details Report" description="Track what you collected, by method and by account, and every deposit and transfer between accounts.">
        <ExportMenu />
      </Head>
      <ReportFilters filters={filters} />
      <Dashboard
        tiles={
          <>
            <StatCard small label="Net Collected" value={c(13857200)} change={11.8} hint="vs last period" icon={Wallet} tone="brand" />
            <StatCard small label="Payments" value={n(3934).toLocaleString('en-US')} hint={`avg ${rs(3536)}`} icon={Receipt} tone="ok" />
            <StatCard small label="Refunds" value={c(55200)} hint={`${Math.max(1, n(19))} refunds`} icon={Undo2} tone="warn" />
            <StatCard small label="Moved Between Accounts" value={c(1790000)} hint={`${Math.max(1, n(26))} transfers`} icon={ArrowLeftRight} tone="info" />
            <StatCard small label="Total Balance" value={compact(2140000)} hint="5 accounts · all locations" icon={Landmark} tone="bad" />
          </>
        }
        trend={
          <Panel>
            <PanelTitle title="Net Collection Trend" sub={`Payments taken less refunds given, each day · ${filters.preset}`} right={<span className="tfd-muted shrink-0 text-xs">{filters.branchLabel}</span>} />
            <AreaChart data={filters.trend(13857200)} format={compact} height={230} color={BLUE} />
          </Panel>
        }
        donut={
          <Panel>
            <PanelTitle title="Collected by Account" link="View Details" />
            <Donut stacked center={c(13857200).replace('Rs ', '')} caption="Net Collected" segments={donutOf([['Card terminal', 46, c(6374300)], ['Cash drawers', 31, c(4295700)], ['QR pay', 15, c(2078600)], ['Online payments', 6, c(831400)], ['Current account', 2, c(277200)]])} />
          </Panel>
        }
        cards={
          <>
            <Panel>
              <PanelTitle title="Collections by Method" link="Sales Report" />
              <MiniTable columns={['Method', 'Payments', 'Refunded', 'Net']} rows={[['Card', 1754, 21400, 6374300], ['Cash', 1182, 18400, 4295700], ['QR', 572, 8300, 2078600], ['Online', 228, 7100, 831400], ['Bank transfer', 76, 0, 277200], ['Cash on delivery', 122, 0, 412600]].map(([method, count, refunded, net]) => [method, n(count as number), refunded ? <span key="r" className="tfd-warn">{c(refunded as number)}</span> : '—', c(net as number)])} />
            </Panel>
            <Panel>
              <PanelTitle title="Account Balances" link="View All" />
              <MiniTable columns={['Account', 'This Period', 'Balance']} rows={[['Current account', 1790000, 1486000], ['Card terminal', 412000, 412000], ['Cash drawers', -84200, 82250], ['QR pay', 96400, 96400], ['Online payments', 63350, 63350]].map(([account, period, balance]) => [<span key="a" className="tfd-brand">{account}</span>, <span key="p" className={(period as number) >= 0 ? 'tfd-ok' : 'tfd-bad'}>{(period as number) >= 0 ? '+ ' : '− '}{c(Math.abs(period as number))}</span>, compact(balance as number)])} />
            </Panel>
            <Panel>
              <PanelTitle title="Deposits & Transfers" link="View Details" />
              <ul className="space-y-2.5">
                {(
                  [
                    ['Deposit to Current account', '30 Sep · Priya · end of day banking', 120000, true],
                    ['Card terminal → Current account', '30 Sep · settlement', 186200, false],
                    ['Deposit to Current account', '29 Sep · Priya · end of day banking', 71200, true],
                    ['QR pay → Current account', '29 Sep · settlement', 68400, false],
                  ] as const
                ).map(([title, meta, amount, deposit], i) => (
                  <li key={i} className="flex items-center gap-2.5 text-sm">
                    <span className={cn('tfd-pill !rounded-lg !p-2', deposit ? 'tfd-pill-ok' : 'tfd-pill-brand')}>{deposit ? <ArrowDownToLine className="h-4 w-4" aria-hidden /> : <ArrowLeftRight className="h-4 w-4" aria-hidden />}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{title}</span>
                      <span className="tfd-muted block truncate text-xs">{meta}</span>
                    </span>
                    <span className="shrink-0 font-semibold tabular-nums">{rs(amount)}</span>
                  </li>
                ))}
              </ul>
            </Panel>
          </>
        }
      />
    </div>
  )
}

// ── 10. Reservations ────────────────────────────────────────────────────────

export function ReservationsReport() {
  const filters = useFilters('Last 30 days')
  const { n } = filters
  return (
    <div className="space-y-5">
      <Head title="Reservations Report" description="Bookings taken, guests expected, and how many were kept, cancelled or never arrived.">
        <ExportMenu />
      </Head>
      <ReportFilters filters={filters} />
      <Dashboard
        tiles={
          <>
            <StatCard small label="Bookings" value={String(n(184))} change={7.6} hint="vs last period" icon={CalendarClock} tone="brand" />
            <StatCard small label="Covers" value={String(n(742))} hint="guests booked" icon={Users} tone="info" />
            <StatCard small label="Honoured" value={String(n(154))} hint="93% of those not cancelled" icon={CheckCircle2} tone="ok" />
            <StatCard small label="Cancelled" value={String(n(19))} hint="10% of bookings" icon={CalendarX2} tone="warn" />
            <StatCard small label="No-shows" value={String(n(11))} hint="9 still to come" icon={Ban} tone="bad" />
          </>
        }
        trend={
          <Panel>
            <PanelTitle title="Bookings by Day" sub={`Bookings held each day, cancelled ones included · ${filters.preset}`} right={<span className="tfd-muted shrink-0 text-xs">{filters.branchLabel}</span>} />
            <AreaChart data={filters.trend(184)} format={(v) => `${v} bookings`} height={230} color={BLUE} />
          </Panel>
        }
        donut={
          <Panel>
            <PanelTitle title="Bookings by Status" link="Diary" />
            <Donut stacked center={String(n(184))} caption="Bookings" segments={donutOf([['Completed', 79, String(n(145))], ['Cancelled', 10, String(n(19))], ['No show', 6, String(n(11))], ['Confirmed', 4, String(n(7))], ['Pending', 1, String(n(2))]])} />
          </Panel>
        }
        cards={
          <>
            <Panel>
              <PanelTitle title="Busiest Times" link="Diary" />
              <MiniTable columns={['Hour', 'Bookings', 'Covers']} rows={[['20:00', 52, 218], ['19:00', 44, 181], ['21:00', 31, 122], ['13:00', 29, 108], ['12:00', 18, 71]].map(([hour, bookings, covers]) => [hour, n(bookings as number), n(covers as number)])} />
            </Panel>
            <Panel>
              <PanelTitle title="Most Booked Tables" link="Tables" />
              <MiniTable columns={['Table', 'Bookings', 'Covers', 'No-shows']} rows={[['Table 8', 'Colombo 03', 31, 224, 2], ['Table 13', 'Colombo 03', 26, 148, 1], ['Table 5', 'Kandy City', 22, 118, 0], ['Table 3', 'Galle Fort', 19, 71, 3]].map(([table, branch, bookings, covers, missed]) => [<span key="t">{table}<span className="tfd-muted block text-xs">{branch}</span></span>, n(bookings as number), n(covers as number), missed ? <span key="m" className="tfd-bad">{missed}</span> : '—'])} />
            </Panel>
            <Panel>
              <PanelTitle title="Cancellations & No-shows" link="Diary" />
              <ul className="space-y-2.5">
                {(
                  [
                    ['Pradeep Kumar · 4 · Table 6', '29 Sep, 8:00 pm · did not arrive', true],
                    ['Zainab Hameed · 2', '28 Sep, 7:30 pm · change of plans · by guest', false],
                    ['Sanjaya G. · 6 · Table 13', '27 Sep, 8:30 pm · did not arrive', true],
                    ['Aisha Nazeer · 3 · Table 3', '26 Sep, 1:00 pm · double booking · by Priya', false],
                  ] as const
                ).map(([title, meta, noShow], i) => (
                  <li key={i} className="flex items-center gap-2.5 text-sm">
                    <span className={cn('tfd-pill !rounded-lg !p-2', noShow ? 'tfd-pill-bad' : 'tfd-pill-warn')}>{noShow ? <Ban className="h-4 w-4" aria-hidden /> : <CalendarX2 className="h-4 w-4" aria-hidden />}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{title}</span>
                      <span className="tfd-muted block truncate text-xs">{meta}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </Panel>
          </>
        }
      />
    </div>
  )
}
