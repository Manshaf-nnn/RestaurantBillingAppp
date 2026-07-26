'use client'

import * as React from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import type { OrderStatus } from '@prisma/client'
import { Check, ChefHat, Clock, Flame, Hand, Printer, Timer, Utensils, X } from 'lucide-react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/feedback'
import { VegIndicator } from '@/components/ui/status'
import { OpsShell, OpsStats } from '@/components/ops-shell'
import { AutoRefresh } from '@/components/auto-refresh'
import { EVENTS, type OrderStatusPayload, type OrderSummaryPayload } from '@/lib/realtime/events'
import { cn } from '@/lib/utils'
import { useNotificationSound } from '@/hooks/use-notification-sound'
import { useSocketEvent } from '@/hooks/use-socket'
import { updateOrderStatus } from '@/features/orders/actions'
import { printKitchenTicket } from '@/features/printing/print'

export interface KitchenTicket {
  id: string
  orderNumber: string
  status: OrderStatus
  tableNumber: string | null
  customerName: string
  notes: string | null
  placedAt: string
  estimatedMinutes: number
  items: Array<{
    id: string
    name: string
    quantity: number
    notes: string | null
    isVeg: boolean
    optionsLabel: string
  }>
}

export interface KitchenStats {
  pending: number
  preparing: number
  ready: number
  completedToday: number
  averageCookMinutes: number
}

const COLUMNS: Array<{
  key: 'PENDING' | 'ACTIVE' | 'READY'
  title: string
  statuses: OrderStatus[]
  accent: string
  icon: React.ElementType
}> = [
  { key: 'PENDING', title: 'New orders', statuses: ['PENDING'], accent: 'border-t-warning', icon: Hand },
  {
    key: 'ACTIVE',
    title: 'In the kitchen',
    statuses: ['ACCEPTED', 'PREPARING'],
    accent: 'border-t-primary',
    icon: Flame,
  },
  { key: 'READY', title: 'Ready to serve', statuses: ['READY'], accent: 'border-t-success', icon: Check },
]

