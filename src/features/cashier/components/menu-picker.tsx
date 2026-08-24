'use client'

import * as React from 'react'
import Image from 'next/image'
import { Search, UtensilsCrossed } from 'lucide-react'

import { Input } from '@/components/ui/input'
import type { PublicMenu, PublicMenuItem } from '@/features/menu/queries'

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
 */

export function MenuPicker({
  menu,
  quantityOf,
  onAdd,
  money,
  /** Tighter grid and a scroll cap, for use inside a dialog. */
  compact = false,
}: {
  menu: PublicMenu
  quantityOf: (foodId: string) => number
  onAdd: (item: PublicMenuItem) => void
  money: (minor: number) => string
  compact?: boolean
}) {
  const [categoryId, setCategoryId] = React.useState<string | null>(null)
  const [search, setSearch] = React.useState('')

  const visible = React.useMemo(() => {
    const term = search.trim().toLowerCase()
    return menu.items.filter((item) => {
      if (!item.isAvailable) return false
      if (categoryId && item.categoryId !== categoryId) return false
      if (!term) return true
      return (
        item.name.toLowerCase().includes(term) ||
        (item.description?.toLowerCase().includes(term) ?? false)
      )
    })
  }, [menu.items, categoryId, search])

  return (
    <div className="space-y-3">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          className="pl-9"
          placeholder="Search the menu"
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

      {visible.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
          Nothing matches that.
        </div>
      ) : (
        <div
          className={
            compact
              ? 'grid max-h-[26rem] grid-cols-2 gap-2.5 overflow-y-auto pr-1 sm:grid-cols-3'
              : 'grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4'
          }
        >
          {visible.map((item) => (
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
        <p className="line-clamp-2 text-sm font-medium leading-snug">{item.name}</p>
        <p className="mt-1 text-sm font-semibold tabular-nums text-primary">{money(item.price)}</p>
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
