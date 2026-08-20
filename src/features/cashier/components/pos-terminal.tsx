'use client'

import * as React from 'react'
import Image from 'next/image'
import { Minus, Plus, Search, ShoppingCart, Trash2, UtensilsCrossed, X } from 'lucide-react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { formatMoney } from '@/lib/money'
import { createStaffOrder } from '@/features/orders/actions'
import type { PublicMenu, PublicMenuItem } from '@/features/menu/queries'

/**
 * Counter order terminal — takeaway, delivery and walk-in sales.
 *
 * Built for speed with one thumb on a busy counter: the menu is a grid of
 * photographs, and tapping a photo adds one of that item. Quantity is adjusted
 * with − and + on the order panel rather than by typing a number, because a
 * cashier with a queue in front of them should never have to aim at a text
 * field.
 *
 * Dine-in is deliberately absent. It needs a table, and that flow already lives
 * on the floor plan where the table is chosen first.
 */

type OrderType = 'DINE_IN' | 'TAKEAWAY' | 'DELIVERY' | 'COUNTER'

const TYPES: Array<{ value: OrderType; label: string; hint: string }> = [
  { value: 'DINE_IN', label: 'Dine in', hint: 'Ordered at the counter, eating at a table' },
  { value: 'COUNTER', label: 'Counter', hint: 'Walk-in paying at the till' },
  { value: 'TAKEAWAY', label: 'Takeaway', hint: 'Collected later' },
  { value: 'DELIVERY', label: 'Delivery', hint: 'Sent to an address' },
]

interface Line {
  item: PublicMenuItem
  quantity: number
}

