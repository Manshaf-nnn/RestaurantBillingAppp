'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'

import { AppError, NotFoundError } from '@/lib/errors'
import { runAction, type ActionResult } from '@/lib/action'
import { minorUnitFactor } from '@/lib/money'
import { PERMISSIONS } from '@/lib/rbac'
import { AUDIT_ACTIONS, audit } from '@/server/audit'
import { requirePermission } from '@/server/auth/guard'
import { prisma } from '@/server/db/prisma'
import { requireRestaurant } from '@/server/db/tenant'

/*
 * Not exported. A 'use server' module may export nothing but async functions,
 * and exporting a schema breaks every action in the file at runtime rather than
 * failing a lint.
 */
const paymentSchema = z.object({
  supplierId: z.string().min(1),
  /** Optional — a lump sum on account is how most small suppliers are settled. */
  purchaseId: z.string().min(1).optional().or(z.literal('')),
  amount: z.coerce.number().positive('Enter an amount above zero').max(1_000_000_000),
  // The existing PaymentMethod enum, reused rather than a parallel list — a
  // second set of payment methods is a second thing to keep in step.
  method: z.enum(['CASH', 'CARD', 'BANK_TRANSFER', 'QR', 'ONLINE', 'WALLET']),
  reference: z.string().trim().max(80).optional().or(z.literal('')),
  notes: z.string().trim().max(300).optional().or(z.literal('')),
  paidAt: z.string().optional().or(z.literal('')),
})

export async function recordSupplierPaymentAction(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  return runAction(
    paymentSchema,
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.SUPPLIER_PAYMENT)

      const supplier = await prisma.supplier.findFirst({
        where: { id: data.supplierId, restaurantId: user.restaurantId },
        select: { id: true, name: true },
      })
      if (!supplier) throw new NotFoundError('Supplier')

      /*
       * A payment attached to an order must be an order of THIS supplier's.
       * Otherwise the money would leave one account and settle another, and the
       * two balances would both be wrong in opposite directions.
       */
      if (data.purchaseId) {
        const purchase = await prisma.purchase.findFirst({
          where: {
            id: data.purchaseId,
            restaurantId: user.restaurantId,
            supplierId: supplier.id,
          },
          select: { id: true },
        })
        if (!purchase) {
          throw new AppError(
            'That order does not belong to this supplier',
            400,
            'PAYMENT_WRONG_SUPPLIER',
          )
        }
      }

      const restaurant = await requireRestaurant(user.restaurantId)
      // Entered in whole currency, stored in minor units — the same as every
      // other money field here, so typing 500 cannot become five rupees.
      const amount = Math.round(data.amount * minorUnitFactor(restaurant.currency))

      const payment = await prisma.supplierPayment.create({
        data: {
          restaurantId: user.restaurantId,
          supplierId: supplier.id,
          purchaseId: data.purchaseId || null,
          amount,
          method: data.method,
          reference: data.reference || null,
          notes: data.notes || null,
          paidAt: data.paidAt ? new Date(data.paidAt) : new Date(),
          createdById: user.id,
          createdByName: user.name,
        },
      })

      await audit({
        restaurantId: user.restaurantId,
        userId: user.id,
        actorName: user.name,
        action: AUDIT_ACTIONS.SUPPLIER_PAID,
        entity: 'SupplierPayment',
        entityId: payment.id,
        after: {
          supplier: supplier.name,
          amount,
          method: data.method,
          reference: data.reference || null,
        },
      })

      revalidatePath(`/dashboard/suppliers/${supplier.id}`)
      revalidatePath('/dashboard/suppliers')
      return { id: payment.id }
    },
    'Payment recorded.',
  )
}

/**
 * Remove a payment entered by mistake.
 *
 * Deleted rather than reversed, unlike a stock movement. A stock movement is a
 * physical fact that happened and cannot be un-happened; a payment row that was
 * never a real payment is a typo, and leaving a wrong entry plus a correcting
 * entry on a supplier's statement makes it harder to read, not more honest. The
 * audit log keeps the record that it existed and who removed it.
 */
export async function deleteSupplierPaymentAction(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  return runAction(
    z.object({ paymentId: z.string().min(1) }),
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.SUPPLIER_PAYMENT)

      const payment = await prisma.supplierPayment.findFirst({
        where: { id: data.paymentId, restaurantId: user.restaurantId },
        include: { supplier: { select: { id: true, name: true } } },
      })
      if (!payment) throw new NotFoundError('Payment')

      await prisma.supplierPayment.delete({ where: { id: payment.id } })

      await audit({
        restaurantId: user.restaurantId,
        userId: user.id,
        actorName: user.name,
        action: AUDIT_ACTIONS.SUPPLIER_PAYMENT_REMOVED,
        entity: 'SupplierPayment',
        entityId: payment.id,
        before: {
          supplier: payment.supplier.name,
          amount: payment.amount,
          reference: payment.reference,
          paidAt: payment.paidAt.toISOString(),
        },
      })

      revalidatePath(`/dashboard/suppliers/${payment.supplier.id}`)
      revalidatePath('/dashboard/suppliers')
      return { id: payment.id }
    },
    'Payment removed.',
  )
}
