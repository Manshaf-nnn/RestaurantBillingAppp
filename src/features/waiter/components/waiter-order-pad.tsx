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
import { splitLine } from '@/features/orders/split-line'
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
  /**
   * True once the guests have asked for the bill.
   *
   * Adding a dish to a bill somebody is already paying is how a guest gets
   * charged for something they did not order, or walks out before it arrives.
   */
  billRequested: boolean
}

/**
 * Whether a waiter may start an order here, and if not, why not.
 *
 * ── Two blocks, and the one deliberate non-block ────────────────────────────
 *
 * RESERVED is held for somebody else. Seating a walk-in there loses the
 * booking, and the QR menu has refused to order at a reserved table since
 * reservations were added — this makes the waiter's pad agree with the guest's
 * phone instead of quietly allowing what the guest is refused.
 *
 * A bill being settled is blocked because the total has been quoted. A dish
 * added after that either misses the bill the guest is paying or reopens a
 * total they have already been shown.
 *
 * What is NOT blocked is an ordinary second round. Drinks, then starters, then
 * mains are three orders on one sitting, and that is how the cashier's bill
 * list is built — "what does table 4 owe tonight" is a question about the
 * sitting, not about whichever order is newest. Blocking it would mean every
 * course after the first had to be dictated to the till.
 */
export function orderBlock(table: PadTable): string | null {
  if (table.status === 'RESERVED') {
    return 'This table is held for a booking. Seat the party from the floor plan first.'
  }
  if (table.billRequested) {
    return 'The bill for this table is being settled. Start a new sitting once it is paid.'
  }
  return null
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
   * A line being given its own requirement — "one of these two, less spicy".
   * Distinct from `choosing`, which is a dish being added for the first time.
   */
  const [splitting, setSplitting] = React.useState<Line | null>(null)

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
  const blocked = table ? orderBlock(table) : null

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

  /**
   * One of these is different (see `splitLine`).
   *
   * The dialog opens on what the line already is, so the waiter edits rather
   * than rebuilds it, and the units they ask for move onto a line of their own
   * carrying the new options and note.
   */
  const applySplit = (source: Line, optionIds: string[], quantity: number, itemNotes: string) => {
    const chosen = source.item.groups.flatMap((group) =>
      group.options
        .filter((option) => optionIds.includes(option.id))
        .map((option) => ({
          id: option.id,
          name: option.name,
          groupName: group.name,
          priceDelta: option.priceDelta,
        })),
    )
    const nextKey = lineKey(source.item.id, optionIds, itemNotes)
    setLines((current) =>
      splitLine(current, {
        sourceKey: source.key,
        quantity,
        nextKey,
        create: (moved) => ({
          key: nextKey,
          item: source.item,
          quantity: moved,
          options: chosen,
          notes: itemNotes,
        }),
        merge: (existing, moved) => ({
          ...existing,
          quantity: Math.min(50, existing.quantity + moved),
        }),
      }),
    )
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
    /*
     * Checked again here, not only on the button's `disabled`.
     *
     * The table list is a snapshot: a host can reserve the table, or the
     * guests can ask for the bill, in the seconds between this screen
     * rendering and the waiter tapping send. `disabled` cannot see that and
     * this can — and the server is the real fence, which `createStaffOrder`
     * enforces for the same two reasons.
     */
    if (blocked) {
      toast.error(blocked)
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
         * The waiter's own rule, enforced on the server too. The till does not
         * send this — a cashier overriding a booking or adding to a bill being
         * settled is ordinary work. See `enforceTableReady` on the schema.
         */
        enforceTableReady: true,
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
    <div className="grid gap-3 p-3 sm:p-4 lg:grid-cols-[1fr_21rem]">
      <div className="space-y-4">
        {/* ── Which table ─────────────────────────────────────────────── */}
        <section className="rounded-xl border bg-card p-3 shadow-soft sm:p-4">
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
            <div className="grid grid-cols-4 gap-1.5 sm:grid-cols-6 md:grid-cols-8 lg:grid-cols-6 xl:grid-cols-8">
              {tables.map((t) => {
                const busyTable = t.openOrders.length > 0
                /*
                 * A blocked table is shown, dimmed and unpickable, rather than
                 * hidden. A waiter looking for table 7 must find table 7 and
                 * be told why not — a gap in the grid reads as "the system has
                 * lost my table" and ends in a call to the manager.
                 */
                const stop = orderBlock(t)
                return (
                  <button
                    key={t.id}
                    type="button"
                    disabled={Boolean(stop)}
                    title={stop ?? undefined}
                    onClick={() => setTableId(t.id)}
                    className={cn(
                      'min-h-14 rounded-lg border p-1.5 text-center transition active:scale-95',
                      stop
                        ? 'cursor-not-allowed border-dashed border-border bg-muted/40 opacity-60'
                        : tableId === t.id
                          ? 'border-primary bg-primary text-primary-foreground'
                          : 'border-border bg-background hover:bg-muted',
                    )}
                  >
                    <span className="block text-base font-bold leading-tight">{t.number}</span>
                    <span
                      className={cn(
                        'block text-[10px] leading-tight',
                        tableId === t.id && !stop
                          ? 'text-primary-foreground/80'
                          : 'text-muted-foreground',
                      )}
                    >
                      {t.status === 'RESERVED'
                        ? 'Reserved'
                        : t.billRequested
                          ? 'Billing'
                          : busyTable
                            ? 'Seated'
                            : `${t.capacity} seats`}
                    </span>
                  </button>
                )
              })}
            </div>
          )}

          {/* Why this table cannot be ordered on, in words, once it is picked. */}
          {blocked ? (
            <p className="mt-3 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm">
              {blocked}
            </p>
          ) : null}

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
        {/*
          Rows, not photographs, and only once a table is chosen. A waiter
          knows the dishes; what they need is many of them on one phone screen
          and a target they can hit while holding a tray. See `MenuPicker`.
        */}
        <section className="rounded-xl border bg-card p-3 shadow-soft sm:p-4">
          <MenuPicker
            menu={menu}
            quantityOf={quantityOf}
            onAdd={add}
            money={money}
            layout="list"
          />
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
                  {/*
                    The line itself opens its own requirements. A guest saying
                    "one of those without onions" is the ordinary case, and the
                    waiter should be able to say so on the line in front of
                    them rather than deleting it and starting again.
                  */}
                  <button
                    type="button"
                    onClick={() => setSplitting(line)}
                    className="min-w-0 flex-1 text-left"
                    aria-label={`Change or split ${line.item.name}`}
                  >
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
                      {line.quantity > 1 ? ' · tap to split' : ' · tap to change'}
                    </p>
                  </button>
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
              disabled={busy || lines.length === 0 || !tableId || Boolean(blocked)}
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

      {splitting ? (
        <OptionDialog
          item={splitting.item}
          currency={currency}
          locale={locale}
          money={money}
          title={
            splitting.quantity > 1
              ? `One of these ${splitting.item.name}`
              : splitting.item.name
          }
          confirmLabel={splitting.quantity > 1 ? 'Split off' : 'Update'}
          initialOptionIds={splitting.options.map((option) => option.id)}
          initialNotes={splitting.notes}
          // One unit by default when there are several: the guest said one of
          // them is different, not all of them.
          initialQuantity={splitting.quantity > 1 ? 1 : splitting.quantity}
          onCancel={() => setSplitting(null)}
          onConfirm={(optionIds, quantity, itemNotes) => {
            applySplit(splitting, optionIds, quantity, itemNotes)
            setSplitting(null)
          }}
        />
      ) : null}

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
