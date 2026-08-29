import { NextResponse, type NextRequest } from 'next/server'

import { Prisma } from '@prisma/client'

import { prisma } from '@/server/db/prisma'
import { getCurrentUser, getGuestSessionId } from '@/server/auth/session'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Change detector for screens that cannot hold a websocket.
 *
 *   GET /api/pulse                → staff scope, from the signed-in session
 *   GET /api/pulse?orderId=<id>   → guest scope, for one order
 *
 * Returns a short opaque token that changes whenever anything the caller cares
 * about has changed. Clients poll this and only re-render when the token moves.
 *
 * The point is cost. Re-rendering a whole route to discover nothing happened
 * means re-running every query on the page; on a serverless host that is a slow,
 * expensive invocation repeated all day. This is a single indexed statement
 * returning a few dozen bytes, so screens can check *more* often than before
 * while doing a fraction of the work — and the expensive refresh happens only on
 * a real change.
 *
 * Every lookup is bounded by an index, so cost stays flat as history grows:
 * `MAX("updatedAt")` per restaurant is an index scan on
 * `orders(restaurantId, updatedAt)`, and the item timestamp is restricted to
 * orders still in an active status — a handful of rows at any moment.
 *
 * Note there is deliberately no time window here. Windowing on `placedAt` looks
 * cheaper but is wrong: an order placed before the window that then changes
 * status would never move the token, and the screens watching it would sit
 * stale.
 *
 * ── Scopes, and why there is more than one ──────────────────────────────────
 *
 *   ?scope=ops       orders, items, service requests   (the original)
 *   ?scope=catalog   the menu, and what stock backs it
 *   ?scope=live      ops + the floor + customers
 *
 * The token used to watch orders and nothing else, which meant **editing the
 * menu moved nothing**. Every screen polled faithfully, correctly concluded
 * that nothing had happened, and went on showing yesterday's menu until
 * somebody reloaded the browser — which is exactly what the till did.
 *
 * The obvious repair — one token watching everything — is worse than the bug.
 * A refresh re-renders the whole route including the layout, so a token that
 * moves on every order-item update would re-run every report page, every ten
 * seconds, all day, on a host billed per invocation. That is the cost this
 * route exists to avoid.
 *
 * So a screen says what it is watching. The till reacts to a new dish and
 * ignores the kitchen; the kitchen reacts to the kitchen and ignores the menu.
 */
export type PulseScope = 'ops' | 'catalog' | 'live'

const SCOPES: readonly PulseScope[] = ['ops', 'catalog', 'live']

function scopeOf(raw: string | null): PulseScope {
  return SCOPES.includes(raw as PulseScope) ? (raw as PulseScope) : 'ops'
}

