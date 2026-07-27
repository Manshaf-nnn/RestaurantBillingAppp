import { notFound } from 'next/navigation'

import { CartProvider } from '@/features/orders/cart-store'
import { resolvePublicTenant } from '@/server/db/tenant'

/**
 * The public QR-ordering shell.
 *
 * The tenant is resolved from the request (host / `?r=` slug / single-tenant
 * fallback) once, here, and shared with every screen below.
 */
export default async function OrderLayout({ children }: { children: React.ReactNode }) {
  const restaurant = await resolvePublicTenant()

  if (!restaurant) notFound()

  return (
    <div className="min-h-dvh">
      <CartProvider restaurantId={restaurant.id}>
        <div className="glass-chrome mx-auto min-h-dvh w-full max-w-lg overflow-x-clip shadow-elevated sm:my-0">
          {children}
        </div>
      </CartProvider>
    </div>
  )
}
