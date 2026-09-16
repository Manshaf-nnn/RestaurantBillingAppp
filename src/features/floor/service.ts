import 'server-only'

import type { Prisma } from '@prisma/client'

import { AppError, NotFoundError } from '@/lib/errors'
import { prisma } from '@/server/db/prisma'
import { normalizeTableStatus } from './table-state'
import { reservationsInWindow } from './table-state-server'

/** What a freed table looks like to the caller that has to announce it. */
export interface FreedTable {
  id: string
  number: string
  branchId: string
}

/**
 * Free a table: nothing open is left on it (abc.md §3).
 *
 * ── Empty, not Cleaning ─────────────────────────────────────────────────────
 *
 * Settling the last bill used to put the table in CLEANING, and nothing in
 * server code ever cleared that — a busser tapped it, or did not, and from
 * lunchtime on every screen that trusted the column showed a floor emptier
 * than it was. The spec is explicit: once the sitting is over the table is
 * Empty and available for the next party. Whether somebody wiped it is not a
 * state the system can know, so it is not a state the system keeps.
 *
 * ── One writer ──────────────────────────────────────────────────────────────
 *
 * Three places freed tables — order completed, order cancelled, bill settled
 * — each with its own copy of "count what is still open, then close the
 * sitting". Three copies drifted (one wrote AVAILABLE, two wrote CLEANING).
 * This is the one; each caller decides whether the last open order is the one
 * it is closing, then hands over. Returns the table so the caller can emit
 * `tableUpdated` AFTER its transaction commits — an event for a rollback is a
 * lie on every screen that heard it.
 *
 * Never called because food was prepared: the spec's "availability depends on
 * the actual active session/payment rules", and nothing here reacts to READY.
 */
export async function freeTable(
  tx: Prisma.TransactionClient,
  params: { restaurantId: string; tableId: string },
): Promise<FreedTable | null> {
  const table = await tx.restaurantTable.findFirst({
    where: { id: params.tableId, restaurantId: params.restaurantId },
    select: { id: true, number: true, branchId: true },
  })
  if (!table) return null

  await tx.restaurantTable.update({
    where: { id: table.id },
    data: { status: 'AVAILABLE' },
  })
  // The table clearing is what ends the sitting.
  await tx.tableSession.updateMany({
    where: { restaurantId: params.restaurantId, tableId: table.id, status: 'OPEN' },
    data: { status: 'CLOSED', closedAt: new Date(), activeTableKey: null },
  })
  return table
}

/** Whether anything other than `exceptOrderId` is still open at the table. */
export async function otherOpenOrders(
  tx: Prisma.TransactionClient,
  params: { restaurantId: string; tableId: string; exceptOrderId: string },
): Promise<number> {
  return tx.order.count({
    where: {
      restaurantId: params.restaurantId,
      tableId: params.tableId,
      id: { not: params.exceptOrderId },
      status: { notIn: ['COMPLETED', 'CANCELLED'] },
    },
  })
}

const OPEN = ['COMPLETED', 'CANCELLED'] as const

export interface SwapResult {
  from: FreedTable
  to: FreedTable
  movedOrderIds: string[]
  /** The sitting that moved, when the source had one. */
  sessionId: string | null
}

/**
 * Move a sitting to another table (abc.md §3).
 *
 * ── What moves, and what does not ───────────────────────────────────────────
 *
 * The open sitting (`TableSession`) and every open order on the source are
 * re-pointed at the target; the order rows keep their items, payments,
 * customer, discounts and history untouched, because a table is where a
 * bill is, not what it is. Each moved order gets an event saying where it
 * came from, so the trail reads correctly afterwards. The target becomes
 * Occupied and the source Empty — nothing open remains on it by
 * construction, which is the "logically safe" the spec asks for.
 *
 * ── Refusals ────────────────────────────────────────────────────────────────
 *
 * The target must be at the same site, in service, and genuinely free: no
 * open sitting, no open order, not held by a booking whose window covers
 * now, and not marked Occupied by hand. The source must have something to
 * move. Both rows are locked for the duration (in id order, so two swaps
 * touching the same pair cannot deadlock), and the sitting's unique
 * `activeTableKey` guarantees the target cannot acquire two sittings even
 * if a check above were somehow skipped.
 */
