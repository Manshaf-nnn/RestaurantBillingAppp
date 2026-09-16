import 'server-only'

import type { Prisma, PrismaClient } from '@prisma/client'

import { prisma } from '@/server/db/prisma'
import { RESERVATION_LEAD_MINUTES, tableState, type TableState } from './table-state'

type Db = PrismaClient | Prisma.TransactionClient

export interface ReservationInWindow {
  id: string
  tableId: string
  customerName: string
  partySize: number
  reservedAt: Date
  endsAt: Date
}

/** Bookings that make a table read as Reserved at `now` (abc.md §4). */
const RESERVING_STATUSES = ['PENDING', 'CONFIRMED'] as const

/**
 * The bookings whose window covers `now`, per table.
 *
 * The window is `[reservedAt − lead, reservedAt + duration)`. Computed in
 * SQL-ish terms here rather than trusting a stored end, because a booking's
 * end is `reservedAt + durationMinutes` by definition and the two must never
 * disagree. Candidates are narrowed by `reservedAt` in the database (nothing
 * booked more than the longest allowed duration ago can still be running) and
 * the exact window is applied in memory.
 *
 * SEATED bookings are not reserving: the party is at the table, which is
 * OCCUPIED. COMPLETED / CANCELLED / NO_SHOW never reserve.
 */
export async function reservationsInWindow(
  db: Db,
  params: { restaurantId: string; branchId?: string | null; tableIds?: string[]; now?: Date },
): Promise<Map<string, ReservationInWindow>> {
  const now = params.now ?? new Date()
  const lead = RESERVATION_LEAD_MINUTES * 60_000
  // Six hours is the longest booking the form allows (360 minutes).
  const earliestStart = new Date(now.getTime() - 6 * 60 * 60_000)
  const latestStart = new Date(now.getTime() + lead)

  const rows = await db.reservation.findMany({
    where: {
      restaurantId: params.restaurantId,
      status: { in: [...RESERVING_STATUSES] },
      tableId: params.tableIds ? { in: params.tableIds } : { not: null },
      ...(params.branchId ? { branchId: params.branchId } : {}),
      reservedAt: { gte: earliestStart, lte: latestStart },
    },
    select: {
      id: true, tableId: true, customerName: true, partySize: true,
      reservedAt: true, durationMinutes: true,
    },
    orderBy: { reservedAt: 'asc' },
  })

  const byTable = new Map<string, ReservationInWindow>()
  for (const row of rows) {
    if (!row.tableId) continue
    const endsAt = new Date(row.reservedAt.getTime() + row.durationMinutes * 60_000)
    const opensAt = new Date(row.reservedAt.getTime() - lead)
    if (now < opensAt || now >= endsAt) continue
    // The earliest booking wins a table with two overlapping ones; the
    // conflict check on save is what stops that happening in the first place.
    if (!byTable.has(row.tableId)) {
      byTable.set(row.tableId, {
        id: row.id,
        tableId: row.tableId,
        customerName: row.customerName,
        partySize: row.partySize,
        reservedAt: row.reservedAt,
        endsAt,
      })
    }
  }
  return byTable
}

export interface TableStateRow {
  state: TableState
  /** The booking making it Reserved, when that is why. */
  reservation: ReservationInWindow | null
}

/**
 * Every table's state, in one read (abc.md §3). The single place a screen
 * asks "what is this table right now"; tables page, waiter board, live board,
 * the swap picker and the guest's table screen all read from here so they
 * never disagree.
 *
 * Occupancy is the stored column, kept true by the order and payment writers
 * (an order seats the table; settling or cancelling the last order frees it),
 * OR an open sitting/order handed in by a caller that already has them.
 */
export async function tableStatesFor(
  db: Db,
  params: {
    restaurantId: string
    branchId?: string | null
    tableIds?: string[]
    /** Tables the caller already knows to be occupied (open orders). */
    occupiedIds?: Iterable<string>
    now?: Date
  },
): Promise<Map<string, TableStateRow>> {
  const [tables, reserving] = await Promise.all([
    db.restaurantTable.findMany({
      where: {
        restaurantId: params.restaurantId,
        ...(params.branchId ? { branchId: params.branchId } : {}),
        ...(params.tableIds ? { id: { in: params.tableIds } } : {}),
      },
      select: { id: true, status: true },
    }),
    reservationsInWindow(db, {
      restaurantId: params.restaurantId,
      branchId: params.branchId,
      tableIds: params.tableIds,
      now: params.now,
    }),
  ])
  const occupied = new Set(params.occupiedIds ?? [])

  const out = new Map<string, TableStateRow>()
  for (const table of tables) {
    const reservation = reserving.get(table.id) ?? null
    const state = tableState({
      stored: table.status,
      occupied: occupied.has(table.id),
      reservedNow: reservation !== null,
    })
    out.set(table.id, { state, reservation: state === 'RESERVED' ? reservation : null })
  }
  return out
}

/** Convenience for the common single-restaurant read. */
export const tableStates = (params: Parameters<typeof tableStatesFor>[1]) => tableStatesFor(prisma, params)
