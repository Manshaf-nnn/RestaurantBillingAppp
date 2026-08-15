import { NextResponse, type NextRequest } from 'next/server'

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
 */
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

    return json(await staffToken(user.restaurantId))
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

/** Everything an operational screen reacts to, collapsed into one value. */
async function staffToken(restaurantId: string): Promise<string> {
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
          AND o.status IN ('PENDING', 'ACCEPTED', 'PREPARING', 'READY'))::bigint AS order_active,
      (SELECT EXTRACT(EPOCH FROM MAX(oi."updatedAt"))::double precision
         FROM order_items oi
         JOIN orders o ON o.id = oi."orderId"
        WHERE o."restaurantId" = ${restaurantId}
          AND o.status IN ('PENDING', 'ACCEPTED', 'PREPARING', 'READY'))        AS item_ts,
      (SELECT EXTRACT(EPOCH FROM MAX(sr."createdAt"))::double precision
         FROM service_requests sr
        WHERE sr."restaurantId" = ${restaurantId})                              AS request_ts,
      (SELECT COUNT(*)
         FROM service_requests sr
        WHERE sr."restaurantId" = ${restaurantId}
          AND sr.status = 'OPEN')::bigint                                        AS request_open
  `

  return [
    Math.round(row?.order_ts ?? 0),
    Number(row?.order_active ?? 0),
    Math.round(row?.item_ts ?? 0),
    Math.round(row?.request_ts ?? 0),
    Number(row?.request_open ?? 0),
  ].join('.')
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
