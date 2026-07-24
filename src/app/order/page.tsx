import { notFound } from 'next/navigation'
import type { Metadata } from 'next'

import { TableEntry } from '@/features/orders/components/table-entry'
import { isOpenNow, parseOpeningHours, todayLabel } from '@/lib/opening-hours'
import { resolvePublicTenant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'

export async function generateMetadata(): Promise<Metadata> {
  const restaurant = await resolvePublicTenant()
  return {
    title: restaurant ? `Order at ${restaurant.name}` : 'Order',
    description: restaurant?.tagline ?? 'Scan, pick your table and order from your phone.',
  }
}

export default async function OrderEntryPage() {
  const restaurant = await resolvePublicTenant()
  if (!restaurant) notFound()

  const hours = parseOpeningHours(restaurant.openingHours)

  return (
    <TableEntry
      restaurantName={restaurant.name}
      tagline={restaurant.tagline}
      logoUrl={restaurant.logoUrl}
      coverUrl={restaurant.coverUrl}
      city={restaurant.city}
      isOpen={isOpenNow(hours, restaurant.timezone)}
      openingLabel={todayLabel(hours, restaurant.timezone)}
    />
  )
}
