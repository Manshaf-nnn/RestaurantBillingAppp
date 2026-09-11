import type { NextRequest } from 'next/server'

import { jsonNoStore, withWebsiteCaller } from '@/features/website/api'
import { websiteOrderSchema } from '@/features/website/schema'
import { placeWebsiteOrder, websiteOrderView } from '@/features/website/service'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * An order from the website (websiteconnect.md).
 *   POST /api/website/v1/orders
 *   {
 *     "branch": "KDY",                 // optional — code or id; default branch otherwise
 *     "type": "TAKEAWAY" | "DELIVERY",
 *     "customerName": "Nimal", "customerPhone": "+94 77 123 4567",
 *     "deliveryAddress": "12 Galle Rd",  // DELIVERY only
 *     "notes": "no onions",
 *     "items": [{ "foodId": "…", "quantity": 2, "optionIds": ["…"], "notes": "" }],
 *     "couponCode": "SAVE10",
 *     "idempotencyKey": "checkout-8f3a…"  // one per checkout; retries return the same order
 *   }
 *
 * Goes through `placeOrder`, the same function the QR menu and the till use,
 * so the order is priced by TableFlow — client prices are never trusted — and
 * lands in the kitchen display, the POS queue, notifications and reports with
 * `channel: ONLINE`. It is created UNPAID: the cashier settles it at the till
 * like any other, which is how a website with no gateway stays honest.
 *
 * 201 with the priced order; 422 with `fieldErrors` when the body is wrong.
 */
export async function POST(request: NextRequest) {
  return withWebsiteCaller(request, 'websiteOrder', async (caller) => {
    const body: unknown = await request.json().catch(() => null)
    const parsed = websiteOrderSchema.safeParse(body)
    if (!parsed.success) {
      return jsonNoStore(
        {
          error: 'Check the order — one or more fields are wrong',
          code: 'VALIDATION_ERROR',
          fieldErrors: parsed.error.flatten().fieldErrors,
        },
        422,
      )
    }

    const order = await placeWebsiteOrder(caller, parsed.data)
    return jsonNoStore({ order: websiteOrderView(order) }, 201)
  })
}
