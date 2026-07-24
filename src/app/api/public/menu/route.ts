import { NextResponse, type NextRequest } from 'next/server'

import { getPublicMenu } from '@/features/menu/queries'
import { toAppError } from '@/lib/errors'
import { getRestaurantBySlug, resolvePublicTenant } from '@/server/db/tenant'
import { enforceRateLimit } from '@/server/security/rate-limit'

export const dynamic = 'force-dynamic'

/**
 * Public menu API.
 *   GET /api/public/menu?r=<slug>
 * Returns the same priced menu the guest web app renders.
 */
export async function GET(request: NextRequest) {
  try {
    await enforceRateLimit('publicRead')

    const slug = request.nextUrl.searchParams.get('r')
    const restaurant = slug ? await getRestaurantBySlug(slug) : await resolvePublicTenant()

    if (!restaurant) {
      return NextResponse.json({ error: 'Restaurant not found', code: 'NOT_FOUND' }, { status: 404 })
    }

    const menu = await getPublicMenu(restaurant.id, restaurant.timezone)

    return NextResponse.json(
      {
        restaurant: {
          name: restaurant.name,
          slug: restaurant.slug,
          currency: restaurant.currency,
          tagline: restaurant.tagline,
        },
        categories: menu.categories,
        items: menu.items,
      },
      { headers: { 'Cache-Control': 'public, max-age=30, stale-while-revalidate=120' } },
    )
  } catch (error) {
    const app = toAppError(error)
    return NextResponse.json({ error: app.message, code: app.code }, { status: app.status })
  }
}
