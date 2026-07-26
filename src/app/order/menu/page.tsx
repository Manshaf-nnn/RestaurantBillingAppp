import { notFound } from 'next/navigation'
import type { Metadata } from 'next'

import { getPublicMenu } from '@/features/menu/queries'
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

  const menu = await getPublicMenu(restaurant.id, restaurant.timezone)

  return (
    <MenuBrowser
      menu={menu}
      restaurantName={restaurant.name}
      currency={restaurant.currency}
      locale={restaurant.locale === 'en' ? 'en-IN' : restaurant.locale}
      loyalty={{
        enabled: restaurant.loyaltyEnabled,
        earnRateX100: restaurant.loyaltyEarnRateX100,
        pointValue: restaurant.loyaltyPointValue,
      }}
    />
  )
}