export function KitchenBoard({
  initialTickets,
  initialStats,
  user,
  restaurantName,
}: {
  initialTickets: KitchenTicket[]
  initialStats: KitchenStats
  user: { name: string; role: string }
  restaurantName: string
}) {
  const [tickets, setTickets] = React.useState(initialTickets)
  const [stats, setStats] = React.useState(initialStats)

  // When realtime is off (serverless), AutoRefresh re-fetches and passes fresh
  // props — re-sync local state from them.
  React.useEffect(() => setTickets(initialTickets), [initialTickets])
  React.useEffect(() => setStats(initialStats), [initialStats])
  const [flashing, setFlashing] = React.useState<Set<string>>(new Set())
  const [soundEnabled, setSoundEnabled] = React.useState(true)
  const [pendingId, setPendingId] = React.useState<string | null>(null)
  const { play } = useNotificationSound(soundEnabled)

  const toTicket = (payload: OrderSummaryPayload): KitchenTicket => ({
    id: payload.id,
    orderNumber: payload.orderNumber,
    status: payload.status,
    tableNumber: payload.tableNumber,
    customerName: payload.customerName,
    notes: payload.notes,
    placedAt: payload.placedAt,
    estimatedMinutes: payload.estimatedMinutes,
    items: payload.items.map((item) => ({
      id: item.id,
      name: item.name,
      quantity: item.quantity,
      notes: item.notes,
      isVeg: item.isVeg,
      optionsLabel: item.options.map((option) => option.name).join(' · '),
    })),
  })

  useSocketEvent(EVENTS.ORDER_CREATED, (payload: OrderSummaryPayload) => {
    setTickets((current) =>
      current.some((ticket) => ticket.id === payload.id) ? current : [...current, toTicket(payload)],
    )
    setStats((current) => ({ ...current, pending: current.pending + 1 }))
    play('new-order')
    toast.success(`New order ${payload.orderNumber}`, {
      description: payload.tableNumber ? `Table ${payload.tableNumber}` : payload.customerName,
    })

    // Flash the card for 6 seconds so it is impossible to miss across a room.
    setFlashing((current) => new Set(current).add(payload.id))
    setTimeout(
      () =>
        setFlashing((current) => {
          const next = new Set(current)
          next.delete(payload.id)
          return next
        }),
      6000,
    )
  })

  useSocketEvent(EVENTS.ORDER_UPDATED, (payload: OrderSummaryPayload) => {
    setTickets((current) =>
      current.map((ticket) => (ticket.id === payload.id ? toTicket(payload) : ticket)),
    )
  })

  useSocketEvent(EVENTS.ORDER_STATUS, (payload: OrderStatusPayload) => {
    setTickets((current) =>
      payload.status === 'SERVED' || payload.status === 'COMPLETED' || payload.status === 'CANCELLED'
        ? current.filter((ticket) => ticket.id !== payload.orderId)
        : current.map((ticket) =>
            ticket.id === payload.orderId ? { ...ticket, status: payload.status } : ticket,
          ),
    )
  })

  useSocketEvent(EVENTS.ORDER_CANCELLED, (payload: OrderStatusPayload) => {
    setTickets((current) => current.filter((ticket) => ticket.id !== payload.orderId))
    toast.warning(`Order ${payload.orderNumber} was cancelled`)
  })

  const advance = async (ticket: KitchenTicket, status: OrderStatus) => {
    setPendingId(ticket.id)
    const result = await updateOrderStatus({ orderId: ticket.id, status })
    setPendingId(null)

    if (!result.ok) {
      toast.error(result.error)
      return
    }

    setTickets((current) =>
      status === 'SERVED'
        ? current.filter((entry) => entry.id !== ticket.id)
        : current.map((entry) => (entry.id === ticket.id ? { ...entry, status } : entry)),
    )

    if (status === 'READY') play('ready')
  }

  const live = React.useMemo(() => {
    const counts = { pending: 0, preparing: 0, ready: 0 }
    for (const ticket of tickets) {
      if (ticket.status === 'PENDING') counts.pending += 1
      else if (ticket.status === 'ACCEPTED' || ticket.status === 'PREPARING') counts.preparing += 1
      else if (ticket.status === 'READY') counts.ready += 1
    }
    return counts
  }, [tickets])

  return (
    <OpsShell
      title="Kitchen display"
      subtitle={restaurantName}
      user={user}
      soundEnabled={soundEnabled}
      onToggleSound={() => setSoundEnabled((value) => !value)}
    >
      <AutoRefresh intervalMs={5000} />
      <OpsStats
        items={[
          { label: 'New', value: live.pending, tone: 'warning' },
          { label: 'Cooking', value: live.preparing, tone: 'primary' },
          { label: 'Ready', value: live.ready, tone: 'success' },
          { label: 'Avg cook time', value: `${stats.averageCookMinutes} min` },
        ]}
      />

      <div className="grid gap-4 p-4 lg:grid-cols-3">
        {COLUMNS.map((column) => {
          const columnTickets = tickets
            .filter((ticket) => column.statuses.includes(ticket.status))
            .sort((a, b) => new Date(a.placedAt).getTime() - new Date(b.placedAt).getTime())

          return (
            <section key={column.key} className="flex flex-col gap-3">
              <header className="flex items-center justify-between rounded-lg border bg-background px-3 py-2">
                <span className="flex items-center gap-2 text-sm font-semibold">
                  <column.icon className="size-4" />
                  {column.title}
                </span>
                <Badge variant="secondary">{columnTickets.length}</Badge>
              </header>

              {columnTickets.length === 0 ? (
                <EmptyState
                  className="border-dashed py-10"
                  icon={<ChefHat />}
                  title="Nothing here"
                  description={
                    column.key === 'PENDING'
                      ? 'New orders will appear here the moment they are placed.'
                      : column.key === 'ACTIVE'
                        ? 'Accept an order to start cooking.'
                        : 'Finished dishes will land here.'
                  }
                />
              ) : (
                <AnimatePresence mode="popLayout">
                  {columnTickets.map((ticket) => (
                    <TicketCard
                      key={ticket.id}
                      ticket={ticket}
                      accent={column.accent}
                      flashing={flashing.has(ticket.id)}
                      pending={pendingId === ticket.id}
                      onAdvance={advance}
                      restaurantName={restaurantName}
                    />
                  ))}
                </AnimatePresence>
              )}
            </section>
          )
        })}
      </div>
    </OpsShell>
  )
}

