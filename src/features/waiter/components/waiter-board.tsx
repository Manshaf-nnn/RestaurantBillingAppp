'use client'

import * as React from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import type { OrderItemStatus, ServiceRequestType, TableStatus } from '@prisma/client'
import {
  Bell,
  Check,
  ChefHat,
  Clock,
  HandPlatter,
  Receipt,
  Sparkles,
  Users,
} from 'lucide-react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/feedback'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/primitives'
import { OrderStatusBadge, TableStatusBadge, VegIndicator } from '@/components/ui/status'
import { OpsShell, OpsStats } from '@/components/ops-shell'
import { AutoRefresh } from '@/components/auto-refresh'
import { EVENTS, type OrderStatusPayload, type ServiceRequestPayload } from '@/lib/realtime/events'
import { formatMoney } from '@/lib/money'
import { cn } from '@/lib/utils'
import { useNotificationSound } from '@/hooks/use-notification-sound'
import { isRealtimeEnabled } from '@/lib/realtime/client'
import { useSocketEvent } from '@/hooks/use-socket'
import { resolveServiceRequest, updateItemStatus, updateOrderStatus } from '@/features/orders/actions'

export interface WaiterOrder {
  id: string
  orderNumber: string
  status: 'PENDING' | 'ACCEPTED' | 'PREPARING' | 'READY'
  tableNumber: string | null
  customerName: string
  grandTotal: number
  readyAt: string | null
  placedAt: string
  items: Array<{
    id: string
    name: string
    quantity: number
    isVeg: boolean
    notes: string | null
    status: OrderItemStatus
  }>
}

export interface WaiterRequest {
  id: string
  tableNumber: string
  type: ServiceRequestType
  note: string | null
  createdAt: string
}

export interface WaiterTable {
  id: string
  number: string
  label: string | null
  area: string | null
  capacity: number
  status: TableStatus
  openOrders: Array<{ id: string; orderNumber: string; status: string; grandTotal: number; paymentStatus: string }>
}

const REQUEST_META: Record<ServiceRequestType, { label: string; emoji: string }> = {
  WATER: { label: 'Water', emoji: '💧' },
  PLATES: { label: 'Extra plates', emoji: '🍽️' },
  BILL: { label: 'Bill requested', emoji: '🧾' },
  HELP: { label: 'Needs help', emoji: '🙋' },
  CLEAN_TABLE: { label: 'Clean table', emoji: '🧹' },
}

