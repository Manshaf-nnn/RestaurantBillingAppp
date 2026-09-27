'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { Bike, Check, ChefHat, MapPin, Phone, QrCode, Store, StickyNote } from 'lucide-react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/feedback'
import { callAction } from '@/lib/use-action'
import { formatMoney } from '@/lib/money'
import { cn } from '@/lib/utils'
import { updateOrderStatus } from '@/features/orders/actions'
import { acceptGuestOrderAction } from '@/features/cashier/actions'

/**
 * The deliveries going out.
 *
 * ── What this screen is for ─────────────────────────────────────────────────
 *
 * Nobody is standing at a table waiting: the address is the order. So the
 * place leads every card, the rider's note sits under it, and the phone number
 * is one tap away — those are the three things somebody handling a delivery
 * reaches for, and on the till they were not on the screen at all.
 *
 * ── It stops at Ready ───────────────────────────────────────────────────────
 *
 * This screen takes a delivery as far as the kitchen: accept it, cook it, mark
 * it ready. Closing it belongs to the Delivery Desk, where the customer's PIN
 * is typed in — a second "Delivered" button here would be a way to close a
 * delivery without the one check that makes the word mean anything, and the
 * person on this screen is not at the door anyway.
 */

export interface DeliveryOrderView {
  id: string
  orderNumber: string
  status: string
  paymentStatus: string
  placedAt: string
  customerName: string
  customerPhone: string | null
  /** As snapshotted when the guest chose it: "University — Boys Hostel". */
  place: string | null
  /** For the rider, never shown to the guest. */
  placeNote: string | null
  /** The code that produced it, or null for one taken at the counter. */
  source: string | null
  grandTotal: number
  outstanding: number
  notes: string | null
  items: Array<{
    id: string
    name: string
    quantity: number
    lineTotal: number
    options: string
    notes: string | null
  }>
}

/**
 * What the person on this screen can move the order to next.
 *
 * It stops at READY on purpose. Closing a delivery needs the PIN the customer
 * reads out at the door, which happens on the Delivery Desk — leaving a
 * "Delivered" button here would be a second way to close one that skips the
 * only check that makes "delivered" mean anything.
 */
const NEXT: Record<string, { status: string; label: string; icon: typeof Check } | undefined> = {
  /*
   * Accept sends it straight to the kitchen. ACCEPTED already means "sent to
   * the kitchen" — the order's own event says exactly that and the tickets are
   * routed on it — so a separate "Send to kitchen" tap was a second button for
   * something the first one had already done. One decision, one tap: this
   * order is good, cook it.
   */
  PENDING: { status: 'ACCEPTED', label: 'Accept & send to kitchen', icon: ChefHat },
  ACCEPTED: { status: 'PREPARING', label: 'Cooking', icon: ChefHat },
  PREPARING: { status: 'READY', label: 'Ready', icon: Check },
}

const STATUS_LABEL: Record<string, string> = {
  PENDING: 'Received',
  ACCEPTED: 'With the kitchen',
  PREPARING: 'Preparing',
  READY: 'Ready — with the delivery desk',
}

