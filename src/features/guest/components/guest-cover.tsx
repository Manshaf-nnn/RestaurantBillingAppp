'use client'

import * as React from 'react'
import { Clock, CreditCard, QrCode, Search, Utensils, UtensilsCrossed } from 'lucide-react'

import { sampleBrandColor, type Rgb } from '@/features/orders/components/brand-theme'
import { hexToRgb, type GuestAppearance } from '../appearance'

/** The TableFlow orange, used until the logo has been read. */
const FALLBACK: Rgb = { r: 249, g: 115, b: 22 }

/**
 * The accent sampled from the restaurant's own artwork.
 *
 * One hook so the landing screen, the QR entry screen and the menu behind them
 * all derive it the same way — `sampleBrandColor` weights each pixel by its
 * saturation, because the interesting colour in a logo is almost never the
 * white it sits on. Runs in the browser because it needs a canvas.
 */
export function useBrandAccent(logoUrl: string | null, coverUrl: string | null): Rgb {
  const [accent, setAccent] = React.useState<Rgb>(FALLBACK)
  const source = logoUrl || coverUrl

  React.useEffect(() => {
    let active = true
    void sampleBrandColor(source).then((colour) => {
      if (active) setAccent(colour)
    })
    return () => {
      active = false
    }
  }, [source])

  return accent
}

/**
 * The welcome screen every guest meets, whichever code they scanned.
 *
 * ── Why this is one component and not two ───────────────────────────────────
 *
 * The ordinary table QR lands on `/order/<slug>/<branch>` and a QR menu lands
 * on `/m/<code>`. The owner's instruction is that they look identical — and
 * two components that must look identical are two components that will drift
 * the first time somebody changes one. So the whole treatment lives here —
 * background layers, logo badge, hours pill, the glass card, the tiles, the
 * footer — and each flow passes only the part that differs: the form in the
 * middle of the card.
 *
 * `CoverPage` and the QR entry screen are now both thin: they own their own
 * question and their own submit, and nothing about how it looks.
 *
 * ── The accent ──────────────────────────────────────────────────────────────
 *
 * Sampled from the restaurant's logo by default, which is what the guest
 * screens have always done, and published as `--theme-r/g/b` for the CSS in
 * `globals.css`. An owner whose logo is black-and-white can pin a colour
 * instead; that is `accentMode: 'CUSTOM'`.
 */

export interface GuestCoverProps {
  restaurantName: string
  tagline: string | null
  logoUrl: string | null
  coverUrl: string | null
  isOpen: boolean
  openingLabel: string | null
  appearance: GuestAppearance
  /** The accent sampled from the artwork, when `accentMode` is AUTO. */
  sampled: { r: number; g: number; b: number }
  /** The card's body: whatever this particular code asks the guest. */
  children: React.ReactNode
  /**
   * Rendered instead of the live screen's own chrome when the settings editor
   * is showing a preview — it must not be full-viewport or fixed there.
   */
  embedded?: boolean
}

