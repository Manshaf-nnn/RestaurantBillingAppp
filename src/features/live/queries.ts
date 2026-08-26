import 'server-only'

import { Prisma } from '@prisma/client'

import { prisma } from '@/server/db/prisma'
import type { CustomerHistoryRow, OpenOrderRow, ServiceCallRow } from './derive'

/**
 * What is happening on the floor, right now.
 *
 * ── Four statements, two hops ───────────────────────────────────────────────
 *
 * The first three are independent and run together: the open orders with their
 * item quantities rolled up, the floor itself, and any unanswered call-waiter
 * requests. The fourth needs the customer ids the first one found, so it waits.
 *
 * Raw SQL rather than Prisma, for two reasons that are not style: the roll-up
 * needs `SUM(quantity) FILTER (WHERE status = …)`, which `groupBy` cannot
 * express and which would otherwise mean pivoting five rows per order in
 * TypeScript; and the customer history needs a window function, which Prisma
 * cannot express at all.
 *
 * ── Occupancy is derived, never read off the table ──────────────────────────
 *
 * A table counts as occupied when it has an open order — the same predicate the
 * write path already uses to decide when to FREE a table. `RestaurantTable.status`
 * is a hand-maintained column that lands in `CLEANING` after every bill and is
 * only cleared when a busser taps it, so a board trusting it would under-report
 * the floor from lunchtime onwards.
 */

/** Orders that are still going on. SERVED is included: the bill may be unpaid. */
const OPEN_STATUSES = Prisma.sql`('PENDING', 'ACCEPTED', 'PREPARING', 'READY', 'SERVED')`

export interface LiveBoardData {
  orders: OpenOrderRow[]
  history: CustomerHistoryRow[]
  calls: ServiceCallRow[]
  tablesTotal: number
}

const iso = (value: Date | null): string | null => value?.toISOString() ?? null

export async function getLiveBoard(params: {
  restaurantId: string
  /** The one location this board is showing. Never null — a board is one floor. */
  branchId: string
}): Promise<LiveBoardData> {
  const { restaurantId, branchId } = params

  const [orders, floor, calls] = await Promise.all([
    /*
     * One row per open order, with its quantities already summed.
     *
     * Per ORDER and not per table, because a table can hold a split bill or a
     * second round an hour later and both levels matter — `foldOrdersToTables`
     * collapses them afterwards, which is also what stops one table producing
     * two alerts.
     *
     * The WHERE clause is written to match `orders_live_open_idx`, a partial
     * index over exactly these statuses. Keep the two in step: Postgres only
     * uses a partial index when it can prove the query is a subset of it.
     */
    prisma.$queryRaw<
      Array<{
        id: string
        orderNumber: string
        status: string
        paymentStatus: string
        tableId: string | null
        tableNumber: string | null
        table_label: string | null
        table_area: string | null
        table_capacity: number | null
        table_status: string | null
        guestCount: number | null
        customerId: string | null
        customerName: string
        customerPhone: string
        placedAt: Date
        acceptedAt: Date | null
        preparingAt: Date | null
        readyAt: Date | null
        servedAt: Date | null
        grandTotal: number
        paidTotal: number
        ordered: number | null
        queued: number | null
        preparing: number | null
        ready: number | null
        served: number | null
        cancelled: number | null
      }>
    >`
      WITH open_orders AS (
        SELECT o.* FROM orders o
         WHERE o."restaurantId" = ${restaurantId}
           AND o."branchId" = ${branchId}
           AND o.status IN ${OPEN_STATUSES}
      ),
      rollup AS (
        SELECT oi."orderId",
               SUM(oi.quantity) FILTER (WHERE oi.status <> 'CANCELLED') AS ordered,
               SUM(oi.quantity) FILTER (WHERE oi.status = 'QUEUED')     AS queued,
               SUM(oi.quantity) FILTER (WHERE oi.status = 'PREPARING')  AS preparing,
               SUM(oi.quantity) FILTER (WHERE oi.status = 'READY')      AS ready,
               SUM(oi.quantity) FILTER (WHERE oi.status = 'SERVED')     AS served,
               SUM(oi.quantity) FILTER (WHERE oi.status = 'CANCELLED')  AS cancelled
          FROM order_items oi
         WHERE oi."orderId" IN (SELECT id FROM open_orders)
         GROUP BY oi."orderId"
      )
      SELECT o.id, o."orderNumber", o.status::text, o."paymentStatus"::text,
             o."tableId", o."tableNumber", o."guestCount",
             o."customerId", o."customerName", o."customerPhone",
             o."placedAt", o."acceptedAt", o."preparingAt", o."readyAt", o."servedAt",
             o."grandTotal", o."paidTotal",
             t.label AS table_label, t.area AS table_area,
             t.capacity AS table_capacity, t.status::text AS table_status,
             COALESCE(r.ordered, 0)::int   AS ordered,
             COALESCE(r.queued, 0)::int    AS queued,
             COALESCE(r.preparing, 0)::int AS preparing,
             COALESCE(r.ready, 0)::int     AS ready,
             COALESCE(r.served, 0)::int    AS served,
             COALESCE(r.cancelled, 0)::int AS cancelled
        FROM open_orders o
        LEFT JOIN rollup r ON r."orderId" = o.id
        LEFT JOIN restaurant_tables t ON t.id = o."tableId"
       ORDER BY o."placedAt" ASC
    `,

    prisma.restaurantTable.count({
      where: { restaurantId, branchId, isActive: true },
    }),

    /*
     * `ServiceRequest` carries no branch of its own — it reaches one through
     * its table. Filtering on the restaurant alone would put another branch's
     * call-waiter requests on this floor's board.
     */
    prisma.$queryRaw<
      Array<{ id: string; tableId: string; number: string; type: string; createdAt: Date }>
    >`
      SELECT sr.id, sr."tableId", sr.type::text, sr."createdAt", t.number
        FROM service_requests sr
        JOIN restaurant_tables t ON t.id = sr."tableId"
       WHERE sr."restaurantId" = ${restaurantId}
         AND t."branchId" = ${branchId}
         AND sr.status = 'OPEN'
       ORDER BY sr."createdAt" ASC
    `,
  ])

  const customerIds = [
    ...new Set(
      orders
        // The empty phone is the shared walk-in row every anonymous sale feeds,
        // so it is not a person and must never be recognised as one.
        .filter((row) => row.customerId && row.customerPhone !== '')
        .map((row) => row.customerId as string),
    ),
  ]

  const history = customerIds.length ? await customerHistory(restaurantId, customerIds) : []

  return {
    orders: orders.map((row) => ({
      orderId: row.id,
      orderNumber: row.orderNumber,
      status: row.status,
      paymentStatus: row.paymentStatus,
      tableId: row.tableId,
      tableNumber: row.tableNumber,
      tableLabel: row.table_label,
      tableArea: row.table_area,
      tableCapacity: row.table_capacity,
      tableStatus: row.table_status,
      guestCount: row.guestCount,
      customerId: row.customerPhone === '' ? null : row.customerId,
      customerName: row.customerName,
      customerPhone: row.customerPhone,
      placedAt: row.placedAt.toISOString(),
      acceptedAt: iso(row.acceptedAt),
      preparingAt: iso(row.preparingAt),
      readyAt: iso(row.readyAt),
      servedAt: iso(row.servedAt),
      grandTotal: row.grandTotal,
      paidTotal: row.paidTotal,
      ordered: row.ordered ?? 0,
      queued: row.queued ?? 0,
      preparing: row.preparing ?? 0,
      ready: row.ready ?? 0,
      served: row.served ?? 0,
      cancelled: row.cancelled ?? 0,
    })),
    history,
    calls: calls.map((row) => ({
      id: row.id,
      tableId: row.tableId,
      tableNumber: row.number,
      type: row.type,
      createdAt: row.createdAt.toISOString(),
    })),
    tablesTotal: floor,
  }
}

