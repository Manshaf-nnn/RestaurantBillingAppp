/**
 * What a table is still waiting for.
 *
 * ── Why this is a rule and not a rendering detail ───────────────────────────
 *
 * The Tables screen used to show `_count.orders` — "2 open". That is a number
 * about paperwork. What the floor acts on is "table 3 is waiting on a pizza,
 * and the burger is ready under the pass", and the kitchen has been writing
 * exactly that all along: `preparedQty` and `servedQty` per line, moved by the
 * same `ORDER_ITEM_STATUS` event the KDS and the guest's tracker read.
 *
 * The arithmetic is small but it is arithmetic, and it has two traps in it —
 * a partly-served line, and what "ready" means when only some of a line is
 * made — so it lives here where it can be tested rather than inside a
 * `'use client'` component where it could only be checked by looking.
 *
 * Client-safe: pure, no Prisma, no `server-only`.
 */

export interface TableOrderItem {
  id: string
  name: string
  quantity: number
  /** How many of `quantity` the kitchen has marked prepared. */
  preparedQty: number
  /** How many of those the floor has actually put in front of the guest. */
  servedQty: number
  status: string
}

export interface TableOrder {
  id: string
  orderNumber: string
  status: string
  placedAt: string
  items: TableOrderItem[]
}

/** How a line reads on the card, by what is left to do with it. */
export type LineState = 'QUEUED' | 'PREPARING' | 'READY'

export interface ComingLine {
  key: string
  name: string
  /** How many of this line have not reached the guest yet. */
  outstanding: number
  state: LineState
}

/**
 * The lines a table is still owed, with how many of each.
 *
 * Derived from the counters rather than from `status` alone, because a line of
 * three burgers with two served is neither "ready" nor "served" — it is one
 * still coming, and that is the only number anybody on the floor acts on.
 */
export function stillComing(orders: TableOrder[]): ComingLine[] {
  const lines: ComingLine[] = []
  for (const order of orders) {
    for (const item of order.items) {
      // A voided dish is not owed to anybody.
      if (item.status === 'CANCELLED') continue
      const outstanding = item.quantity - item.servedQty
      if (outstanding <= 0) continue

      /*
       * Ready means ready to CARRY: enough of the line is prepared to cover
       * what is still owed. Two of three burgers made and none served is one
       * short of ready, so it reads as still cooking — which is the truth the
       * waiter needs before walking to the pass.
       */
      const ready = item.preparedQty - item.servedQty >= outstanding
      const state: LineState = ready
        ? 'READY'
        : item.status === 'PREPARING'
          ? 'PREPARING'
          : 'QUEUED'

      lines.push({ key: item.id, name: item.name, outstanding, state })
    }
  }
  return lines
}

/** How many individual plates have already gone out, across every open order. */
export function servedCount(orders: TableOrder[]): number {
  return orders.reduce(
    (sum, order) =>
      sum +
      order.items.reduce(
        (inner, item) => inner + (item.status === 'CANCELLED' ? 0 : item.servedQty),
        0,
      ),
    0,
  )
}