export function DeliveryBoard({
  orders,
  currency,
  locale,
  canAccept,
}: {
  orders: DeliveryOrderView[]
  currency: string
  locale: string
  /** Holds ORDER_ACCEPT: may take a guest's delivery order into the kitchen. */
  canAccept: boolean
}) {
  const router = useRouter()
  const [busy, setBusy] = React.useState<string | null>(null)
  const money = (value: number) => formatMoney(value, currency, locale)

  async function advance(order: DeliveryOrderView, to: string, label: string) {
    setBusy(order.id)
    /*
     * A PENDING delivery is always a guest's (typed-in orders are born
     * accepted), and a guest order has exactly one way in: the till's accept,
     * which routes every dish to its kitchen section and prints the KOT. The
     * plain status change refuses it on purpose — "waiting for the cashier to
     * accept it" — which is what this button hit when it used that path. The
     * Delivery tab IS the till for deliveries, so it uses the till's door.
     */
    const result = await callAction(() =>
      order.status === 'PENDING'
        ? acceptGuestOrderAction({ orderId: order.id })
        : updateOrderStatus({ orderId: order.id, status: to }),
    )
    setBusy(null)
    if (!result.ok) return toast.error(result.error)
    toast.success(`${order.orderNumber} — ${label.toLowerCase()}`)
    router.refresh()
  }

  if (orders.length === 0) {
    return (
      <EmptyState
        icon={<Bike />}
        title="No deliveries waiting"
        description="Orders placed for delivery arrive here — from a QR code or taken at the counter. One that has been delivered drops off this screen."
      />
    )
  }

  return (
    <ul className="grid gap-3 lg:grid-cols-2">
      {orders.map((order) => {
        const next = NEXT[order.status]
        const Icon = next?.icon ?? Check
        return (
          <li key={order.id} className="rounded-xl border bg-card p-4 shadow-soft">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                {/* The place first: it is what this order is about. */}
                <p className="flex items-center gap-1.5 font-semibold">
                  <MapPin className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 truncate">{order.place ?? 'No place given'}</span>
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {order.orderNumber} · {order.customerName}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <Badge variant={order.status === 'READY' ? 'default' : 'secondary'}>
                  {STATUS_LABEL[order.status] ?? order.status}
                </Badge>
                {order.outstanding > 0 ? (
                  <Badge variant="destructive">{money(order.outstanding)} due</Badge>
                ) : (
                  <Badge variant="outline">Paid</Badge>
                )}
              </div>
            </div>

            {/*
              The rider's note. Kept out of the guest's sight everywhere else,
              and the reason the place alone is often not enough to find a door.
            */}
            {order.placeNote ? (
              <p className="mt-2 flex items-start gap-1.5 rounded-lg bg-muted/60 px-2.5 py-1.5 text-xs">
                <StickyNote className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                <span>{order.placeNote}</span>
              </p>
            ) : null}

            <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
              {order.customerPhone ? (
                <a
                  href={`tel:${order.customerPhone}`}
                  className="inline-flex items-center gap-1 hover:text-foreground hover:underline"
                >
                  <Phone className="size-3.5" /> {order.customerPhone}
                </a>
              ) : null}
              <span className="inline-flex items-center gap-1">
                {order.source ? (
                  <>
                    <QrCode className="size-3.5" /> {order.source}
                  </>
                ) : (
                  <>
                    <Store className="size-3.5" /> Taken at the counter
                  </>
                )}
              </span>
            </div>

            {/* What they asked for, each line with whatever they chose on it. */}
            <ul className="mt-3 space-y-1 border-t pt-2.5 text-sm">
              {order.items.map((item) => (
                <li key={item.id} className="flex items-baseline justify-between gap-2">
                  <span className="min-w-0">
                    <span className="tabular-nums text-muted-foreground">{item.quantity}×</span>{' '}
                    <span>{item.name}</span>
                    {item.options ? (
                      <span className="block text-xs text-muted-foreground">{item.options}</span>
                    ) : null}
                    {item.notes ? (
                      <span className="block text-xs italic text-amber-700 dark:text-amber-400">
                        {item.notes}
                      </span>
                    ) : null}
                  </span>
                  <span className="shrink-0 tabular-nums">{money(item.lineTotal)}</span>
                </li>
              ))}
            </ul>

            {order.notes ? (
              <p className="mt-2 text-xs italic text-muted-foreground">“{order.notes}”</p>
            ) : null}

            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t pt-2.5">
              <span className="font-semibold tabular-nums">{money(order.grandTotal)}</span>
              {next && order.status === 'PENDING' && !canAccept ? (
                <span className="text-xs text-muted-foreground">
                  Accepting delivery orders needs the “Accept orders” permission — ask the owner.
                </span>
              ) : next ? (
                <Button
                  size="sm"
                  onClick={() => advance(order, next.status, next.label)}
                  loading={busy === order.id}
                  disabled={busy !== null}
                >
                  <Icon /> {next.label}
                </Button>
              ) : null}
            </div>
          </li>
        )
      })}
    </ul>
  )
}
