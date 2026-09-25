'use client'

import * as React from 'react'
import Link from 'next/link'
import { AnimatePresence, motion } from 'framer-motion'
import type { OrderItemStatus, OrderStatus } from '@prisma/client'
import { Bell, Check, ChefHat, Clock, Flame, Printer, Timer, Utensils } from 'lucide-react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/feedback'
import { Checkbox } from '@/components/ui/primitives'
import { VegIndicator } from '@/components/ui/status'
import { OpsShell, OpsStats } from '@/components/ops-shell'
import { AutoRefresh } from '@/components/auto-refresh'
import {
  EVENTS,
  type OrderItemProgressPayload,
  type OrderStatusPayload,
  type OrderSummaryPayload,
} from '@/lib/realtime/events'
import { cn } from '@/lib/utils'
import { useNotificationSound } from '@/hooks/use-notification-sound'
import { isRealtimeEnabled } from '@/lib/realtime/client'
import { useSocketEvent } from '@/hooks/use-socket'
import { progressItemsAction, updateItemStatus, updateOrderStatus } from '@/features/orders/actions'
import { isGuestChannel } from '@/features/orders/channels'
import { callWaiterAction } from '@/features/floor/actions'
import { setOrderPriorityAction } from '../actions'
import { printKitchenTicket, type PaperWidth } from '@/features/printing/print'
import { callAction } from '@/lib/use-action'

export interface KitchenTicket {
  id: string
  orderNumber: string
  type: 'DINE_IN' | 'TAKEAWAY' | 'DELIVERY'
  status: OrderStatus
  /** So the kitchen can call a waiter to the table (abc.md §7). */
  tableId: string | null
  tableNumber: string | null
  /** Where a delivery goes, with the rider's note. Null for dine-in. */
  deliveryLocationName?: string | null
  customerName: string
  customerPhone: string
  notes: string | null
  placedAt: string
  estimatedMinutes: number
  priority: string
  items: Array<{
    id: string
    name: string
    quantity: number
    notes: string | null
    isVeg: boolean
    status: OrderItemStatus
    /** How many of `quantity` are made / carried out (abc.md §6). */
    preparedQty: number
    servedQty: number
    optionsLabel: string
  }>
}

/** One line's progress, as the checkbox and the "+1" send it. */
type ProgressUpdate = { itemId: string; preparedQty: number }

export interface KitchenStats {
  preparing: number
  ready: number
  completedToday: number
  averageCookMinutes: number
}

/*
 * Two columns, no "New orders" (aO.md §1).
 *
 * Every ticket on this rail is already accepted: a staff order by being typed
 * in, a QR / online order by the cashier's Accept. So the kitchen's only
 * questions are "what am I cooking" and "what is ready to go out".
 */
