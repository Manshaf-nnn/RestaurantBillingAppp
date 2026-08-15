'use server'

import { revalidatePath } from 'next/cache'
import type { Prisma } from '@prisma/client'

import { runAction, type ActionResult } from '@/lib/action'
import { bpsFromPercent } from '@/lib/money'
import { PERMISSIONS } from '@/lib/rbac'
import { AUDIT_ACTIONS, audit } from '@/server/audit'
import { requirePermission } from '@/server/auth/guard'
import { prisma } from '@/server/db/prisma'
import { paymentSettingsSchema, printerSettingsSchema, restaurantSettingsSchema } from './schema'

export async function updateRestaurantSettings(input: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction(
    restaurantSettingsSchema,
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.SETTINGS_MANAGE)

      const updated = await prisma.restaurant.update({
        where: { id: user.restaurantId },
        data: {
          name: data.name,
          tagline: data.tagline || null,
          description: data.description || null,
          logoUrl: data.logoUrl || null,
          coverUrl: data.coverUrl || null,
          email: data.email || null,
          phone: data.phone || null,
          addressLine: data.addressLine || null,
          city: data.city || null,
          state: data.state || null,
          postalCode: data.postalCode || null,
          currency: data.currency,
          timezone: data.timezone,
          taxLabel: data.taxLabel,
          taxRateBps: bpsFromPercent(data.taxRatePercent),
          taxInclusive: data.taxInclusive,
          serviceChargeBps: bpsFromPercent(data.serviceChargePercent),
          loyaltyEnabled: data.loyaltyEnabled,
          loyaltyEarnRateX100: Math.round(data.loyaltyEarnRate * 100),
          // Stored in minor units (paise/cents).
          loyaltyPointValue: Math.round(data.loyaltyPointValue * 100),
        },
      })

      await audit({
        restaurantId: user.restaurantId,
        userId: user.id,
        actorName: user.name,
        action: AUDIT_ACTIONS.SETTINGS_UPDATED,
        entity: 'Restaurant',
        entityId: user.restaurantId,
        after: { name: data.name, currency: data.currency },
      })

      revalidatePath('/dashboard/settings')
      return { id: updated.id }
    },
    'Settings saved.',
  )
}

export async function updatePaymentSettings(input: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction(
    paymentSettingsSchema,
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.SETTINGS_MANAGE)

      await prisma.restaurant.update({
        where: { id: user.restaurantId },
        data: {
          paymentConfig: {
            cash: data.cash,
            card: data.card,
            qr: data.qr,
            online: data.online,
            upiId: data.upiId || undefined,
            payeeName: data.payeeName || undefined,
            bankTransfer: data.bankTransfer,
            bankName: data.bankName || undefined,
            accountName: data.accountName || undefined,
            accountNumber: data.accountNumber || undefined,
            bankBranch: data.bankBranch || undefined,
            receiptWhatsapp: data.receiptWhatsapp || undefined,
          } as Prisma.InputJsonValue,
        },
      })

      await audit({
        restaurantId: user.restaurantId,
        userId: user.id,
        actorName: user.name,
        action: AUDIT_ACTIONS.SETTINGS_UPDATED,
        entity: 'Restaurant',
        entityId: user.restaurantId,
        after: { payments: 'updated' },
      })

      revalidatePath('/dashboard/settings')
      return { id: user.restaurantId }
    },
    'Payment settings saved.',
  )
}

export async function updatePrinterSettings(input: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction(
    printerSettingsSchema,
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.SETTINGS_MANAGE)

      await prisma.restaurant.update({
        where: { id: user.restaurantId },
        data: {
          printerConfig: {
            receipt: { width: data.receiptWidth },
            kitchen: { width: data.kitchenWidth },
          } as Prisma.InputJsonValue,
        },
      })

      await audit({
        restaurantId: user.restaurantId,
        userId: user.id,
        actorName: user.name,
        action: AUDIT_ACTIONS.SETTINGS_UPDATED,
        entity: 'Restaurant',
        entityId: user.restaurantId,
        after: { printer: { receipt: data.receiptWidth, kitchen: data.kitchenWidth } },
      })

      revalidatePath('/dashboard/settings')
      revalidatePath('/cashier')
      revalidatePath('/kitchen')
      return { id: user.restaurantId }
    },
    'Printer settings saved.',
  )
}
