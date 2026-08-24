import 'server-only'

import { Prisma } from '@prisma/client'

import type { DateRange } from '@/features/reports/range'
import { prisma } from '@/server/db/prisma'
import { utc } from '@/server/db/sql-time'

/**
 * The floor: what it looks like right now, and which tables earn.
 *
 * ── Two questions, two clocks ───────────────────────────────────────────────
 *
 * `status` is a live column — it says what is happening in the room at this
 * moment. Asking "how many tables were occupied last March" of it is
 * meaningless: the column holds one value and it is today's. So the status
 * counts ignore the range, and only the takings table uses it. Same split as
 * the dashboard's hero row, for the same reason.
 *
 * ── Why "in use" is more than OCCUPIED ──────────────────────────────────────
 *
 * `TableStatus` has eight values and four of them mean a guest is sitting
 * there: ORDERING, EATING, WAITING_BILL and OCCUPIED. The dashboard's existing
 * tile counts only the last one, so a table whose guests are mid-meal reads as
 * free. That tile is left alone here — changing a number somebody watches
 * daily is its own decision — but this summary counts all four, and labels the
 * figure "in use" rather than "occupied" so the two are not mistaken for the
 * same measurement.
 *
 * This is the first floor analytics in the codebase; `src/features/floor/` has
 * actions and no queries at all.
 */
export interface FloorSummary {
  /** Live counts. Not affected by the range. */
  inUse: number
  free: number
  cleaning: number
  reserved: number
  outOfService: number
  total: number
  /** Over the period. */
  topTables: Array<{
    id: string
    number: string
    area: string | null
    revenue: number
    orders: number
    covers: number
  }>
  /** Every seated order over the period, for the average below. */
  seatedOrders: number
  averageTableSpend: number
}

/** The four statuses that mean a guest is at the table. */
const IN_USE = Prisma.sql`('ORDERING', 'EATING', 'WAITING_BILL', 'OCCUPIED')`

export async function getFloorSummary(params: {
  restaurantId: string
  range: DateRange
  branchIds?: string[] | null
}): Promise<FloorSummary> {
  const { restaurantId, range } = params
  const ids = params.branchIds

  const scope = (alias: string) =>
    ids
      ? ids.length
        ? Prisma.sql`AND ${Prisma.raw(`${alias}."branchId"`)} IN (${Prisma.join(ids)})`
        : Prisma.sql`AND false`
      : Prisma.empty

  const [counts] = await prisma.$queryRaw<
    Array<{
      in_use: bigint
      free: bigint
      cleaning: bigint
      reserved: bigint
      out_of_service: bigint
      total: bigint
    }>
  >`
    SELECT
      COUNT(*) FILTER (WHERE t.status IN ${IN_USE})::bigint      AS in_use,
      COUNT(*) FILTER (WHERE t.status = 'AVAILABLE')::bigint     AS free,
      COUNT(*) FILTER (WHERE t.status = 'CLEANING')::bigint      AS cleaning,
      COUNT(*) FILTER (WHERE t.status = 'RESERVED')::bigint      AS reserved,
      COUNT(*) FILTER (WHERE t.status = 'OUT_OF_SERVICE')::bigint AS out_of_service,
      COUNT(*)::bigint                                            AS total
    FROM restaurant_tables t
    WHERE t."restaurantId" = ${restaurantId}
      AND t."isActive" = true
      ${scope('t')}
  `

  /*
   * Takings are joined through the ORDER's branch, not the table's. They are
   * the same in every ordinary case — a table stands in one building — but the
   * order is what carries the money, and scoping the money by where it was
   * taken is the honest reading.
   *
   * `guestCount` is nullable: a walk-in nobody counted. Summed with COALESCE so
   * a null contributes zero rather than turning the whole sum null.
   */
  const rows = await prisma.$queryRaw<
    Array<{
      id: string
      number: string
      area: string | null
      revenue: bigint | null
      orders: bigint
      covers: bigint | null
    }>
  >`
    SELECT t.id                                  AS id,
           t.number                              AS number,
           t.area                                AS area,
           SUM(o."grandTotal")::bigint           AS revenue,
           COUNT(*)::bigint                      AS orders,
           COALESCE(SUM(o."guestCount"), 0)::bigint AS covers
    FROM orders o
    JOIN restaurant_tables t ON t.id = o."tableId"
    WHERE o."restaurantId" = ${restaurantId}
      AND o.status <> 'CANCELLED'
      AND o."placedAt" >= ${utc(range.from)}
      AND o."placedAt" <= ${utc(range.to)}
      ${scope('o')}
    GROUP BY t.id, t.number, t.area
    ORDER BY revenue DESC NULLS LAST
    LIMIT 6
  `

  const [totals] = await prisma.$queryRaw<Array<{ seated: bigint; revenue: bigint }>>`
    SELECT COUNT(*)::bigint                        AS seated,
           COALESCE(SUM(o."grandTotal"), 0)::bigint AS revenue
    FROM orders o
    WHERE o."restaurantId" = ${restaurantId}
      AND o.status <> 'CANCELLED'
      AND o."tableId" IS NOT NULL
      AND o."placedAt" >= ${utc(range.from)}
      AND o."placedAt" <= ${utc(range.to)}
      ${scope('o')}
  `

  const seatedOrders = Number(totals?.seated ?? 0)
  const seatedRevenue = Number(totals?.revenue ?? 0)

  return {
    inUse: Number(counts?.in_use ?? 0),
    free: Number(counts?.free ?? 0),
    cleaning: Number(counts?.cleaning ?? 0),
    reserved: Number(counts?.reserved ?? 0),
    outOfService: Number(counts?.out_of_service ?? 0),
    total: Number(counts?.total ?? 0),
    topTables: rows.map((r) => ({
      id: r.id,
      number: r.number,
      area: r.area,
      revenue: Number(r.revenue ?? 0),
      orders: Number(r.orders),
      covers: Number(r.covers ?? 0),
    })),
    seatedOrders,
    averageTableSpend: seatedOrders > 0 ? Math.round(seatedRevenue / seatedOrders) : 0,
  }
}
