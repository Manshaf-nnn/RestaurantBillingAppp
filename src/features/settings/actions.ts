'use server'

import { revalidatePath } from 'next/cache'
import type { Prisma } from '@prisma/client'

import { getLiveBoardPolicy } from '@/features/live/policy'
import { readPaymentConfig } from '@/features/payments/service'
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
  paymentDestinationsSchema,
  paymentSettingsSchema,
  printerSettingsSchema,
  receiptFieldsSchema,
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

      /*
       * Read, merge, write — not write.
       *
       * This used to hand Prisma an object literal of exactly the twelve keys
       * this form owns, which silently deleted every key it does not: the
       * moment anything else lives in `paymentConfig` (the destinations map
       * below does), saving the Payments tab would wipe it. `updateLiveBoardPolicy`
       * already does it the right way; this now matches.
       */
      const existing = readPaymentConfig(
        (await prisma.restaurant.findUniqueOrThrow({
          where: { id: user.restaurantId },
          select: { paymentConfig: true },
        })).paymentConfig,
      )

      await prisma.restaurant.update({
        where: { id: user.restaurantId },
        data: {
          paymentConfig: {
            ...existing,
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
          } as unknown as Prisma.InputJsonValue,
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

/**
 * Where each method's money is booked (bill.md §2).
 *
 * A separate action from the Payments form above, writing the same column
 * through the same read-merge-write, because the two forms are saved
 * independently and neither may clobber the other's keys.
 *
 * The audit entry carries `before` as well as `after`: this map decides which
 * account a payment is allocated to, so "who changed Card from HNB to BOC, and
 * when" is a question the books have to be able to answer (§4).
 */
export async function updatePaymentDestinations(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  return runAction(
    paymentDestinationsSchema,
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.SETTINGS_MANAGE)

      const existing = readPaymentConfig(
        (await prisma.restaurant.findUniqueOrThrow({
          where: { id: user.restaurantId },
          select: { paymentConfig: true },
        })).paymentConfig,
      )

      /*
       * A code that a payment already carries can never be dropped, only
       * retired. Deleting one would leave stamped payments pointing at nothing
       * and every historical report reading the raw code instead of a name.
       */
      const stamped = await prisma.payment.findMany({
        where: { restaurantId: user.restaurantId, destination: { not: null } },
        select: { destination: true },
        distinct: ['destination'],
      })
      const kept = data.destinations.map((destination) => destination.code)
      const orphaned = stamped
        .map((row) => row.destination)
        .filter((code): code is string => code !== null && !kept.includes(code))

      const survivors = orphaned.flatMap((code) => {
        const previous = existing.destinations?.find((entry) => entry.code === code)
        return [
          {
            code,
            name: previous?.name ?? code,
            kind: previous?.kind ?? ('OTHER' as const),
            archived: true,
          },
        ]
      })

      // Empty string means "not booked anywhere" — dropped, so the map holds
      // only real decisions and `destinationForMethod` refuses the rest.
      const methodDestinations = Object.fromEntries(
        Object.entries(data.methodDestinations).filter(([, code]) => Boolean(code)),
      )

      await prisma.restaurant.update({
        where: { id: user.restaurantId },
        data: {
          paymentConfig: {
            ...existing,
            destinations: [...data.destinations, ...survivors],
            methodDestinations,
          } as unknown as Prisma.InputJsonValue,
        },
      })

      await audit({
        restaurantId: user.restaurantId,
        userId: user.id,
        actorName: user.name,
        action: AUDIT_ACTIONS.SETTINGS_UPDATED,
        entity: 'Restaurant',
        entityId: user.restaurantId,
        before: {
          destinations: existing.destinations ?? [],
          methodDestinations: existing.methodDestinations ?? {},
        },
        after: { destinations: data.destinations, methodDestinations },
      })

      revalidatePath('/dashboard/settings')
      revalidatePath('/cashier')
      return { id: user.restaurantId }
    },
    'Payment destinations saved.',
  )
}

/**
 * Which rows a printed bill shows (bill.md §1).
 *
 * Its own action writing its own column, deliberately: the paper-width form
 * next to it writes `printerConfig`, and keeping them apart is what makes it
 * impossible for one to erase the other.
 */
export async function updateReceiptFields(input: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction(
    receiptFieldsSchema,
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.SETTINGS_MANAGE)

      const { logoUrl, ...fields } = data

      await prisma.restaurant.update({
        where: { id: user.restaurantId },
        data: {
          receiptConfig: fields as unknown as Prisma.InputJsonValue,
          // Only when the form sent one, so saving the toggles never clears a
          // logo the owner set on the profile tab.
          ...(logoUrl === undefined ? {} : { logoUrl: logoUrl || null }),
        },
      })

      await audit({
        restaurantId: user.restaurantId,
        userId: user.id,
        actorName: user.name,
        action: AUDIT_ACTIONS.SETTINGS_UPDATED,
        entity: 'Restaurant',
        entityId: user.restaurantId,
        after: { receipt: fields, logoUrl: logoUrl ?? null },
      })

      revalidatePath('/dashboard/settings')
      revalidatePath('/cashier')
      revalidatePath('/cashier/pos')
      return { id: user.restaurantId }
    },
    'Bill settings saved.',
  )
}

export async function updatePrinterSettings(input: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction(
    printerSettingsSchema,
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.SETTINGS_MANAGE)

      // Merged, for the same reason `updatePaymentSettings` above is: a form
      // owns its own keys and has no business deleting the rest of the column.
      const storedPrinter = (await prisma.restaurant.findUniqueOrThrow({
        where: { id: user.restaurantId },
        select: { printerConfig: true },
      })).printerConfig
      const basePrinter =
        storedPrinter && typeof storedPrinter === 'object' && !Array.isArray(storedPrinter)
          ? (storedPrinter as Record<string, unknown>)
          : {}

      await prisma.restaurant.update({
        where: { id: user.restaurantId },
        data: {
          printerConfig: {
            ...basePrinter,
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