export function WaiterBoard({
  initialReady,
  initialServing,
  initialRequests,
  initialTables,
  user,
  restaurantName,
  currency,
  locale,
}: {
  initialReady: WaiterOrder[]
  initialServing: WaiterOrder[]
  initialRequests: WaiterRequest[]
  initialTables: WaiterTable[]
  user: { name: string; role: string }
  restaurantName: string
  currency: string
  locale: string
}) {
  const [ready, setReady] = React.useState(initialReady)
  const [serving, setServing] = React.useState(initialServing)
  const [requests, setRequests] = React.useState(initialRequests)
  const [tables, setTables] = React.useState(initialTables)

  // Re-sync from fresh server props when polling (realtime off / serverless).
  React.useEffect(() => setReady(initialReady), [initialReady])
  React.useEffect(() => setServing(initialServing), [initialServing])
  React.useEffect(() => setRequests(initialRequests), [initialRequests])
  React.useEffect(() => setTables(initialTables), [initialTables])
  const [soundEnabled, setSoundEnabled] = React.useState(true)
  const [busyId, setBusyId] = React.useState<string | null>(null)
  const { play } = useNotificationSound(soundEnabled)

  // On serverless there's no websocket — new requests / ready orders arrive via
  // polling (fresh props). Chime here so waiters are alerted with sound too.
  const seenRequestIds = React.useRef<Set<string>>(new Set(initialRequests.map((r) => r.id)))
  const seenReadyIds = React.useRef<Set<string>>(new Set(initialReady.map((o) => o.id)))
  React.useEffect(() => {
    if (isRealtimeEnabled()) return
    const hasNew = initialRequests.some((r) => !seenRequestIds.current.has(r.id))
    seenRequestIds.current = new Set(initialRequests.map((r) => r.id))
    if (hasNew) play('alert')
  }, [initialRequests, play])
  React.useEffect(() => {
    if (isRealtimeEnabled()) return
    const hasNew = initialReady.some((o) => !seenReadyIds.current.has(o.id))
    seenReadyIds.current = new Set(initialReady.map((o) => o.id))
    if (hasNew) play('ready')
  }, [initialReady, play])

  useSocketEvent(EVENTS.ORDER_STATUS, (payload: OrderStatusPayload) => {
    if (payload.status === 'READY') {
      setServing((current) => {
        const promoted = current.find((order) => order.id === payload.orderId)
        if (promoted) {
          setReady((existing) =>
            existing.some((order) => order.id === promoted.id)
              ? existing
              : [...existing, { ...promoted, status: 'READY', readyAt: payload.at }],
          )
        }
        return current.filter((order) => order.id !== payload.orderId)
      })
      play('ready')
      toast.success(`Order ${payload.orderNumber} is ready`, {
        description: payload.tableNumber ? `Table ${payload.tableNumber}` : undefined,
      })
      return
    }

    if (['SERVED', 'COMPLETED', 'CANCELLED'].includes(payload.status)) {
      setReady((current) => current.filter((order) => order.id !== payload.orderId))
      setServing((current) => current.filter((order) => order.id !== payload.orderId))
      return
    }

    setServing((current) =>
      current.map((order) =>
        order.id === payload.orderId
          ? { ...order, status: payload.status as WaiterOrder['status'] }
          : order,
      ),
    )
  })

  useSocketEvent(EVENTS.SERVICE_REQUEST_CREATED, (payload: ServiceRequestPayload) => {
    setRequests((current) =>
      current.some((request) => request.id === payload.id)
        ? current
        : [
            ...current,
            {
              id: payload.id,
              tableNumber: payload.tableNumber,
              type: payload.type,
              note: payload.note,
              createdAt: payload.createdAt,
            },
          ],
    )
    play('alert')
    toast.warning(`Table ${payload.tableNumber} · ${REQUEST_META[payload.type].label}`)
  })

  useSocketEvent(EVENTS.SERVICE_REQUEST_RESOLVED, (payload: { id: string }) => {
    setRequests((current) => current.filter((request) => request.id !== payload.id))
  })

  // Serve a single item. When it's the last outstanding item the server moves
  // the whole order to SERVED, so we drop the card once every item is served.
  const serveItem = async (orderId: string, itemId: string) => {
    setBusyId(itemId)
    const result = await updateItemStatus({ orderId, itemId, status: 'SERVED' })
    setBusyId(null)

    if (!result.ok) {
      toast.error(result.error)
      return
    }
    setReady((current) =>
      current
        .map((order) =>
          order.id === orderId
            ? {
                ...order,
                items: order.items.map((it) =>
                  it.id === itemId ? { ...it, status: 'SERVED' as OrderItemStatus } : it,
                ),
              }
            : order,
        )
        .filter((order) => !order.items.every((it) => it.status === 'SERVED')),
    )
  }

  const markDelivered = async (order: WaiterOrder) => {
    setBusyId(order.id)
    const result = await updateOrderStatus({ orderId: order.id, status: 'SERVED' })
    setBusyId(null)

    if (!result.ok) {
      toast.error(result.error)
      return
    }
    setReady((current) => current.filter((entry) => entry.id !== order.id))
    toast.success(`Order ${order.orderNumber} served`)
  }

  const clearRequest = async (request: WaiterRequest) => {
    setBusyId(request.id)
    const result = await resolveServiceRequest(request.id)
    setBusyId(null)

    if (!result.ok) {
      toast.error(result.error)
      return
    }
    setRequests((current) => current.filter((entry) => entry.id !== request.id))
  }

  const occupied = tables.filter((table) => table.status === 'OCCUPIED').length

  return (
    <OpsShell
      title="Waiter station"
      subtitle={restaurantName}
      user={user}
      soundEnabled={soundEnabled}
      onToggleSound={() => setSoundEnabled((value) => !value)}
    >
      <AutoRefresh intervalMs={5000} />
      <OpsStats
        items={[
          { label: 'Ready to serve', value: ready.length, tone: 'success' },
          { label: 'In the kitchen', value: serving.length, tone: 'primary' },
          { label: 'Open requests', value: requests.length, tone: requests.length ? 'warning' : 'default' },
          { label: 'Tables occupied', value: `${occupied}/${tables.length}` },
        ]}
      />

      <Tabs defaultValue="serve" className="p-4">
        <TabsList className="w-full sm:w-auto">
          <TabsTrigger value="serve" className="flex-1 sm:flex-none">
            <HandPlatter className="size-4" /> Serve
            {ready.length ? <Badge variant="success" size="sm">{ready.length}</Badge> : null}
          </TabsTrigger>
          <TabsTrigger value="requests" className="flex-1 sm:flex-none">
            <Bell className="size-4" /> Requests
            {requests.length ? <Badge variant="warning" size="sm">{requests.length}</Badge> : null}
          </TabsTrigger>
          <TabsTrigger value="tables" className="flex-1 sm:flex-none">
            <Users className="size-4" /> Tables
          </TabsTrigger>
        </TabsList>

        {/* ── ready to serve ─────────────────────────────────────── */}
        <TabsContent value="serve">
          {ready.length === 0 ? (
            <EmptyState
              icon={<ChefHat />}
              title="Nothing waiting"
              description="When the kitchen marks an order ready it appears here with a chime."
            />
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <AnimatePresence mode="popLayout">
                {ready.map((order) => (
                  <motion.article
                    key={order.id}
                    layout
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.97 }}
                    className="overflow-hidden rounded-xl border border-t-4 border-t-success bg-card shadow-soft"
                  >
                    <div className="flex items-start justify-between gap-2 border-b p-3">
                      <div className="min-w-0">
                        <p className="text-lg font-bold leading-none">#{order.orderNumber}</p>
                        <p className="mt-1 truncate text-xs text-muted-foreground">
                          {order.customerName}
                        </p>
                      </div>
                      {order.tableNumber ? (
                        <Badge variant="solid" size="lg" className="font-bold">
                          T{order.tableNumber}
                        </Badge>
                      ) : (
                        <Badge variant="secondary">Takeaway</Badge>
                      )}
                    </div>

                    <ul className="divide-y text-sm">
                      {order.items.map((item) => (
                        <li key={item.id} className="flex items-center gap-2 px-3 py-2">
                          <span className="flex size-6 shrink-0 items-center justify-center rounded bg-primary/10 text-xs font-bold text-primary">
                            {item.quantity}
                          </span>
                          <VegIndicator isVeg={item.isVeg} />
                          <span
                            className={cn(
                              'flex-1 truncate',
                              item.status === 'SERVED' && 'text-muted-foreground line-through',
                            )}
                          >
                            {item.name}
                          </span>
                          {item.status === 'SERVED' ? (
                            <span className="flex items-center gap-1 text-xs font-semibold text-success">
                              <Check className="size-3.5" /> Served
                            </span>
                          ) : (
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 shrink-0 px-2.5 text-xs"
                              loading={busyId === item.id}
                              onClick={() => serveItem(order.id, item.id)}
                            >
                              Serve
                            </Button>
                          )}
                        </li>
                      ))}
                    </ul>

                    <div className="flex items-center gap-2 border-t p-3">
                      <span className="flex items-center gap-1 text-xs text-muted-foreground">
                        <Clock className="size-3" />
                        {order.readyAt ? `${minutesSince(order.readyAt)}m waiting` : 'just now'}
                      </span>
                      <Button
                        variant="success"
                        size="sm"
                        className="ml-auto"
                        loading={busyId === order.id}
                        onClick={() => markDelivered(order)}
                      >
                        <Check /> Serve all
                      </Button>
                    </div>
                  </motion.article>
                ))}
              </AnimatePresence>
            </div>
          )}
        </TabsContent>

        {/* ── guest requests ─────────────────────────────────────── */}
        <TabsContent value="requests">
          {requests.length === 0 ? (
            <EmptyState
              icon={<Sparkles />}
              title="All clear"
              description="Guest requests from the table QR appear here instantly."
            />
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <AnimatePresence mode="popLayout">
                {requests.map((request) => (
                  <motion.div
                    key={request.id}
                    layout
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.97 }}
                    className="flex items-center gap-3 rounded-xl border border-warning/40 bg-warning/5 p-4"
                  >
                    <span className="text-3xl">{REQUEST_META[request.type].emoji}</span>
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold">Table {request.tableNumber}</p>
                      <p className="text-sm text-muted-foreground">
                        {REQUEST_META[request.type].label}
                        {request.note ? ` · ${request.note}` : ''}
                      </p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {minutesSince(request.createdAt)}m ago
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      loading={busyId === request.id}
                      onClick={() => clearRequest(request)}
                    >
                      <Check /> Done
                    </Button>
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>
          )}
        </TabsContent>

        {/* ── floor plan ─────────────────────────────────────────── */}
        <TabsContent value="tables">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {tables.map((table) => {
              const unpaid = table.openOrders.filter((order) => order.paymentStatus !== 'PAID')
              const total = table.openOrders.reduce((sum, order) => sum + order.grandTotal, 0)

              return (
                <div
                  key={table.id}
                  className={cn(
                    'rounded-xl border bg-card p-4 shadow-soft transition-colors',
                    table.status === 'OCCUPIED' && 'border-primary/40 bg-primary/5',
                    table.status === 'CLEANING' && 'border-warning/40 bg-warning/5',
                  )}
                >
                  <div className="flex items-start justify-between">
                    <p className="text-2xl font-bold leading-none">{table.number}</p>
                    <TableStatusBadge status={table.status} />
                  </div>

                  <p className="mt-1 text-xs text-muted-foreground">
                    {table.area ? `${table.area} · ` : ''}seats {table.capacity}
                  </p>

                  {table.openOrders.length ? (
                    <div className="mt-3 space-y-1 border-t pt-2 text-xs">
                      {table.openOrders.map((order) => (
                        <div key={order.id} className="flex items-center justify-between gap-2">
                          <span className="truncate font-medium">#{order.orderNumber}</span>
                          <OrderStatusBadge
                            status={order.status as WaiterOrder['status']}
                            showIcon={false}
                          />
                        </div>
                      ))}
                      <div className="flex items-center justify-between pt-1 font-semibold">
                        <span>Total</span>
                        <span>{formatMoney(total, currency, locale)}</span>
                      </div>
                      {unpaid.length ? (
                        <p className="flex items-center gap-1 pt-1 text-destructive">
                          <Receipt className="size-3" /> {unpaid.length} unpaid
                        </p>
                      ) : null}
                    </div>
                  ) : (
                    <p className="mt-3 border-t pt-2 text-xs text-muted-foreground">No open orders</p>
                  )}
                </div>
              )
            })}
          </div>
        </TabsContent>
      </Tabs>
    </OpsShell>
  )
}

function minutesSince(iso: string): number {
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000))
}