export async function swapTable(params: {
  restaurantId: string
  fromTableId: string
  toTableId: string
  actorId?: string | null
  actorName?: string | null
}): Promise<SwapResult> {
  if (params.fromTableId === params.toTableId) {
    throw new AppError('Choose a different table to move to', 400, 'TABLE_SWAP_SAME')
  }

  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<
      Array<{ id: string; number: string; branchId: string; isActive: boolean; status: string }>
    >`
      SELECT id, number, "branchId", "isActive", status::text AS status
        FROM restaurant_tables
       WHERE "restaurantId" = ${params.restaurantId}
         AND id IN (${params.fromTableId}, ${params.toTableId})
       ORDER BY id
       FOR UPDATE
    `
    const source = rows.find((row) => row.id === params.fromTableId)
    const target = rows.find((row) => row.id === params.toTableId)
    if (!source || !target) throw new NotFoundError('Table')

    if (source.branchId !== target.branchId) {
      throw new AppError('Both tables have to be at the same location', 409, 'TABLE_SWAP_BRANCH')
    }
    if (!target.isActive) {
      throw new AppError(`Table ${target.number} is out of service`, 409, 'TABLE_SWAP_TARGET_INACTIVE')
    }

    const [targetOrders, targetSession, held] = await Promise.all([
      tx.order.count({
        where: { restaurantId: params.restaurantId, tableId: target.id, status: { notIn: [...OPEN] } },
      }),
      tx.tableSession.findFirst({
        where: { restaurantId: params.restaurantId, tableId: target.id, status: 'OPEN' },
        select: { id: true },
      }),
      reservationsInWindow(tx, { restaurantId: params.restaurantId, tableIds: [target.id] }),
    ])
    if (targetOrders > 0 || targetSession || normalizeTableStatus(target.status) === 'OCCUPIED') {
      throw new AppError(`Table ${target.number} is occupied`, 409, 'TABLE_SWAP_TARGET_OCCUPIED')
    }
    const booking = held.get(target.id)
    if (booking) {
      throw new AppError(
        `Table ${target.number} is reserved for ${booking.customerName}`,
        409,
        'TABLE_SWAP_TARGET_RESERVED',
      )
    }

    const [openOrders, sourceSession] = await Promise.all([
      tx.order.findMany({
        where: { restaurantId: params.restaurantId, tableId: source.id, status: { notIn: [...OPEN] } },
        select: { id: true, status: true },
      }),
      tx.tableSession.findFirst({
        where: { restaurantId: params.restaurantId, tableId: source.id, status: 'OPEN' },
        select: { id: true },
      }),
    ])
    if (openOrders.length === 0 && !sourceSession) {
      throw new AppError(`Nothing is open on table ${source.number}`, 409, 'TABLE_SWAP_NOTHING_OPEN')
    }

    if (sourceSession) {
      await tx.tableSession.update({
        where: { id: sourceSession.id },
        data: { tableId: target.id, activeTableKey: target.id },
      })
    }
    await tx.order.updateMany({
      where: { restaurantId: params.restaurantId, tableId: source.id, status: { notIn: [...OPEN] } },
      data: { tableId: target.id, tableNumber: target.number },
    })
    for (const order of openOrders) {
      await tx.orderEvent.create({
        data: {
          orderId: order.id,
          status: order.status,
          note: `Moved from table ${source.number} to table ${target.number}`,
          actorId: params.actorId ?? null,
          actorName: params.actorName ?? null,
        },
      })
    }
    await tx.restaurantTable.update({ where: { id: target.id }, data: { status: 'OCCUPIED' } })
    await tx.restaurantTable.update({ where: { id: source.id }, data: { status: 'AVAILABLE' } })

    return {
      from: { id: source.id, number: source.number, branchId: source.branchId },
      to: { id: target.id, number: target.number, branchId: target.branchId },
      movedOrderIds: openOrders.map((order) => order.id),
      sessionId: sourceSession?.id ?? null,
    }
  })
}
