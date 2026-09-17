import 'server-only'

import type { OrderStatus, Prisma, PrismaClient } from '@prisma/client'

import { normalizeTableStatus, type TableState } from '@/features/floor/table-state'
import { reservationsInWindow } from '@/features/floor/table-state-server'

/**
 * Whether a QR guest may order at a table, decided on the server (aO.md §2).
 *
 * One reader for the cover screen (`resolveTable`) and the placement itself
 * (`placeOrder`), so what the guest is told and what the server refuses can
 * never disagree:
 *
 *   - OCCUPIED: an order is open on the table (whoever placed it, paid or
 *     not — a party that has paid is still eating) or a sitting is open, or
 *     the till marked it so. A stranger cannot start another order there.
 *     The party already sitting there — the guest session that owns one of
 *     those orders — may: their own order is handed back so the screen can
 *     take them to it, and a second round is theirs to place.
 *   - RESERVED: a booking's window covers now and the host has not seated
 *     it. Nobody orders by QR until they do (the till may always seat a table).
 *   - AVAILABLE: the guest may order.
 *
 * `reason` is what the guest is shown; it never mentions another party's
 * bill, and it never says an order "will be added" to anything.
 */
export interface TableAvailability {
  tableId: string
  tableNumber: string
  state: TableState
  /** Why the guest cannot order here, or null when they can. */
  reason: string | null
  /** The newest open order of the guest's own session on this table. */
  ownOrder: {
    id: string
    orderNumber: string
    status: OrderStatus
    /** Still UNPAID and not yet served: items can be added to it. */
    editable: boolean
  } | null
}

const CLOSED: OrderStatus[] = ['COMPLETED', 'CANCELLED']
const LOCKED: OrderStatus[] = ['SERVED', 'COMPLETED', 'CANCELLED']

export async function tableAvailability(
  db: PrismaClient | Prisma.TransactionClient,
  params: {
    restaurantId: string
    tableId: string
    guestSessionId: string | null
    /** For the reservation time in `reason`; defaults to the server's zone. */
    timeZone?: string | null
    now?: Date
  },
): Promise<TableAvailability | null> {
  const table = await db.restaurantTable.findFirst({
    where: { id: params.tableId, restaurantId: params.restaurantId },
    select: { id: true, number: true, status: true },
  })
  if (!table) return null

  const [openOrders, openSitting] = await Promise.all([
    db.order.findMany({
      where: { restaurantId: params.restaurantId, tableId: table.id, status: { notIn: CLOSED } },
      select: { id: true, orderNumber: true, status: true, paymentStatus: true, guestSessionId: true },
      orderBy: { placedAt: 'desc' },
    }),
    db.tableSession.findFirst({
      where: { restaurantId: params.restaurantId, tableId: table.id, status: 'OPEN' },
      select: { id: true },
    }),
  ])

  const occupied =
    openOrders.length > 0 || openSitting !== null || normalizeTableStatus(table.status) === 'OCCUPIED'

  if (occupied) {
    const own = params.guestSessionId
      ? openOrders.find((order) => order.guestSessionId === params.guestSessionId) ?? null
      : null
    return {
      tableId: table.id,
      tableNumber: table.number,
      state: 'OCCUPIED',
      reason: own ? null : `Table ${table.number} is currently in use`,
      ownOrder: own
        ? {
            id: own.id,
            orderNumber: own.orderNumber,
            status: own.status,
            editable: !LOCKED.includes(own.status) && own.paymentStatus === 'UNPAID',
          }
        : null,
    }
  }

  const booking = (
    await reservationsInWindow(db, {
      restaurantId: params.restaurantId,
      tableIds: [table.id],
      now: params.now,
    })
  ).get(table.id)
  if (booking) {
    const at = new Intl.DateTimeFormat('en-GB', {
      hour: 'numeric',
      minute: '2-digit',
      ...(params.timeZone ? { timeZone: params.timeZone } : {}),
    }).format(booking.reservedAt)
    return {
      tableId: table.id,
      tableNumber: table.number,
      state: 'RESERVED',
      reason: `Table ${table.number} is reserved for a booking at ${at}`,
      ownOrder: null,
    }
  }

  return { tableId: table.id, tableNumber: table.number, state: 'AVAILABLE', reason: null, ownOrder: null }
}
