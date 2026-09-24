'use client'

import * as React from 'react'
import Link from 'next/link'
import { ArrowLeft, Minus, Plus, Send, Trash2, UtensilsCrossed } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/feedback'
import { Input } from '@/components/ui/input'
import { formatMoney } from '@/lib/money'
import { newRequestKey } from '@/lib/request-key'
import { callAction } from '@/lib/use-action'
import { createStaffOrder } from '@/features/orders/actions'
import type { PublicMenu, PublicMenuItem } from '@/features/menu/queries'
import { MenuPicker, StepButton } from '@/features/cashier/components/menu-picker'
import { OptionDialog } from '@/features/cashier/components/option-dialog'
import { cn } from '@/lib/utils'

/**
 * A waiter takes the order at the table and sends it straight to the kitchen.
 *
 * ── What is genuinely new, and what was already there ───────────────────────
 *
 * Almost all of this already worked. `createStaffOrder` writes a STAFF-channel
 * order, and `acceptedOnPlacement(channel)` is true for anything that is not a
 * QR or online order — so the order is written ACCEPTED and `commitToKitchen`
 * routes its lines to stations, pins the recipe versions, snapshots the costs
 * and reconciles the depletion, all in the same transaction. `getKitchenQueue`
 * selects ACCEPTED, PREPARING and READY with no channel filter, so it is on the
 * rail the moment it is written.
 *
 * What was missing was the SCREEN. A waiter had no way to create an order, so
 * every dine-in order was dictated to whoever was at the till. This is that
 * screen, and it calls exactly the same action the till calls. No second order
 * path, no second acceptance rule, no second set of permissions.
 *
 * ── A new round on the same bill ────────────────────────────────────────────
 *
 * `placeOrder` joins the table's open sitting when there is one and creates a
 * new Order inside it. That is deliberate and is what the cashier's bill list
 * is built on: what table 4 owes tonight is a question about the sitting, not
 * about whichever order happens to be newest. So a second visit to a seated
 * table starts another round — and the pad says so, because silently doing the
 * right thing is still silent.
 */

interface Line {
  /** Dish plus chosen options: Normal and Full are two lines, not one. */
  key: string
  item: PublicMenuItem
  quantity: number
  options: Array<{ id: string; name: string; groupName: string; priceDelta: number }>
  notes: string
}

/** The same collapse rule the till and the guest cart use. */
function lineKey(foodId: string, optionIds: string[], notes: string): string {
  return `${foodId}::${[...optionIds].sort().join(',')}::${notes.trim().toLowerCase()}`
}

export interface PadTable {
  id: string
  number: string
  label: string | null
  area: string | null
  capacity: number
  status: string
  /** Open orders already on this table, so a second round can say so. */
  openOrders: Array<{ id: string; orderNumber: string }>
  /** The party already seated, when there is a sitting. */
  seatedGuests: number | null
}

