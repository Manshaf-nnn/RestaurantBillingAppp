import type { Metadata } from 'next'
import QRCode from 'qrcode'

import { DemoSite } from '@/features/demo/demo-site'
import type { QrShape } from '@/features/demo/ui'

/*
 * The public demo.
 *
 * This is the page the QR on the visiting card opens, so the address is fixed:
 * it must keep working for as long as those cards are in people's wallets. It
 * needs no sign-in (the middleware only guards its allow-listed prefixes) and
 * reads nothing from the database — every figure comes from
 * `features/demo/data.ts`.
 */
const DEMO_URL = 'https://tableflow.markui.lk/demo'

export const metadata: Metadata = {
  title: 'Live demo',
  description:
    'Try TableFlow with sample data: QR table ordering, billing, kitchen screen, live floor, stock, transfers, approvals and reports.',
  alternates: { canonical: DEMO_URL },
  openGraph: {
    type: 'website',
    url: DEMO_URL,
    siteName: 'TableFlow',
    title: 'TableFlow live demo — run your whole restaurant from one screen',
    description: 'Tap through the real screens with sample data. No sign-up needed.',
    images: [{ url: '/logo-full.png' }],
  },
}

/** The same QR that is printed on the card, as one SVG path with a quiet zone. */
function demoQr(): QrShape {
  const quiet = 2
  const { modules } = QRCode.create(DEMO_URL, { errorCorrectionLevel: 'Q' })
  let path = ''
  for (let row = 0; row < modules.size; row++) {
    for (let col = 0; col < modules.size; col++) {
      if (modules.get(row, col)) path += `M${col + quiet} ${row + quiet}h1v1h-1z`
    }
  }
  return { size: modules.size + quiet * 2, path }
}

export default function DemoPage() {
  return <DemoSite qr={demoQr()} demoUrl={DEMO_URL} />
}
