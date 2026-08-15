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
    /*
     * Neutral shell. The dark "liquid glass" treatment belongs to the landing
     * screen alone — it paints its own full-viewport background — and must not
     * be set here, because this layout is shared with the menu, cart, tracking
     * and bill screens, which are built for the light theme. Forcing
     * `bg-zinc-950 text-white` at this level left those screens with a light
     * header floating on a black body and unreadable dark-on-dark text.
     */
    <div className="min-h-dvh bg-background">
      <CartProvider restaurantId={restaurant.id}>
        {/*
         * `overflow-x-clip` — NOT `overflow-x-hidden`. Per CSS spec, setting
         * `overflow-x: hidden` forces the computed `overflow-y` from `visible`
         * to `auto`, which turns this wrapper into a nested scroll container.
         * On mobile that fights the document scroll: `dvh` resizes as the
         * browser toolbar collapses, the container re-lays-out mid-scroll and
         * the scroll position snaps back to the top. `clip` contains the same
         * horizontal overflow without ever creating a scroll box, so the page
         * scrolls normally and `position: sticky` headers resolve against the
         * document as intended.
         */}
        <div className="relative mx-auto min-h-dvh w-full max-w-md overflow-x-clip bg-background shadow-2xl sm:my-0">
          {children}
        </div>
      </CartProvider>
    </div>
  )
}
