'use client'

import * as React from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  ArrowLeft,
  Bell,
  ChevronRight,
  Flame,
  Search,
  ShoppingBag,
  Sparkles,
  Star,
  Timer,
  Utensils,
  X,
} from 'lucide-react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { EmptyState } from '@/components/ui/feedback'
import { Input } from '@/components/ui/input'
import { ThemeToggle } from '@/components/theme-toggle'
import { SpiceLevelIndicator, VegIndicator } from '@/components/ui/status'
import { formatMoney } from '@/lib/money'
import { cn } from '@/lib/utils'
import type { PublicMenu, PublicMenuItem } from '@/features/menu/queries'
import { createServiceRequest } from '../actions'
import { useCart } from '../cart-store'
import { guestPath } from '@/features/orders/guest-path'
import { ItemSheet } from './item-sheet'
import { callAction } from '@/lib/use-action'

type DietFilter = 'ALL' | 'VEG' | 'NON_VEG'

const SERVICE_ACTIONS = [
  { type: 'WATER' as const, label: 'Water', emoji: '💧' },
  { type: 'PLATES' as const, label: 'Extra plates', emoji: '🍽️' },
  { type: 'BILL' as const, label: 'Bring the bill', emoji: '🧾' },
  { type: 'HELP' as const, label: 'Call a waiter', emoji: '🙋' },
]

