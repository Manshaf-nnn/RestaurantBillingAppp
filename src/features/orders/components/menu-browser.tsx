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
import { SpiceLevelIndicator, VegIndicator } from '@/components/ui/status'
import { formatMoney } from '@/lib/money'
import { cn } from '@/lib/utils'
import type { PublicMenu, PublicMenuItem } from '@/features/menu/queries'
import { createServiceRequest } from '../actions'
import { useCart } from '../cart-store'
import { ItemSheet } from './item-sheet'

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
  currency,
  locale,
  loyalty,
}: {
  menu: PublicMenu
  restaurantName: string
  currency: string
  locale: string
  loyalty?: { enabled: boolean; earnRateX100: number; pointValue: number }
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
    if (hydrated && !state.table) router.replace('/order')
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
    <div className="flex min-h-dvh flex-col pb-24">
      <header
        ref={headerRef}
        className="sticky top-0 z-30 border-b bg-background/90 backdrop-blur-xl"
      >
        <div className="flex items-center gap-2 px-4 py-3">
          <Button variant="ghost" size="icon-sm" asChild aria-label="Back">
            <Link href="/order">
              <ArrowLeft />
            </Link>
          </Button>

          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold leading-tight">{restaurantName}</p>
            {state.table ? (
              <p className="text-xs text-muted-foreground">
                Table {state.table.tableNumber}
                {state.table.label ? ` · ${state.table.label}` : ''}
              </p>
            ) : null}
          </div>

          <ServiceRequestDialog tableId={state.table?.tableId ?? null} />
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
            className="h-11 rounded-xl bg-muted/50"
          />
        </div>

        <div className="no-scrollbar flex gap-2 overflow-x-auto px-4 pb-3">
          <Chip active={diet === 'VEG'} onClick={() => setDiet(diet === 'VEG' ? 'ALL' : 'VEG')}>
            <span className="text-success">●</span> Veg
          </Chip>
          <Chip
            active={diet === 'NON_VEG'}
            onClick={() => setDiet(diet === 'NON_VEG' ? 'ALL' : 'NON_VEG')}
          >
            <span className="text-destructive">●</span> Non-veg
          </Chip>
          <span className="my-1 w-px shrink-0 bg-border" />
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

        {loyalty?.enabled && loyalty.earnRateX100 > 0 ? (
          <div className="mx-4 mt-4 flex items-center gap-3 rounded-xl border border-primary/20 bg-primary/5 p-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-lg">
              🎁
            </span>
            <div className="min-w-0 text-xs leading-snug">
              <p className="font-semibold text-foreground">
                Earn {formatPoints(loyalty.earnRateX100 / 100)}{' '}
                {loyalty.earnRateX100 === 100 ? 'point' : 'points'} for every {currency} 1 you spend
              </p>
              <p className="text-muted-foreground">
                Collect points on every order
                {loyalty.pointValue > 0 ? ` and redeem them for ${currency} off future visits` : ''}.
              </p>
            </div>
          </div>
        ) : null}

        {showRecommended ? (
          <section className="border-b bg-gradient-to-b from-primary/[0.07] to-transparent py-5">
            <div className="mb-3 flex items-center gap-2.5 px-4">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-primary to-chart-5 text-white shadow-soft">
                <Sparkles className="size-4" />
              </span>
              <div>
                <h2 className="text-sm font-bold leading-tight">Chef&rsquo;s picks &amp; favourites</h2>
                <p className="text-[11px] text-muted-foreground">Our guests love these — tap to add</p>
              </div>
            </div>
            <div className="no-scrollbar flex gap-3 overflow-x-auto px-4 pb-1">
              {recommended.map((item, index) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setActive(item)}
                  style={{ animationDelay: `${index * 70}ms` }}
                  className="group w-44 shrink-0 animate-fade-up overflow-hidden rounded-2xl border border-primary/15 bg-card text-left shadow-soft ring-1 ring-black/5 transition-transform active:scale-[0.97]"
                >
                  <div className="relative h-28 overflow-hidden bg-gradient-to-br from-amber-50 to-orange-100">
                    {item.imageUrl ? (
                      <Image
                        src={item.imageUrl}
                        alt={item.name}
                        fill
                        sizes="176px"
                        className="object-cover transition-transform duration-500 group-hover:scale-110"
                      />
                    ) : (
                      <span className="flex size-full items-center justify-center text-orange-400">
                        <Utensils className="size-7" />
                      </span>
                    )}
                    <span className="absolute left-2 top-2 rounded-full bg-white/90 px-2 py-0.5 text-[10px] font-bold text-primary shadow-soft backdrop-blur">
                      {item.isPopular ? '🔥 Popular' : '⭐ Chef’s pick'}
                    </span>
                    <span className="absolute bottom-2 right-2 rounded-lg bg-black/65 px-2 py-0.5 text-xs font-bold text-white backdrop-blur">
                      {formatMoney(item.price, currency, locale)}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5 p-2.5">
                    <VegIndicator isVeg={item.isVeg} />
                    <p className="line-clamp-1 text-sm font-semibold">{item.name}</p>
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
            <section key={entry.id} className="border-b last:border-b-0">
              <div
                style={{ top: headerHeight }}
                className="sticky z-10 bg-background/90 px-4 py-2.5 backdrop-blur"
              >
                <h2 className="text-sm font-bold uppercase tracking-wide text-muted-foreground">
                  {entry.name}
                  <span className="ml-2 font-normal normal-case">{items.length}</span>
                </h2>
              </div>

              <ul className="divide-y">
                {items.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      onClick={() => item.isAvailable && setActive(item)}
                      disabled={!item.isAvailable}
                      className={cn(
                        'flex w-full items-start gap-3 px-4 py-4 text-left transition-colors',
                        item.isAvailable ? 'active:bg-muted/50' : 'cursor-not-allowed opacity-55',
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

                        <h3 className="mt-1 text-[15px] font-semibold leading-tight">{item.name}</h3>

                        <div className="mt-1 flex items-center gap-2">
                          <span className="text-[15px] font-semibold">
                            {formatMoney(item.price, currency, locale)}
                          </span>
                          {item.compareAt ? (
                            <span className="text-xs text-muted-foreground line-through">
                              {formatMoney(item.compareAt, currency, locale)}
                            </span>
                          ) : null}
                        </div>

                        {item.description ? (
                          <p className="mt-1.5 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                            {item.description}
                          </p>
                        ) : null}

                        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
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
                            <span className="font-medium text-destructive">Sold out</span>
                          ) : null}
                        </div>
                      </div>

                      <div className="relative size-24 shrink-0 overflow-hidden rounded-xl bg-gradient-to-br from-amber-50 to-orange-100 ring-1 ring-black/5">
                        {item.imageUrl ? (
                          <Image
                            src={item.imageUrl}
                            alt={item.name}
                            fill
                            sizes="96px"
                            className="object-cover"
                          />
                        ) : (
                          <span className="flex size-full flex-col items-center justify-center gap-0.5 text-orange-400">
                            <Utensils className="size-6" />
                            <span className="text-[9px] font-medium uppercase tracking-wide">Photo soon</span>
                          </span>
                        )}
                        {item.isAvailable ? (
                          <span className="absolute bottom-1 right-1 rounded-lg bg-background px-2 py-0.5 text-[11px] font-bold text-primary shadow-soft">
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
            href="/order/cart"
            className="flex items-center gap-3 rounded-2xl bg-primary px-4 py-3.5 text-primary-foreground shadow-elevated transition-transform active:scale-[0.99]"
          >
            <span className="relative flex size-9 items-center justify-center rounded-xl bg-white/20">
              <ShoppingBag className="size-4.5" />
              <span className="absolute -right-1 -top-1 flex size-5 items-center justify-center rounded-full bg-background text-[11px] font-bold text-primary">
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
      className={cn(
        'flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3.5 py-1.5 text-sm font-medium transition-all active:scale-95',
        active
          ? 'border-primary bg-primary text-primary-foreground shadow-soft'
          : 'bg-background hover:bg-muted',
      )}
    >
      {children}
    </button>
  )
}

function ServiceRequestDialog({ tableId }: { tableId: string | null }) {
  const [open, setOpen] = React.useState(false)
  const [pending, startTransition] = React.useTransition()

  if (!tableId) return null

  const request = (type: (typeof SERVICE_ACTIONS)[number]['type']) => {
    startTransition(async () => {
      const result = await createServiceRequest({ tableId, type })
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
        <Button variant="outline" size="sm" className="shrink-0 gap-1.5">
          <Bell className="size-3.5" /> Call
        </Button>
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
