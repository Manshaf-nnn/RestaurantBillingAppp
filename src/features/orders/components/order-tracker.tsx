'use client'

import * as React from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { AnimatePresence, motion } from 'framer-motion'
import type { OrderItemStatus, OrderStatus } from '@prisma/client'
import {
  ArrowLeft,
  Bell,
  Check,
  CheckCircle2,
  ChefHat,
  Clock,
  Hand,
  PartyPopper,
  Receipt,
  UtensilsCrossed,
  XCircle,
} from 'lucide-react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/primitives'
import { VegIndicator } from '@/components/ui/status'
import { EVENTS, type OrderStatusPayload } from '@/lib/realtime/events'
import { formatMoney } from '@/lib/money'
import { cn } from '@/lib/utils'
import { useOrderRoom, useSocketEvent } from '@/hooks/use-socket'
import { useNotificationSound } from '@/hooks/use-notification-sound'
import { isRealtimeEnabled } from '@/lib/realtime/client'
import { AutoRefresh } from '@/components/auto-refresh'
import { createServiceRequest, updateGuestOrderItems } from '../actions'
import { callAction } from '@/lib/use-action'

/** What the guest is told when their order reaches each stage. */
const STATUS_MESSAGES: Partial<Record<OrderStatus, string>> = {
  ACCEPTED: 'The kitchen accepted your order',
  PREPARING: 'Your food is being prepared',
  READY: 'Your order is ready',
  SERVED: 'Your food has been served — enjoy!',
  COMPLETED: 'Thanks for dining with us',
  CANCELLED: 'Your order was cancelled',
}

const STEPS: Array<{ status: OrderStatus; label: string; description: string; icon: React.ElementType }> = [
  { status: 'PENDING', label: 'Order received', description: 'We have your order', icon: Check },
  { status: 'ACCEPTED', label: 'Accepted', description: 'The kitchen has taken it on', icon: Hand },
  { status: 'PREPARING', label: 'Preparing', description: 'Your food is being cooked', icon: ChefHat },
  { status: 'READY', label: 'Ready', description: 'Freshly plated', icon: CheckCircle2 },
  { status: 'SERVED', label: 'Served', description: 'Enjoy your meal', icon: UtensilsCrossed },
]

export interface TrackedOrder {
  id: string
  orderNumber: string
  status: OrderStatus
  tableId: string | null
  tableNumber: string | null
  customerName: string
  grandTotal: number
  estimatedMinutes: number
  placedAt: string
  paymentStatus: string
  cancelReason: string | null
  items: Array<{
    id: string
    name: string
    quantity: number
    lineTotal: number
    notes: string | null
    isVeg: boolean
    status: OrderItemStatus
    optionsLabel: string
  }>
}

