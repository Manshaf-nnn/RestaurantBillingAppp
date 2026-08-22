import { notFound } from 'next/navigation'
import type { Metadata } from 'next'

import { getPublicMenu } from '@/features/menu/queries'
import { resolvePublicBranch } from '@/features/branches/public-branch'
import { BrandTheme } from '@/features/orders/components/brand-theme'
import { MenuBrowser } from '@/features/orders/components/menu-browser'
import { resolvePublicTenant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'

export async function generateMetadata(): Promise<Metadata> {
  const restaurant = await resolvePublicTenant()
  return { title: restaurant ? `${restaurant.name} — Menu` : 'Menu' }
}

export default async function MenuPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const restaurant = await resolvePublicTenant()
  if (!restaurant) notFound()

  /*
   * Which branch this guest is in: their menu, and their prices.
   *
   * `?b=` first, then the cookie the middleware wrote, then the restaurant's
   * default. Reading the URL as well as the cookie matters on a phone that
   * drops cookies — an in-app browser, a private window — where the cookie
   * alone would silently show another branch's menu at another branch's prices.
   */
  const params = await searchParams
  const branchCode = typeof params.b === 'string' ? params.b : null
  /*
   * A code that matches no location is `notFound()`, not an error boundary.
   *
   * `resolvePublicBranch` refuses an explicitly-supplied code that matches
   * nothing, rather than quietly serving the default branch. That is the right
   * answer for an API caller; for a guest holding a phone it has to look like a
   * page that does not exist, not like the software falling over.
   */
  const branch = await resolvePublicBranch(restaurant.id, branchCode).catch(() => null)
  if (branchCode && !branch) notFound()
  const menu = await getPublicMenu(restaurant.id, restaurant.timezone, branch?.id ?? null)

  return (
    <BrandTheme logoUrl={restaurant.logoUrl} coverUrl={restaurant.coverUrl}>
      <MenuBrowser
        menu={menu}
        restaurantName={restaurant.name}
        logoUrl={restaurant.logoUrl}
        currency={restaurant.currency}
        locale={restaurant.locale === 'en' ? 'en-IN' : restaurant.locale}
        loyalty={{
          enabled: restaurant.loyaltyEnabled,
          earnRateX100: restaurant.loyaltyEarnRateX100,
          pointValue: restaurant.loyaltyPointValue,
        }}
      />
    </BrandTheme>
  )
}