const COLUMNS: Array<{
  key: 'ACTIVE' | 'READY'
  title: string
  statuses: OrderStatus[]
  accent: string
  icon: React.ElementType
}> = [
  {
    key: 'ACTIVE',
    title: 'Kitchen',
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
  exit,
  sections = [],
  restaurantName,
  branchName,
  paperWidth,
  timeZone,
  branchIds,
}: {
  initialTickets: KitchenTicket[]
  initialStats: KitchenStats
  user: { name: string; role: string }
  /**
   * A way back to the dashboard, rendered by the page.
   *
   * A ReactNode rather than anything computed here: deciding whether this
   * person has somewhere to go needs their permissions, which live on the
   * server. The page renders `<StationExit>` and hands the element across —
   * elements serialize, functions do not.
   */
  exit?: React.ReactNode
  /** Sections this cook may open, with what each is carrying. */
  sections?: Array<{
    stationId: string
    name: string
    queued: number
    preparing: number
    ready: number
  }>
  restaurantName: string
  /** Which kitchen this screen is for (correctionA.md §6). */
  branchName?: string | null
  paperWidth: PaperWidth
  /** The restaurant's IANA zone, so a printed ticket carries ITS clock. */
  timeZone: string
  /**
   * The locations this rail is showing. Null means every one of them — an
   * owner deliberately watching the whole business.
   */
  branchIds: string[] | null
}) {
  /*
   * Whether a live event belongs on this screen.
   *
   * Socket rooms are keyed `r:<restaurantId>:kitchen` with no branch segment,
   * so every kitchen in the chain receives every order the instant it is
   * placed. The server render is branch-scoped, so the stray ticket vanished
   * on the next refresh — but not before it had chimed, flashed for six
   * seconds and told a chef in Kandy to start cooking for Colombo.
   *
   * Filtering on arrival fixes that without touching the socket handshake or
   * the room names, which would mean threading the branch through the
   * connection and into `server.mjs` for the same outcome.
   */
  const isOurs = React.useCallback(
    (payload: { branchId?: string }) =>
      branchIds === null || !payload.branchId || branchIds.includes(payload.branchId),
    [branchIds],
  )
  const [tickets, setTickets] = React.useState(initialTickets)
  const [stats, setStats] = React.useState(initialStats)
  const [search, setSearch] = React.useState('')

  // When realtime is off (serverless), AutoRefresh re-fetches and passes fresh
  // props — re-sync local state from them.
  React.useEffect(() => setTickets(initialTickets), [initialTickets])
  React.useEffect(() => setStats(initialStats), [initialStats])
  const [flashing, setFlashing] = React.useState<Set<string>>(new Set())
  const [soundEnabled, setSoundEnabled] = React.useState(true)
  const [pendingId, setPendingId] = React.useState<string | null>(null)
  const { play } = useNotificationSound(soundEnabled)

  // Serverless has no websocket, so new orders arrive via polling (fresh props),
  // not socket events — chime here too so the kitchen never misses one.
  const seenTicketIds = React.useRef<Set<string>>(new Set(initialTickets.map((t) => t.id)))
  React.useEffect(() => {
    if (isRealtimeEnabled()) return
    const hasNew = initialTickets.some((t) => !seenTicketIds.current.has(t.id))
    seenTicketIds.current = new Set(initialTickets.map((t) => t.id))
    if (hasNew) play('new-order')
  }, [initialTickets, play])

  const toTicket = (payload: OrderSummaryPayload): KitchenTicket => ({
    // A socket payload carries no priority — that comes from the queue query.
    // Normal is the safe default; the next poll replaces it with the real answer.
    priority: 'NORMAL',
    id: payload.id,
    orderNumber: payload.orderNumber,
    type: payload.type as 'DINE_IN' | 'TAKEAWAY' | 'DELIVERY',
    status: payload.status,
    tableId: payload.tableId,
    tableNumber: payload.tableNumber,
    customerName: payload.customerName,
    deliveryLocationName: payload.deliveryLocationName ?? null,
    customerPhone: payload.customerPhone,
    notes: payload.notes,
    placedAt: payload.placedAt,
    estimatedMinutes: payload.estimatedMinutes,
    items: payload.items.map((item) => ({
      id: item.id,
      name: item.name,
      quantity: item.quantity,
      notes: item.notes,
      isVeg: item.isVeg,
      status: item.status as OrderItemStatus,
      preparedQty: item.preparedQty,
      servedQty: item.servedQty,
      optionsLabel: item.options.map((option) => option.name).join(' · '),
    })),
  })

  // A new ticket on the rail: chime, toast, flash for six seconds.
  const arrive = (payload: OrderSummaryPayload, description: string) => {
    setTickets((current) =>
      current.some((ticket) => ticket.id === payload.id) ? current : [...current, toTicket(payload)],
    )
    play('new-order')
    toast.success(`New order ${payload.orderNumber}`, { description })

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
  }

  useSocketEvent(EVENTS.ORDER_CREATED, (payload: OrderSummaryPayload) => {
    if (!isOurs(payload)) return
    /*
     * Nothing PENDING belongs on this rail (aO.md §1). A QR / online order is
     * the till's until the cashier accepts it, and arrives here on
     * `order:updated` the moment that happens — with ACCEPTED as its status —
     * and not a second before. A staff order is accepted as it is placed, so
     * it arrives here already ACCEPTED.
     */
    if (payload.status === 'PENDING') return
    arrive(payload, payload.tableNumber ? `Table ${payload.tableNumber}` : payload.customerName)
  })

  useSocketEvent(EVENTS.ORDER_UPDATED, (payload: OrderSummaryPayload) => {
    if (!isOurs(payload)) return
    if (payload.status === 'PENDING') return
    const onRail = ['ACCEPTED', 'PREPARING', 'READY'].includes(payload.status)
    // aO.md §3: a guest added dishes to a ticket already here — say so.
    const before = tickets.find((ticket) => ticket.id === payload.id)
    const live = (items: Array<{ quantity: number; status: string }>) =>
      items.filter((item) => item.status !== 'CANCELLED').reduce((sum, item) => sum + item.quantity, 0)
    if (before && live(payload.items) > live(before.items)) {
      play('new-order')
      toast.info(`Order ${payload.orderNumber} · ${live(payload.items) - live(before.items)} more item(s) added`, {
        description: payload.tableNumber ? `Table ${payload.tableNumber}` : payload.customerName,
      })
    }
    setTickets((current) => {
      if (current.some((ticket) => ticket.id === payload.id)) {
        return current.map((ticket) => (ticket.id === payload.id ? toTicket(payload) : ticket))
      }
      return current
    })
    // Accepted at the till: it is a new ticket as far as this room is concerned.
    if (onRail && isGuestChannel(payload.channel) && !tickets.some((ticket) => ticket.id === payload.id)) {
      arrive(
        payload,
        `${payload.channel === 'ONLINE' ? 'Online' : 'QR'} order accepted at the till${
          payload.tableNumber ? ` · Table ${payload.tableNumber}` : ''
        }`,
      )
    }
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

  // A section board ticking one of this ticket's lines shows here at once.
  useSocketEvent(EVENTS.ORDER_ITEM_STATUS, (payload: OrderItemProgressPayload) => {
    setTickets((current) =>
      current.map((ticket) =>
        ticket.id !== payload.orderId
          ? ticket
          : {
              ...ticket,
              items: ticket.items.map((item) =>
                item.id === payload.itemId
                  ? {
                      ...item,
                      status: payload.status as OrderItemStatus,
                      preparedQty: payload.preparedQty,
                      servedQty: payload.servedQty,
                    }
                  : item,
              ),
            },
      ),
    )
  })

  /*
   * Item-level progress (abc.md §6): a checkbox per line, Select all, and a
   * "+1" on a line of several. One call per gesture, so Select all is one
   * transaction; the server refuses anything backwards or over the quantity,
   * derives the order's status from its lines, and tells the floor and the
   * guest. The card is updated from the answer, not from hope.
   */
  // abc.md §7: one call per table; a repeat says so instead of ringing twice.
  const callWaiter = async (ticket: KitchenTicket) => {
    if (!ticket.tableId) return
    const result = await callAction(() =>
      callWaiterAction({ tableId: ticket.tableId, note: `From the kitchen · order ${ticket.orderNumber}` }),
    )
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    toast.success(
      result.data.created
        ? `A waiter has been called to table ${result.data.tableNumber}`
        : `Table ${result.data.tableNumber} already has a waiter on the way`,
    )
  }

  /*
   * The middle rung: this dish is on the heat, none of it finished yet.
   *
   * ── Why this is not a counter ───────────────────────────────────────────
   *
   * `preparedQty` counts plates FINISHED, so it cannot say "started". A cook
   * putting three burgers on the grill has finished none of them, and ticking
   * one to say so would tell the guest a burger was ready. So Preparing stays
   * a plain status flip beside the counters — exactly what the section board
   * has always sent — and the two never disagree: a line only offers this
   * while nothing of it is made, and `rowStatusFromCounters` puts a line at
   * PREPARING by itself the moment the first plate is ticked.
   *
   * The server takes it only from QUEUED, so a second tap moves nothing: the
   * button is hidden by then, and a racing tap from another screen is refused
   * where it matters rather than only in the browser.
   */
  const prepare = async (ticket: KitchenTicket, itemId: string) => {
    setPendingId(ticket.id)
    const result = await callAction(() =>
      updateItemStatus({ orderId: ticket.id, itemId, status: 'PREPARING' }),
    )
    setPendingId(null)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    setTickets((current) =>
      current.map((entry) =>
        entry.id !== ticket.id
          ? entry
          : {
              ...entry,
              /*
               * The order follows its lines (`deriveOrderStatus` owns that, one
               * direction only). Both statuses sit in the same column, so this
               * is a label catching up, not a card moving; the socket carries
               * the authoritative value a moment later either way.
               */
              status: entry.status === 'ACCEPTED' ? 'PREPARING' : entry.status,
              items: entry.items.map((item) =>
                item.id === itemId && item.status === 'QUEUED'
                  ? { ...item, status: 'PREPARING' as OrderItemStatus }
                  : item,
              ),
            },
      ),
    )
  }

  const progress = async (ticket: KitchenTicket, updates: ProgressUpdate[]) => {
    if (updates.length === 0) return
    setPendingId(ticket.id)
    const result = await callAction(() => progressItemsAction({ orderId: ticket.id, updates }))
    setPendingId(null)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    const status = result.data.status
    setTickets((current) =>
      status === 'SERVED' || status === 'COMPLETED'
        ? current.filter((entry) => entry.id !== ticket.id)
        : current.map((entry) =>
            entry.id !== ticket.id
              ? entry
              : {
                  ...entry,
                  status,
                  items: entry.items.map((item) => {
                    const update = updates.find((u) => u.itemId === item.id)
                    if (!update) return item
                    const preparedQty = Math.max(item.preparedQty, update.preparedQty)
                    return {
                      ...item,
                      preparedQty,
                      status:
                        item.status === 'SERVED'
                          ? item.status
                          : preparedQty >= item.quantity
                            ? 'READY'
                            : 'PREPARING',
                    }
                  }),
                },
          ),
    )
  }

  /*
   * §15: jump a table up every section's screen at once.
   *
   * Sections sort by priority before waiting time, so this is said once here
   * rather than to each section in turn. Logged with the previous value —
   * "who marked this urgent, and why" is the question asked afterwards.
   */
  const prioritise = async (ticket: KitchenTicket, priority: 'NORMAL' | 'HIGH' | 'URGENT') => {
    setPendingId(ticket.id)
    const result = await callAction(() =>
      setOrderPriorityAction({ orderId: ticket.id, priority }),
    )
    setPendingId(null)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    setTickets((current) =>
      current.map((entry) => (entry.id === ticket.id ? { ...entry, priority } : entry)),
    )
  }

  const advance = async (ticket: KitchenTicket, status: OrderStatus) => {
    setPendingId(ticket.id)
    const result = await callAction(() => updateOrderStatus({ orderId: ticket.id, status }))
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
    const counts = { preparing: 0, ready: 0 }
    for (const ticket of tickets) {
      if (ticket.status === 'ACCEPTED' || ticket.status === 'PREPARING') counts.preparing += 1
      else if (ticket.status === 'READY') counts.ready += 1
    }
    return counts
  }, [tickets])

  const matchesSearch = React.useCallback((ticket: KitchenTicket) => {
    if (!search.trim()) return true

    const query = search.trim().toLowerCase()
    const text = [
      ticket.orderNumber,
      ticket.customerName,
      ticket.customerPhone,
      ticket.tableNumber ?? 'takeaway pickup collection',
      ticket.type.toLowerCase(),
      ticket.notes ?? '',
    ]
      .join(' ')
      .toLowerCase()

    return text.includes(query)
  }, [search])

  return (
    <OpsShell
      title="Kitchen display"
      subtitle={restaurantName}
      branch={branchName}
      branchIds={branchIds}
      canAnswerCalls={false}
      user={user}
      actions={exit}
      soundEnabled={soundEnabled}
      onToggleSound={() => setSoundEnabled((value) => !value)}
    >
      <AutoRefresh intervalMs={2500} />
      <OpsStats
        items={[
          { label: 'Cooking', value: live.preparing, tone: 'primary' },
          { label: 'Ready', value: live.ready, tone: 'success' },
          { label: 'Avg cook time', value: `${stats.averageCookMinutes} min` },
        ]}
      />

      {/*
        The sections, if this kitchen has any.
        This rail stays the place orders are taken on; each section's own screen
        is where its dishes are cooked. A restaurant with no sections never sees
        this strip and works exactly as it always has.
      */}
      {sections.length > 0 ? (
        <div className="flex flex-wrap gap-2 px-4 pt-4">
          {sections.map((section) => {
            const waiting = section.queued + section.preparing
            return (
              <Link
                key={section.stationId}
                href={`/kitchen/${section.stationId}`}
                className="flex items-center gap-2 rounded-lg border-2 border-border bg-card px-3 py-2 text-sm font-medium hover:border-primary/50"
              >
                {section.name}
                {waiting > 0 ? (
                  <span className="rounded-md bg-primary/10 px-1.5 text-xs font-bold tabular-nums text-primary">
                    {waiting}
                  </span>
                ) : null}
                {section.ready > 0 ? (
                  <span className="rounded-md bg-success/10 px-1.5 text-xs font-bold tabular-nums text-success">
                    {section.ready} up
                  </span>
                ) : null}
              </Link>
            )
          })}
        </div>
      ) : null}

      <div className="px-4 pt-4">
        <div className="max-w-md">
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search orders by name, phone, takeaway keyword or order #"
            className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          />
        </div>
      </div>

      <div className="grid gap-4 p-4 lg:grid-cols-2">
        {COLUMNS.map((column) => {
          const columnTickets = tickets
            .filter((ticket) => column.statuses.includes(ticket.status))
            .filter(matchesSearch)
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
                    column.key === 'ACTIVE'
                      ? 'Orders land here the moment they are placed at the till or accepted by the cashier.'
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
                      onPrepare={prepare}
                      onProgress={progress}
                      onCallWaiter={callWaiter}
                      onPrioritise={prioritise}
                      restaurantName={restaurantName}
                      paperWidth={paperWidth}
                      timeZone={timeZone}
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
  onPrepare,
  onProgress,
  onCallWaiter,
  onPrioritise,
  restaurantName,
  paperWidth,
  timeZone,
}: {
  ticket: KitchenTicket
  accent: string
  flashing: boolean
  pending: boolean
  onAdvance: (ticket: KitchenTicket, status: OrderStatus) => void
  /** One line goes on the heat — the rung between accepted and prepared. */
  onPrepare: (ticket: KitchenTicket, itemId: string) => void
  onProgress: (ticket: KitchenTicket, updates: ProgressUpdate[]) => void
  onCallWaiter: (ticket: KitchenTicket) => void
  onPrioritise: (ticket: KitchenTicket, priority: 'NORMAL' | 'HIGH' | 'URGENT') => void
  restaurantName: string
  paperWidth: PaperWidth
  timeZone: string
}) {
  const [elapsed, setElapsed] = React.useState(() => minutesSince(ticket.placedAt))

  React.useEffect(() => {
    const timer = setInterval(() => setElapsed(minutesSince(ticket.placedAt)), 15_000)
    return () => clearInterval(timer)
  }, [ticket.placedAt])

  // Colour the timer as the ticket ages against its own estimate.
  const overdue = elapsed > ticket.estimatedMinutes && ticket.status !== 'READY'
  const warning = !overdue && elapsed > ticket.estimatedMinutes * 0.7

  // Every ticket on this rail is accepted (aO.md §1), so every line has its box.
  const canTick = true
  // A cancelled line is shown, crossed out, and counts for nothing (aO.md §4).
  const liveItems = ticket.items.filter((item) => item.status !== 'CANCELLED')
  const orderedCount = liveItems.reduce((sum, item) => sum + item.quantity, 0)
  const preparedCount = liveItems.reduce((sum, item) => sum + item.preparedQty, 0)
  const allPrepared = liveItems.length > 0 && preparedCount >= orderedCount

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
      <div className="flex items-stretch justify-between gap-2 border-b">
        {/* Table number — the biggest thing on the ticket so the line can
            identify the table across the room at a glance. */}
        <div
          className={cn(
            'flex shrink-0 flex-col items-center justify-center px-3.5 py-2 text-center leading-none',
            ticket.tableNumber ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground',
          )}
        >
          {ticket.tableNumber ? (
            <>
              <span className="text-[10px] font-bold uppercase tracking-widest opacity-80">Table</span>
              <span className="text-3xl font-black tabular-nums">{ticket.tableNumber}</span>
            </>
          ) : (
            <>
              <Utensils className="size-5" />
              <span className="mt-1 text-[10px] font-bold uppercase tracking-wide">Takeaway</span>
            </>
          )}
        </div>

        <div className="flex min-w-0 flex-1 items-start justify-between gap-2 py-3 pr-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-bold leading-tight tracking-tight">#{ticket.orderNumber}</p>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              {ticket.customerName}
              {ticket.type === 'TAKEAWAY' ? ' · Pickup' : ''}
            </p>
            {/*
              Where it is going, on the ticket that packs it. A delivery with
              no destination in front of the person bagging it is one somebody
              has to walk over and ask about.
            */}
            {ticket.deliveryLocationName ? (
              <p className="mt-0.5 truncate text-xs font-semibold text-primary">
                → {ticket.deliveryLocationName}
              </p>
            ) : null}
          </div>
          <span
            className={cn(
              'flex shrink-0 items-center gap-1 font-mono text-xs font-semibold tabular-nums',
              overdue ? 'text-destructive' : warning ? 'text-warning' : 'text-muted-foreground',
            )}
          >
            <Clock className="size-3" />
            {elapsed}m{overdue ? ' late' : ''}
          </span>
        </div>
      </div>

      {/* abc.md §6: a box per line and Select all, once the ticket is taken on.
          A box only ever gets ticked — progress does not go backwards — and a
          line of several can be ticked one plate at a time. */}
      {canTick ? (
        <label className="flex cursor-pointer items-center gap-2 border-t bg-muted/30 px-3 py-1.5 text-xs font-semibold">
          <Checkbox
            checked={allPrepared}
            disabled={pending || allPrepared}
            onCheckedChange={() =>
              onProgress(
                ticket,
                liveItems
                  .filter((item) => item.preparedQty < item.quantity)
                  .map((item) => ({ itemId: item.id, preparedQty: item.quantity })),
              )
            }
            aria-label="Select all"
          />
          Select all
          <span className="ml-auto font-normal tabular-nums text-muted-foreground">
            {preparedCount} of {orderedCount} prepared
          </span>
        </label>
      ) : null}

      <ul className="divide-y">
        {ticket.items.map((item) => {
          const done = item.preparedQty >= item.quantity
          const cancelled = item.status === 'CANCELLED'
          return (
          <li
            key={item.id}
            className={cn('flex gap-2.5 px-3 py-2.5', cancelled && 'bg-destructive/5')}
            aria-disabled={cancelled || undefined}
            data-cancelled={cancelled || undefined}
          >
            {canTick && !cancelled ? (
              <Checkbox
                className="mt-1"
                checked={done}
                disabled={pending || done}
                onCheckedChange={() => onProgress(ticket, [{ itemId: item.id, preparedQty: item.quantity }])}
                aria-label={`${item.name} prepared`}
              />
            ) : null}
            <span
              className={cn(
                'flex size-7 shrink-0 items-center justify-center rounded-md text-sm font-bold',
                cancelled ? 'bg-muted text-muted-foreground line-through' : 'bg-primary/10 text-primary',
              )}
            >
              {item.quantity}
            </span>
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-1.5 text-sm font-semibold leading-tight">
                <VegIndicator isVeg={item.isVeg} />
                <span
                  className={cn(
                    'truncate',
                    (item.status === 'SERVED' || cancelled) && 'text-muted-foreground line-through',
                  )}
                >
                  {item.name}
                </span>
                {cancelled ? (
                  // Not silently removed: the kitchen sees it was taken back and does not cook it.
                  <span className="ml-auto flex shrink-0 items-center gap-1 rounded-md bg-destructive/10 px-1.5 py-0.5 text-[11px] font-bold text-destructive">
                    Cancelled — do not prepare
                  </span>
                ) : item.status === 'SERVED' ? (
                  <span className="ml-auto flex shrink-0 items-center gap-1 text-[11px] font-bold text-success">
                    <Check className="size-3" /> Served
                  </span>
                ) : done ? (
                  <span className="ml-auto flex shrink-0 items-center gap-1 text-[11px] font-bold text-success">
                    <Check className="size-3" /> Ready
                  </span>
                ) : canTick && item.status === 'QUEUED' ? (
                  /*
                   * The middle rung, per line: this dish has gone on the heat.
                   * It sits where "+1" sits for a line already under way — a
                   * queued line has nothing prepared, so the only honest next
                   * step is starting it, and ticking a plate from here would
                   * skip straight past the state the guest is waiting to see.
                   * The button leaves as the line does, so it cannot be
                   * pressed twice.
                   */
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => onPrepare(ticket, item.id)}
                    className="ml-auto shrink-0 rounded-md border border-warning/40 bg-warning/10 px-1.5 py-0.5 text-[11px] font-bold text-warning hover:bg-warning/20 disabled:opacity-50"
                    aria-label={`Start preparing ${item.name}`}
                    title="On the heat — the guest sees this straight away"
                  >
                    <Flame className="mr-0.5 inline size-3" />
                    Preparing
                  </button>
                ) : canTick && item.quantity > 1 ? (
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => onProgress(ticket, [{ itemId: item.id, preparedQty: item.preparedQty + 1 }])}
                    className="ml-auto shrink-0 rounded-md border border-border px-1.5 py-0.5 text-[11px] font-semibold tabular-nums hover:bg-muted disabled:opacity-50"
                    aria-label={`One more ${item.name} prepared`}
                    title="One more plate prepared"
                  >
                    {item.preparedQty} of {item.quantity} · +1
                  </button>
                ) : item.status === 'PREPARING' ? (
                  // Started, nothing finished: the same word the guest is reading.
                  <span className="ml-auto flex shrink-0 items-center gap-1 text-[11px] font-bold text-warning">
                    <Flame className="size-3" /> Preparing
                  </span>
                ) : null}
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
          )
        })}
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
          onClick={() => printKitchenTicket({ ...ticket, timeZone }, restaurantName, paperWidth)}
          aria-label="Print ticket"
          title="Print ticket"
        >
          <Printer />
        </Button>

        {/* abc.md §7: the pass can call a waiter to the table — food is up,
            or a question for the guest — through the same door as the guest. */}
        {ticket.tableId ? (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => onCallWaiter(ticket)}
            aria-label={`Call a waiter to table ${ticket.tableNumber ?? ''}`}
            title="Call a waiter to this table"
          >
            <Bell />
          </Button>
        ) : null}

        {ticket.status === 'ACCEPTED' || ticket.status === 'PREPARING' ? (
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

        {/* Rush this table. Sections sort on it, so one tap here moves it up
            every screen rather than needing to be said to each in turn. */}
        <Button
          variant={ticket.priority === 'NORMAL' ? 'ghost' : 'destructive'}
          size="icon-sm"
          onClick={() => onPrioritise(ticket, ticket.priority === 'NORMAL' ? 'URGENT' : 'NORMAL')}
          aria-label={ticket.priority === 'NORMAL' ? 'Mark urgent' : 'Back to normal priority'}
          title={ticket.priority === 'NORMAL' ? 'Mark urgent' : 'Back to normal priority'}
        >
          <Flame />
        </Button>

        <Badge variant="outline" className="shrink-0">
          <Timer /> {ticket.estimatedMinutes}m
        </Badge>
      </div>
    </motion.article>
  )
}

function minutesSince(iso: string): number {
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000))
}
