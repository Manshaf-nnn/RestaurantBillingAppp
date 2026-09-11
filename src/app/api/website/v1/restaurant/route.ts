import type { NextRequest } from 'next/server'

import { jsonNoStore, withWebsiteCaller } from '@/features/website/api'
import { listWebsiteBranches, websiteRestaurantView } from '@/features/website/service'
import { requestOrigin } from '@/lib/tenant-url'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Restaurant information and branding for the website (websiteconnect.md).
 *   GET /api/website/v1/restaurant
 *
 * Name, tagline, logo, cover, currency, tax rules, address, opening hours,
 * theme, and every branch that takes orders. Image URLs are absolute so they
 * load from the website's own pages. Nothing internal — payment accounts,
 * printer setup, receipt layout — is on this payload, by construction.
 */
export async function GET(request: NextRequest) {
  return withWebsiteCaller(request, 'websiteRead', async ({ restaurant }) => {
    const [branches, origin] = await Promise.all([
      listWebsiteBranches(restaurant.id),
      requestOrigin(),
    ])
    return jsonNoStore({ restaurant: websiteRestaurantView(restaurant, origin, branches) })
  })
}
