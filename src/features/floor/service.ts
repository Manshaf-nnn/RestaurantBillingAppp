import 'server-only'

import type { Prisma } from '@prisma/client'

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
