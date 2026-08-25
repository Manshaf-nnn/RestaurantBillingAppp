import type { Metadata } from 'next'

import { SettingsView } from '@/features/settings/components/settings-view'
import { readPaymentConfig } from '@/features/payments/service'
import { readPaperWidths } from '@/features/printing/paper'
import { getApprovalPolicy } from '@/features/approvals/service'
import { minorUnitFactor } from '@/lib/money'
import { can, PERMISSIONS } from '@/lib/rbac'
import { requirePagePermission } from '@/server/auth/guard'
import { prisma } from '@/server/db/prisma'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Settings' }

export default async function SettingsPage() {
  const user = await requirePagePermission(PERMISSIONS.SETTINGS_VIEW, '/dashboard/settings')
  const restaurant = await prisma.restaurant.findUniqueOrThrow({ where: { id: user.restaurantId } })
  const payment = readPaymentConfig(restaurant.paymentConfig)
  const policy = await getApprovalPolicy(user.restaurantId)
  // Stored in minor units, shown and typed in major ones — the same boundary
  // every other cash field in the app crosses.
  const factor = minorUnitFactor(restaurant.currency)

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
        allowNegativeStock: restaurant.allowNegativeStock,
        serviceChargePercent: restaurant.serviceChargeBps / 100,
        loyaltyEnabled: restaurant.loyaltyEnabled,
        loyaltyEarnRate: restaurant.loyaltyEarnRateX100 / 100,
        loyaltyPointValue: restaurant.loyaltyPointValue / 100,
        printer: {
          receiptWidth: readPaperWidths(restaurant.printerConfig).receipt,
          kitchenWidth: readPaperWidths(restaurant.printerConfig).kitchen,
        },
        cash: {
          cashVarianceAbove: policy.cashVarianceAbove / factor,
          pettyCashApprovalAbove: policy.pettyCashApprovalAbove / factor,
          requireCashierSession: policy.requireCashierSession,
        },
        payment: {
          cash: payment.cash ?? true,
          card: payment.card ?? true,
          qr: payment.qr ?? true,
          online: payment.online ?? false,
          upiId: payment.upiId ?? '',
          payeeName: payment.payeeName ?? '',
          bankTransfer: payment.bankTransfer ?? false,
          bankName: payment.bankName ?? '',
          accountName: payment.accountName ?? '',
          accountNumber: payment.accountNumber ?? '',
          bankBranch: payment.bankBranch ?? '',
          receiptWhatsapp: payment.receiptWhatsapp ?? '',
        },
      }}
    />
  )
}
