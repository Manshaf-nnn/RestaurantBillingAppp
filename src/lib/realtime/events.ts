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
  }>
}

export interface OrderStatusPayload {
  orderId: string
  orderNumber: string
  status: OrderStatus
  tableId: string | null
  tableNumber: string | null
  at: string
}

export interface PaymentPayload {
  orderId: string
  orderNumber: string
  paymentId: string
  method: PaymentMethod
  amount: number
  tableNumber: string | null
  at: string
}

export interface ServiceRequestPayload {
  id: string
  tableId: string
  tableNumber: string
  type: ServiceRequestType
  note: string | null
  createdAt: string
}

export interface TablePayload {
  id: string
  number: string
  status: TableStatus
}

export interface NotificationPayload {
  id: string
  type: NotificationType
  title: string
  body: string | null
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
  [EVENTS.ORDER_ITEM_STATUS]: (payload: { orderId: string; itemId: string; status: string }) => void
  [EVENTS.ORDER_CANCELLED]: (payload: OrderStatusPayload) => void
  [EVENTS.PAYMENT_RECEIVED]: (payload: PaymentPayload) => void
  [EVENTS.PAYMENT_PENDING]: (payload: PaymentPayload) => void
  [EVENTS.SERVICE_REQUEST_CREATED]: (payload: ServiceRequestPayload) => void
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
