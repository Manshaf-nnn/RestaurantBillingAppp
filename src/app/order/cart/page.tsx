import { notFound } from 'next/navigation'
import type { Metadata } from 'next'

import { CartCheckout } from '@/features/orders/components/cart-checkout'
import { resolvePublicTenant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Your order' }

export default async function CartPage() {
  const restaurant = await resolvePublicTenant()
  if (!restaurant) notFound()

  return (
    <CartCheckout
      currency={restaurant.currency}
      locale={restaurant.locale === 'en' ? 'en-IN' : restaurant.locale}
      taxLabel={restaurant.taxLabel}
      restaurantName={restaurant.name}
    />
  )
}
