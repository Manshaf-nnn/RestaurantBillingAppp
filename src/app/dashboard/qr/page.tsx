import type { Metadata } from 'next'

import { QrPoster } from '@/features/settings/components/qr-poster'
import { toQrDataUrl } from '@/features/payments/service'
import { appUrl } from '@/lib/env'
import { PERMISSIONS } from '@/lib/rbac'
import { requirePagePermission } from '@/server/auth/guard'
import { requireRestaurant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'QR code' }

export default async function QrPage() {
  const user = await requirePagePermission(PERMISSIONS.SETTINGS_VIEW, '/dashboard/qr')
  const restaurant = await requireRestaurant(user.restaurantId)

  const orderUrl = `${appUrl()}/order?r=${restaurant.slug}`
  const qrDataUrl = await toQrDataUrl(orderUrl)

  return <QrPoster restaurantName={restaurant.name} orderUrl={orderUrl} qrDataUrl={qrDataUrl} />
}
