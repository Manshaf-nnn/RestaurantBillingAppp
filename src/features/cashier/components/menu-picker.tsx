'use client'

import * as React from 'react'
import Image from 'next/image'
import { Search, UtensilsCrossed } from 'lucide-react'

import { Input } from '@/components/ui/input'
import type { PublicMenu, PublicMenuItem } from '@/features/menu/queries'
import { priceRange } from '@/features/menu/variant-pricing'

/**
 * The menu, as a grid of photographs you tap to add.
 *
 * ── Why this is its own component ───────────────────────────────────────────
 *
 * There were two menus in this app and one of them was much worse. The POS at
 * /cashier/pos showed photographs and made the whole card a button. The "New
 * takeaway" dialog on /cashier showed the same dishes as plain text rows with
 * no photograph, and the card was not clickable at all — the only targets were
 * two 32px ± buttons, beside a word "Add" that was a `<span>` and did nothing
 * when you pressed it.
 *
 * Both were fed by the SAME `getPublicMenu` call, and the dialog already
 * received `imageUrl` on every item. It simply never read the field. So the
 * fix was never "add images to the dialog" — it was to stop having two
 * answers to one question. Both screens now render this, and a change to how
 * dishes are picked can only happen in one place.
 *
 * ── What it owns, and what it does not ──────────────────────────────────────
 *
 * The grid, the search box and the category strip. Not the cart, not the
 * customer fields, not the submit — a full page and a modal want different
 * framing around the same picker, and folding their layouts in here would make
 * it serve neither well.
 *
 * ── Two layouts, because two people are using it ────────────────────────────
 *
 * `grid` is photographs, for a cashier who may not know every dish and is
 * aiming at a card across a counter. `list` is dense rows, for a WAITER on a
 * phone: they already know the menu, they are standing at a table, and what
 * they need is many dishes on one screen and a thumb-sized target — not four
 * large photographs and a scroll. The photo grid on a 390px phone showed two
 * dishes at a time, which is a scroll for every course.
 */

/** How the dishes are laid out. See the note above. */
export type MenuPickerLayout = 'grid' | 'list'

