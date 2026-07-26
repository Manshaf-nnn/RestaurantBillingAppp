import type { Metadata, Viewport } from 'next'

import { Providers } from '@/components/providers'
import { appUrl } from '@/lib/env'

import './globals.css'

export const metadata: Metadata = {
  metadataBase: new URL(appUrl()),
  title: {
    default: 'TableFlow — Smart Dining, Simplified',
    template: '%s · TableFlow',
  },
  description:
    'Cloud restaurant operating system: QR ordering, kitchen display, billing, payments, inventory and analytics in one platform.',
  applicationName: 'TableFlow',
  manifest: '/manifest.webmanifest',
  appleWebApp: {
    capable: true,
    title: 'TableFlow',
    statusBarStyle: 'black-translucent',
  },
  formatDetection: { telephone: false },
  openGraph: {
    type: 'website',
    siteName: 'TableFlow',
    title: 'TableFlow — Restaurant POS & QR Ordering',
    description:
      'Run your whole restaurant from one screen: orders, kitchen, billing, inventory and insights.',
  },
  robots: { index: true, follow: true },
}

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#0d0f14' },
  ],
  width: 'device-width',
  initialScale: 1,
  maximumScale: 5,
  viewportFit: 'cover',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[100] focus:rounded-lg focus:bg-primary focus:px-4 focus:py-2 focus:text-primary-foreground"
        >
          Skip to content
        </a>
        <Providers>{children}</Providers>
        <script
          // Registers the offline service worker for staff dashboards.
          dangerouslySetInnerHTML={{
            __html: `if('serviceWorker' in navigator){window.addEventListener('load',function(){navigator.serviceWorker.register('/sw.js').catch(function(){})})}`,
          }}
        />
      </body>
    </html>
  )
}
