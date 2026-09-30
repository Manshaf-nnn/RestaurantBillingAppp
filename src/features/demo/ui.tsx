'use client'

import { createContext, useContext, useEffect, useId, useState } from 'react'
import { createPortal } from 'react-dom'
import type { LucideIcon } from 'lucide-react'
import { ArrowDownRight, ArrowUpRight, X } from 'lucide-react'

import { cn } from '@/lib/utils'

// ── Shared bits for the demo screens ────────────────────────────────────────

export type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'violet' | 'brand' | 'neutral'

export function Pill({ tone = 'neutral', className, children }: { tone?: Tone; className?: string; children: React.ReactNode }) {
  return <span className={cn('tfd-pill', `tfd-pill-${tone}`, className)}>{children}</span>
}

export function Card({ className, children, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('tfd-card min-w-0 rounded-2xl p-4', className)} {...rest}>
      {children}
    </div>
  )
}

export function CardTitle({ icon: Icon, children, right }: { icon?: LucideIcon; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
      <h3 className="flex items-center gap-2 text-sm font-semibold">
        {Icon ? <Icon className="tfd-brand h-4 w-4" aria-hidden /> : null}
        {children}
      </h3>
      {right}
    </div>
  )
}

export function Stat({
  icon: Icon,
  label,
  value,
  delta,
  hint,
  tone = 'brand',
  lowerIsBetter = false,
}: {
  icon: LucideIcon
  label: string
  value: string
  delta?: number
  hint?: string
  tone?: Tone
  /** Prep time, delivery time, food cost: a fall is the good direction. */
  lowerIsBetter?: boolean
}) {
  return (
    <Card className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className={cn('tfd-pill !p-2', `tfd-pill-${tone}`)}>
          <Icon className="h-4 w-4" aria-hidden />
        </span>
        {delta != null ? (
          <span className={cn('flex items-center text-xs font-semibold', delta >= 0 !== lowerIsBetter ? 'tfd-ok' : 'tfd-bad')}>
            {delta >= 0 ? <ArrowUpRight className="h-3.5 w-3.5" aria-hidden /> : <ArrowDownRight className="h-3.5 w-3.5" aria-hidden />}
            {Math.abs(delta).toFixed(1)}%
          </span>
        ) : null}
      </div>
      <div>
        <p className="text-xl font-bold tabular-nums tracking-tight sm:text-2xl">{value}</p>
        <p className="tfd-muted text-xs">{label}</p>
        {hint ? <p className="tfd-muted mt-0.5 text-[11px]">{hint}</p> : null}
      </div>
    </Card>
  )
}

export function Meter({ value, tone = 'brand', className }: { value: number; tone?: Tone; className?: string }) {
  const colors: Record<Tone, string> = {
    ok: 'var(--ok)',
    warn: 'var(--warn)',
    bad: 'var(--bad)',
    info: 'var(--info)',
    violet: 'var(--violet)',
    brand: 'var(--brand)',
    neutral: 'var(--muted)',
  }
  return (
    <div className={cn('tfd-track h-1.5 w-full overflow-hidden rounded-full', className)}>
      <div
        className="h-full rounded-full transition-[width] duration-700 ease-out"
        style={{ width: `${Math.max(3, Math.min(100, value))}%`, background: colors[tone] }}
      />
    </div>
  )
}

/** One shared clock: a count of seconds since the screen opened. */
export function useTick(ms = 1000) {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), ms)
    return () => clearInterval(timer)
  }, [ms])
  return tick
}

export function clock(seconds: number) {
  const s = Math.max(0, Math.floor(seconds))
  const m = Math.floor(s / 60)
  return `${m}:${String(s % 60).padStart(2, '0')}`
}

// ── "This is a demo" notices ────────────────────────────────────────────────

const NotifyContext = createContext<(message: string) => void>(() => {})

export const NotifyProvider = NotifyContext.Provider

export function useNotify() {
  return useContext(NotifyContext)
}

// ── Dialogs ─────────────────────────────────────────────────────────────────

