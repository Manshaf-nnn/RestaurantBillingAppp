import type { Metadata } from 'next'

import { SettingsView } from '@/features/settings/components/settings-view'
import { readPaymentConfig } from '@/features/payments/service'
import { readPaperWidths } from '@/features/printing/paper'
import { readReceiptFields } from '@/features/printing/receipt-fields'
import { getLiveBoardPolicy } from '@/features/live/policy'
import { getApprovalPolicy } from '@/features/approvals/service'
import { readAppearance } from '@/features/guest/appearance'
import { mergeSmsConfig } from '@/features/sms/config'
import { publicSmsConfig } from '@/features/sms/types'
import { isOpenNow, parseOpeningHours, todayLabel } from '@/lib/opening-hours'
import { isCredentialStoreReady } from '@/lib/env'
import { minorUnitFactor } from '@/lib/money'
import { can, PERMISSIONS } from '@/lib/rbac'
import { requirePagePermission } from '@/server/auth/guard'
import { prisma } from '@/server/db/prisma'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Settings' }

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const user = await requirePagePermission(PERMISSIONS.SETTINGS_VIEW, '/dashboard/settings')
  const params = await searchParams
  const restaurant = await prisma.restaurant.findUniqueOrThrow({ where: { id: user.restaurantId } })
  const payment = readPaymentConfig(restaurant.paymentConfig)
  // Only live accounts: a method may not be pointed at one that is retired.
  const accounts = await prisma.paymentAccount.findMany({
    where: { restaurantId: user.restaurantId, isActive: true },
    orderBy: { name: 'asc' },
    select: { code: true, name: true, bankName: true },
  })
  const policy = await getApprovalPolicy(user.restaurantId)
  const livePolicy = await getLiveBoardPolicy(user.restaurantId)
  // Stored in minor units, shown and typed in major ones — the same boundary
  // every other cash field in the app crosses.
  const factor = minorUnitFactor(restaurant.currency)
  const hours = parseOpeningHours(restaurant.openingHours)

  return (
    <SettingsView
      canManage={can(user, PERMISSIONS.SETTINGS_MANAGE)}
      initialTab={typeof params.tab === 'string' ? params.tab : 'profile'}
      guest={{
        appearance: readAppearance(restaurant.guestExperience),
        isOpen: isOpenNow(hours, restaurant.timezone),
        openingLabel: todayLabel(hours, restaurant.timezone),
      }}
      /* Ciphertext stripped here, at the boundary — the browser gets which
       * slots are filled and their last four characters, never the values. */
      sms={publicSmsConfig(mergeSmsConfig(restaurant.smsConfig as never))}
      credentialStoreReady={isCredentialStoreReady()}
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
        receipt: readReceiptFields(restaurant.receiptConfig),
        /*
         * The real accounts, from the table (bank.md). The dropdown may only
         * offer somewhere money can actually land, so this is the live rows
         * rather than `paymentConfig.destinations`, which is now legacy.
         */
        destinations: accounts.map((account) => ({
          code: account.code,
          name: account.name,
          bankName: account.bankName,
        })),
        // `readPaymentConfig` drops empty codes, so a method missing from this
        // map is a method with nowhere to book — which is what the screen shows.
        methodDestinations: (payment.methodDestinations ?? {}) as Record<string, string>,
        live: {
          ...livePolicy,
          // Typed in whole currency like every other amount on this screen.
          vipAfterSpend: livePolicy.vipAfterSpend / factor,
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
