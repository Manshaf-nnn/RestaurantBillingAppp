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

export default async function MenuPage() {
  const restaurant = await resolvePublicTenant()
  if (!restaurant) notFound()

  // Which branch this guest is in, from the QR's code (via the cookie the
  // middleware set) or the restaurant's default. Their menu and their prices.
  const branch = await resolvePublicBranch(restaurant.id)
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
