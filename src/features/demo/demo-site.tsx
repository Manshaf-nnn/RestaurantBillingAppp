'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Image from 'next/image'
import Link from 'next/link'
import {
  ArrowRight,
  BarChart3,
  Bike,
  Boxes,
  CalendarCheck,
  ChefHat,
  Cloud,
  Menu,
  Moon,
  QrCode as QrIcon,
  Receipt,
  Search,
  ShieldCheck,
  Smartphone,
  Sparkles,
  Store,
  Sun,
  Wifi,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

import { cn } from '@/lib/utils'

import { BOOK_LINK, CHAT_LINK, WHATSAPP_DISPLAY, rs } from './data'
import { GenericScreen } from './more-screens'
import { ALL_SCREENS, HIGHLIGHTS, NAV, type DemoScreen } from './nav'
import { Approvals, Customers, Stock, Transfers } from './screens-backoffice'
import { GuestPreview } from './screens-guest'
import { Kitchen } from './screens-kitchen'
import { CommandCenter, LiveFloor } from './screens-operations'
import { Delivery } from './screens-ordering'
import {
  CashDrawerReport,
  DeliveryReport,
  InventoryReport,
  PaymentDetailsReport,
  PettyCashReport,
  ProfitReport,
  PurchasingReport,
  ReportsHub,
  ReservationsReport,
  SalesReport,
} from './screens-reports'
import { Tools } from './screens-tools'
import { DeliveryDesk, Drawer, Pos, Shift } from './screens-pos'
import { CardTitle, Modal, NotifyProvider, Pill, PortalProvider, QrCode, Sparkline, WhatsAppIcon, type QrShape } from './ui'

import './demo.css'

/** Report pages carry their own title, description and export button, as the real ones do. */
const OWN_HEADING = new Set(['reports', 'sales-report', 'delivery-report', 'gross-profit', 'inventory-report', 'purchasing-report', 'cash-drawer-report', 'petty-cash-report', 'payment-details-report', 'reservations-report', 'tools'])

type Theme = 'light' | 'dark'

const THEME_KEY = 'tfd-theme'

const FEATURES: { icon: LucideIcon; title: string; text: string }[] = [
  { icon: QrIcon, title: 'QR ordering', text: 'Guests order from the table with their own phone. No app, no waiting.' },
  { icon: Receipt, title: 'Fast billing', text: 'Dine-in, takeaway and delivery bills with cash, card and LankaQR.' },
  { icon: ChefHat, title: 'Kitchen display', text: 'Every order goes straight to the right kitchen station.' },
  { icon: Boxes, title: 'Stock control', text: 'Recipes deduct stock on every sale. Low stock warns you early.' },
  { icon: Store, title: 'Many branches', text: 'Run every location from one login and compare them side by side.' },
  { icon: ShieldCheck, title: 'Owner approvals', text: 'Discounts, voids and refunds need your approval, from anywhere.' },
  { icon: BarChart3, title: 'Clear reports', text: 'Sales, profit, purchasing and staff reports, ready to export.' },
  { icon: Cloud, title: 'Works everywhere', text: 'Phone, tablet or computer. Your data is safe in the cloud.' },
]

function useTheme() {
  const [theme, setTheme] = useState<Theme>('light')

  // Light is the default; `?theme=dark` or an earlier choice on this phone wins.
  useEffect(() => {
    let saved: string | null = null
    try {
      saved = new URLSearchParams(window.location.search).get('theme') ?? window.localStorage.getItem(THEME_KEY)
    } catch {
      saved = null
    }
    if (saved === 'dark' || saved === 'light') setTheme(saved)
  }, [])

  const toggle = useCallback(() => {
    setTheme((current) => {
      const next = current === 'light' ? 'dark' : 'light'
      try {
        window.localStorage.setItem(THEME_KEY, next)
      } catch {
        // Private windows may refuse storage; the toggle still works for this visit.
      }
      return next
    })
  }, [])

  return { theme, toggle }
}

export function DemoSite({ qr, demoUrl }: { qr: QrShape; demoUrl: string }) {
  const { theme, toggle } = useTheme()
  const [screenId, setScreenId] = useState('command')
  const [notice, setNotice] = useState<{ id: number; message: string } | null>(null)
  const [portal, setPortal] = useState<HTMLDivElement | null>(null)
  const windowRef = useRef<HTMLDivElement>(null)
  const railRef = useRef<HTMLDivElement>(null)
  const screen = ALL_SCREENS.find((s) => s.id === screenId) ?? ALL_SCREENS[1]
  const [menuOpen, setMenuOpen] = useState(false)

  useEffect(() => {
    // `/demo#reports` opens straight on a screen, so one screen can be shared.
    const read = () => {
      const fromHash = window.location.hash.slice(1)
      if (ALL_SCREENS.some((s) => s.id === fromHash)) setScreenId(fromHash)
    }
    read()
    window.addEventListener('hashchange', read)
    return () => window.removeEventListener('hashchange', read)
  }, [])

  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(null), 4200)
    return () => clearTimeout(timer)
  }, [notice])

  const notify = useCallback((message: string) => setNotice({ id: Date.now(), message }), [])

  function open(id: string) {
    setScreenId(id)
    setMenuOpen(false)
    try {
      window.history.replaceState(null, '', `#${id}`)
    } catch {
      // The address bar is a nicety; the tab still switches.
    }
    // A reader deep in a long screen would otherwise land mid-way down the next one.
    const top = windowRef.current?.getBoundingClientRect().top ?? 0
    if (top < 0) windowRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    railRef.current?.querySelector(`[data-screen="${id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' })
  }

  return (
    <NotifyProvider value={notify}>
      <PortalProvider value={portal}>
      <div className="tfd" data-theme={theme}>
        <div className="tfd-backdrop" aria-hidden>
          <div className="tfd-blob tfd-blob-1" />
          <div className="tfd-blob tfd-blob-2" />
          <div className="tfd-blob tfd-blob-3" />
          <div className="tfd-blob tfd-blob-4" />
        </div>

        {/* ── Top bar ─────────────────────────────────────────────────────── */}
        <header className="sticky top-0 z-40 px-3 pt-3 sm:px-6">
          <div className="tfd-glass-strong mx-auto flex max-w-6xl items-center gap-2 rounded-full py-2 pl-3 pr-2">
            <a href="#top" className="flex min-w-0 items-center gap-2">
              <Image src="/logo-mark.png" alt="" width={32} height={32} className="h-8 w-8 shrink-0" priority />
              <span className="hidden truncate text-base font-extrabold tracking-tight min-[380px]:inline">TableFlow</span>
              <span className="hidden sm:inline">
                <Pill tone="brand">
                  <span className="tfd-live-dot" /> Live demo
                </Pill>
              </span>
            </a>
            <div className="ml-auto flex items-center gap-1.5 sm:gap-2">
              <Link href="/login" className="tfd-muted hidden px-2 text-sm font-semibold hover:underline md:inline">
                Sign in
              </Link>
              <button
                type="button"
                onClick={toggle}
                aria-label={theme === 'light' ? 'Switch to the dark look' : 'Switch to the light look'}
                title={theme === 'light' ? 'Dark look' : 'Light look'}
                className="tfd-btn tfd-btn-glass h-10 w-10"
              >
                {theme === 'light' ? <Moon className="h-4 w-4" aria-hidden /> : <Sun className="h-4 w-4" aria-hidden />}
              </button>
              <a href={CHAT_LINK} target="_blank" rel="noopener noreferrer" aria-label={`WhatsApp ${WHATSAPP_DISPLAY}`} className="tfd-btn tfd-btn-wa h-10 w-10 lg:w-auto lg:px-4 lg:text-sm">
                <WhatsAppIcon className="h-5 w-5" />
                <span className="hidden lg:inline">{WHATSAPP_DISPLAY}</span>
              </a>
              <a href={BOOK_LINK} target="_blank" rel="noopener noreferrer" className="tfd-btn tfd-btn-primary h-10 px-3.5 text-sm sm:px-4">
                <CalendarCheck className="hidden h-4 w-4 shrink-0 sm:block" aria-hidden />
                Book a demo
              </a>
            </div>
          </div>
        </header>

        <main id="main">
          {/* ── Hero ──────────────────────────────────────────────────────── */}
          <section id="top" className="mx-auto grid max-w-6xl scroll-mt-24 items-center gap-10 px-4 pb-10 pt-10 sm:px-6 sm:pt-16 lg:grid-cols-2">
            <div>
              <Pill tone="brand" className="!px-3 !py-1 !text-xs">
                <Sparkles className="h-3.5 w-3.5" aria-hidden /> Restaurant POS made for Sri Lanka
              </Pill>
              <h1 className="mt-4 text-4xl font-extrabold leading-[1.08] tracking-tight sm:text-5xl lg:text-6xl">
                Run your whole restaurant from <span className="tfd-gradient-text">one screen</span>
              </h1>
              <p className="tfd-muted mt-4 max-w-xl text-base sm:text-lg">
                QR ordering, billing, kitchen, stock, branches and reports in one system. This is a live demo with sample data. Tap around and try everything.
              </p>
              <div className="mt-6 flex flex-col gap-3 sm:flex-row">
                <a href="#explore" className="tfd-btn tfd-btn-primary px-6 py-3.5 text-base">
                  Explore the live demo <ArrowRight className="h-4 w-4" aria-hidden />
                </a>
                <a href={BOOK_LINK} target="_blank" rel="noopener noreferrer" className="tfd-btn tfd-btn-wa px-6 py-3.5 text-base">
                  <WhatsAppIcon className="h-5 w-5" /> Book a free demo
                </a>
              </div>
              <ul className="tfd-muted mt-6 flex flex-wrap gap-x-5 gap-y-2 text-sm">
                <li className="flex items-center gap-1.5"><Smartphone className="tfd-brand h-4 w-4" aria-hidden /> Works on any phone</li>
                <li className="flex items-center gap-1.5"><Wifi className="tfd-brand h-4 w-4" aria-hidden /> Live across all devices</li>
                <li className="flex items-center gap-1.5"><Store className="tfd-brand h-4 w-4" aria-hidden /> One or many branches</li>
              </ul>
            </div>

            <div className="relative mx-auto h-[420px] w-full max-w-md sm:h-[380px]" aria-hidden>
              <div className="tfd-glass tfd-float absolute inset-x-4 top-4 rounded-3xl p-5 sm:inset-x-8">
                <div className="flex items-center justify-between">
                  <p className="tfd-muted text-xs font-semibold">Sales today · 3 branches</p>
                  <Pill tone="ok">▲ 12.4%</Pill>
                </div>
                <p className="mt-1 text-3xl font-extrabold tabular-nums tracking-tight">{rs(486250)}</p>
                <Sparkline values={[12, 19, 27, 58, 74, 52, 26, 22, 32, 49, 70, 61]} className="mt-3 h-16 w-full" />
                <div className="mt-3 grid grid-cols-3 gap-2 text-center text-xs">
                  {[
                    ['142', 'orders'],
                    ['31/46', 'tables'],
                    [rs(3424), 'avg bill'],
                  ].map(([value, label]) => (
                    <div key={label} className="tfd-card rounded-xl py-2">
                      <p className="font-bold tabular-nums">{value}</p>
                      <p className="tfd-muted text-[10px]">{label}</p>
                    </div>
                  ))}
                </div>
              </div>
              <div className="tfd-glass-strong tfd-float-slow absolute bottom-16 left-0 flex items-center gap-3 rounded-2xl px-4 py-3">
                <span className="tfd-pill tfd-pill-violet !p-2"><QrIcon className="h-4 w-4" /></span>
                <div className="text-xs">
                  <p className="font-bold">New QR order · Table 7</p>
                  <p className="tfd-muted">Chicken Kottu ×2 · {rs(3280)}</p>
                </div>
              </div>
              <div className="tfd-glass-strong tfd-float absolute bottom-0 right-0 flex items-center gap-3 rounded-2xl px-4 py-3">
                <span className="tfd-pill tfd-pill-ok !p-2"><ShieldCheck className="h-4 w-4" /></span>
                <div className="text-xs">
                  <p className="font-bold">Discount approved</p>
                  <p className="tfd-muted">Table 4 · by the owner</p>
                </div>
              </div>
            </div>
          </section>

          {/* ── The system itself ─────────────────────────────────────────── */}
          <section id="explore" className="mx-auto max-w-6xl scroll-mt-20 px-3 pb-16 sm:px-6">
            <div className="mb-4 px-1 text-center">
              <h2 className="text-2xl font-extrabold tracking-tight sm:text-3xl">Try the system</h2>
              <p className="tfd-muted mt-1 text-sm">Pick a screen. Everything is clickable, and nothing here touches a real restaurant.</p>
            </div>

            {/* Phone and tablet: the full menu behind one button, and the favourites in a rail. */}
            <div className="sticky top-[68px] z-30 -mx-3 mb-3 px-3 sm:-mx-6 sm:px-6 lg:hidden">
              <div className="tfd-glass-strong flex items-center gap-1 rounded-full p-1">
                <button type="button" onClick={() => setMenuOpen(true)} className="tfd-btn tfd-btn-primary shrink-0 px-3.5 py-2 text-xs">
                  <Menu className="h-3.5 w-3.5" aria-hidden /> All {ALL_SCREENS.length}
                </button>
                <div ref={railRef} role="tablist" aria-label="Popular demo screens" className="tfd-scroll flex min-w-0 flex-1 gap-1 overflow-x-auto">
                  {HIGHLIGHTS.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      role="tab"
                      data-screen={s.id}
                      aria-selected={s.id === screen.id}
                      onClick={() => open(s.id)}
                      className="tfd-tab flex shrink-0 items-center gap-1.5 rounded-full px-3.5 py-2 text-xs font-semibold"
                    >
                      <s.icon className="h-3.5 w-3.5" aria-hidden />
                      {s.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div ref={windowRef} className="tfd-glass scroll-mt-36 rounded-3xl lg:scroll-mt-24">
              <div className="tfd-line flex items-center gap-3 border-b px-4 py-3">
                <span className="flex gap-1.5" aria-hidden>
                  <span className="h-2.5 w-2.5 rounded-full bg-[#ff5f57]" />
                  <span className="h-2.5 w-2.5 rounded-full bg-[#febc2e]" />
                  <span className="h-2.5 w-2.5 rounded-full bg-[#28c840]" />
                </span>
                <p className="tfd-muted min-w-0 flex-1 truncate text-center text-xs font-medium">Spice Garden · 3 branches · sample data</p>
                <span className="tfd-ok flex items-center gap-2 text-xs font-semibold">
                  <span className="tfd-live-dot" /> Live
                </span>
              </div>

              <div className="lg:grid lg:grid-cols-[236px_minmax(0,1fr)]">
                <nav aria-label="Demo screens" className="tfd-line hidden border-r p-3 lg:block">
                  <div className="tfd-thin-scroll sticky top-24 max-h-[calc(100dvh-7.5rem)] overflow-y-auto pr-1">
                    <ScreenList current={screen.id} onOpen={open} />
                  </div>
                </nav>

                <div className="min-w-0 p-3 sm:p-5">
                  <div className={cn('mb-4 flex items-start gap-3', OWN_HEADING.has(screen.id) && 'hidden')}>
                    <span className="tfd-btn-primary flex h-10 w-10 shrink-0 items-center justify-center rounded-xl">
                      <screen.icon className="h-5 w-5" aria-hidden />
                    </span>
                    <div>
                      <h3 className="text-lg font-bold leading-tight">{screen.label}</h3>
                      <p className="tfd-muted text-sm">{screen.blurb}</p>
                    </div>
                  </div>

                  <div key={screen.id} className="tfd-fade">
                    <ScreenBody id={screen.id} qr={qr} />
                  </div>
                </div>
              </div>
            </div>
          </section>

          {/* ── What is included ──────────────────────────────────────────── */}
          <section className="mx-auto max-w-6xl px-4 pb-16 sm:px-6">
            <div className="mb-6 text-center">
              <h2 className="text-2xl font-extrabold tracking-tight sm:text-3xl">
                Everything a restaurant needs, <span className="tfd-gradient-text">in one place</span>
              </h2>
              <p className="tfd-muted mt-1 text-sm">No separate apps for orders, stock and accounts.</p>
            </div>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              {FEATURES.map((f) => (
                <div key={f.title} className="tfd-glass rounded-3xl p-4 transition-transform hover:-translate-y-1 sm:p-5">
                  <span className="tfd-btn-primary flex h-10 w-10 items-center justify-center rounded-xl">
                    <f.icon className="h-5 w-5" aria-hidden />
                  </span>
                  <h3 className="mt-3 text-sm font-bold sm:text-base">{f.title}</h3>
                  <p className="tfd-muted mt-1 text-xs sm:text-sm">{f.text}</p>
                </div>
              ))}
            </div>
          </section>

          {/* ── Book a demo ───────────────────────────────────────────────── */}
          <section id="book" className="mx-auto max-w-6xl scroll-mt-24 px-4 pb-24 sm:px-6">
            <div className="tfd-glass-strong grid items-center gap-8 rounded-[2rem] p-6 sm:p-10 md:grid-cols-[1fr_auto]">
              <div>
                <h2 className="text-2xl font-extrabold tracking-tight sm:text-4xl">
                  See it with <span className="tfd-gradient-text">your own menu</span>
                </h2>
                <p className="tfd-muted mt-3 max-w-lg text-sm sm:text-base">
                  Book a free demo and we will set TableFlow up with your dishes, your tables and your branches, so you can see exactly how it fits your restaurant.
                </p>
                <div className="mt-6 flex flex-col gap-3 sm:flex-row">
                  <a href={BOOK_LINK} target="_blank" rel="noopener noreferrer" className="tfd-btn tfd-btn-primary px-6 py-3.5 text-base">
                    <CalendarCheck className="h-5 w-5" aria-hidden /> Book a free demo
                  </a>
                  <a href={CHAT_LINK} target="_blank" rel="noopener noreferrer" className="tfd-btn tfd-btn-wa px-6 py-3.5 text-base">
                    <WhatsAppIcon className="h-5 w-5" /> {WHATSAPP_DISPLAY}
                  </a>
                </div>
              </div>
              <div className="mx-auto text-center">
                <div className="rounded-3xl bg-white p-4 shadow-xl">
                  <QrCode qr={qr} className="h-40 w-40 sm:h-44 sm:w-44" />
                </div>
                <p className="tfd-muted mt-3 text-xs">Scan to open this demo on another phone</p>
                <p className="text-xs font-semibold">{demoUrl.replace(/^https?:\/\//, '')}</p>
              </div>
            </div>
            <p className="tfd-muted mt-6 text-center text-xs">
              © 2026 TableFlow · Smart dining, simplified. All names and figures on this page are sample data.
            </p>
          </section>
        </main>

        {/* Always one tap from a conversation. */}
        <a
          href={CHAT_LINK}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Chat on WhatsApp, ${WHATSAPP_DISPLAY}`}
          className="tfd-btn tfd-btn-wa fixed bottom-5 right-4 z-40 h-14 w-14 sm:right-6"
          style={{ marginBottom: 'env(safe-area-inset-bottom)' }}
        >
          <WhatsAppIcon className="h-7 w-7" />
        </a>

        <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-5 z-50 flex justify-center px-4 pr-20 sm:pr-4">
          {notice ? (
            <div key={notice.id} className={cn('tfd-glass-strong tfd-pop pointer-events-auto flex max-w-md items-start gap-2.5 rounded-2xl px-4 py-3 text-sm font-medium')}>
              <Sparkles className="tfd-brand mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              {notice.message}
            </div>
          ) : null}
        </div>

        {menuOpen ? (
          <Modal title={`All ${ALL_SCREENS.length} screens`} subtitle="The same menu your team sees, in the same order." onClose={() => setMenuOpen(false)}>
            <ScreenList current={screen.id} onOpen={open} />
          </Modal>
        ) : null}

        {/* Dialogs from the demo screens are portalled here: see Modal in ui.tsx. */}
        <div ref={setPortal} />
      </div>
      </PortalProvider>
    </NotifyProvider>
  )
}

