"use client"

import React, { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  ArrowRight,
  Clock,
  CreditCard,
  QrCode,
  Search,
  UtensilsCrossed,
  Utensils,
} from 'lucide-react'
import { toast } from 'sonner'

import { Alert } from '@/components/ui/feedback'
import { resolveTable } from '@/features/orders/actions'
import { useCart } from '@/features/orders/cart-store'

interface Props {
  restaurantName: string
  tagline: string | null
  logoUrl: string | null
  coverUrl: string | null
  city: string | null
  isOpen: boolean
  openingLabel: string | null
}

function rgbToCss(r: number, g: number, b: number) {
  return `${r}, ${g}, ${b}`
}

async function extractThemeColor(url: string | null) {
  if (!url) return { r: 249, g: 115, b: 22 }
  try {
    const img = new window.Image()
    img.crossOrigin = 'anonymous'
    img.src = url
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej })
    const size = 40
    const canvas = document.createElement('canvas')
    canvas.width = size; canvas.height = size
    const ctx = canvas.getContext('2d')
    if (!ctx) return { r: 249, g: 115, b: 22 }
    ctx.drawImage(img, 0, 0, size, size)
    const data = ctx.getImageData(0, 0, size, size).data
    let r = 0, g = 0, b = 0, count = 0
    for (let i = 0; i < data.length; i += 4) {
      const alpha = data[i + 3]
      if (alpha < 100) continue
      const rr = data[i], gg = data[i + 1], bb = data[i + 2]
      const max = Math.max(rr, gg, bb), min = Math.min(rr, gg, bb)
      const sat = max === 0 ? 0 : (max - min) / max
      const weight = 1 + sat * 2
      r += rr * weight; g += gg * weight; b += bb * weight; count += weight
    }
    if (!count) return { r: 249, g: 115, b: 22 }
    return { r: Math.round(r / count), g: Math.round(g / count), b: Math.round(b / count) }
  } catch {
    return { r: 249, g: 115, b: 22 }
  }
}

