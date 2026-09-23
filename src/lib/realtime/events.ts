import type {
  NotificationType,
  OrderStatus,
  PaymentMethod,
  ServiceRequestType,
  TableStatus,
} from '@prisma/client'

/**
 * The realtime contract shared by the Socket.IO server (server.mjs), the
 * server-side emitter and every client hook. Event names live here only.
 */

export const ROOM = {
  tenant: (restaurantId: string) => `r:${restaurantId}`,
  kitchen: (restaurantId: string) => `r:${restaurantId}:kitchen`,
  waiter: (restaurantId: string) => `r:${restaurantId}:waiter`,
  cashier: (restaurantId: string) => `r:${restaurantId}:cashier`,
  management: (restaurantId: string) => `r:${restaurantId}:management`,
  order: (orderId: string) => `order:${orderId}`,
  table: (tableId: string) => `table:${tableId}`,
  user: (userId: string) => `user:${userId}`,
} as const

export const EVENTS = {
  ORDER_CREATED: 'order:created',
  ORDER_UPDATED: 'order:updated',
  ORDER_STATUS: 'order:status',
  ORDER_ITEM_STATUS: 'order:item-status',
  ORDER_CANCELLED: 'order:cancelled',
  PAYMENT_RECEIVED: 'payment:received',
  PAYMENT_PENDING: 'payment:pending',
  SERVICE_REQUEST_CREATED: 'service-request:created',
  SERVICE_REQUEST_ACKNOWLEDGED: 'service-request:acknowledged',
  SERVICE_REQUEST_RESOLVED: 'service-request:resolved',
  TABLE_UPDATED: 'table:updated',
  NOTIFICATION: 'notification',
  LOW_STOCK: 'inventory:low-stock',
  MENU_UPDATED: 'menu:updated',
  // client → server
  JOIN_ORDER: 'join:order',
  LEAVE_ORDER: 'leave:order',
} as const

export type EventName = (typeof EVENTS)[keyof typeof EVENTS]

export interface OrderSummaryPayload {
  id: string
  orderNumber: string
  /**
   * Which location the order belongs to.
   *
   * Rooms are keyed `r:<restaurantId>:<role>` with no branch segment, so every
   * kitchen, waiter and cashier screen in the chain receives every order the
   * moment it is placed — the ticket appears with a chime, and only the next
   * server render (which IS branch-scoped) prunes it away again. Carrying the
   * branch on the payload lets each board ignore what is not its own on
   * arrival, without changing the socket handshake.
   */
  branchId: string
  status: OrderStatus
  type: string
  /** QR / ONLINE orders wait at the till; the KDS ignores them until accepted (abc.md §5). */
  channel: string
  tableId: string | null
  tableNumber: string | null
  customerName: string
  customerPhone: string
  itemCount: number
  grandTotal: number
  notes: string | null
  placedAt: string
  estimatedMinutes: number
  items: Array<{
    id: string
    name: string
    quantity: number
    notes: string | null
    isVeg: boolean
    options: Array<{ groupName: string; name: string }>
    /** Where the line is, so a pushed ticket shows the same boxes as a polled one. */
    status: string
    preparedQty: number
    servedQty: number
  }>
}

/**
 * One line moved (abc.md §6): the kitchen ticked it prepared, or the floor
 * served some of it. Carries the counters so every listener — the KDS, the
 * waiter's card, the guest's tracker — can draw "2 of 3 ready" without a
 * round trip, and the branch so the boards can ignore other sites.
 */
export interface OrderItemProgressPayload {
  orderId: string
  itemId: string
  branchId: string
  status: string
  quantity: number
  preparedQty: number
  servedQty: number
}