/*
 * The demo window is a glass panel, and a backdrop-filter makes its element the
 * containing block for `position: fixed`. A dialog rendered inside it would be
 * pinned to the panel instead of the screen, so dialogs are portalled to a node
 * at the root of the demo (still inside `.tfd`, so the theme applies).
 */
const PortalContext = createContext<HTMLElement | null>(null)

export const PortalProvider = PortalContext.Provider

export function Modal({
  title,
  subtitle,
  onClose,
  children,
}: {
  title: string
  subtitle?: string
  onClose: () => void
  children: React.ReactNode
}) {
  const root = useContext(PortalContext)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  if (!root) return null
  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-end justify-center sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-label={title}>
      <button type="button" aria-label="Close dialog" className="absolute inset-0 cursor-default bg-black/45" onClick={onClose} />
      <div className="tfd-modal tfd-pop tfd-thin-scroll relative max-h-[88dvh] w-full overflow-y-auto rounded-t-3xl p-5 sm:max-w-md sm:rounded-3xl">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h3 className="text-base font-bold leading-tight">{title}</h3>
            {subtitle ? <p className="tfd-muted mt-0.5 text-xs">{subtitle}</p> : null}
          </div>
          <button type="button" aria-label="Close" onClick={onClose} className="tfd-btn tfd-btn-glass h-8 w-8 shrink-0">
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
        {children}
      </div>
    </div>,
    root,
  )
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block text-xs">
      <span className="mb-1 block font-semibold">{label}</span>
      {children}
      {hint ? <span className="tfd-muted mt-1 block text-[11px]">{hint}</span> : null}
    </label>
  )
}

/** The green/red diet mark printed on Sri Lankan and Indian menus. */
export function VegMark({ veg }: { veg: boolean }) {
  return (
    <span
      title={veg ? 'Vegetarian' : 'Non-vegetarian'}
      className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[3px] border-[1.5px]"
      style={{ borderColor: veg ? '#16a34a' : '#dc2626' }}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: veg ? '#16a34a' : '#dc2626' }} />
    </span>
  )
}

// ── Charts (plain SVG: no chart library to download on a phone) ─────────────

function smoothPath(points: [number, number][]) {
  if (points.length < 2) return ''
  let d = `M ${points[0][0]} ${points[0][1]}`
  for (let i = 0; i < points.length - 1; i++) {
    const [x0, y0] = points[i]
    const [x1, y1] = points[i + 1]
    const mid = (x0 + x1) / 2
    d += ` C ${mid} ${y0}, ${mid} ${y1}, ${x1} ${y1}`
  }
  return d
}

export function AreaChart({
  data,
  height = 180,
  format,
}: {
  data: { label: string; value: number }[]
  height?: number
  format: (value: number) => string
}) {
  const id = useId().replace(/:/g, '')
  const [active, setActive] = useState<number | null>(null)
  const W = 600
  const H = 200
  const max = Math.max(...data.map((d) => d.value)) * 1.12
  const step = W / (data.length - 1)
  const points = data.map((d, i) => [i * step, H - (d.value / max) * H] as [number, number])
  const line = smoothPath(points)
  const shown = active ?? data.reduce((best, d, i) => (d.value > data[best].value ? i : best), 0)

  return (
    <div>
      <div className="relative" style={{ height }}>
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-full w-full overflow-visible" aria-hidden>
          <defs>
            <linearGradient id={`area-${id}`} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="var(--brand)" stopOpacity="0.45" />
              <stop offset="100%" stopColor="var(--brand)" stopOpacity="0" />
            </linearGradient>
            <linearGradient id={`line-${id}`} x1="0" x2="1" y1="0" y2="0">
              <stop offset="0%" stopColor="#ffab4d" />
              <stop offset="60%" stopColor="#f2611a" />
              <stop offset="100%" stopColor="#e8408a" />
            </linearGradient>
          </defs>
          {[0.25, 0.5, 0.75].map((g) => (
            <line key={g} x1="0" x2={W} y1={H * g} y2={H * g} stroke="var(--track)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
          ))}
          <path d={`${line} L ${W} ${H} L 0 ${H} Z`} fill={`url(#area-${id})`} />
          <path d={line} fill="none" stroke={`url(#line-${id})`} strokeWidth="3" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        </svg>
        {/* Hover/tap columns and the marker live in HTML so they are not stretched with the SVG. */}
        <div className="absolute inset-0 flex">
          {data.map((d, i) => (
            <button
              key={d.label}
              type="button"
              aria-label={`${d.label}: ${format(d.value)}`}
              className="h-full flex-1 cursor-crosshair focus:outline-none"
              onMouseEnter={() => setActive(i)}
              onFocus={() => setActive(i)}
              onClick={() => setActive(i)}
            />
          ))}
        </div>
        <div
          className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 transition-all duration-200"
          style={{ left: `${(points[shown][0] / W) * 100}%`, top: `${(points[shown][1] / H) * 100}%` }}
        >
          <span className="block h-3 w-3 rounded-full border-2 border-white" style={{ background: 'var(--brand)' }} />
          <span className="tfd-glass-strong absolute bottom-4 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-lg px-2 py-1 text-[11px] font-semibold">
            {data[shown].label} · {format(data[shown].value)}
          </span>
        </div>
      </div>
      <div className="tfd-muted mt-2 flex justify-between text-[10px] sm:text-[11px]">
        {data.map((d) => (
          <span key={d.label}>{d.label}</span>
        ))}
      </div>
    </div>
  )
}