export function MenuBrowser({
  menu,
  restaurantName,
  logoUrl = null,
  currency,
  locale,
  loyalty,
  slug,
  branchCode,
  branchName = null,
  taxLabel,
}: {
  menu: PublicMenu
  restaurantName: string
  logoUrl?: string | null
  currency: string
  locale: string
  loyalty?: { enabled: boolean; earnRateX100: number; pointValue: number }
  taxLabel?: string | null
  /**
   * Where this guest is, carried in the URL of every screen.
   *
   * These used to be absent: the branch lived in a query parameter on the first
   * page and a cookie thereafter, so every link below dropped it and a stale
   * cookie silently substituted the default branch.
   */
  slug: string
  branchCode: string
  /** Shown when the restaurant has more than one place to order from. */
  branchName?: string | null
}) {
  const router = useRouter()
  const { state, itemCount, subtotal, hydrated } = useCart()
  const [search, setSearch] = React.useState('')
  const [category, setCategory] = React.useState<string>('ALL')
  const [diet, setDiet] = React.useState<DietFilter>('ALL')
  const [active, setActive] = React.useState<PublicMenuItem | null>(null)
  const [liveOrder, setLiveOrder] = React.useState<{ id: string; orderNumber: string } | null>(null)

  React.useEffect(() => {
    try {
      const raw = window.localStorage.getItem('ros:last-order')
      if (!raw) return
      const parsed = JSON.parse(raw) as { id?: string; orderId?: string; orderNumber?: string } | null
      const orderId = parsed?.orderId ?? parsed?.id
      if (orderId && parsed?.orderNumber) setLiveOrder({ id: orderId, orderNumber: parsed.orderNumber })
    } catch {
      // Ignore invalid cached state.
    }
  }, [])

  // Without a table the guest has skipped the entry screen — send them back.
  React.useEffect(() => {
    if (hydrated && !state.table) router.replace(guestPath(slug, branchCode))
  }, [hydrated, state.table, router])

  const filtered = React.useMemo(() => {
    const query = search.trim().toLowerCase()
    return menu.items.filter((item) => {
      if (category !== 'ALL' && item.categoryId !== category) return false
      if (diet === 'VEG' && !item.isVeg) return false
      if (diet === 'NON_VEG' && item.isVeg) return false
      if (!query) return true
      return (
        item.name.toLowerCase().includes(query) ||
        item.description?.toLowerCase().includes(query) ||
        item.tags.some((tag) => tag.toLowerCase().includes(query))
      )
    })
  }, [menu.items, search, category, diet])

  const grouped = React.useMemo(() => {
    const byCategory = new Map<string, PublicMenuItem[]>()
    for (const item of filtered) {
      const list = byCategory.get(item.categoryId) ?? []
      list.push(item)
      byCategory.set(item.categoryId, list)
    }
    return menu.categories
      .filter((entry) => byCategory.has(entry.id))
      .map((entry) => ({ category: entry, items: byCategory.get(entry.id) ?? [] }))
  }, [filtered, menu.categories])

  const recommended = React.useMemo(
    () =>
      menu.items
        .filter((item) => (item.isRecommended || item.isPopular) && item.isAvailable)
        .slice(0, 10),
    [menu.items],
  )

  const showRecommended = !search && category === 'ALL' && diet === 'ALL' && recommended.length > 0

  // The per-category headings stick *below* the main header. Measure the header
  // instead of hard-coding its height: it changes with the device font size,
  // whether a tagline is present, and how the filter chips wrap.
  const headerRef = React.useRef<HTMLElement | null>(null)
  const [headerHeight, setHeaderHeight] = React.useState(152)

  React.useEffect(() => {
    const node = headerRef.current
    if (!node) return
    const observer = new ResizeObserver(([entry]) => {
      setHeaderHeight(Math.round(entry.contentRect.height))
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  return (
    <div className="guest-ink flex min-h-dvh flex-col pb-28">
      {/* Glass chrome over the restaurant's own cover photo (see BrandTheme). */}
      <header
        ref={headerRef}
        className="guest-chrome sticky top-0 z-30 border-b"
      >
        <div className="flex items-center gap-2.5 px-4 py-3">
          <Link
            href={guestPath(slug, branchCode)}
            aria-label="Back"
            className="guest-control flex size-9 shrink-0 items-center justify-center rounded-xl border transition-opacity active:opacity-70"
          >
            <ArrowLeft className="size-4" />
          </Link>

          {logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={logoUrl}
              alt=""
              className="size-9 shrink-0 rounded-xl border border-black/10 object-cover dark:border-white/20"
            />
          ) : null}

          <div className="min-w-0 flex-1">
            <p className="guest-ink truncate text-sm font-semibold leading-tight">{restaurantName}</p>
            {/*
              The branch, named. This header never said which location it was
              showing, so a guest browsing the wrong branch's menu at the wrong
              branch's prices had nothing on screen to tell them — and neither
              did an owner testing their own QR codes.
            */}
            {branchName || state.table ? (
              <p className="guest-ink-muted truncate text-xs">
                {branchName}
                {branchName && state.table ? ' · ' : ''}
                {state.table ? `Table ${state.table.tableNumber}` : ''}
                {state.table?.label ? ` · ${state.table.label}` : ''}
              </p>
            ) : null}
          </div>

          <ThemeToggle className="guest-ink shrink-0 hover:bg-black/5 dark:hover:bg-white/10" />
          <ServiceRequestDialog
            tableId={state.table?.tableId ?? null}
            // The branch the guest scanned, checked server-side against the
            // table — a call bell must ring in the room the guest is sitting in.
            branchCode={state.table?.branchCode ?? null}
          />
        </div>

        <div className="px-4 pb-3">
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search the menu…"
            startIcon={<Search />}
            endIcon={
              search ? (
                <button type="button" onClick={() => setSearch('')} aria-label="Clear search">
                  <X className="size-4" />
                </button>
              ) : undefined
            }
            className="guest-control h-11 rounded-xl border focus-visible:ring-[rgb(var(--brand-r),var(--brand-g),var(--brand-b))]"
          />
        </div>

        <div className="no-scrollbar flex gap-2 overflow-x-auto px-4 pb-3">
          <Chip active={diet === 'VEG'} onClick={() => setDiet(diet === 'VEG' ? 'ALL' : 'VEG')}>
            <span className="text-emerald-400">●</span> Veg
          </Chip>
          <Chip
            active={diet === 'NON_VEG'}
            onClick={() => setDiet(diet === 'NON_VEG' ? 'ALL' : 'NON_VEG')}
          >
            <span className="text-red-400">●</span> Non-veg
          </Chip>
          <span className="guest-divider my-1 w-px shrink-0" />
          <Chip active={category === 'ALL'} onClick={() => setCategory('ALL')}>
            All
          </Chip>
          {menu.categories.map((entry) => (
            <Chip
              key={entry.id}
              active={category === entry.id}
              onClick={() => setCategory(entry.id)}
            >
              {entry.icon ? <span>{entry.icon}</span> : null}
              {entry.name}
            </Chip>
          ))}
        </div>
      </header>

      <main className="flex-1">
        {liveOrder ? (
          <div className="mx-4 mt-4">
            <Button asChild className="w-full justify-center gap-2 rounded-xl">
              <Link href={`/order/track/${liveOrder.id}`}>
                <span className="text-base">📡</span> Live order {liveOrder.orderNumber}
              </Link>
            </Button>
          </div>
        ) : null}

        {/*
          Stays on screen while they browse. The toast at table entry is easy to
          miss, and this is the kind of thing a guest should be able to re-read
          before they commit to an order rather than discover on the bill.
        */}
        {state.table?.openBill ? (
          <div className="guest-surface mx-4 mt-4 flex items-start gap-3 rounded-2xl border p-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-amber-500/15 text-lg">
              🧾
            </span>
            <div className="min-w-0 text-xs leading-snug">
              <p className="guest-ink font-semibold">
                Table {state.table.tableNumber} already has an open bill
              </p>
              <p className="guest-ink-muted">
                {state.table.openBill.itemCount} item
                {state.table.openBill.itemCount === 1 ? '' : 's'} ·{' '}
                {formatMoney(state.table.openBill.outstanding, currency, locale)} unpaid. Anything
                you add joins this bill. Ask our staff if this is not your table.
              </p>
            </div>
          </div>
        ) : null}

        {loyalty?.enabled && loyalty.earnRateX100 > 0 ? (
          <div
            className="mx-4 mt-4 flex items-center gap-3 rounded-2xl border p-3 backdrop-blur-xl"
            style={{
              borderColor: 'rgba(var(--brand-r),var(--brand-g),var(--brand-b),0.35)',
              backgroundColor: 'rgba(var(--brand-r),var(--brand-g),var(--brand-b),0.12)',
            }}
          >
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-black/5 text-lg dark:bg-white/10">
              🎁
            </span>
            <div className="min-w-0 text-xs leading-snug">
              <p className="guest-ink font-semibold">
                Earn {formatPoints(loyalty.earnRateX100 / 100)}{' '}
                {loyalty.earnRateX100 === 100 ? 'point' : 'points'} for every {currency} 1 you spend
              </p>
              <p className="guest-ink-muted">
                Collect points on every order
                {loyalty.pointValue > 0 ? ` and redeem them for ${currency} off future visits` : ''}.
              </p>
            </div>
          </div>
        ) : null}

        {showRecommended ? (
          <section className="py-5">
            <div className="mb-3 flex items-center gap-2.5 px-4">
              <span
                className="flex size-8 shrink-0 items-center justify-center rounded-xl text-white shadow-lg"
                style={{ backgroundColor: 'rgb(var(--brand-r),var(--brand-g),var(--brand-b))' }}
              >
                <Sparkles className="size-4" />
              </span>
              <div>
                <h2 className="guest-ink text-sm font-bold leading-tight">
                  Chef&rsquo;s picks &amp; favourites
                </h2>
                <p className="guest-ink-muted text-[11px]">Our guests love these — tap to add</p>
              </div>
            </div>
            <div className="no-scrollbar flex gap-3 overflow-x-auto px-4 pb-1">
              {recommended.map((item, index) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setActive(item)}
                  style={{ animationDelay: `${index * 70}ms` }}
                  className="guest-surface group w-44 shrink-0 animate-fade-up overflow-hidden rounded-2xl border text-left transition-transform active:scale-[0.97]"
                >
                  <div className="relative h-28 overflow-hidden bg-black/[0.04] dark:bg-white/[0.06]">
                    {item.imageUrl ? (
                      <Image
                        src={item.imageUrl}
                        alt={item.name}
                        fill
                        sizes="176px"
                        className="object-cover transition-transform duration-500 group-hover:scale-110"
                      />
                    ) : (
                      <span
                        className="flex size-full items-center justify-center"
                        style={{ color: 'rgba(var(--brand-r),var(--brand-g),var(--brand-b),0.75)' }}
                      >
                        <Utensils className="size-7" />
                      </span>
                    )}
                    <span
                      className="absolute left-2 top-2 rounded-full bg-white/90 px-2 py-0.5 text-[10px] font-bold shadow-soft backdrop-blur"
                      style={{ color: 'rgb(var(--brand-r),var(--brand-g),var(--brand-b))' }}
                    >
                      {item.isPopular ? '🔥 Popular' : '⭐ Chef’s pick'}
                    </span>
                    <span className="absolute bottom-2 right-2 rounded-lg bg-black/65 px-2 py-0.5 text-xs font-bold text-white backdrop-blur">
                      {formatMoney(item.price, currency, locale)}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5 p-2.5">
                    <VegIndicator isVeg={item.isVeg} />
                    <p className="guest-ink line-clamp-1 text-sm font-semibold">{item.name}</p>
                  </div>
                </button>
              ))}
            </div>
          </section>
        ) : null}

        {grouped.length === 0 ? (
          <EmptyState
            className="m-4"
            icon={<Search />}
            title="Nothing matched"
            description={
              search
                ? `We could not find anything for “${search}”. Try a different word.`
                : 'No items match these filters right now.'
            }
            action={
              <Button
                variant="outline"
                onClick={() => {
                  setSearch('')
                  setCategory('ALL')
                  setDiet('ALL')
                }}
              >
                Clear filters
              </Button>
            }
          />
        ) : (
          grouped.map(({ category: entry, items }) => (
            <section key={entry.id}>
              <div
                style={{ top: headerHeight }}
                className="guest-chrome sticky z-10 px-4 py-2.5"
              >
                <h2 className="guest-ink-muted text-xs font-bold uppercase tracking-[0.14em]">
                  {entry.name}
                  <span className="guest-ink-faint ml-2 font-normal normal-case">{items.length}</span>
                </h2>
              </div>

              <ul className="space-y-2.5 px-4 py-3">
                {items.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      onClick={() => item.isAvailable && setActive(item)}
                      disabled={!item.isAvailable}
                      className={cn(
                        'guest-surface flex w-full items-start gap-3 rounded-2xl border p-3 text-left transition-all',
                        item.isAvailable
                          ? 'active:scale-[0.985] active:opacity-80'
                          : 'cursor-not-allowed opacity-45',
                      )}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <VegIndicator isVeg={item.isVeg} />
                          {item.isPopular ? (
                            <Badge variant="warning" size="sm">
                              <Star className="fill-current" /> Popular
                            </Badge>
                          ) : null}
                          {item.priceReason === 'happy-hour' ? (
                            <Badge variant="destructive" size="sm">
                              <Flame /> Happy hour
                            </Badge>
                          ) : null}
                        </div>

                        <h3 className="guest-ink mt-1 text-[15px] font-semibold leading-tight">
                          {item.name}
                        </h3>

                        <div className="mt-1 flex items-center gap-2">
                          <span
                            className="text-[15px] font-bold"
                            style={{ color: 'rgb(var(--brand-r),var(--brand-g),var(--brand-b))' }}
                          >
                            {formatMoney(item.price, currency, locale)}
                          </span>
                          {item.compareAt ? (
                            <span className="guest-ink-faint text-xs line-through">
                              {formatMoney(item.compareAt, currency, locale)}
                            </span>
                          ) : null}
                        </div>

                        {item.description ? (
                          <p className="guest-ink-muted mt-1.5 line-clamp-2 text-xs leading-relaxed">
                            {item.description}
                          </p>
                        ) : null}

                        <div className="guest-ink-muted mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
                          <span className="flex items-center gap-1">
                            <Timer className="size-3" /> {item.prepTimeMinutes} min
                          </span>
                          <SpiceLevelIndicator level={item.spiceLevel} />
                          {item.rating ? (
                            <span className="flex items-center gap-0.5">
                              <Star className="size-3 fill-warning text-warning" />
                              {item.rating.toFixed(1)}
                              <span className="opacity-60">({item.ratingCount})</span>
                            </span>
                          ) : null}
                          {!item.isAvailable ? (
                            <span className="font-semibold text-red-400">Sold out</span>
                          ) : null}
                        </div>
                      </div>

                      <div className="guest-surface relative size-24 shrink-0 overflow-hidden rounded-xl border">
                        {item.imageUrl ? (
                          <Image
                            src={item.imageUrl}
                            alt={item.name}
                            fill
                            sizes="96px"
                            className="object-cover"
                          />
                        ) : (
                          <span
                            className="flex size-full flex-col items-center justify-center gap-0.5"
                            style={{ color: 'rgba(var(--brand-r),var(--brand-g),var(--brand-b),0.75)' }}
                          >
                            <Utensils className="size-6" />
                            <span className="text-[9px] font-medium uppercase tracking-wide">Photo soon</span>
                          </span>
                        )}
                        {item.isAvailable ? (
                          <span
                            className="absolute bottom-1 right-1 rounded-lg px-2 py-0.5 text-[11px] font-bold text-white shadow-lg"
                            style={{
                              backgroundColor: 'rgb(var(--brand-r),var(--brand-g),var(--brand-b))',
                            }}
                          >
                            ADD
                          </span>
                        ) : null}
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}
      </main>

      {itemCount > 0 ? (
        <div className="fixed inset-x-0 bottom-0 z-40 mx-auto max-w-lg p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <Link
            href={guestPath(slug, branchCode, 'cart')}
            style={{
              backgroundColor: 'rgb(var(--brand-r),var(--brand-g),var(--brand-b))',
              boxShadow: '0 12px 34px rgba(var(--brand-r),var(--brand-g),var(--brand-b),0.45)',
            }}
            className="flex items-center gap-3 rounded-2xl px-4 py-3.5 text-white transition-transform active:scale-[0.99]"
          >
            <span className="relative flex size-9 items-center justify-center rounded-xl bg-white/20">
              <ShoppingBag className="size-4.5" />
              <span
                className="absolute -right-1 -top-1 flex size-5 items-center justify-center rounded-full bg-white text-[11px] font-bold"
                style={{ color: 'rgb(var(--brand-r),var(--brand-g),var(--brand-b))' }}
              >
                {itemCount}
              </span>
            </span>
            <span className="flex-1">
              <span className="block text-xs opacity-90">
                {itemCount} item{itemCount > 1 ? 's' : ''} in your order
              </span>
              <span className="block text-base font-bold">
                {formatMoney(subtotal, currency, locale)}
              </span>
            </span>
            <span className="flex items-center gap-1 text-sm font-semibold">
              View cart <ChevronRight className="size-4" />
            </span>
          </Link>
        </div>
      ) : null}

      <ItemSheet
        item={active}
        currency={currency}
        locale={locale}
        onOpenChange={(open) => !open && setActive(null)}
      />
    </div>
  )
}

/** Trim trailing zeros so "1.0" reads as "1" and "0.50" as "0.5". */
function formatPoints(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.?0+$/, '')
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={
        active
          ? {
              backgroundColor: 'rgb(var(--brand-r),var(--brand-g),var(--brand-b))',
              borderColor: 'rgb(var(--brand-r),var(--brand-g),var(--brand-b))',
              boxShadow: '0 6px 20px rgba(var(--brand-r),var(--brand-g),var(--brand-b),0.35)',
            }
          : undefined
      }
      className={cn(
        'flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3.5 py-1.5 text-sm font-medium transition-all active:scale-95',
        active
          ? 'border-transparent text-white'
          : 'guest-control border',
      )}
    >
      {children}
    </button>
  )
}

function ServiceRequestDialog({
  tableId,
  branchCode,
}: {
  tableId: string | null
  branchCode: string | null
}) {
  const [open, setOpen] = React.useState(false)
  const [pending, startTransition] = React.useTransition()

  if (!tableId) return null

  const request = (type: (typeof SERVICE_ACTIONS)[number]['type']) => {
    startTransition(async () => {
      const result = await callAction(() =>
        createServiceRequest({ tableId, type }, undefined, branchCode),
      )
      if (result.ok) {
        toast.success('Our staff have been notified')
        setOpen(false)
      } else {
        toast.error(result.error)
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {/* Glass, not the default outline button — this sits on the dark chrome. */}
        <button
          type="button"
          className="guest-control flex shrink-0 items-center gap-1.5 rounded-xl border px-3 py-2 text-sm font-medium transition-opacity active:opacity-70"
        >
          <Bell className="size-3.5" /> Call
        </button>
      </DialogTrigger>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>How can we help?</DialogTitle>
          <DialogDescription>A team member will be with you shortly.</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-2">
          {SERVICE_ACTIONS.map((action) => (
            <button
              key={action.type}
              type="button"
              disabled={pending}
              onClick={() => request(action.type)}
              className="flex flex-col items-center gap-2 rounded-xl border p-4 transition-colors hover:border-primary hover:bg-primary/5 disabled:opacity-50"
            >
              <span className="text-2xl">{action.emoji}</span>
              <span className="text-sm font-medium">{action.label}</span>
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