function TicketCard({
  ticket,
  accent,
  flashing,
  pending,
  onAdvance,
  restaurantName,
}: {
  ticket: KitchenTicket
  accent: string
  flashing: boolean
  pending: boolean
  onAdvance: (ticket: KitchenTicket, status: OrderStatus) => void
  restaurantName: string
}) {
  const [elapsed, setElapsed] = React.useState(() => minutesSince(ticket.placedAt))

  React.useEffect(() => {
    const timer = setInterval(() => setElapsed(minutesSince(ticket.placedAt)), 15_000)
    return () => clearInterval(timer)
  }, [ticket.placedAt])

  // Colour the timer as the ticket ages against its own estimate.
  const overdue = elapsed > ticket.estimatedMinutes && ticket.status !== 'READY'
  const warning = !overdue && elapsed > ticket.estimatedMinutes * 0.7

  return (
    <motion.article
      layout
      initial={{ opacity: 0, scale: 0.96, y: 8 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.15 } }}
      transition={{ type: 'spring', stiffness: 320, damping: 28 }}
      className={cn(
        'overflow-hidden rounded-xl border border-t-4 bg-card shadow-soft',
        accent,
        flashing && 'animate-flash-ring ring-2 ring-primary',
      )}
    >
      <div className="flex items-start justify-between gap-2 border-b p-3">
        <div className="min-w-0">
          <p className="text-lg font-bold leading-none tracking-tight">#{ticket.orderNumber}</p>
          <p className="mt-1 truncate text-xs text-muted-foreground">{ticket.customerName}</p>
        </div>

        <div className="flex shrink-0 flex-col items-end gap-1">
          {ticket.tableNumber ? (
            <Badge variant="solid" size="lg" className="font-bold">
              T{ticket.tableNumber}
            </Badge>
          ) : (
            <Badge variant="secondary">Takeaway</Badge>
          )}
          <span
            className={cn(
              'flex items-center gap-1 font-mono text-xs font-semibold tabular-nums',
              overdue ? 'text-destructive' : warning ? 'text-warning' : 'text-muted-foreground',
            )}
          >
            <Clock className="size-3" />
            {elapsed}m
            {overdue ? ' late' : ''}
          </span>
        </div>
      </div>

      <ul className="divide-y">
        {ticket.items.map((item) => (
          <li key={item.id} className="flex gap-2.5 px-3 py-2.5">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-sm font-bold text-primary">
              {item.quantity}
            </span>
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-1.5 text-sm font-semibold leading-tight">
                <VegIndicator isVeg={item.isVeg} />
                <span className="truncate">{item.name}</span>
              </p>
              {item.optionsLabel ? (
                <p className="mt-0.5 text-xs text-muted-foreground">{item.optionsLabel}</p>
              ) : null}
              {item.notes ? (
                <p className="mt-1 rounded bg-warning/10 px-1.5 py-0.5 text-xs font-medium text-warning">
                  {item.notes}
                </p>
              ) : null}
            </div>
          </li>
        ))}
      </ul>

      {ticket.notes ? (
        <p className="border-t bg-warning/10 px-3 py-2 text-xs font-medium text-warning">
          Order note: {ticket.notes}
        </p>
      ) : null}

      <div className="flex items-center gap-2 border-t p-3">
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => printKitchenTicket(ticket, restaurantName)}
          aria-label="Print ticket"
          title="Print ticket"
        >
          <Printer />
        </Button>

        {ticket.status === 'PENDING' ? (
          <Button className="flex-1" loading={pending} onClick={() => onAdvance(ticket, 'ACCEPTED')}>
            <Hand /> Accept
          </Button>
        ) : null}

        {ticket.status === 'ACCEPTED' ? (
          <Button className="flex-1" loading={pending} onClick={() => onAdvance(ticket, 'PREPARING')}>
            <Flame /> Start cooking
          </Button>
        ) : null}

        {ticket.status === 'PREPARING' ? (
          <Button
            variant="success"
            className="flex-1"
            loading={pending}
            onClick={() => onAdvance(ticket, 'READY')}
          >
            <Check /> Mark ready
          </Button>
        ) : null}

        {ticket.status === 'READY' ? (
          <Button
            variant="outline"
            className="flex-1"
            loading={pending}
            onClick={() => onAdvance(ticket, 'SERVED')}
          >
            <Utensils /> Handed over
          </Button>
        ) : null}

        {ticket.status === 'PENDING' ? (
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground hover:text-destructive"
            onClick={() => onAdvance(ticket, 'CANCELLED')}
            aria-label="Reject order"
            title="Reject order"
          >
            <X />
          </Button>
        ) : (
          <Badge variant="outline" className="shrink-0">
            <Timer /> {ticket.estimatedMinutes}m
          </Badge>
        )}
      </div>
    </motion.article>
  )
}

function minutesSince(iso: string): number {
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000))
}
