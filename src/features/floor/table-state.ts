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
 * ── RESERVED comes from the diary, and may also be set by hand ─────────────
 *
 * A table reads as Reserved from the moment a booking is made until that
 * booking ends, is cancelled, or the party sits down (aO.md §2). Derived at
 * read time from the booking itself, so it appears the instant a host saves
 * a reservation and disappears by itself — nothing has to be remembered to
 * un-set it. See `reservationsHolding` in `table-state-server.ts`.
 *
 * It can also be stored, because a host sometimes holds a table with no
 * booking behind it: keeping the corner table for whoever is expected at
 * eight. That is a person's decision about a table, so it is a column, and
 * it holds until somebody clears it or a party is seated there.
 *
 * Occupancy still wins over both: whoever is actually sitting there is the
 * truth about the table, whatever the diary says.
 */

export const TABLE_STATES = ['AVAILABLE', 'OCCUPIED', 'RESERVED'] as const
export type TableState = (typeof TABLE_STATES)[number]

/** All three are a person's to set; a booking sets Reserved on its own too. */
export const SETTABLE_TABLE_STATES = ['AVAILABLE', 'OCCUPIED', 'RESERVED'] as const
export type SettableTableState = (typeof SETTABLE_TABLE_STATES)[number]

/** How long before a booking its table reads as Reserved. */
export const RESERVATION_LEAD_MINUTES = 15

/**
 * How far ahead a booking holds its table, in minutes.
 *
 * `null` means from the moment it is saved, however distant the booking —
 * which is what a host asking for "reserve the table and it goes reserved"
 * means, and what this is set to. The cost is that a table booked for next
 * Friday reads Reserved all week and QR guests cannot order at it, so a
 * restaurant that takes bookings far in advance wants a number here instead:
 * 240 would hold a table for the four hours before its booking and leave it
 * available until then. One value, read by every screen.
 */
export const RESERVATION_HOLD_AHEAD_MINUTES: number | null = null

/** What the stored column means in the three-state vocabulary. */
export function normalizeTableStatus(raw: TableStatus | string): TableState {
  switch (raw) {
    case 'OCCUPIED':
    case 'ORDERING':
    case 'EATING':
    case 'WAITING_BILL':
      return 'OCCUPIED'
    case 'RESERVED':
      // Held by hand, with no booking behind it. The 20260923100000 migration
      // cleared the hand-set rows of the era when this column was set by
      // people who then never cleared it, so a RESERVED here was written
      // deliberately and recently.
      return 'RESERVED'
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
  /** A booking is holding this table — see `reservationsHolding`. */
  reservedNow: boolean
}): TableState {
  const stored = normalizeTableStatus(input.stored)
  if (input.occupied || stored === 'OCCUPIED') return 'OCCUPIED'
  if (input.reservedNow || stored === 'RESERVED') return 'RESERVED'
  return 'AVAILABLE'
}
