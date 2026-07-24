import { NextResponse } from 'next/server'

export const dynamic = 'force-static'

/** PWA manifest — installable staff dashboards and guest ordering. */
export function GET() {
  const manifest = {
    name: 'RestaurantOS',
    short_name: 'RestaurantOS',
    description: 'Restaurant POS, QR ordering, kitchen display and analytics.',
    start_url: '/dashboard',
    scope: '/',
    display: 'standalone',
    orientation: 'any',
    background_color: '#0d0f14',
    theme_color: '#ea580c',
    categories: ['business', 'food', 'productivity'],
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
    shortcuts: [
      { name: 'Kitchen display', url: '/kitchen' },
      { name: 'Cashier', url: '/cashier' },
      { name: 'Orders', url: '/dashboard/orders' },
    ],
  }

  return NextResponse.json(manifest, {
    headers: { 'Content-Type': 'application/manifest+json' },
  })
}