export default function CoverPage(props: Props) {
  const { restaurantName, tagline, logoUrl, coverUrl, isOpen, openingLabel } = props
  const [theme, setTheme] = useState({ r: 249, g: 115, b: 22 })
  const [tableNumber, setTableNumber] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [focused, setFocused] = useState(false)

  const router = useRouter()
  const { setTable } = useCart()

  const bgImage = coverUrl || '/default-cover.jpg'

  useEffect(() => {
    let mounted = true
    extractThemeColor(bgImage).then((c) => { if (mounted) setTheme(c) })
    return () => { mounted = false }
  }, [bgImage])

  const rgb = rgbToCss(theme.r, theme.g, theme.b)

  const submit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault()
    setError(null)
    const trimmed = tableNumber.trim()
    if (!trimmed) { setError('Enter the number printed on your table'); return }
    try {
      setPending(true)
      const result = await resolveTable({ tableNumber: trimmed })
      if (!result.ok) { setError(result.error); setPending(false); return }
      setTable(result.data)
      // Say so up front if the table is mid-service. Finding out only at the
      // bill that it includes an earlier round is how arguments start.
      if (result.data.openBill) {
        toast.info(`Table ${result.data.tableNumber} already has an open bill`, {
          description: 'Anything you order will be added to it.',
        })
      } else {
        toast.success(`Table ${result.data.tableNumber} — welcome!`)
      }
      router.push('/order/menu')
    } catch { setError('Something went wrong') }
    finally { setPending(false) }
  }

  return (
    /**
     * `min-h-dvh`, not `h-dvh overflow-hidden`.
     *
     * The layout is tuned to fit one screen and on a normal phone it still
     * does — `justify-between` fills the viewport exactly. But the content has
     * a real minimum height (logo, name, hours, the glass card with its input
     * and button, four tiles, footer), and on a short screen — a small phone, a
     * landscape phone, or any device once the browser chrome and an on-screen
     * keyboard are showing — it overflows. Clipping that overflow meant the
     * guest's scroll snapped straight back and, worse, the "Continue" button
     * could sit permanently out of reach. Letting it scroll costs nothing when
     * everything already fits.
     */
    <div
      className="guest-ink relative isolate flex min-h-dvh w-full flex-col items-center justify-between px-4 py-3 text-center selection:bg-orange-500/30"
      // CSS custom properties are not in React's CSSProperties key type; the
      // cast is on the object rather than each key so the values stay checked.
      style={
        {
          '--theme-r': theme.r,
          '--theme-g': theme.g,
          '--theme-b': theme.b,
        } as React.CSSProperties
      }
    >
      {/*
        ── Background layers ───────────────────────────────────────────────────
        `fixed` so the ambient cover keeps filling the viewport if the page does
        scroll on a short screen, rather than sliding away with it.

        Stacked with `isolate` on the wrapper and `z-0` here rather than negative
        z-indexes: a negative z-index paints behind an ancestor's background, so
        the moment the shared order layout carries an opaque background these
        layers would vanish and the white text would land on white. `isolate`
        creates a stacking context this page owns, and the content below sits at
        `z-10`, above these.
      */}
      <div
        className="fixed inset-0 z-0 bg-cover bg-center scale-105 pointer-events-none"
        style={{ backgroundImage: `url(${bgImage})` }}
      />
      <div className="guest-scrim fixed inset-0 z-0 pointer-events-none" />
      <div className="fixed inset-0 z-0 backdrop-blur-[12px] pointer-events-none" />
      <div
        className="fixed inset-0 z-0 pointer-events-none"
        style={{ background: `radial-gradient(circle at 50% 55%,rgba(${rgb},0.22),transparent 55%)` }}
      />

      {/* ── 1. SHOP HEADER ───────────────────────────────────────────────────── */}
      <header className="relative z-10 flex flex-col items-center w-full max-w-md shrink-0 pt-1">
        {/* Logo — compact 56 × 56 px badge */}
        <div className="relative group">
          <div
            className="absolute -inset-1 rounded-xl blur-sm opacity-50 group-hover:opacity-75 transition-opacity"
            style={{ backgroundColor: `rgb(${rgb})` }}
          />
          <div className="relative flex h-14 w-14 items-center justify-center overflow-hidden rounded-xl border border-black/10 bg-white p-0.5 shadow-xl shadow-black/20 dark:border-white/40 dark:shadow-black/80">
            {logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={logoUrl} alt={restaurantName} className="h-full w-full rounded-[10px] object-cover" />
            ) : (
              <div className="flex h-full w-full items-center justify-center rounded-[10px] bg-gradient-to-br from-amber-500 to-orange-600">
                <Utensils className="h-6 w-6 text-white drop-shadow" />
              </div>
            )}
          </div>
        </div>

        {/* Restaurant name */}
        <h1 className="guest-ink mt-2 text-2xl font-extrabold tracking-tight leading-tight">
          {restaurantName}
        </h1>

        {tagline && (
          <p className="guest-ink-muted mt-0.5 text-[11px] font-medium leading-tight max-w-[200px] truncate">
            {tagline}
          </p>
        )}

        {/* Hours + status pill */}
        <div className="guest-surface mt-2 inline-flex items-center gap-2 rounded-full border px-3 py-1 text-[11px] font-medium">
          <Clock size={11} className="guest-ink-muted shrink-0" />
          <span className="guest-ink">{openingLabel ?? '11:00 – 23:30'}</span>
          <span className="guest-ink-faint">•</span>
          <span className={isOpen
            ? 'inline-flex items-center gap-1 text-emerald-400 font-semibold'
            : 'inline-flex items-center gap-1 text-red-400 font-semibold'
          }>
            <span className={isOpen
              ? 'h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse'
              : 'h-1.5 w-1.5 rounded-full bg-red-500'
            } />
            {isOpen ? 'Open' : 'Closed'}
          </span>
        </div>
      </header>

      {/* ── 2. LIQUID GLASS CARD ─────────────────────────────────────────────── */}
      <main className="relative z-10 w-full max-w-md flex-1 flex items-center my-2">
        <div
          className="guest-surface relative w-full overflow-hidden rounded-[28px] border px-5 py-5"
        >
          {/* Corner refraction highlight */}
          <div className="pointer-events-none absolute -top-10 -right-10 h-28 w-28 rounded-full bg-gradient-to-bl from-amber-400/35 via-orange-500/15 to-transparent blur-md" />

          {/* Ambient blobs */}
          <div
            className="pointer-events-none absolute -left-16 -top-16 h-48 w-48 rounded-full blur-3xl opacity-60"
            style={{ backgroundColor: `rgba(${rgb},0.2)` }}
          />
          <div
            className="pointer-events-none absolute -right-16 -bottom-16 h-48 w-48 rounded-full blur-3xl opacity-50"
            style={{ backgroundColor: `rgba(${rgb},0.18)` }}
          />

          <div className="relative">
            {/* Brand header */}
            <div className="flex flex-col items-center text-center">
              <p className="guest-ink-muted text-[10px] font-medium tracking-widest uppercase">Powered by</p>
              <div className="mt-0.5 flex items-baseline justify-center">
                <span className="guest-ink text-xl font-extrabold tracking-tight">Table</span>
                <span className="relative ml-0.5 pr-1 text-2xl font-extrabold italic text-transparent bg-clip-text bg-gradient-to-r from-orange-400 via-amber-400 to-orange-500 font-serif">
                  Flow
                  <svg className="absolute -bottom-0.5 left-0 w-full h-1.5" viewBox="0 0 60 10" fill="none">
                    <path d="M2 7C18 2 42 2 58 7" stroke="url(#sg)" strokeWidth="2.5" strokeLinecap="round" />
                    <defs>
                      <linearGradient id="sg" x1="0" y1="0" x2="60" y2="0" gradientUnits="userSpaceOnUse">
                        <stop stopColor="#F97316" /><stop offset="1" stopColor="#F59E0B" />
                      </linearGradient>
                    </defs>
                  </svg>
                </span>
              </div>
              <p className="guest-ink-faint mt-1 text-[9px] font-bold tracking-[0.24em] uppercase">
                SMART DINING, SIMPLIFIED.
              </p>
            </div>

            {/* Table number prompt */}
            <div className="mt-4 text-center">
              <h2 className="guest-ink text-base font-bold tracking-tight">What is your table number?</h2>
              <p className="guest-ink-muted mt-0.5 text-[11px]">You will find it on the stand or card on your table.</p>
            </div>

            {/* Input + submit */}
            <form onSubmit={submit} className="mt-3.5">
              <div
                className={`guest-control relative flex h-14 items-center rounded-xl border px-3.5 transition-all duration-300 ${
                  focused
                    ? 'border-amber-500/80 ring-4 ring-amber-500/20 shadow-[0_0_28px_rgba(249,115,22,0.28)]'
                    : tableNumber.length > 0
                    ? 'border-amber-500/55 shadow-[0_0_18px_rgba(249,115,22,0.18)]'
                    : ''
                }`}
              >
                {/* Table icon */}
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-black/10 bg-black/5 text-amber-500 dark:border-white/10 dark:bg-white/5 dark:text-amber-400">
                  <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 7h18" /><path d="M5 7v13" /><path d="M19 7v13" />
                    <path d="M8 12h8" /><path d="M12 7v5" />
                  </svg>
                </div>
                <div className="guest-divider mx-3 h-6 w-px shrink-0" />
                <input
                  ref={inputRef}
                  value={tableNumber}
                  onChange={(e) => { setTableNumber(e.target.value.toUpperCase().slice(0, 10)); setError(null) }}
                  onFocus={() => setFocused(true)}
                  onBlur={() => setFocused(false)}
                  inputMode="numeric"
                  placeholder="5"
                  aria-label="Table number"
                  aria-describedby={error ? 'table-error' : undefined}
                  className="guest-ink w-full bg-transparent text-center text-2xl font-extrabold tracking-wider outline-none placeholder:opacity-40"
                />
              </div>

              {error && (
                <div className="mt-2.5" id="table-error">
                  <Alert variant="destructive" className="text-center bg-red-950/80 border-red-500/50 text-red-200 py-1.5 text-xs">
                    {error}
                  </Alert>
                </div>
              )}

              <button
                type="submit"
                disabled={pending}
                className="group relative mt-3.5 flex h-13 w-full items-center justify-center gap-2 overflow-hidden rounded-xl bg-gradient-to-r from-orange-500 via-amber-500 to-orange-600 text-sm font-bold text-white shadow-lg shadow-orange-500/30 transition-all duration-300 hover:shadow-orange-500/50 hover:scale-[1.01] active:scale-[0.98] disabled:opacity-50 cursor-pointer py-3.5"
              >
                <span>{pending ? 'Verifying Table…' : 'Continue to the menu'}</span>
                <ArrowRight className="h-4 w-4 transition-transform duration-300 group-hover:translate-x-1" />
              </button>
            </form>

            {/* Feature tiles — compact row */}
            <div className="mt-4 grid grid-cols-4 gap-2">
              <FeatureTile icon={<QrCode size={16} />} label="Scan" />
              <FeatureTile icon={<UtensilsCrossed size={16} />} label="Order" />
              <FeatureTile icon={<Search size={16} />} label="Track" />
              <FeatureTile icon={<CreditCard size={16} />} label="Pay" />
            </div>

            <p className="guest-ink-faint mt-3.5 text-center text-[10px]">
              No app, no sign-up. Order straight from your phone.
            </p>
          </div>
        </div>
      </main>

      {/* ── 3. FOOTER ─────────────────────────────────────────────────────────── */}
      <footer className="relative z-10 shrink-0 pb-1">
        <p className="guest-ink-faint text-[9px] font-medium">
          © {new Date().getFullYear()} {restaurantName} · Powered by TableFlow
        </p>
      </footer>
    </div>
  )
}

function FeatureTile({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <div className="guest-surface flex flex-col items-center justify-center gap-1 rounded-xl border py-2.5 px-1 text-center transition-all duration-200 hover:scale-[1.04]">
      <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-orange-500/10 text-orange-400 border border-orange-500/20">
        {icon}
      </div>
      <span className="guest-ink-muted text-[10px] font-medium">{label}</span>
    </div>
  )
}
