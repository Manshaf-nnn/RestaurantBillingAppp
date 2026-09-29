'use server'

import { z } from 'zod'

import { runAction, type ActionResult } from '@/lib/action'
import { AppError, NotFoundError } from '@/lib/errors'
import { PERMISSIONS, type Permission } from '@/lib/rbac'
import { selectedBranch } from '@/features/dashboard/selected-branch'
import { readSmsConfig } from '@/features/sms/config'
import { AUDIT_ACTIONS, audit } from '@/server/audit'
import { requirePermission } from '@/server/auth/guard'
import { prisma } from '@/server/db/prisma'
import { sendSms } from '@/server/sms/send'

/**
 * One message, typed by a member of staff, to the guest on a record.
 *
 * The number is never taken from the form. The record — an order, a booking,
 * a customer — is looked up on this restaurant and its own phone is used, so
 * the button can only ever text the person the screen is about. That is also
 * what decides who may press it: whoever may act on the record may text about
 * it, which is a narrower and more obvious rule than a permission of its own.
 */
const manualSmsSchema = z.object({
  entity: z.enum(['Order', 'Reservation', 'Customer']),
  entityId: z.string().cuid(),
  text: z.string().trim().min(1, 'Write the message').max(480),
})

export interface ManualSmsResult {
  sent: boolean
  /** The number it went to, as dialled. */
  dialled: string | null
}

export async function sendManualSms(input: unknown): Promise<ActionResult<ManualSmsResult>> {
  return runAction(
    manualSmsSchema,
    input,
    async (data) => {
      const target = await resolveTarget(data.entity, data.entityId)
      const user = await requirePermission(target.permission)

      const record = await target.load(user.restaurantId)
      if (!record) throw new NotFoundError(data.entity)
      if (!record.phone.trim()) {
        throw new AppError('This guest has no phone number on record', 422, 'NO_PHONE')
      }

      const config = await readSmsConfig(user.restaurantId)
      if (!config.enabled) {
        throw new AppError('SMS is switched off for this restaurant. Turn it on under Settings → SMS.', 422, 'SMS_OFF')
      }

      const result = await sendSms({
        restaurantId: user.restaurantId,
        branchId: record.branchId ?? (await selectedBranch(user)).branchId,
        to: record.phone,
        text: data.text,
        purpose: target.purpose,
        entity: data.entity,
        entityId: data.entityId,
        requestedById: user.id,
        config,
      })

      await audit({
        restaurantId: user.restaurantId,
        userId: user.id,
        actorName: user.name,
        action: AUDIT_ACTIONS.SMS_MANUAL_SENT,
        entity: data.entity,
        entityId: data.entityId,
        after: { sent: result.sent, errorCode: result.errorCode ?? null, messageId: result.messageId },
      })

      if (!result.sent) {
        throw new AppError(result.error ?? 'The message could not be sent', 502, result.errorCode ?? 'SMS_FAILED')
      }

      const row = result.messageId
        ? await prisma.smsMessage.findUnique({ where: { id: result.messageId }, select: { toE164: true } })
        : null
      return { sent: true, dialled: row?.toE164 ?? null }
    },
    'Message sent.',
    'sms.manual',
  )
}

interface Target {
  permission: Permission
  purpose: 'ORDER_STATUS' | 'RESERVATION' | 'MARKETING'
  load: (restaurantId: string) => Promise<{ phone: string; branchId: string | null } | null>
}

async function resolveTarget(entity: 'Order' | 'Reservation' | 'Customer', id: string): Promise<Target> {
  switch (entity) {
    case 'Order':
      return {
        permission: PERMISSIONS.ORDER_UPDATE_STATUS,
        purpose: 'ORDER_STATUS',
        load: async (restaurantId) => {
          const order = await prisma.order.findFirst({
            where: { id, restaurantId },
            select: { customerPhone: true, branchId: true },
          })
          return order ? { phone: order.customerPhone, branchId: order.branchId } : null
        },
      }
    case 'Reservation':
      return {
        permission: PERMISSIONS.RESERVATION_MANAGE,
        purpose: 'RESERVATION',
        load: async (restaurantId) => {
          const reservation = await prisma.reservation.findFirst({
            where: { id, restaurantId },
            select: { customerPhone: true, branchId: true },
          })
          return reservation ? { phone: reservation.customerPhone, branchId: reservation.branchId } : null
        },
      }
    case 'Customer':
      return {
        permission: PERMISSIONS.CUSTOMER_MANAGE,
        purpose: 'MARKETING',
        load: async (restaurantId) => {
          const customer = await prisma.customer.findFirst({
            where: { id, restaurantId },
            select: { phone: true },
          })
          return customer ? { phone: customer.phone, branchId: null } : null
        },
      }
  }
}
