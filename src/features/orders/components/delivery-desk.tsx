'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { Bike, Check, Copy, MapPin, Phone, StickyNote } from 'lucide-react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/feedback'
import { Input } from '@/components/ui/input'
import { callAction } from '@/lib/use-action'
import { formatTime } from '@/lib/datetime'
import { formatMoney } from '@/lib/money'
import { completeDelivery } from '../actions'

/**
 * The delivery desk: ready orders, and the PIN that closes them.
 *
 * ── What is deliberately not here ───────────────────────────────────────────
 *
 * The PIN. Not as a hidden field, not in a data attribute, not compared in
 * this file. The server sends every column this screen needs except that one,
 * so there is nothing here to read out of the page source and nothing to skip
 * — the only way to find out whether four digits are right is to send them and
 * be told, one guess at a time, ten guesses per order.
 */

export interface DeliveryDeskRow {
  id: string
  orderNumber: string
  customerName: string
  customerPhone: string | null
  place: string | null
  placeNote: string | null
  placedAt: string
  readyAt: string | null
  grandTotal: number
  outstanding: number
  items: Array<{ id: string; name: string; quantity: number; options: string; notes: string | null }>
}

export function DeliveryDesk({
  rows,
  currency,
  locale,
  timeZone,
}: {
  rows: DeliveryDeskRow[]
  currency: string
  locale: string
  timeZone: string
}) {
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={<Bike />}
        title="No deliveries ready"
        description="An order appears here the moment the kitchen marks it ready. Close it with the four digits the customer reads out at the door."
      />
    )
  }

  return (
    <ul className="grid gap-3 lg:grid-cols-2">
      {rows.map((row) => (
        <DeliveryCard
          key={row.id}
          row={row}
          currency={currency}
          locale={locale}
          timeZone={timeZone}
        />
      ))}
    </ul>
  )
}

function DeliveryCard({
  row,
  currency,
  locale,
  timeZone,
}: {
  row: DeliveryDeskRow
  currency: string
  locale: string
  timeZone: string
}) {
  const router = useRouter()
  const [pin, setPin] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [done, setDone] = React.useState(false)

  const money = (value: number) => formatMoney(value, currency, locale)
  /*
   * Through `formatTime`, not `toLocaleTimeString`.
   *
   * Both take a zone, so this reads like a distinction without a difference —
   * it is not. `no-bare-locale-dates` exists because the zone is the argument
   * people forget, and a rider told an order was ready at the wrong hour has
   * no way to tell. One helper, one place the restaurant's zone is applied.
   */
  const at = (iso: string | null) => (iso ? formatTime(iso, { locale, timeZone }) : '—')

  async function confirm() {
    if (busy || done) return
    setError(null)
    if (!/^\d{4}$/.test(pin.trim())) {
      setError('The PIN is four digits.')
      return
    }
    setBusy(true)
    const result = await callAction(() => completeDelivery({ orderId: row.id, pin: pin.trim() }))
    setBusy(false)
    if (!result.ok) {
      // The server's words: they carry how many tries are left.
      setError(result.error)
      setPin('')
      return
    }
    /*
     * Latched, so a second tap on a slow connection cannot fire again. The
     * server refuses a repeat anyway — this only keeps the screen honest while
     * the refresh is on its way.
     */
    setDone(true)
    toast.success(`${row.orderNumber} delivered`)
    router.refresh()
  }

  async function copyPhone() {
    if (!row.customerPhone) return
    await navigator.clipboard.writeText(row.customerPhone).catch(() => undefined)
    toast.success('Number copied')
  }

  return (
    <li className="rounded-xl border bg-card p-4 shadow-soft">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-semibold">{row.orderNumber}</p>
          <p className="mt-0.5 truncate text-sm text-muted-foreground">{row.customerName}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Badge>Ready · {at(row.readyAt ?? row.placedAt)}</Badge>
          {row.outstanding > 0 ? (
            <Badge variant="destructive">Collect {money(row.outstanding)}</Badge>
          ) : (
            <Badge variant="outline">Paid</Badge>
          )}
        </div>
      </div>

      {/* Where it goes, and how to reach them — the two things at a door. */}
      <p className="mt-2 flex items-start gap-1.5 text-sm">
        <MapPin className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <span>{row.place ?? 'No address given'}</span>
      </p>
      {row.placeNote ? (
        <p className="mt-1.5 flex items-start gap-1.5 rounded-lg bg-muted/60 px-2.5 py-1.5 text-xs">
          <StickyNote className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
          <span>{row.placeNote}</span>
        </p>
      ) : null}

      {row.customerPhone ? (
        <div className="mt-2 flex items-center gap-2">
          <a
            href={`tel:${row.customerPhone}`}
            className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline"
          >
            <Phone className="size-4" /> {row.customerPhone}
          </a>
          <Button size="sm" variant="ghost" onClick={copyPhone} aria-label="Copy the number">
            <Copy className="size-3.5" />
          </Button>
        </div>
      ) : null}

      <ul className="mt-3 space-y-1 border-t pt-2.5 text-sm">
        {row.items.map((item) => (
          <li key={item.id}>
            <span className="tabular-nums text-muted-foreground">{item.quantity}×</span> {item.name}
            {item.options ? (
              <span className="block text-xs text-muted-foreground">{item.options}</span>
            ) : null}
            {item.notes ? (
              <span className="block text-xs italic text-amber-700 dark:text-amber-400">
                {item.notes}
              </span>
            ) : null}
          </li>
        ))}
      </ul>

      <div className="mt-3 border-t pt-3">
        <label htmlFor={`pin-${row.id}`} className="text-xs font-medium">
          Delivery PIN
        </label>
        <p className="mb-1.5 text-xs text-muted-foreground">
          Ask the customer for the four digits on their order screen.
        </p>
        <div className="flex flex-wrap gap-2">
          <Input
            id={`pin-${row.id}`}
            value={pin}
            onChange={(e) => {
              // Digits only, four of them: the field cannot hold anything else.
              setPin(e.target.value.replace(/\D/g, '').slice(0, 4))
              setError(null)
            }}
            inputMode="numeric"
            autoComplete="off"
            placeholder="0000"
            disabled={busy || done}
            className="w-28 text-center text-lg tracking-[0.4em] tabular-nums"
          />
          <Button onClick={confirm} loading={busy} disabled={busy || done || pin.length < 4}>
            <Check /> {done ? 'Delivered' : 'Confirm PIN & complete'}
          </Button>
        </div>
        {error ? <p className="mt-1.5 text-xs font-medium text-destructive">{error}</p> : null}
      </div>
    </li>
  )
}