export function Donut({
  segments,
  center,
  caption,
}: {
  segments: { label: string; share: number; color: string }[]
  center: string
  caption: string
}) {
  let offset = 25
  return (
    <div className="flex items-center gap-4">
      <div className="relative h-28 w-28 shrink-0">
        <svg viewBox="0 0 36 36" className="h-full w-full" aria-hidden>
          <circle cx="18" cy="18" r="15.915" fill="none" stroke="var(--track)" strokeWidth="4" />
          {segments.map((s) => {
            const node = (
              <circle
                key={s.label}
                cx="18"
                cy="18"
                r="15.915"
                fill="none"
                stroke={s.color}
                strokeWidth="4"
                strokeDasharray={`${Math.max(0, s.share - 1.2)} ${100 - Math.max(0, s.share - 1.2)}`}
                strokeDashoffset={offset}
                strokeLinecap="round"
              />
            )
            offset -= s.share
            return node
          })}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-base font-bold">{center}</span>
          <span className="tfd-muted text-[10px]">{caption}</span>
        </div>
      </div>
      <ul className="min-w-0 flex-1 space-y-1.5 text-xs">
        {segments.map((s) => (
          <li key={s.label} className="flex items-center justify-between gap-2">
            <span className="flex min-w-0 items-center gap-2">
              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: s.color }} />
              <span className="truncate">{s.label}</span>
            </span>
            <span className="font-semibold tabular-nums">{s.share}%</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

export function Sparkline({ values, className }: { values: number[]; className?: string }) {
  const max = Math.max(...values)
  const min = Math.min(...values)
  const points = values.map((v, i) => [(i / (values.length - 1)) * 100, 30 - ((v - min) / (max - min || 1)) * 26 - 2] as [number, number])
  return (
    <svg viewBox="0 0 100 30" preserveAspectRatio="none" className={className} aria-hidden>
      <path d={smoothPath(points)} fill="none" stroke="var(--brand)" strokeWidth="2.5" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

/** A real, scannable QR drawn from a pre-computed path (see app/demo/page.tsx). */
export interface QrShape {
  size: number
  path: string
}

export function QrCode({ qr, className }: { qr: QrShape; className?: string }) {
  return (
    <svg viewBox={`0 0 ${qr.size} ${qr.size}`} className={className} shapeRendering="crispEdges" role="img" aria-label="QR code that opens this demo">
      <rect width={qr.size} height={qr.size} fill="#fff" />
      <path d={qr.path} fill="#11131f" />
    </svg>
  )
}

export function WhatsAppIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z" />
    </svg>
  )
}