export async function GET(request: NextRequest) {
  try {
    const orderId = request.nextUrl.searchParams.get('orderId')

    if (orderId) {
      const token = await guestToken(orderId)
      return json(token)
    }

    const user = await getCurrentUser()
    if (!user?.restaurantId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const scope = scopeOf(request.nextUrl.searchParams.get('scope'))
    return json(await staffToken(user.restaurantId, scope))
  } catch {
    // Never fail loudly: a failed pulse should leave the screen on its previous
    // token and try again, not surface an error to someone working a service.
    return json(null)
  }
}

function json(token: string | null) {
  return NextResponse.json(
    { v: token },
    // Must never be cached — a stale token would mean a screen that never updates.
    { headers: { 'Cache-Control': 'no-store, max-age=0' } },
  )
}

/**
 * An epoch timestamp, in MILLISECONDS.
 *
 * Seconds are not enough resolution. `EXTRACT(EPOCH …)` returns a float and
 * rounding it to the nearest second makes two changes within the same second
 * indistinguishable — so a row edited moments after the previous poll produced
 * an identical token and the screens watching it sat stale until the next
 * unrelated change happened along. Rare in a quiet restaurant and routine
 * during a rush, which is precisely the wrong way round.
 */
const ts = (value: number | null | undefined) => Math.round(Number(value ?? 0) * 1000)

/** A count, which is how the token notices a DELETE — those move no timestamp. */
const n = (value: bigint | number | null | undefined) => Number(value ?? 0)

/**
 * Which order statuses count as "still going on".
 *
 * `live` includes SERVED because a table whose food is all out but whose bill
 * is unpaid is still on the floor, and the board raises a payment-pending alert
 * about exactly that. The operational screens stop at READY, which is right for
 * them — a kitchen has no further interest in a served order.
 */
const ACTIVE_OPS = `('PENDING', 'ACCEPTED', 'PREPARING', 'READY')`
const ACTIVE_LIVE = `('PENDING', 'ACCEPTED', 'PREPARING', 'READY', 'SERVED')`

/** Orders, items and service calls — what a kitchen, till or waiter reacts to. */
async function opsToken(restaurantId: string, active: string): Promise<string> {
  const [row] = await prisma.$queryRaw<
    Array<{
      order_ts: number | null
      order_active: bigint
      item_ts: number | null
      request_ts: number | null
      request_open: bigint
    }>
  >`
    SELECT
      (SELECT EXTRACT(EPOCH FROM MAX(o."updatedAt"))::double precision
         FROM orders o
        WHERE o."restaurantId" = ${restaurantId})                               AS order_ts,
      (SELECT COUNT(*)
         FROM orders o
        WHERE o."restaurantId" = ${restaurantId}
          AND o.status IN ${Prisma.raw(active)})::bigint                         AS order_active,
      (SELECT EXTRACT(EPOCH FROM MAX(oi."updatedAt"))::double precision
         FROM order_items oi
         JOIN orders o ON o.id = oi."orderId"
        WHERE o."restaurantId" = ${restaurantId}
          AND o.status IN ${Prisma.raw(active)})                                AS item_ts,
      (SELECT EXTRACT(EPOCH FROM MAX(sr."createdAt"))::double precision
         FROM service_requests sr
        WHERE sr."restaurantId" = ${restaurantId})                              AS request_ts,
      (SELECT COUNT(*)
         FROM service_requests sr
        WHERE sr."restaurantId" = ${restaurantId}
          AND sr.status = 'OPEN')::bigint                                        AS request_open
  `

  return [
    ts(row?.order_ts), n(row?.order_active), ts(row?.item_ts),
    ts(row?.request_ts), n(row?.request_open),
  ].join('.')
}

/**
 * The menu, and the stock behind it.
 *
 * This is the half that was missing, and it is why the till never noticed a new
 * dish. Counts sit beside the timestamps because a DELETE moves no `updatedAt`
 * — without them, removing an item from the menu would go unnoticed on every
 * other screen.
 */
async function catalogToken(restaurantId: string): Promise<string> {
  const [row] = await prisma.$queryRaw<
    Array<{
      food_ts: number | null
      food_n: bigint
      category_ts: number | null
      category_n: bigint
      branch_food_ts: number | null
      item_ts: number | null
      station_ts: number | null
      station_n: bigint
    }>
  >`
    SELECT
      (SELECT EXTRACT(EPOCH FROM MAX(f."updatedAt"))::double precision
         FROM foods f WHERE f."restaurantId" = ${restaurantId})                  AS food_ts,
      (SELECT COUNT(*) FROM foods f
        WHERE f."restaurantId" = ${restaurantId})::bigint                        AS food_n,
      (SELECT EXTRACT(EPOCH FROM MAX(c."updatedAt"))::double precision
         FROM categories c WHERE c."restaurantId" = ${restaurantId})             AS category_ts,
      (SELECT COUNT(*) FROM categories c
        WHERE c."restaurantId" = ${restaurantId})::bigint                        AS category_n,
      (SELECT EXTRACT(EPOCH FROM MAX(fb."updatedAt"))::double precision
         FROM food_branches fb
         JOIN foods f ON f.id = fb."foodId"
        WHERE f."restaurantId" = ${restaurantId})                                AS branch_food_ts,
      (SELECT EXTRACT(EPOCH FROM MAX(ii."updatedAt"))::double precision
         FROM inventory_items ii
        WHERE ii."restaurantId" = ${restaurantId})                               AS item_ts,
      (SELECT EXTRACT(EPOCH FROM MAX(ks."updatedAt"))::double precision
         FROM kitchen_stations ks
        WHERE ks."restaurantId" = ${restaurantId})                               AS station_ts,
      -- The count matters as much as the timestamp: retiring a section is an
      -- UPDATE and moves the clock, but deleting one moves nothing at all.
      (SELECT COUNT(*) FROM kitchen_stations ks
        WHERE ks."restaurantId" = ${restaurantId})::bigint                       AS station_n
  `

  return [
    ts(row?.food_ts), n(row?.food_n), ts(row?.category_ts),
    n(row?.category_n), ts(row?.branch_food_ts), ts(row?.item_ts),
    ts(row?.station_ts), n(row?.station_n),
  ].join('.')
}

/** The floor itself: table states and the customers sitting at them. */
async function floorToken(restaurantId: string): Promise<string> {
  const [row] = await prisma.$queryRaw<
    Array<{ table_ts: number | null; table_n: bigint; customer_ts: number | null }>
  >`
    SELECT
      (SELECT EXTRACT(EPOCH FROM MAX(t."updatedAt"))::double precision
         FROM restaurant_tables t WHERE t."restaurantId" = ${restaurantId})      AS table_ts,
      (SELECT COUNT(*) FROM restaurant_tables t
        WHERE t."restaurantId" = ${restaurantId} AND t."isActive")::bigint       AS table_n,
      (SELECT EXTRACT(EPOCH FROM MAX(c."updatedAt"))::double precision
         FROM customers c WHERE c."restaurantId" = ${restaurantId})              AS customer_ts
  `
  return [ts(row?.table_ts), n(row?.table_n), ts(row?.customer_ts)].join('.')
}

/** Everything the caller's screen reacts to, collapsed into one value. */
async function staffToken(restaurantId: string, scope: PulseScope): Promise<string> {
  if (scope === 'catalog') return catalogToken(restaurantId)

  if (scope === 'live') {
    // Two statements rather than one wide one: they are independent index
    // lookups, so running them together costs the slower of the pair.
    const [ops, floor] = await Promise.all([
      opsToken(restaurantId, ACTIVE_LIVE),
      floorToken(restaurantId),
    ])
    return `${ops}.${floor}`
  }

  return opsToken(restaurantId, ACTIVE_OPS)
}

/**
 * A guest may only watch their own order, proven by the same guest-session
 * cookie that authorises the tracking and bill screens.
 */
async function guestToken(orderId: string): Promise<string | null> {
  const guestSessionId = await getGuestSessionId()
  if (!guestSessionId) return null

  const order = await prisma.order.findFirst({
    where: { id: orderId, guestSessionId },
    select: {
      updatedAt: true,
      status: true,
      paymentStatus: true,
      items: { select: { updatedAt: true }, orderBy: { updatedAt: 'desc' }, take: 1 },
    },
  })
  if (!order) return null

  const itemTs = order.items[0]?.updatedAt?.getTime() ?? 0
  return [
    Math.round(order.updatedAt.getTime() / 1000),
    Math.round(itemTs / 1000),
    order.status,
    order.paymentStatus,
  ].join('.')
}
