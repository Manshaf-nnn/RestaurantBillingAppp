import 'server-only'
import type { Server as SocketServer } from 'socket.io'

import { EVENTS, ROOM, type ServerToClientEvents } from '@/lib/realtime/events'

/**
 * Server-side realtime emitter.
 *
 * `server.mjs` attaches the Socket.IO instance to `globalThis.__ros_io` after
 * boot; route handlers and server actions running in the same Node process
 * publish through it here. If the app is started with plain `next start`
 * (no custom server) emitting is a no-op and clients fall back to polling —
 * the application stays fully functional either way.
 */
type Io = SocketServer<Record<string, never>, ServerToClientEvents>

function io(): Io | null {
  return (globalThis as unknown as { __ros_io?: Io }).__ros_io ?? null
}

export const isRealtimeReady = () => io() !== null

function emit(rooms: string[], event: string, payload: unknown) {
  const server = io()
  if (!server) return
  try {
    server.to(rooms).emit(event as keyof ServerToClientEvents, payload as never)
  } catch (error) {
    console.error('[realtime] emit failed', event, error)
  }
}

type Audience = 'kitchen' | 'waiter' | 'cashier' | 'management' | 'all'

function roomsFor(restaurantId: string, audiences: Audience[]): string[] {
  const rooms = new Set<string>()
  for (const audience of audiences) {
    if (audience === 'all') rooms.add(ROOM.tenant(restaurantId))
    else rooms.add(ROOM[audience](restaurantId))
  }
  return [...rooms]
}

export const realtime = {
  /** New order — lands on the kitchen display and every management screen. */
  orderCreated(restaurantId: string, payload: Parameters<ServerToClientEvents['order:created']>[0]) {
    emit(roomsFor(restaurantId, ['kitchen', 'management', 'cashier', 'waiter']), EVENTS.ORDER_CREATED, payload)
  },

  orderUpdated(restaurantId: string, payload: Parameters<ServerToClientEvents['order:updated']>[0]) {
    emit(
      [...roomsFor(restaurantId, ['kitchen', 'management', 'cashier', 'waiter']), ROOM.order(payload.id)],
      EVENTS.ORDER_UPDATED,
      payload,
    )
  },

  /** Status transitions fan out to staff *and* to the guest tracking screen. */
  orderStatus(restaurantId: string, payload: Parameters<ServerToClientEvents['order:status']>[0]) {
    emit(
      [...roomsFor(restaurantId, ['all', 'kitchen', 'waiter', 'cashier', 'management']), ROOM.order(payload.orderId)],
      EVENTS.ORDER_STATUS,
      payload,
    )
  },

  orderItemStatus(restaurantId: string, orderId: string, itemId: string, status: string) {
    emit([...roomsFor(restaurantId, ['kitchen', 'waiter']), ROOM.order(orderId)], EVENTS.ORDER_ITEM_STATUS, {
      orderId,
      itemId,
      status,
    })
  },

  orderCancelled(restaurantId: string, payload: Parameters<ServerToClientEvents['order:cancelled']>[0]) {
    emit(
      [...roomsFor(restaurantId, ['kitchen', 'waiter', 'cashier', 'management']), ROOM.order(payload.orderId)],
      EVENTS.ORDER_CANCELLED,
      payload,
    )
  },

  paymentReceived(restaurantId: string, payload: Parameters<ServerToClientEvents['payment:received']>[0]) {
    emit(
      [...roomsFor(restaurantId, ['cashier', 'management']), ROOM.order(payload.orderId)],
      EVENTS.PAYMENT_RECEIVED,
      payload,
    )
  },

  serviceRequest(restaurantId: string, payload: Parameters<ServerToClientEvents['service-request:created']>[0]) {
    emit(roomsFor(restaurantId, ['waiter', 'management']), EVENTS.SERVICE_REQUEST_CREATED, payload)
  },

  serviceRequestResolved(restaurantId: string, id: string) {
    emit(roomsFor(restaurantId, ['waiter', 'management']), EVENTS.SERVICE_REQUEST_RESOLVED, { id })
  },

  tableUpdated(restaurantId: string, payload: Parameters<ServerToClientEvents['table:updated']>[0]) {
    emit(roomsFor(restaurantId, ['all', 'waiter', 'management', 'cashier']), EVENTS.TABLE_UPDATED, payload)
  },

  notify(
    restaurantId: string,
    audiences: Audience[],
    payload: Parameters<ServerToClientEvents['notification']>[0],
  ) {
    emit(roomsFor(restaurantId, audiences), EVENTS.NOTIFICATION, payload)
  },

  notifyUser(userId: string, payload: Parameters<ServerToClientEvents['notification']>[0]) {
    emit([ROOM.user(userId)], EVENTS.NOTIFICATION, payload)
  },

  notifyOrder(orderId: string, payload: Parameters<ServerToClientEvents['notification']>[0]) {
    emit([ROOM.order(orderId)], EVENTS.NOTIFICATION, payload)
  },

  lowStock(restaurantId: string, payload: Parameters<ServerToClientEvents['inventory:low-stock']>[0]) {
    emit(roomsFor(restaurantId, ['management', 'kitchen']), EVENTS.LOW_STOCK, payload)
  },

  menuUpdated(restaurantId: string) {
    emit([ROOM.tenant(restaurantId)], EVENTS.MENU_UPDATED, { restaurantId })
  },
}
