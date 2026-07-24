import { NextResponse, type NextRequest } from 'next/server'

import { getOrderForGuest, readOptions } from '@/features/orders/queries'
import { toAppError } from '@/lib/errors'
import { resolvePublicTenant } from '@/server/db/tenant'
import { enforceRateLimit } from '@/server/security/rate-limit'

export const dynamic = 'force-dynamic'

/**
 * Guest order status API.
 *   GET /api/public/orders/<orderId>
 * Requires the guest session cookie set when the order was placed — used by the
 * PWA/offline layer to poll status when the websocket is unavailable.
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ orderId: string }> }) {
  try {
    await enforceRateLimit('publicRead')
    const { orderId } = await params

    const restaurant = await resolvePublicTenant()
    if (!restaurant) {
      return NextResponse.json({ error: 'Restaurant not found', code: 'NOT_FOUND' }, { status: 404 })
    }

    const order = await getOrderForGuest(restaurant.id, orderId)
    if (!order) {
      return NextResponse.json({ error: 'Order not found', code: 'NOT_FOUND' }, { status: 404 })
    }

    return NextResponse.json({
      id: order.id,
      orderNumber: order.orderNumber,
      status: order.status,
      paymentStatus: order.paymentStatus,
      estimatedMinutes: order.estimatedMinutes,
      grandTotal: order.grandTotal,
      placedAt: order.placedAt.toISOString(),
      items: order.items.map((item) => ({
        name: item.name,
        quantity: item.quantity,
        status: item.status,
        options: readOptions(item.options).map((option) => option.name),
      })),
    })
  } catch (error) {
    const app = toAppError(error)
    return NextResponse.json({ error: app.message, code: app.code }, { status: app.status })
  }
}