// ── The sidebar: every screen of the real dashboard, searchable ─────────────

function ScreenList({ current, onOpen }: { current: string; onOpen: (id: string) => void }) {
  const [query, setQuery] = useState('')
  const q = query.trim().toLowerCase()
  const sections = NAV.map((section) => ({
    ...section,
    items: section.items.filter((item) => q === '' || item.label.toLowerCase().includes(q) || section.title.toLowerCase().includes(q)),
  })).filter((section) => section.items.length > 0)

  return (
    <div role="tablist" aria-label="Demo screens">
      <label className="relative mb-2 block">
        <Search className="tfd-muted pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2" aria-hidden />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={`Search ${ALL_SCREENS.length} screens`}
          aria-label="Search screens"
          className="tfd-input w-full py-1.5 pl-8 pr-2 text-xs"
        />
      </label>
      {sections.map((section) => (
        <div key={section.title} className="mb-2">
          <p className="tfd-muted px-3 pb-1 pt-2 text-[10px] font-bold uppercase tracking-[0.14em]">{section.title}</p>
          {section.items.map((item: DemoScreen) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={item.id === current}
              onClick={() => onOpen(item.id)}
              className="tfd-tab flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-[13px] font-semibold"
            >
              <item.icon className="h-4 w-4 shrink-0" aria-hidden />
              <span className="truncate">{item.label}</span>
            </button>
          ))}
        </div>
      ))}
      {sections.length === 0 ? <p className="tfd-muted px-3 py-4 text-xs">No screen matches that.</p> : null}
    </div>
  )
}