export function GuestCover({
  restaurantName,
  tagline,
  logoUrl,
  coverUrl,
  isOpen,
  openingLabel,
  appearance,
  sampled,
  children,
  embedded = false,
}: GuestCoverProps) {
  const custom = appearance.accentMode === 'CUSTOM' ? hexToRgb(appearance.accentColour) : null
  const accent = custom ?? sampled
  const rgb = `${accent.r}, ${accent.g}, ${accent.b}`
  const bgImage = coverUrl || '/default-cover.jpg'

  // Fixed layers fill the viewport on the real screen; inside a preview box
  // they must stay inside the box, or they would cover the settings form.
  const layer = embedded ? 'absolute' : 'fixed'

  return (
    <div
      className={`guest-ink relative isolate flex w-full flex-col items-center justify-between px-4 py-3 text-center selection:bg-orange-500/30 ${
        embedded ? 'h-full overflow-hidden rounded-2xl' : 'min-h-dvh'
      }`}
      style={{ '--theme-r': accent.r, '--theme-g': accent.g, '--theme-b': accent.b } as React.CSSProperties}
    >
      {/* ── Background layers ─────────────────────────────────────────────── */}
      <div
        className={`${layer} inset-0 z-0 scale-105 bg-cover bg-center pointer-events-none`}
        style={{ backgroundImage: `url(${bgImage})` }}
      />
      <div className={`guest-scrim ${layer} inset-0 z-0 pointer-events-none`} />
      <div className={`${layer} inset-0 z-0 backdrop-blur-[12px] pointer-events-none`} />
      <div
        className={`${layer} inset-0 z-0 pointer-events-none`}
        style={{ background: `radial-gradient(circle at 50% 55%,rgba(${rgb},0.22),transparent 55%)` }}
      />

      {/* ── 1. Shop header ────────────────────────────────────────────────── */}
      <header className="relative z-10 flex w-full max-w-md shrink-0 flex-col items-center pt-1">
        {appearance.showLogo ? (
          <div className="group relative">
            <div
              className="absolute -inset-1 rounded-xl opacity-50 blur-sm transition-opacity group-hover:opacity-75"
              style={{ backgroundColor: `rgb(${rgb})` }}
            />
            <div className="relative flex h-14 w-14 items-center justify-center overflow-hidden rounded-xl border border-black/10 bg-white p-0.5 shadow-xl shadow-black/20 dark:border-white/40 dark:shadow-black/80">
              {logoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={logoUrl} alt={restaurantName} className="h-full w-full rounded-[10px] object-cover" />
              ) : (
                /*
                 * The placeholder an owner sees before they upload anything.
                 * A branded mark rather than a broken image or an empty box:
                 * the screen is a guest's first impression of the restaurant,
                 * and a missing logo should not read as a missing page.
                 */
                <div className="flex h-full w-full items-center justify-center rounded-[10px] bg-gradient-to-br from-amber-500 to-orange-600">
                  <Utensils className="h-6 w-6 text-white drop-shadow" />
                </div>
              )}
            </div>
          </div>
        ) : null}

        <h1 className={`guest-ink text-2xl font-extrabold leading-tight tracking-tight ${appearance.showLogo ? 'mt-2' : ''}`}>
          {restaurantName}
        </h1>

        {appearance.showTagline && tagline ? (
          <p className="guest-ink-muted mt-0.5 max-w-[200px] truncate text-[11px] font-medium leading-tight">
            {tagline}
          </p>
        ) : null}

        {appearance.showHours ? (
          <div className="guest-surface mt-2 inline-flex items-center gap-2 rounded-full border px-3 py-1 text-[11px] font-medium">
            <Clock size={11} className="guest-ink-muted shrink-0" />
            <span className="guest-ink">{openingLabel ?? '11:00 – 23:30'}</span>
            <span className="guest-ink-faint">•</span>
            <span
              className={
                isOpen
                  ? 'inline-flex items-center gap-1 font-semibold text-emerald-400'
                  : 'inline-flex items-center gap-1 font-semibold text-red-400'
              }
            >
              <span
                className={
                  isOpen
                    ? 'h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400'
                    : 'h-1.5 w-1.5 rounded-full bg-red-500'
                }
              />
              {isOpen ? 'Open' : 'Closed'}
            </span>
          </div>
        ) : null}
      </header>

      {/* ── 2. The glass card ─────────────────────────────────────────────── */}
      <main className="relative z-10 my-2 flex w-full max-w-md flex-1 items-center">
        <div className="guest-surface relative w-full overflow-hidden rounded-[28px] border px-5 py-5">
          <div className="pointer-events-none absolute -right-10 -top-10 h-28 w-28 rounded-full bg-gradient-to-bl from-amber-400/35 via-orange-500/15 to-transparent blur-md" />
          <div
            className="pointer-events-none absolute -left-16 -top-16 h-48 w-48 rounded-full opacity-60 blur-3xl"
            style={{ backgroundColor: `rgba(${rgb},0.2)` }}
          />
          <div
            className="pointer-events-none absolute -bottom-16 -right-16 h-48 w-48 rounded-full opacity-50 blur-3xl"
            style={{ backgroundColor: `rgba(${rgb},0.18)` }}
          />

          <div className="relative">
            {appearance.showPoweredBy ? (
              <div className="flex flex-col items-center text-center">
                <p className="guest-ink-muted text-[10px] font-medium uppercase tracking-widest">Powered by</p>
                <div className="mt-0.5 flex items-baseline justify-center">
                  <span className="guest-ink text-xl font-extrabold tracking-tight">Table</span>
                  <span className="relative ml-0.5 bg-gradient-to-r from-orange-400 via-amber-400 to-orange-500 bg-clip-text pr-1 font-serif text-2xl font-extrabold italic text-transparent">
                    Flow
                    <svg className="absolute -bottom-0.5 left-0 h-1.5 w-full" viewBox="0 0 60 10" fill="none">
                      <path d="M2 7C18 2 42 2 58 7" stroke="url(#sg)" strokeWidth="2.5" strokeLinecap="round" />
                      <defs>
                        <linearGradient id="sg" x1="0" y1="0" x2="60" y2="0" gradientUnits="userSpaceOnUse">
                          <stop stopColor="#F97316" />
                          <stop offset="1" stopColor="#F59E0B" />
                        </linearGradient>
                      </defs>
                    </svg>
                  </span>
                </div>
                <p className="guest-ink-faint mt-1 text-[9px] font-bold uppercase tracking-[0.24em]">
                  SMART DINING, SIMPLIFIED.
                </p>
              </div>
            ) : null}

            {children}

            {appearance.showTiles ? (
              <div className="mt-4 grid grid-cols-4 gap-2">
                <FeatureTile icon={<QrCode size={16} />} label="Scan" />
                <FeatureTile icon={<UtensilsCrossed size={16} />} label="Order" />
                <FeatureTile icon={<Search size={16} />} label="Track" />
                <FeatureTile icon={<CreditCard size={16} />} label="Pay" />
              </div>
            ) : null}

            {appearance.footerNote ? (
              <p className="guest-ink-faint mt-3.5 text-center text-[10px]">{appearance.footerNote}</p>
            ) : null}
          </div>
        </div>
      </main>

      {/* ── 3. Footer ─────────────────────────────────────────────────────── */}
      {appearance.showFooter ? (
        <footer className="relative z-10 shrink-0 pb-1">
          <p className="guest-ink-faint text-[9px] font-medium">
            © {new Date().getFullYear()} {restaurantName} · Powered by TableFlow
          </p>
        </footer>
      ) : null}
    </div>
  )
}

