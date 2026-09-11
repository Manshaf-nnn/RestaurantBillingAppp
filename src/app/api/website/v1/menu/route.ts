import { NextResponse, type NextRequest } from 'next/server'

import { getPublicMenu } from '@/features/menu/queries'
import { withWebsiteCaller } from '@/features/website/api'
import { absoluteMediaUrl, resolveWebsiteBranch } from '@/features/website/service'
import { requestOrigin } from '@/lib/tenant-url'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * The menu, priced for one branch (websiteconnect.md).
 *   GET /api/website/v1/menu?branch=<code or id>
 *
 * The same `getPublicMenu` the QR ordering page renders — categories, items,
 * variants and add-ons, happy-hour and discount pricing already resolved,
 * per-branch price and availability applied. Prices are minor units in the
 * restaurant's currency. Omit `branch` for the default branch.
 *
 * `private`, not `public`: the reply is keyed by a credential and no shared
 * cache may keep it — but the website's own server may hold it for half a
 * minute, which is how the QR page treats the same data.
 */
export async function GET(request: NextRequest) {
  return withWebsiteCaller(request, 'websiteRead', async ({ restaurant }) => {
    const branch = await resolveWebsiteBranch(
      restaurant.id,
      request.nextUrl.searchParams.get('branch'),
    )
    const [menu, origin] = await Promise.all([
      getPublicMenu(restaurant.id, restaurant.timezone, branch.id),
      requestOrigin(),
    ])

    return NextResponse.json(
      {
        branch,
        currency: restaurant.currency,
        categories: menu.categories,
        items: menu.items.map((item) => ({
          ...item,
          imageUrl: absoluteMediaUrl(item.imageUrl, origin),
        })),
      },
      { headers: { 'Cache-Control': 'private, max-age=30' } },
    )
  })
}