export function WaiterOrderPad({
  menu,
  tables,
  currency,
  locale,
  branchId,
  backHref,
}: {
  menu: PublicMenu
  tables: PadTable[]
  currency: string
  locale: string
  /** The floor this station is standing on; sent with the order. */
  branchId: string | null
  backHref: string
}) {
  const [tableId, setTableId] = React.useState<string>('')
  const [lines, setLines] = React.useState<Line[]>([])
  const [guests, setGuests] = React.useState('')
  const [notes, setNotes] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [choosing, setChoosing] = React.useState<PublicMenuItem | null>(null)

  /*
   * One key per cart, so a double tap places one order.
   *
   * A wall tablet on a busy floor is exactly where this matters: `disabled`
   * while busy cannot help across a dropped connection the browser retries,
   * and a second order deducts another full set of ingredients. The key
   * survives a failed attempt on purpose — retrying the same cart must resolve
   * to the same order, not a second one — and is regenerated only once an
   * order has actually gone.
   */
  const idempotencyKey = React.useRef(newRequestKey('waiter'))

  const money = (minor: number) => formatMoney(minor, currency, locale)
  const table = tables.find((t) => t.id === tableId) ?? null
  const hasOpenOrder = (table?.openOrders.length ?? 0) > 0

  /* ── The cart ───────────────────────────────────────────────────────────── */

  // A dish with choices asks; a dish without adds on the tap.
  const add = (item: PublicMenuItem) => {
    if (item.groups.length > 0) {
      setChoosing(item)
      return
    }
    addLine(item, [], 1, '')
  }

  const addLine = (item: PublicMenuItem, optionIds: string[], quantity: number, itemNotes: string) => {
    const chosen = item.groups.flatMap((group) =>
      group.options
        .filter((option) => optionIds.includes(option.id))
        .map((option) => ({
          id: option.id,
          name: option.name,
          groupName: group.name,
          priceDelta: option.priceDelta,
        })),
    )
    const key = lineKey(item.id, optionIds, itemNotes)
    setLines((current) => {
      const found = current.find((l) => l.key === key)
      if (!found) return [...current, { key, item, quantity, options: chosen, notes: itemNotes }]
      return current.map((l) =>
        l.key === key ? { ...l, quantity: Math.min(50, l.quantity + quantity) } : l,
      )
    })
  }

  const setQty = (key: string, quantity: number) => {
    setLines((current) =>
      quantity <= 0
        ? current.filter((l) => l.key !== key)
        : current.map((l) => (l.key === key ? { ...l, quantity: Math.min(50, quantity) } : l)),
    )
  }

  const unitOf = (line: Line) =>
    line.item.price + line.options.reduce((total, option) => total + option.priceDelta, 0)

  const subtotal = lines.reduce((total, l) => total + unitOf(l) * l.quantity, 0)
  const count = lines.reduce((total, l) => total + l.quantity, 0)
  const quantityOf = (foodId: string) =>
    lines.filter((l) => l.item.id === foodId).reduce((total, l) => total + l.quantity, 0)

  /* ── Send ───────────────────────────────────────────────────────────────── */

  const send = async () => {
    if (!tableId) {
      toast.error('Choose a table first')
      return
    }
    if (lines.length === 0) {
      toast.error('The order is empty')
      return
    }

    setBusy(true)
    const result = await callAction(() =>
      createStaffOrder({
        /*
         * Always a seated order. `placeOrder` throws on DINE_IN without a
         * table, and the table is what resolves the branch — a waiter with a
         * tablet on the floor is taking dine-in orders, and a type chip would
         * mean carrying the till's branch-resolution path onto a screen that
         * does not need it.
         */
        type: 'DINE_IN',
        branchId: branchId ?? '',
        tableId,
        /*
         * Only on a new sitting. `placeOrder` reads `guestCount` when it OPENS
         * a table session and silently ignores it on a later round, so
         * offering the field for a second round would be offering an input
         * that is discarded — worse than not offering it.
         */
        guestCount: !hasOpenOrder && guests ? Number(guests) : undefined,
        notes,
        idempotencyKey: idempotencyKey.current,
        items: lines.map((l) => ({
          foodId: l.item.id,
          quantity: l.quantity,
          optionIds: l.options.map((option) => option.id),
          notes: l.notes,
        })),
      }),
    )
    setBusy(false)

    if (!result.ok) {
      toast.error(result.error)
      return
    }

    toast.success(`Order ${result.data.orderNumber} sent to the kitchen`, {
      description: table ? `Table ${table.number}` : undefined,
    })
    // A fresh key: the next cart is genuinely a different order.
    idempotencyKey.current = newRequestKey('waiter')
    setLines([])
    setNotes('')
    setGuests('')
  }

  /* ── Screen ─────────────────────────────────────────────────────────────── */

  return (
    <div className="grid gap-4 p-4 lg:grid-cols-[1fr_22rem]">
      <div className="space-y-4">
        {/* ── Which table ─────────────────────────────────────────────── */}
        <section className="rounded-xl border bg-card p-4 shadow-soft">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold">Which table?</h2>
            <Button asChild variant="ghost" size="sm">
              <Link href={backHref}>
                <ArrowLeft /> Back to station
              </Link>
            </Button>
          </div>

          {tables.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              There are no tables on this floor yet. A manager adds them from the Tables screen.
            </p>
          ) : (
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-5 lg:grid-cols-6">
              {tables.map((t) => {
                const busyTable = t.openOrders.length > 0
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => setTableId(t.id)}
                    className={cn(
                      'rounded-xl border p-2 text-center transition active:scale-95',
                      tableId === t.id
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'border-border bg-background hover:bg-muted',
                    )}
                  >
                    <span className="block text-lg font-bold leading-tight">{t.number}</span>
                    <span
                      className={cn(
                        'block text-[10px]',
                        tableId === t.id ? 'text-primary-foreground/80' : 'text-muted-foreground',
                      )}
                    >
                      {busyTable ? 'Seated' : `${t.capacity} seats`}
                    </span>
                  </button>
                )
              })}
            </div>
          )}

          {/*
            Said out loud, because the alternative is a waiter thinking they
            have added to the existing order. They have not: this is a second
            order on the same sitting, which is how the cashier's bill list is
            built and how "what does table 4 owe tonight" stays answerable.
          */}
          {table && hasOpenOrder ? (
            <p className="mt-3 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm">
              Table {table.number} already has an open order (
              {table.openOrders.map((o) => o.orderNumber).join(', ')}). This starts a new round on
              the same bill.
            </p>
          ) : null}

          {/* Only on a new sitting — see the note at the send call. */}
          {table && !hasOpenOrder ? (
            <div className="mt-3 flex items-center gap-2">
              <label className="text-sm text-muted-foreground" htmlFor="guests">
                Guests
              </label>
              <Input
                id="guests"
                type="number"
                inputMode="numeric"
                min={1}
                max={table.capacity * 2}
                className="w-24"
                value={guests}
                onChange={(event) => setGuests(event.target.value)}
                placeholder={String(table.capacity)}
              />
            </div>
          ) : null}
          {table && hasOpenOrder && table.seatedGuests ? (
            <p className="mt-3 text-sm text-muted-foreground">
              {table.seatedGuests} already seated.
            </p>
          ) : null}
        </section>

        {/* ── The menu ────────────────────────────────────────────────── */}
        <section className="rounded-xl border bg-card p-4 shadow-soft">
          <MenuPicker menu={menu} quantityOf={quantityOf} onAdd={add} money={money} />
        </section>
      </div>

      {/* ── The order ─────────────────────────────────────────────────── */}
      <aside className="lg:sticky lg:top-4 lg:h-fit">
        <div className="rounded-xl border bg-card shadow-soft">
          <header className="flex items-center justify-between border-b px-4 py-3">
            <h2 className="text-sm font-semibold">
              {table ? `Table ${table.number}` : 'New order'}
            </h2>
            {count > 0 ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setLines([])}
                aria-label="Clear the order"
              >
                <Trash2 /> Clear
              </Button>
            ) : null}
          </header>

          {lines.length === 0 ? (
            <div className="p-4">
              <EmptyState
                icon={<UtensilsCrossed className="size-8" />}
                title="Nothing added yet"
                description="Tap a dish to put it on the order."
              />
            </div>
          ) : (
            <ul className="max-h-[50vh] divide-y overflow-y-auto">
              {lines.map((line) => (
                <li key={line.key} className="flex items-start gap-2 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{line.item.name}</p>
                    {line.options.length > 0 ? (
                      <p className="truncate text-xs text-muted-foreground">
                        {line.options.map((option) => option.name).join(', ')}
                      </p>
                    ) : null}
                    {line.notes ? (
                      <p className="truncate text-xs italic text-muted-foreground">{line.notes}</p>
                    ) : null}
                    <p className="mt-0.5 text-xs text-muted-foreground tabular-nums">
                      {money(unitOf(line))} each
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <StepButton
                      label={`One less ${line.item.name}`}
                      onClick={() => setQty(line.key, line.quantity - 1)}
                    >
                      <Minus className="size-4" />
                    </StepButton>
                    <span className="w-6 text-center text-sm font-semibold tabular-nums">
                      {line.quantity}
                    </span>
                    <StepButton
                      label={`One more ${line.item.name}`}
                      onClick={() => setQty(line.key, line.quantity + 1)}
                    >
                      <Plus className="size-4" />
                    </StepButton>
                  </div>
                </li>
              ))}
            </ul>
          )}

          <div className="space-y-3 border-t p-4">
            <Input
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              placeholder="Note for the kitchen (optional)"
            />

            {/*
              A running count, and labelled as one. Tax, service charge and any
              offer are added by the server when the order is written — the
              cashier's bill is the figure the guest is asked for, and quoting
              a different one here would be worse than quoting none.
            */}
            <div className="flex items-baseline justify-between text-sm">
              <span className="text-muted-foreground">
                {count} {count === 1 ? 'item' : 'items'} · before tax
              </span>
              <span className="text-lg font-bold tabular-nums">{money(subtotal)}</span>
            </div>

            <Button
              className="w-full"
              size="lg"
              loading={busy}
              disabled={busy || lines.length === 0 || !tableId}
              onClick={send}
            >
              <Send /> Send to kitchen
            </Button>
            <p className="text-center text-xs text-muted-foreground">
              Goes straight to the kitchen. No cashier approval needed.
            </p>
          </div>
        </div>
      </aside>

      {choosing ? (
        <OptionDialog
          item={choosing}
          currency={currency}
          locale={locale}
          money={money}
          onCancel={() => setChoosing(null)}
          onConfirm={(optionIds, quantity, itemNotes) => {
            addLine(choosing, optionIds, quantity, itemNotes)
            setChoosing(null)
          }}
        />
      ) : null}
    </div>
  )
}