export interface OrderStatusPayload {
  orderId: string
  orderNumber: string
  /**
   * Which location this concerns.
   *
   * Rooms are keyed `r:<restaurantId>:<role>` with no branch segment, so every
   * board in the chain receives every event and each one filters on arrival.
   * `OrderSummaryPayload` gained this first and the kitchen board used it;
   * these three had no branch at all, which is why the waiter, cashier and
   * dashboard boards could not filter and rang for other branches.
   */
  branchId: string
  status: OrderStatus
  tableId: string | null
  tableNumber: string | null
  at: string
  /** On `order:cancelled`: why, so the guest's screen can say (abc.md §5). */
  reason?: string | null
}

export interface PaymentPayload {
  orderId: string
  orderNumber: string
  /** Which location took the money. See `OrderStatusPayload.branchId`. */
  branchId: string
  paymentId: string
  method: PaymentMethod
  amount: number
  tableNumber: string | null
  at: string
}

export interface ServiceRequestPayload {
  id: string
  tableId: string
  /**
   * The branch of the table that called.
   *
   * `ServiceRequest` has no branch column — it reaches one through its table,
   * which is how `getWaiterBoard` already scopes the list. Carrying it on the
   * payload lets the waiter station do the same for the live bell, instead of
   * ringing at every station in the business.
   */
  branchId: string
  tableNumber: string
  type: ServiceRequestType
  note: string | null
  createdAt: string
  /** Who called: "Table 4" for a guest, a colleague's name from the till or KDS (abc.md §7). */
  requestedByName: string
  status: 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED'
}

/** Somebody said "on my way", so the other stations can stop (abc.md §7). */
export interface ServiceRequestAcknowledgedPayload {
  id: string
  branchId: string
  acknowledgedByName: string
  acknowledgedAt: string
}

export interface TablePayload {
  id: string
  number: string
  status: TableStatus
  /** Rooms are not branch-scoped, so the payload says which site (abc.md §9). */
  branchId: string | null
}

export interface NotificationPayload {
  id: string
  type: NotificationType
  title: string
  body: string | null
  /**
   * Which location it concerns; `null` is a genuine business-wide notice.
   *
   * Role rooms carry no branch segment, so every site receives every
   * MANAGEMENT push. The listener filters on this, exactly as the order
   * boards do — otherwise a live toast crosses a branch the stored list would
   * never have shown.
   */
  branchId: string | null
  data?: Record<string, unknown> | null
  createdAt: string
}

export interface LowStockPayload {
  itemId: string
  name: string
  quantity: number
  reorderLevel: number
  unit: string
}

export interface ServerToClientEvents {
  [EVENTS.ORDER_CREATED]: (payload: OrderSummaryPayload) => void
  [EVENTS.ORDER_UPDATED]: (payload: OrderSummaryPayload) => void
  [EVENTS.ORDER_STATUS]: (payload: OrderStatusPayload) => void
  [EVENTS.ORDER_ITEM_STATUS]: (payload: OrderItemProgressPayload) => void
  [EVENTS.ORDER_CANCELLED]: (payload: OrderStatusPayload) => void
  [EVENTS.PAYMENT_RECEIVED]: (payload: PaymentPayload) => void
  [EVENTS.PAYMENT_PENDING]: (payload: PaymentPayload) => void
  [EVENTS.SERVICE_REQUEST_CREATED]: (payload: ServiceRequestPayload) => void
  [EVENTS.SERVICE_REQUEST_ACKNOWLEDGED]: (payload: ServiceRequestAcknowledgedPayload) => void
  [EVENTS.SERVICE_REQUEST_RESOLVED]: (payload: { id: string }) => void
  [EVENTS.TABLE_UPDATED]: (payload: TablePayload) => void
  [EVENTS.NOTIFICATION]: (payload: NotificationPayload) => void
  [EVENTS.LOW_STOCK]: (payload: LowStockPayload) => void
  [EVENTS.MENU_UPDATED]: (payload: { restaurantId: string }) => void
}

export interface ClientToServerEvents {
  [EVENTS.JOIN_ORDER]: (orderId: string) => void
  [EVENTS.LEAVE_ORDER]: (orderId: string) => void
}
