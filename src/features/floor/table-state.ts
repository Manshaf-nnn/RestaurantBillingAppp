import type { TableStatus } from '@prisma/client'

/**
 * A table is in one of three states (abc.md §3): Empty, Occupied, Reserved.
 *
 * ── Why three, and where the other five went ────────────────────────────────
 *
 * `TableStatus` in the database has eight values. Four of them — ORDERING,
 * EATING, WAITING_BILL, OCCUPIED — all meant "somebody is sitting there" and
 * were set by hand on the waiter board, which nobody did consistently, so
 * every screen that trusted the column disagreed with the floor. CLEANING was
 * where a paid table landed and stayed until a busser tapped it, so from
 * lunchtime on the column under-reported the room. OUT_OF_SERVICE is a fact
 * about the table, not about who is at it, and `isActive` already says it.
 *
 * The enum values are still in Postgres (a Prisma enum value cannot be dropped
 * without a destructive migration, and this history has none). They are simply
 * never written any more: every writer maps to AVAILABLE or OCCUPIED, the
 * backfill migration moved the old rows, and `normalizeTableStatus` folds any
 * stray value a reader meets. The UI vocabulary is the three-state one.
 *
 * ── RESERVED is derived, never stored ───────────────────────────────────────
 *
 * Nothing sets RESERVED by hand any more, and nothing ever un-set it before.
 * A table reads as Reserved while a booking is in its window — from
 * `RESERVATION_LEAD_MINUTES` before the booked time until it ends, or until
 * the party sits down and orders. Derived at read time, so it appears and
 * disappears by itself; see `table-state-server.ts`.
 */

export const TABLE_STATES = ['AVAILABLE', 'OCCUPIED', 'RESERVED'] as const
export type TableState = (typeof TABLE_STATES)[number]

/** The two states a person may set directly. Reserved comes from bookings. */
export const SETTABLE_TABLE_STATES = ['AVAILABLE', 'OCCUPIED'] as const
export type SettableTableState = (typeof SETTABLE_TABLE_STATES)[number]

/** How long before a booking its table reads as Reserved. */
export const RESERVATION_LEAD_MINUTES = 15

/** What the stored column means in the three-state vocabulary. */
export function normalizeTableStatus(raw: TableStatus | string): TableState {
  switch (raw) {
    case 'OCCUPIED':
    case 'ORDERING':
    case 'EATING':
    case 'WAITING_BILL':
      return 'OCCUPIED'
    case 'RESERVED':
      // A stored RESERVED is a leftover from the hand-set days; the booking
      // window decides now, and a table nobody is at is Empty.
      return 'AVAILABLE'
    default:
      return 'AVAILABLE'
  }
}

/**
 * The state a table shows, from what is known about it. Occupancy wins over a
 * booking (the booked party has arrived, or somebody else is there and the
 * host will sort it out); a booking in its window wins over Empty.
 */
export function tableState(input: {
  stored: TableStatus | string
  /** Open orders or an open sitting at this table right now. */
  occupied?: boolean
  reservedNow: boolean
}): TableState {
  if (input.occupied || normalizeTableStatus(input.stored) === 'OCCUPIED') return 'OCCUPIED'
  if (input.reservedNow) return 'RESERVED'
  return 'AVAILABLE'
}
