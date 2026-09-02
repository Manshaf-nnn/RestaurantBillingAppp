'use server'

import { revalidatePath } from 'next/cache'
import type { Prisma } from '@prisma/client'

import { getLiveBoardPolicy } from '@/features/live/policy'
import { runAction, type ActionResult } from '@/lib/action'
import { bpsFromPercent } from '@/lib/money'
import { PERMISSIONS } from '@/lib/rbac'
import { AUDIT_ACTIONS, audit } from '@/server/audit'
import { requirePermission } from '@/server/auth/guard'
import { prisma } from '@/server/db/prisma'
import { requireRestaurant } from '@/server/db/tenant'
import { minorUnitFactor } from '@/lib/money'
import { getApprovalPolicy } from '@/features/approvals/service'
import {
  cashControlsSchema,
  liveBoardPolicySchema,
  paymentSettingsSchema,
  printerSettingsSchema,
  restaurantSettingsSchema,
} from './schema'

export async function updateRestaurantSettings(input: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction(
    restaurantSettingsSchema,
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.SETTINGS_MANAGE)

      const before = await prisma.restaurant.findUnique({
        where: { id: user.restaurantId },
        select: {
          name: true, currency: true, taxRateBps: true,
          serviceChargeBps: true, taxInclusive: true, timezone: true,
        },
      })

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
          allowNegativeStock: data.allowNegativeStock,
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
        // The full before/after of the money-shaping fields: tax and service
        // rates decide every bill, and a change to them with no prior value
        // recorded is unexplainable a month later.
        before: {
          name: before?.name,
          currency: before?.currency,
          taxRateBps: before?.taxRateBps,
          serviceChargeBps: before?.serviceChargeBps,
          taxInclusive: before?.taxInclusive,
          timezone: before?.timezone,
        },
        after: {
          name: data.name,
          currency: data.currency,
          taxRateBps: updated.taxRateBps,
          serviceChargeBps: updated.serviceChargeBps,
          taxInclusive: updated.taxInclusive,
          timezone: updated.timezone,
        },
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

/**
 * The cash controls: variance review, petty cash approval, and the till gate.
 *
 * They live in the same `approvalPolicy` JSON as the refund and discount
 * thresholds, because they answer the same question — how much is worth a
 * second pair of eyes — and an owner should find all of it in one place. This
 * is also the first UI that column has ever had; the four approval thresholds
 * have been configurable in the database and nowhere else.
 *
 * Merged rather than overwritten, so saving this form cannot silently reset the
 * refund threshold to its default.
 */
export async function updateCashControls(input: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction(
    cashControlsSchema,
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.SETTINGS_MANAGE)
      const restaurant = await requireRestaurant(user.restaurantId)
      const factor = minorUnitFactor(restaurant.currency)

      const existing = await getApprovalPolicy(user.restaurantId)
      const next = {
        ...existing,
        cashVarianceAbove: Math.round(data.cashVarianceAbove * factor),
        pettyCashApprovalAbove: Math.round(data.pettyCashApprovalAbove * factor),
        requireCashierSession: data.requireCashierSession,
      }

      await prisma.restaurant.update({
        where: { id: user.restaurantId },
        data: { approvalPolicy: next as unknown as Prisma.InputJsonValue },
      })

      await audit({
        restaurantId: user.restaurantId,
        userId: user.id,
        actorName: user.name,
        action: AUDIT_ACTIONS.SETTINGS_UPDATED,
        entity: 'Restaurant',
        entityId: user.restaurantId,
        after: {
          cashVarianceAbove: next.cashVarianceAbove,
          pettyCashApprovalAbove: next.pettyCashApprovalAbove,
          requireCashierSession: next.requireCashierSession,
        },
      })

      revalidatePath('/dashboard/settings')
      revalidatePath('/dashboard/cash-drawer')
      revalidatePath('/dashboard/petty-cash')
      return { id: user.restaurantId }
    },
    'Cash controls saved.',
  )
}

/**
 * The live floor board's thresholds.
 *
 * Merged over what is stored rather than written wholesale, for the same reason
 * `updateCashControls` above does it: saving this form must not silently reset
 * a field that was added to the policy after this form was last opened.
 */
export async function updateLiveBoardPolicy(input: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction(
    liveBoardPolicySchema,
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.SETTINGS_MANAGE)
      const restaurant = await requireRestaurant(user.restaurantId)
      const factor = minorUnitFactor(restaurant.currency)

      const existing = await getLiveBoardPolicy(user.restaurantId)
      const next = {
        ...existing,
        ...data,
        // Typed in whole currency, stored in minor units like every other
        // amount in the schema.
        vipAfterSpend: Math.round(data.vipAfterSpend * factor),
      }

      await prisma.restaurant.update({
        where: { id: user.restaurantId },
        data: { liveBoardPolicy: next as unknown as Prisma.InputJsonValue },
      })

      await audit({
        restaurantId: user.restaurantId,
        userId: user.id,
        actorName: user.name,
        action: AUDIT_ACTIONS.SETTINGS_UPDATED,
        entity: 'Restaurant',
        entityId: user.restaurantId,
        after: { liveBoard: next },
      })

      revalidatePath('/dashboard/settings')
      revalidatePath('/dashboard/live')
      return { id: user.restaurantId }
    },
    'Live floor settings saved.',
  )
}
