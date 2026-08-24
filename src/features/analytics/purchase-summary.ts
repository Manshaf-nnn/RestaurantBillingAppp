import 'server-only'

import { Prisma } from '@prisma/client'

import type { DateRange } from '@/features/reports/range'
import { prisma } from '@/server/db/prisma'
import { utc } from '@/server/db/sql-time'

/**
 * What the restaurant spent on stock, and what is still owed to suppliers.
 *
 * ── Why this is an aggregate and not a list ─────────────────────────────────
 *
 * The purchasing report computes its headline figures by fetching
 * `listPurchaseOrders({ limit: 200 })` and reducing the array in JavaScript.
 * That is silently wrong in two ways, and both get worse the busier the
 * restaurant is:
 *
 *   1. Any window holding more than 200 purchase orders under-reports spend,
 *      with no indication that anything was left out. A number that is quietly
 *      too small is worse than an error, because nobody goes looking for it.
 *   2. The page's "outstanding" figure filters the same 200 rows by status and
 *      ignores the chosen date range entirely, so it answers a different
 *      question from the one beside it.
 *
 * Postgres can sum a million rows without sending one of them over the wire.
 * The report now calls this too, which fixes both.
 *
 * ── Which statuses count ────────────────────────────────────────────────────
 *
 * `DRAFT` is not spend — it is a shopping list somebody is still typing.
 * `CANCELLED` is not spend either. Both are excluded from every figure here,
 * matching the `notIn: ['CANCELLED', 'DRAFT']` the supplier breakdown on the
 * report already uses, so the two panels agree.
 *
 * Outstanding is `APPROVED | ORDERED | PARTIALLY_RECEIVED` — committed, not yet
 * fully on the shelf. Unlike the rest, it deliberately ignores the range: money
 * you owe is money you owe, whether the order was raised this month or last.
 * "Overdue" is the subset whose `expectedAt` has already passed, which is the
 * list worth chasing.
 */
export interface PurchaseSummary {
  /** Committed spend over the period, excluding drafts and cancellations. */
  spend: number
  /** Purchase orders raised in the period. */
  ordersPlaced: number
  /** Received in full during the period. */
  received: number
  /** Value still awaiting delivery — not limited to the period. */
  outstandingValue: number
  outstandingCount: number
  /** Of those, the ones whose expected date has passed. */
  overdueCount: number
  overdueValue: number
  /** Biggest suppliers over the period. */
  topSuppliers: Array<{ name: string; spend: number; orders: number }>
}

const COUNTED = Prisma.sql`status NOT IN ('CANCELLED', 'DRAFT')`
const OUTSTANDING = Prisma.sql`status IN ('APPROVED', 'ORDERED', 'PARTIALLY_RECEIVED')`

export async function getPurchaseSummary(params: {
  restaurantId: string
  range: DateRange
  branchIds?: string[] | null
}): Promise<PurchaseSummary> {
  const { restaurantId, range } = params
  const ids = params.branchIds

  /*
   * An empty allow-list means "sees nothing" and must never be read as "no
   * filter" — the same rule as everywhere else in this codebase. `IN ()` is a
   * syntax error in Postgres, so it becomes a false predicate instead.
   */
  const atBranch = ids
    ? ids.length
      ? Prisma.sql`AND "branchId" IN (${Prisma.join(ids)})`
      : Prisma.sql`AND false`
    : Prisma.empty

  const now = new Date()

  const [row] = await prisma.$queryRaw<
    Array<{
      spend: bigint
      orders_placed: bigint
      received: bigint
      outstanding_value: bigint
      outstanding_count: bigint
      overdue_count: bigint
      overdue_value: bigint
    }>
  >`
    SELECT
      (SELECT COALESCE(SUM(total), 0) FROM purchases
        WHERE "restaurantId" = ${restaurantId} AND ${COUNTED} ${atBranch}
          AND "createdAt" >= ${utc(range.from)} AND "createdAt" <= ${utc(range.to)})::bigint  AS spend,
      (SELECT COUNT(*) FROM purchases
        WHERE "restaurantId" = ${restaurantId} AND ${COUNTED} ${atBranch}
          AND "createdAt" >= ${utc(range.from)} AND "createdAt" <= ${utc(range.to)})::bigint  AS orders_placed,
      (SELECT COUNT(*) FROM purchases
        WHERE "restaurantId" = ${restaurantId} AND status = 'RECEIVED' ${atBranch}
          AND "receivedAt" >= ${utc(range.from)} AND "receivedAt" <= ${utc(range.to)})::bigint AS received,
      (SELECT COALESCE(SUM(total), 0) FROM purchases
        WHERE "restaurantId" = ${restaurantId} AND ${OUTSTANDING} ${atBranch})::bigint AS outstanding_value,
      (SELECT COUNT(*) FROM purchases
        WHERE "restaurantId" = ${restaurantId} AND ${OUTSTANDING} ${atBranch})::bigint AS outstanding_count,
      (SELECT COUNT(*) FROM purchases
        WHERE "restaurantId" = ${restaurantId} AND ${OUTSTANDING} ${atBranch}
          AND "expectedAt" IS NOT NULL AND "expectedAt" < ${utc(now)})::bigint           AS overdue_count,
      (SELECT COALESCE(SUM(total), 0) FROM purchases
        WHERE "restaurantId" = ${restaurantId} AND ${OUTSTANDING} ${atBranch}
          AND "expectedAt" IS NOT NULL AND "expectedAt" < ${utc(now)})::bigint           AS overdue_value
  `

  const suppliers = await prisma.$queryRaw<
    Array<{ name: string | null; spend: bigint | null; orders: bigint }>
  >`
    SELECT s.name                     AS name,
           COALESCE(SUM(p.total), 0)::bigint AS spend,
           COUNT(*)::bigint           AS orders
    FROM purchases p
    LEFT JOIN suppliers s ON s.id = p."supplierId"
    WHERE p."restaurantId" = ${restaurantId}
      AND p.status NOT IN ('CANCELLED', 'DRAFT')
      AND p."createdAt" >= ${utc(range.from)} AND p."createdAt" <= ${utc(range.to)}
      ${
        ids
          ? ids.length
            ? Prisma.sql`AND p."branchId" IN (${Prisma.join(ids)})`
            : Prisma.sql`AND false`
          : Prisma.empty
      }
    GROUP BY s.name
    ORDER BY spend DESC
    LIMIT 5
  `

  return {
    spend: Number(row?.spend ?? 0),
    ordersPlaced: Number(row?.orders_placed ?? 0),
    received: Number(row?.received ?? 0),
    outstandingValue: Number(row?.outstanding_value ?? 0),
    outstandingCount: Number(row?.outstanding_count ?? 0),
    overdueCount: Number(row?.overdue_count ?? 0),
    overdueValue: Number(row?.overdue_value ?? 0),
    topSuppliers: suppliers.map((s) => ({
      name: s.name ?? 'No supplier',
      spend: Number(s.spend ?? 0),
      orders: Number(s.orders),
    })),
  }
}