function ScreenBody({ id, qr }: { id: string; qr: QrShape }) {
  switch (id) {
    case 'command':
      return <CommandCenter />
    case 'floor':
      return <LiveFloor />
    case 'qr':
      return <GuestPreview qr={qr} />
    case 'pos':
      return <Pos qr={qr} />
    case 'kitchen':
      return <Kitchen />
    case 'approvals':
      return <Approvals />
    case 'transfers':
      return <Transfers />
    case 'stock':
      return <Stock />
    case 'reports':
      return <ReportsHub />
    case 'sales-report':
      return <SalesReport />
    case 'delivery-report':
      return <DeliveryReport />
    case 'gross-profit':
      return <ProfitReport />
    case 'inventory-report':
      return <InventoryReport />
    case 'purchasing-report':
      return <PurchasingReport />
    case 'cash-drawer-report':
      return <CashDrawerReport />
    case 'petty-cash-report':
      return <PettyCashReport />
    case 'payment-details-report':
      return <PaymentDetailsReport />
    case 'reservations-report':
      return <ReservationsReport />
    case 'tools':
      return <Tools />
    case 'customers':
      return <Customers />
    case 'cash-drawer':
      return <Drawer />
    case 'shift':
      return <Shift />
    case 'delivery':
      return (
        <div className="space-y-6">
          <div>
            <CardTitle icon={Bike}>Orders at the desk</CardTitle>
            <DeliveryDesk />
          </div>
          <div>
            <CardTitle icon={Bike}>Following each delivery</CardTitle>
            <Delivery />
          </div>
        </div>
      )
    default:
      return <GenericScreen id={id} qr={qr} />
  }
}