export function PosTerminal({
  menu,
  currency,
  initialType = 'COUNTER',
  tables = [],
  servers = [],
  currentUserId,
}: {
  menu: PublicMenu
  currency: string
  initialType?: OrderType
  /** Free tables, so a counter order can be seated. */
  tables?: Array<{ id: string; number: string; area: string | null; status: string }>
  /** Who can be credited with serving it. */
  servers?: Array<{ id: string; name: string; role: string }>
  currentUserId?: string
}) {
  const [type, setType] = React.useState<OrderType>(initialType)
  const [categoryId, setCategoryId] = React.useState<string | null>(null)
  const [search, setSearch] = React.useState('')
  const [lines, setLines] = React.useState<Line[]>([])
  const [name, setName] = React.useState('')
  const [phone, setPhone] = React.useState('')
  const [notes, setNotes] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [cartOpen, setCartOpen] = React.useState(false)
  const [tableId, setTableId] = React.useState('')
  // Defaults to whoever is signed in: a waiter taking their own order should
  // not have to find themselves in a list before they can start.
  const [servedById, setServedById] = React.useState(currentUserId ?? '')

  const money = (minor: number) => formatMoney(minor, currency)

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

  const qtyOf = React.useCallback(
    (id: string) => lines.find((l) => l.item.id === id)?.quantity ?? 0,
    [lines],
  )

  const add = (item: PublicMenuItem) => {
    setLines((current) => {
      const found = current.find((l) => l.item.id === item.id)
      if (!found) return [...current, { item, quantity: 1 }]
      return current.map((l) =>
        l.item.id === item.id ? { ...l, quantity: Math.min(50, l.quantity + 1) } : l,
      )
    })
  }

  const setQty = (id: string, quantity: number) => {
    setLines((current) =>
      quantity <= 0
        ? current.filter((l) => l.item.id !== id)
        : current.map((l) => (l.item.id === id ? { ...l, quantity: Math.min(50, quantity) } : l)),
    )
  }

  const subtotal = lines.reduce((total, l) => total + l.item.price * l.quantity, 0)
  const count = lines.reduce((total, l) => total + l.quantity, 0)

  const submit = async () => {
    if (lines.length === 0) {
      toast.error('Add at least one item')
      return
    }
    if (type === 'DELIVERY' && !phone.trim()) {
      toast.error('A delivery needs a phone number')
      return
    }
    // A dine-in order with no table cannot be delivered to anyone — the
    // kitchen would have nowhere to send it.
    if (type === 'DINE_IN' && !tableId) {
      toast.error('Choose a table for a dine-in order')
      return
    }

    setBusy(true)
    const result = await createStaffOrder({
      type,
      tableId: type === 'DINE_IN' ? tableId : '',
      servedById,
      customerName: name,
      customerPhone: phone,
      notes,
      items: lines.map((l) => ({ foodId: l.item.id, quantity: l.quantity, optionIds: [] })),
    })
    setBusy(false)

    if (!result.ok) {
      toast.error(result.error)
      return
    }
    toast.success(`${result.data.orderNumber} sent to the kitchen`)
    setLines([])
    setName('')
    setPhone('')
    setNotes('')
    setTableId('')
    setCartOpen(false)
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_22rem] lg:items-start">
      {/* ── menu side ────────────────────────────────────────────────────── */}
      <div className="space-y-4">
        <div className="flex flex-wrap gap-2">
          {TYPES.map((t) => (
            <button
              key={t.value}
              type="button"
              onClick={() => setType(t.value)}
              title={t.hint}
              className={`rounded-lg border px-4 py-2 text-sm font-medium transition ${
                type === t.value
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-border bg-card hover:bg-muted'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

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
          {menu.categories.map((c) => (
            <Chip key={c.id} active={categoryId === c.id} onClick={() => setCategoryId(c.id)}>
              {c.name}
            </Chip>
          ))}
        </div>

        {visible.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
            Nothing matches that.
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
            {visible.map((item) => (
              <FoodCard
                key={item.id}
                item={item}
                quantity={qtyOf(item.id)}
                money={money}
                onAdd={() => add(item)}
              />
            ))}
          </div>
        )}
      </div>

      {/* ── order side ───────────────────────────────────────────────────── */}
      <aside
        className={`${
          cartOpen ? 'fixed inset-0 z-50 overflow-y-auto bg-background p-4' : 'hidden'
        } lg:sticky lg:top-4 lg:z-auto lg:block lg:overflow-visible lg:bg-transparent lg:p-0`}
      >
        <div className="rounded-xl border border-border bg-card">
          <header className="flex items-center justify-between border-b border-border px-4 py-3">
            <h2 className="font-semibold">Order</h2>
            <div className="flex items-center gap-2">
              {count > 0 && <Badge variant="secondary">{count}</Badge>}
              <button
                type="button"
                onClick={() => setCartOpen(false)}
                className="rounded-md p-1 text-muted-foreground hover:bg-muted lg:hidden"
                aria-label="Close order panel"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
          </header>

          {lines.length === 0 ? (
            <p className="px-4 py-10 text-center text-sm text-muted-foreground">
              Tap a dish to start the order.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {lines.map((line) => (
                <li key={line.item.id} className="flex items-center gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{line.item.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {money(line.item.price)} each
                    </p>
                  </div>

                  <div className="flex shrink-0 items-center gap-1">
                    <StepButton
                      label={`Remove one ${line.item.name}`}
                      onClick={() => setQty(line.item.id, line.quantity - 1)}
                    >
                      {line.quantity === 1 ? (
                        <Trash2 className="h-4 w-4" />
                      ) : (
                        <Minus className="h-4 w-4" />
                      )}
                    </StepButton>
                    <span className="w-7 text-center text-sm font-semibold tabular-nums">
                      {line.quantity}
                    </span>
                    <StepButton
                      label={`Add one ${line.item.name}`}
                      onClick={() => setQty(line.item.id, line.quantity + 1)}
                    >
                      <Plus className="h-4 w-4" />
                    </StepButton>
                  </div>

                  <span className="w-20 shrink-0 text-right text-sm font-semibold tabular-nums">
                    {money(line.item.price * line.quantity)}
                  </span>
                </li>
              ))}
            </ul>
          )}

          <div className="space-y-3 border-t border-border p-4">
            <div className="flex items-center justify-between text-base font-semibold">
              <span>Subtotal</span>
              <span className="tabular-nums">{money(subtotal)}</span>
            </div>
            <p className="-mt-2 text-xs text-muted-foreground">
              Tax and service charge are added on the bill.
            </p>

            <div className="grid gap-2">
              {type === 'DINE_IN' && (
                <div className="space-y-1">
                  <Label htmlFor="pos-table" className="text-xs">Table</Label>
                  <select
                    id="pos-table"
                    className="h-10 w-full rounded-lg border border-input bg-background px-2 text-sm"
                    value={tableId}
                    onChange={(e) => setTableId(e.target.value)}
                  >
                    <option value="">Choose a table…</option>
                    {tables.map((t) => (
                      <option key={t.id} value={t.id}>
                        Table {t.number}
                        {t.area ? ` · ${t.area}` : ''}
                        {t.status !== 'AVAILABLE' ? ` · ${t.status.toLowerCase()}` : ''}
                      </option>
                    ))}
                  </select>
                  {tables.length === 0 && (
                    <p className="text-xs text-amber-600 dark:text-amber-400">
                      No tables set up yet — add them under Tables.
                    </p>
                  )}
                </div>
              )}

              {servers.length > 0 && (
                <div className="space-y-1">
                  <Label htmlFor="pos-server" className="text-xs">Served by</Label>
                  <select
                    id="pos-server"
                    className="h-10 w-full rounded-lg border border-input bg-background px-2 text-sm"
                    value={servedById}
                    onChange={(e) => setServedById(e.target.value)}
                  >
                    {servers.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name} · {s.role.toLowerCase()}
                      </option>
                    ))}
                  </select>
                  <p className="text-xs text-muted-foreground">
                    Credited with the sale in staff reports.
                  </p>
                </div>
              )}

              <div className="space-y-1">
                <Label htmlFor="pos-name" className="text-xs">
                  Customer {type === 'COUNTER' && <span className="text-muted-foreground">(optional)</span>}
                </Label>
                <Input
                  id="pos-name"
                  placeholder={type === 'COUNTER' ? 'Walk-in' : 'Name'}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="pos-phone" className="text-xs">
                  Phone {type === 'DELIVERY' ? '' : <span className="text-muted-foreground">(optional)</span>}
                </Label>
                <Input
                  id="pos-phone"
                  inputMode="tel"
                  placeholder="07X XXX XXXX"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="pos-notes" className="text-xs">
                  {type === 'DELIVERY' ? 'Address / notes' : 'Notes'}
                </Label>
                <Input
                  id="pos-notes"
                  placeholder={type === 'DELIVERY' ? 'Delivery address' : 'e.g. no chilli'}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                />
              </div>
            </div>

            <Button className="w-full" size="lg" onClick={submit} disabled={busy || count === 0}>
              {busy ? 'Sending…' : `Send to kitchen · ${money(subtotal)}`}
            </Button>
          </div>
        </div>
      </aside>

      {/* Mobile: a persistent bar so the running total is always visible. */}
      {count > 0 && !cartOpen && (
        <button
          type="button"
          onClick={() => setCartOpen(true)}
          className="fixed inset-x-3 bottom-3 z-40 flex items-center justify-between rounded-xl bg-primary px-4 py-3 text-primary-foreground shadow-lg lg:hidden"
        >
          <span className="flex items-center gap-2 text-sm font-medium">
            <ShoppingCart className="h-4 w-4" />
            {count} {count === 1 ? 'item' : 'items'}
          </span>
          <span className="font-semibold tabular-nums">{money(subtotal)}</span>
        </button>
      )}
    </div>
  )
}

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

function StepButton({
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
