import { NextResponse, type NextRequest } from 'next/server'

import { getPublicMenu } from '@/features/menu/queries'
import { resolvePublicBranch } from '@/features/branches/public-branch'
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

    /*
     * The branch, from `?b=` or the cookie. It MUST also go in the cache key
     * below, or the first branch to warm the cache is served to every other
     * one — the same mistake the analytics cache keys made, and a wrong menu
     * at a wrong price is worse than a slow one.
     */
    const branch = await resolvePublicBranch(
      restaurant.id,
      request.nextUrl.searchParams.get('b'),
    )
    const menu = await getPublicMenu(restaurant.id, restaurant.timezone, branch?.id ?? null)

    return NextResponse.json(
      {
        restaurant: {
          name: restaurant.name,
          slug: restaurant.slug,
          currency: restaurant.currency,
          tagline: restaurant.tagline,
        },
        branch: branch ? { name: branch.name, code: branch.code } : null,
        categories: menu.categories,
        items: menu.items,
      },
      {
        headers: {
          'Cache-Control': 'public, max-age=30, stale-while-revalidate=120',
          /*
           * The response now varies by branch, and the branch arrives in a
           * cookie. Without this, a shared cache would hand the first branch's
           * menu — and its prices — to every guest at every other branch for
           * the next thirty seconds. `Vary: Cookie` is blunt (it splits the
           * cache per guest session) but a correct menu at a correct price is
           * worth far more than the hit rate.
           */
          Vary: 'Cookie',
        },
      },
    )
  } catch (error) {
    const app = toAppError(error)
    return NextResponse.json({ error: app.message, code: app.code }, { status: app.status })
  }
}