/**
 * Everyone seated, and what the books say about them — in ONE statement.
 *
 * ── Two properties that come from the shape, not from a filter ──────────────
 *
 * `visits` holds only COMPLETED orders, so the sitting a guest is in the middle
 * of can never be its own "previous visit", and an abandoned or cancelled order
 * can never count as one. Both are requirements of the spec, and both are true
 * here by construction rather than by a condition somebody could later drop.
 *
 * The count is computed rather than read from `Customer.totalOrders`, which is
 * incremented the moment an order is placed and decremented on cancellation —
 * so it counts orders in flight and is not a history of visits. `lastOrderAt`
 * is worse for this purpose: it is written at placement, so for a guest sitting
 * down right now it holds *this* visit and can never answer when they were last
 * here.
 */
async function customerHistory(
  restaurantId: string,
  customerIds: string[],
): Promise<CustomerHistoryRow[]> {
  const rows = await prisma.$queryRaw<
    Array<{
      id: string
      name: string
      phone: string
      completed_visits: number
      lifetime_spend: bigint | null
      previous_visit_at: Date | null
    }>
  >`
    WITH visits AS (
      SELECT o."customerId" AS cid, o."placedAt", o."grandTotal",
             ROW_NUMBER() OVER (
               PARTITION BY o."customerId" ORDER BY o."placedAt" DESC
             ) AS rn
        FROM orders o
       WHERE o."restaurantId" = ${restaurantId}
         AND o."customerId" IN (${Prisma.join(customerIds)})
         AND o.status = 'COMPLETED'
    )
    SELECT c.id, c.name, c.phone,
           COALESCE(agg.visits, 0)::int   AS completed_visits,
           COALESCE(agg.spend, 0)::bigint AS lifetime_spend,
           p."placedAt"                   AS previous_visit_at
      FROM customers c
      LEFT JOIN LATERAL (
        SELECT COUNT(*) AS visits, SUM("grandTotal") AS spend
          FROM visits WHERE cid = c.id
      ) agg ON true
      LEFT JOIN visits p ON p.cid = c.id AND p.rn = 1
     WHERE c."restaurantId" = ${restaurantId}
       AND c.id IN (${Prisma.join(customerIds)})
  `

  return rows.map((row) => ({
    customerId: row.id,
    name: row.name,
    phone: row.phone,
    completedVisits: row.completed_visits,
    lifetimeSpend: Number(row.lifetime_spend ?? 0),
    previousVisitAt: row.previous_visit_at?.toISOString() ?? null,
  }))
}
