import type { Metadata } from 'next'

import { SettingsView } from '@/features/settings/components/settings-view'
import { readPaymentConfig } from '@/features/payments/service'
import { can, PERMISSIONS } from '@/lib/rbac'
import { requirePagePermission } from '@/server/auth/guard'
import { prisma } from '@/server/db/prisma'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Settings' }

export default async function SettingsPage() {
  const user = await requirePagePermission(PERMISSIONS.SETTINGS_VIEW, '/dashboard/settings')
  const restaurant = await prisma.restaurant.findUniqueOrThrow({ where: { id: user.restaurantId } })
  const payment = readPaymentConfig(restaurant.paymentConfig)

  return (
    <SettingsView
      canManage={can(user, PERMISSIONS.SETTINGS_MANAGE)}
      initial={{
        name: restaurant.name,
        tagline: restaurant.tagline ?? '',
        description: restaurant.description ?? '',
        logoUrl: restaurant.logoUrl ?? '',
        coverUrl: restaurant.coverUrl ?? '',
        email: restaurant.email ?? '',
        phone: restaurant.phone ?? '',
        addressLine: restaurant.addressLine ?? '',
        city: restaurant.city ?? '',
        state: restaurant.state ?? '',
        postalCode: restaurant.postalCode ?? '',
        currency: restaurant.currency,
        timezone: restaurant.timezone,
        taxLabel: restaurant.taxLabel,
        taxRatePercent: restaurant.taxRateBps / 100,
        taxInclusive: restaurant.taxInclusive,
        serviceChargePercent: restaurant.serviceChargeBps / 100,
        loyaltyEnabled: restaurant.loyaltyEnabled,
        loyaltyEarnRate: restaurant.loyaltyEarnRateX100 / 100,
        payment: {
          cash: payment.cash ?? true,
          card: payment.card ?? true,
          qr: payment.qr ?? true,
          online: payment.online ?? false,
          upiId: payment.upiId ?? '',
          payeeName: payment.payeeName ?? '',
        },
      }}
    />
  )
}