export function OrderTracker({
  order: initial,
  currency,
  locale,
  restaurantName,
}: {
  order: TrackedOrder
  currency: string
  locale: string
  restaurantName: string
}) {
  const router = useRouter()
  const [status, setStatus] = React.useState<OrderStatus>(initial.status)
  const [editing, setEditing] = React.useState(false)
  const [draftItems, setDraftItems] = React.useState(
    () => initial.items.map((item) => ({ id: item.id, name: item.name, quantity: item.quantity })),
  )

  React.useEffect(() => {
    setDraftItems(initial.items.map((item) => ({ id: item.id, name: item.name, quantity: item.quantity })))
  }, [initial.items])

  const { play } = useNotificationSound()

  // Re-sync when polling (realtime off / serverless).
  //
  // On a serverless host there is no socket event to react to, so the chime and
  // the "your order is ready" message have to be driven from the refreshed
  // props — otherwise a guest watching this screen sees the timeline advance in
  // silence and can miss that their food is ready.
  const lastStatus = React.useRef(initial.status)
  React.useEffect(() => {
    setStatus(initial.status)
    if (isRealtimeEnabled()) return
    if (lastStatus.current === initial.status) return

    lastStatus.current = initial.status
    play(initial.status === 'READY' || initial.status === 'SERVED' ? 'ready' : 'new-order')

    const message = STATUS_MESSAGES[initial.status]
    if (message) toast.success(message)
  }, [initial.status, play])

  useOrderRoom(initial.id)

  useSocketEvent(EVENTS.ORDER_STATUS, (payload: OrderStatusPayload) => {
    if (payload.orderId !== initial.id) return
    setStatus(payload.status)
    lastStatus.current = payload.status
    play(payload.status === 'READY' || payload.status === 'SERVED' ? 'ready' : 'new-order')

    const message = STATUS_MESSAGES[payload.status]
    if (message) toast.success(message)
    router.refresh()
  })

  const cancelled = status === 'CANCELLED'
  const currentIndex = STEPS.findIndex((step) => step.status === status)
  const activeIndex = status === 'COMPLETED' ? STEPS.length - 1 : currentIndex

  const elapsedMinutes = Math.max(
    0,
    Math.round((Date.now() - new Date(initial.placedAt).getTime()) / 60000),
  )
  const remaining = Math.max(0, initial.estimatedMinutes - elapsedMinutes)

  const saveEditChanges = async () => {
    const items = draftItems
      .filter((item) => item.quantity > 0)
      .map((item) => ({ itemId: item.id, quantity: item.quantity }))

    if (!items.length) {
      toast.error('Your order needs at least one item.')
      return
    }

    const result = await callAction(() => updateGuestOrderItems({ orderId: initial.id, items }))
    if (result.ok) {
      setEditing(false)
      toast.success('Order updated. The kitchen has the new list.')
      router.refresh()
      return
    }

    toast.error(result.error)
  }

  return (
    <div className="flex min-h-dvh flex-col pb-8">
      <AutoRefresh intervalMs={3000} scope={`order:${initial.id}`} />
      <header className="sticky top-0 z-30 flex items-center gap-2 border-b bg-background/90 px-4 py-3 backdrop-blur-xl">
        <Button variant="ghost" size="icon-sm" asChild aria-label="Back to menu">
          <Link href="/order/menu">
            <ArrowLeft />
          </Link>
        </Button>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-semibold leading-tight">Order {initial.orderNumber}</h1>
          <p className="text-xs text-muted-foreground">
            {restaurantName}
            {initial.tableNumber ? ` · Table ${initial.tableNumber}` : ''}
          </p>
        </div>
        {initial.tableId ? <CallWaiter tableId={initial.tableId} /> : null}
      </header>

      <div className="space-y-5 p-4">
        <AnimatePresence mode="wait">
          {cancelled ? (
            <motion.section
              key="cancelled"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              className="surface flex flex-col items-center gap-3 p-8 text-center"
            >
              <span className="flex size-14 items-center justify-center rounded-2xl bg-destructive/10 text-destructive">
                <XCircle className="size-7" />
              </span>
              <h2 className="text-lg font-bold">This order was cancelled</h2>
              {initial.cancelReason ? (
                <p className="text-sm text-muted-foreground">{initial.cancelReason}</p>
              ) : null}
              <Button asChild variant="outline">
                <Link href="/order/menu">Back to the menu</Link>
              </Button>
            </motion.section>
          ) : (
            <motion.section
              key="progress"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              className="surface overflow-hidden"
            >
              <div className="bg-gradient-to-br from-primary to-chart-5 p-6 text-center text-primary-foreground">
                <motion.div
                  key={status}
                  initial={{ scale: 0.8, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  transition={{ type: 'spring', stiffness: 260, damping: 20 }}
                  className="mx-auto mb-3 flex size-16 items-center justify-center rounded-2xl bg-white/20 backdrop-blur"
                >
                  {status === 'SERVED' || status === 'COMPLETED' ? (
                    <PartyPopper className="size-8" />
                  ) : (
                    React.createElement(STEPS[Math.max(0, activeIndex)]?.icon ?? Clock, {
                      className: 'size-8',
                    })
                  )}
                </motion.div>

                <h2 className="text-xl font-bold">
                  {status === 'SERVED' || status === 'COMPLETED'
                    ? 'Your food has been served'
                    : (STEPS[Math.max(0, activeIndex)]?.label ?? 'Order received')}
                </h2>
                <p className="mt-1 text-sm text-primary-foreground/85">
                  {status === 'READY'
                    ? 'A waiter is bringing it over'
                    : status === 'SERVED' || status === 'COMPLETED'
                      ? 'Enjoy your meal'
                      : remaining > 0
                        ? `About ${remaining} minute${remaining === 1 ? '' : 's'} to go`
                        : 'Almost there'}
                </p>
              </div>

              <ol className="space-y-0 p-5">
                {STEPS.map((step, index) => {
                  const done = index < activeIndex
                  const active = index === activeIndex
                  const Icon = step.icon

                  return (
                    <li key={step.status} className="flex gap-3">
                      <div className="flex flex-col items-center">
                        <motion.span
                          initial={false}
                          animate={{
                            scale: active ? 1.1 : 1,
                            backgroundColor: done || active ? 'hsl(var(--primary))' : 'hsl(var(--muted))',
                          }}
                          className={cn(
                            'flex size-9 shrink-0 items-center justify-center rounded-full',
                            done || active ? 'text-primary-foreground' : 'text-muted-foreground',
                            active && 'animate-flash-ring',
                          )}
                        >
                          {done ? <Check className="size-4" /> : <Icon className="size-4" />}
                        </motion.span>
                        {index < STEPS.length - 1 ? (
                          <span
                            className={cn(
                              'my-1 w-0.5 flex-1 rounded-full transition-colors',
                              done ? 'bg-primary' : 'bg-border',
                            )}
                          />
                        ) : null}
                      </div>

                      <div className={cn('pb-6 pt-1.5', index === STEPS.length - 1 && 'pb-0')}>
                        <p
                          className={cn(
                            'text-sm font-semibold',
                            !done && !active && 'text-muted-foreground',
                          )}
                        >
                          {step.label}
                        </p>
                        <p className="text-xs text-muted-foreground">{step.description}</p>
                      </div>
                    </li>
                  )
                })}
              </ol>
            </motion.section>
          )}
        </AnimatePresence>

        <section className="surface p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold">Your items</h2>
            <Badge variant="secondary">{initial.items.length} item(s)</Badge>
          </div>

          <ul className="space-y-3">
            {initial.items.map((item) => (
              <li key={item.id} className="flex items-start justify-between gap-3 text-sm">
                <div className="min-w-0">
                  <p className="flex items-center gap-1.5 font-medium">
                    <VegIndicator isVeg={item.isVeg} />
                    <span className="truncate">{item.name}</span>
                    <span className="shrink-0 text-muted-foreground">× {item.quantity}</span>
                  </p>
                  {item.optionsLabel ? (
                    <p className="mt-0.5 text-xs text-muted-foreground">{item.optionsLabel}</p>
                  ) : null}
                  {item.notes ? (
                    <p className="mt-0.5 text-xs italic text-primary">“{item.notes}”</p>
                  ) : null}
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <span className="font-medium">{formatMoney(item.lineTotal, currency, locale)}</span>
                  <ItemStatusPill status={item.status} />
                </div>
              </li>
            ))}
          </ul>

          <Separator className="my-3" />

          <div className="flex items-center justify-between font-bold">
            <span>Total</span>
            <span>{formatMoney(initial.grandTotal, currency, locale)}</span>
          </div>
        </section>

        <div className="grid grid-cols-2 gap-3">
          <Button variant="outline" asChild>
            <Link href={`/order/bill/${initial.id}`}>
              <Receipt /> View bill
            </Link>
          </Button>
          <Button variant="outline" asChild>
            <Link href="/order/menu">
              <UtensilsCrossed /> Order more
            </Link>
          </Button>
        </div>

        <section className="surface p-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold">Update your order</h2>
              <p className="text-xs text-muted-foreground">Add a few more or remove what you no longer need.</p>
            </div>
            <Button variant="outline" size="sm" onClick={() => setEditing((value) => !value)}>
              {editing ? 'Close' : 'Edit'}
            </Button>
          </div>

          {editing ? (
            <div className="space-y-3">
              {draftItems.map((item) => (
                <div key={item.id} className="flex items-center justify-between gap-3 rounded-xl border bg-muted/20 p-2.5">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{item.name}</p>
                    <p className="text-[11px] text-muted-foreground">Tap to adjust</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="icon-sm"
                      onClick={() =>
                        setDraftItems((list) =>
                          list.map((entry) =>
                            entry.id === item.id ? { ...entry, quantity: Math.max(0, entry.quantity - 1) } : entry,
                          ),
                        )
                      }
                    >
                      <span className="text-base leading-none">−</span>
                    </Button>
                    <span className="w-6 text-center text-sm font-semibold tabular-nums">{item.quantity}</span>
                    <Button
                      variant="outline"
                      size="icon-sm"
                      onClick={() =>
                        setDraftItems((list) =>
                          list.map((entry) =>
                            entry.id === item.id ? { ...entry, quantity: Math.min(50, entry.quantity + 1) } : entry,
                          ),
                        )
                      }
                    >
                      <span className="text-base leading-none">＋</span>
                    </Button>
                  </div>
                </div>
              ))}

              <Button className="w-full" onClick={saveEditChanges}>Save changes</Button>
            </div>
          ) : null}
        </section>
      </div>
    </div>
  )
}

function CallWaiter({ tableId }: { tableId: string }) {
  const [pending, startTransition] = React.useTransition()

  return (
    <Button
      variant="outline"
      size="sm"
      loading={pending}
      onClick={() =>
        startTransition(async () => {
          const result = await callAction(() => createServiceRequest({ tableId, type: 'HELP' }))
          if (result.ok) toast.success('A waiter is on the way')
          else toast.error(result.error)
        })
      }
    >
      <Bell className="size-3.5" /> Help
    </Button>
  )
}

const ITEM_STATUS_META: Record<OrderItemStatus, { label: string; className: string }> = {
  QUEUED: { label: 'Pending', className: 'bg-muted text-muted-foreground' },
  PREPARING: { label: 'Preparing', className: 'bg-warning/15 text-warning' },
  READY: { label: 'Ready to serve', className: 'bg-primary/15 text-primary' },
  SERVED: { label: 'Served ✓', className: 'bg-success/15 text-success' },
  CANCELLED: { label: 'Cancelled', className: 'bg-destructive/15 text-destructive' },
}

function ItemStatusPill({ status }: { status: OrderItemStatus }) {
  const meta = ITEM_STATUS_META[status]
  return (
    <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-semibold', meta.className)}>
      {meta.label}
    </span>
  )
}
