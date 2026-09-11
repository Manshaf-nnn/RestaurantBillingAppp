import type { NextRequest } from 'next/server'

import { jsonNoStore, withWebsiteCaller } from '@/features/website/api'
import { getOrderForWebsite, websiteOrderView } from '@/features/website/service'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Where an order is up to (websiteconnect.md).
 *   GET /api/website/v1/orders/{orderId}
 *
 * Status, payment status, lines and totals, read straight from the order the
 * kitchen and the till are working. Poll it; there is no webhook to host. An
 * order from another restaurant — or one the website did not place — is a
 * plain 404, because the key decides what exists.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ orderId: string }> },
) {
  return withWebsiteCaller(request, 'websiteRead', async ({ restaurant }) => {
    const { orderId } = await params
    const order = await getOrderForWebsite(restaurant.id, orderId)
    if (!order) return jsonNoStore({ error: 'Order not found', code: 'NOT_FOUND' }, 404)
    return jsonNoStore({ order: websiteOrderView(order) })
  })
}