export function MenuPicker({
  menu,
  quantityOf,
  onAdd,
  money,
  /** Tighter grid and a scroll cap, for use inside a dialog. */
  compact = false,
  layout = 'grid',
}: {
  menu: PublicMenu
  quantityOf: (foodId: string) => number
  onAdd: (item: PublicMenuItem) => void
  money: (minor: number) => string
  compact?: boolean
  layout?: MenuPickerLayout
}) {
  const [categoryId, setCategoryId] = React.useState<string | null>(null)
  const [search, setSearch] = React.useState('')

  const visible = React.useMemo(() => {
    const term = search.trim().toLowerCase()
    return menu.items.filter((item) => {
      if (!item.isAvailable) return false
      if (categoryId && item.categoryId !== categoryId) return false
      if (!term) return true
      /*
       * Name, code, then description — in that order of intent.
       *
       * The code match is deliberately a PREFIX, not a substring. Codes are
       * short and numeric-ish, so `includes` on "12" would surface B12, C120
       * and every dish whose description mentions 12 — which is the opposite
       * of what typing a code is for. Somebody entering a code wants that one
       * dish, and wants it first.
       */
      const code = item.code?.toLowerCase()
      return (
        item.name.toLowerCase().includes(term) ||
        (code ? code.startsWith(term) : false) ||
        (item.description?.toLowerCase().includes(term) ?? false)
      )
    })
  }, [menu.items, categoryId, search])

  /*
   * An exact code match jumps to the front. A waiter who types the number off
   * the printed menu should not then have to find it among the dishes whose
   * names happen to contain those characters.
   */
  const ordered = React.useMemo(() => {
    const term = search.trim().toLowerCase()
    if (!term) return visible
    const exact = visible.filter((item) => item.code?.toLowerCase() === term)
    if (exact.length === 0) return visible
    const rest = visible.filter((item) => item.code?.toLowerCase() !== term)
    return [...exact, ...rest]
  }, [visible, search])

  return (
    <div className="space-y-3">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          className="pl-9"
          placeholder="Search by name or code"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <div className="no-scrollbar -mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
        <Chip active={categoryId === null} onClick={() => setCategoryId(null)}>
          All
        </Chip>
        {menu.categories.map((category) => (
          <Chip
            key={category.id}
            active={categoryId === category.id}
            onClick={() => setCategoryId(category.id)}
          >
            {category.name}
          </Chip>
        ))}
      </div>

      {ordered.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
          Nothing matches that.
        </div>
      ) : layout === 'list' ? (
        /*
         * One column on a phone, two on a tablet, three on a wide screen. The
         * rows are short enough that a phone shows eight or nine dishes at
         * once where the photo grid showed two.
         */
        <div className="grid gap-1.5 sm:grid-cols-2 xl:grid-cols-3">
          {ordered.map((item) => (
            <FoodRow
              key={item.id}
              item={item}
              quantity={quantityOf(item.id)}
              money={money}
              onAdd={() => onAdd(item)}
            />
          ))}
        </div>
      ) : (
        <div
          className={
            compact
              ? 'grid max-h-[26rem] grid-cols-2 gap-2.5 overflow-y-auto pr-1 sm:grid-cols-3'
              : 'grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5'
          }
        >
          {ordered.map((item) => (
            <FoodCard
              key={item.id}
              item={item}
              quantity={quantityOf(item.id)}
              money={money}
              onAdd={() => onAdd(item)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * One dish as a row — the waiter's layout.
 *
 * No photograph. A waiter knows what the food looks like; what they need is
 * the name, the code they may have been told, the price, and a target big
 * enough to hit while holding a tray. The whole row is the button, for the
 * same reason the whole card is in the grid.
 *
 * `min-h-11` keeps every row at least 44px tall, which is the smallest thing
 * a thumb reliably hits — the reason this is not simply a table of text.
 */
function FoodRow({
  item,
  quantity,
  money,
  onAdd,
}: {
  item: PublicMenuItem
  quantity: number
  money: (minor: number) => string
  onAdd: () => void
}) {
  const range = priceRange(item.price, item.groups)

  return (
    <button
      type="button"
      onClick={onAdd}
      aria-label={`Add ${item.name}, ${money(item.price)}`}
      className="flex min-h-11 w-full items-center gap-2 rounded-lg border border-border bg-card px-2.5 py-2 text-left transition hover:border-primary/50 hover:bg-muted active:scale-[0.99]"
    >
      {item.code ? (
        <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] font-semibold text-muted-foreground">
          {item.code}
        </span>
      ) : null}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium leading-tight">{item.name}</span>
        {range.sizeCount > 0 ? (
          <span className="block text-[11px] text-muted-foreground">{range.sizeCount} sizes</span>
        ) : null}
      </span>
      <span className="shrink-0 text-sm font-semibold tabular-nums text-primary">
        {range.sizeCount > 0 ? `from ${money(range.from)}` : money(item.price)}
      </span>
      {quantity > 0 ? (
        <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
          {quantity}
        </span>
      ) : null}
    </button>
  )
}

/**
 * One dish.
 *
 * The whole card is the button. That is the point of it — a cashier with a
 * queue in front of them should be aiming at a 150px photograph, not at a 32px
 * plus sign, and certainly not at a label that looks like a button and is not
 * one.
 */
function FoodCard({
  item,
  quantity,
  money,
  onAdd,
}: {
  item: PublicMenuItem
  quantity: number
  money: (minor: number) => string
  onAdd: () => void
}) {
  const range = priceRange(item.price, item.groups)

  return (
    <button
      type="button"
      onClick={onAdd}
      aria-label={`Add ${item.name}, ${money(item.price)}`}
      className="group relative overflow-hidden rounded-xl border border-border bg-card text-left transition hover:border-primary/50 hover:shadow-md active:scale-[0.98]"
    >
      <div className="relative aspect-[4/3] w-full bg-muted">
        {item.imageUrl ? (
          <Image
            src={item.imageUrl}
            alt={item.name}
            fill
            sizes="(max-width: 640px) 50vw, (max-width: 1280px) 33vw, 25vw"
            className="object-cover"
          />
        ) : (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            <UtensilsCrossed className="h-8 w-8" />
          </div>
        )}
        {quantity > 0 && (
          <span className="absolute right-2 top-2 flex h-7 min-w-7 items-center justify-center rounded-full bg-primary px-2 text-sm font-semibold text-primary-foreground shadow">
            {quantity}
          </span>
        )}
      </div>
      <div className="p-2.5">
        {item.code ? (
          <p className="mb-0.5 font-mono text-[11px] font-semibold text-muted-foreground">
            {item.code}
          </p>
        ) : null}
        <p className="line-clamp-2 text-sm font-medium leading-snug">{item.name}</p>
        {/*
          A cashier needs the same warning a guest does: this dish is going to
          ask a question. Without it, tapping a dish opens a dialog seemingly at
          random.
        */}
        <p className="mt-1 text-sm font-semibold tabular-nums text-primary">
          {range.sizeCount > 0 ? `from ${money(range.from)}` : money(item.price)}
        </p>
        {range.sizeCount > 0 ? (
          <p className="text-xs text-muted-foreground">{range.sizeCount} sizes</p>
        ) : null}
      </div>
    </button>
  )
}

function Chip({
  children,
  active,
  onClick,
}: {
  children: React.ReactNode
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`shrink-0 rounded-full border px-3.5 py-1.5 text-sm transition ${
        active
          ? 'border-primary bg-primary text-primary-foreground'
          : 'border-border bg-card hover:bg-muted'
      }`}
    >
      {children}
    </button>
  )
}

/**
 * − / + for a cart line.
 *
 * Shared with the callers because both order panels step quantities the same
 * way, and both replace the minus with a bin at one so the last tap reads as
 * "remove" rather than "subtract into nothing".
 */
export function StepButton({
  children,
  label,
  onClick,
}: {
  children: React.ReactNode
  label: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-background text-foreground transition hover:bg-muted active:scale-95"
    >
      {children}
    </button>
  )
}

/**
 * The four ways an order can be taken.
 *
 * Exported so the POS page and the cashier dialog offer the same set — the
 * dialog used to hard-code TAKEAWAY, which is why a cashier wanting to ring up
 * a delivery had to leave the bill queue and go to another screen.
 */
export type OrderType = 'DINE_IN' | 'TAKEAWAY' | 'DELIVERY' | 'COUNTER'

export const ORDER_TYPES: Array<{ value: OrderType; label: string; hint: string }> = [
  { value: 'DINE_IN', label: 'Dine in', hint: 'Ordered at the counter, eating at a table' },
  { value: 'COUNTER', label: 'Counter', hint: 'Walk-in paying at the till' },
  { value: 'TAKEAWAY', label: 'Takeaway', hint: 'Collected later' },
  { value: 'DELIVERY', label: 'Delivery', hint: 'Sent to an address' },
]

export function OrderTypeChips({
  value,
  onChange,
}: {
  value: OrderType
  onChange: (next: OrderType) => void
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {ORDER_TYPES.map((type) => (
        <button
          key={type.value}
          type="button"
          onClick={() => onChange(type.value)}
          title={type.hint}
          aria-pressed={value === type.value}
          className={`rounded-lg border px-4 py-2 text-sm font-medium transition ${
            value === type.value
              ? 'border-primary bg-primary text-primary-foreground'
              : 'border-border bg-card hover:bg-muted'
          }`}
        >
          {type.label}
        </button>
      ))}
    </div>
  )
}