/**
 * The card's own heading and helper line, so both flows word their question
 * the same way and the settings page has one thing to change.
 */
export function GuestPrompt({ heading, helper }: { heading: string; helper: string }) {
  return (
    <div className="mt-4 text-center">
      <h2 className="guest-ink text-base font-bold tracking-tight">{heading}</h2>
      {helper ? <p className="guest-ink-muted mt-0.5 text-[11px]">{helper}</p> : null}
    </div>
  )
}

/** The primary action, in the gradient both flows share. */
export function GuestSubmit({
  label,
  pending,
  disabled,
  pendingLabel,
}: {
  label: string
  pending?: boolean
  disabled?: boolean
  pendingLabel?: string
}) {
  return (
    <button
      type="submit"
      disabled={pending || disabled}
      className="group relative mt-3.5 flex h-13 w-full cursor-pointer items-center justify-center gap-2 overflow-hidden rounded-xl bg-gradient-to-r from-orange-500 via-amber-500 to-orange-600 py-3.5 text-sm font-bold text-white shadow-lg shadow-orange-500/30 transition-all duration-300 hover:scale-[1.01] hover:shadow-orange-500/50 active:scale-[0.98] disabled:opacity-50"
    >
      <span>{pending ? (pendingLabel ?? 'Just a moment…') : label}</span>
      <ArrowRightIcon />
    </button>
  )
}

function ArrowRightIcon() {
  return (
    <svg
      className="h-4 w-4 transition-transform duration-300 group-hover:translate-x-1"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M5 12h14" />
      <path d="m12 5 7 7-7 7" />
    </svg>
  )
}

function FeatureTile({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <div className="guest-surface flex flex-col items-center justify-center gap-1 rounded-xl border px-1 py-2.5 text-center transition-all duration-200 hover:scale-[1.04]">
      <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-orange-500/20 bg-orange-500/10 text-orange-400">
        {icon}
      </div>
      <span className="guest-ink-muted text-[10px] font-medium">{label}</span>
    </div>
  )
}
