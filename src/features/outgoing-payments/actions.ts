'use server'

import { revalidatePath } from 'next/cache'

import { runAction, type ActionResult } from '@/lib/action'
import { ConflictError, NotFoundError } from '@/lib/errors'
import { minorUnitFactor, type CurrencyCode } from '@/lib/money'
import { PERMISSIONS, can } from '@/lib/rbac'
import { AUDIT_ACTIONS, audit } from '@/server/audit'
import { assertBranchAccess, requirePermission, type TenantUser } from '@/server/auth/guard'
import { isUniqueViolation, prisma } from '@/server/db/prisma'
import { requireRestaurant } from '@/server/db/tenant'
import {
  decidePaymentSchema,
  draftPaymentSchema,
  expenseCategorySchema,
  paymentIdSchema,
  reversePaymentSchema,
  sendBackSchema,
  updateDraftSchema,
} from './schema'
import {
  cancelOwn,
  createDraft,
  decide,
  markPaid,
  reverse,
  sendBack,
  submit,
  updateDraft,
  type OutgoingActor,
} from './service'

/**
 * The accountant's money-out workflow, action layer.
 *
 * Guard shape on every action: permission → tenant scoping on every read →
 * branch access on the payment's own branch → delegate → audit → revalidate.
 * The service enforces the transitions (CAS) and the approver ≠ submitter
 * rule; the actions enforce WHO may even ask.
 */

function actorFor(user: TenantUser): OutgoingActor {
  return { id: user.id, name: user.name ?? user.email, canApprove: can(user, PERMISSIONS.ACCOUNTING_PAYMENT_APPROVE) }
}

async function paymentBranch(restaurantId: string, paymentId: string) {
  const payment = await prisma.outgoingPayment.findFirst({
    where: { id: paymentId, restaurantId },
    select: { branchId: true },
  })
  if (!payment) throw new NotFoundError('Payment')
  return payment
}

const PAGES = ['/dashboard/accounting', '/dashboard/accounting/payments', '/dashboard/accounting/approvals', '/dashboard/accounting/expenses']
function refresh() {
  for (const page of PAGES) revalidatePath(page)
}

export async function saveDraftAction(input: unknown): Promise<ActionResult<{ id: string; number: string }>> {
  return runAction(draftPaymentSchema, input, async (data) => {
    const user = await requirePermission(PERMISSIONS.ACCOUNTING_PAYMENT_CREATE)
    await assertBranchAccess(user, data.branchId)
    const restaurant = await requireRestaurant(user.restaurantId)
    const factor = minorUnitFactor(restaurant.currency as CurrencyCode)

    const payment = await createDraft({
      restaurantId: user.restaurantId,
      branchId: data.branchId,
      kind: data.kind,
      supplierId: data.supplierId || null,
      purchaseId: data.purchaseId || null,
      expenseCategoryId: data.expenseCategoryId || null,
      amount: Math.round(data.amount * factor),
      method: data.method,
      reference: data.reference || null,
      description: data.description,
      paymentDate: new Date(`${data.paymentDate}T12:00:00.000Z`),
      actor: actorFor(user),
    })

    await audit({
      restaurantId: user.restaurantId,
      branchId: payment.branchId,
      userId: user.id,
      actorName: user.name,
      action: AUDIT_ACTIONS.OUTGOING_CREATED,
      entity: 'OutgoingPayment',
      entityId: payment.id,
      after: { number: payment.number, kind: payment.kind, amount: payment.amount, method: payment.method },
    })
    refresh()
    return { id: payment.id, number: payment.number }
  }, 'Draft saved.')
}

export async function updateDraftAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction(updateDraftSchema, input, async (data) => {
    const user = await requirePermission(PERMISSIONS.ACCOUNTING_PAYMENT_CREATE)
    const existing = await paymentBranch(user.restaurantId, data.paymentId)
    await assertBranchAccess(user, existing.branchId)
    await assertBranchAccess(user, data.patch.branchId)
    const restaurant = await requireRestaurant(user.restaurantId)
    const factor = minorUnitFactor(restaurant.currency as CurrencyCode)

    const before = await prisma.outgoingPayment.findFirst({
      where: { id: data.paymentId, restaurantId: user.restaurantId },
      select: { amount: true, method: true, description: true },
    })
    const payment = await updateDraft({
      restaurantId: user.restaurantId,
      paymentId: data.paymentId,
      patch: {
        branchId: data.patch.branchId,
        kind: data.patch.kind,
        supplierId: data.patch.supplierId || null,
        purchaseId: data.patch.purchaseId || null,
        expenseCategoryId: data.patch.expenseCategoryId || null,
        amount: Math.round(data.patch.amount * factor),
        method: data.patch.method,
        reference: data.patch.reference || null,
        description: data.patch.description,
        paymentDate: new Date(`${data.patch.paymentDate}T12:00:00.000Z`),
      },
      actor: actorFor(user),
    })

    await audit({
      restaurantId: user.restaurantId,
      branchId: payment.branchId,
      userId: user.id,
      actorName: user.name,
      action: AUDIT_ACTIONS.OUTGOING_CREATED,
      entity: 'OutgoingPayment',
      entityId: payment.id,
      before: before ?? undefined,
      after: { amount: payment.amount, method: payment.method, description: payment.description },
    })
    refresh()
    return { id: payment.id }
  }, 'Draft updated.')
}

export async function submitPaymentAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction(paymentIdSchema, input, async (data) => {
    const user = await requirePermission(PERMISSIONS.ACCOUNTING_PAYMENT_CREATE)
    await assertBranchAccess(user, (await paymentBranch(user.restaurantId, data.paymentId)).branchId)

    const payment = await submit({
      restaurantId: user.restaurantId,
      paymentId: data.paymentId,
      actor: actorFor(user),
    })

    await audit({
      restaurantId: user.restaurantId,
      branchId: payment.branchId,
      userId: user.id,
      actorName: user.name,
      action: AUDIT_ACTIONS.OUTGOING_SUBMITTED,
      entity: 'OutgoingPayment',
      entityId: payment.id,
      after: { number: payment.number, amount: payment.amount },
    })
    refresh()
    return { id: payment.id }
  }, 'Sent for approval.')
}

export async function cancelPaymentAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction(paymentIdSchema, input, async (data) => {
    const user = await requirePermission(PERMISSIONS.ACCOUNTING_PAYMENT_CREATE)
    await assertBranchAccess(user, (await paymentBranch(user.restaurantId, data.paymentId)).branchId)

    const payment = await cancelOwn({
      restaurantId: user.restaurantId,
      paymentId: data.paymentId,
      actor: actorFor(user),
    })

    await audit({
      restaurantId: user.restaurantId,
      branchId: payment.branchId,
      userId: user.id,
      actorName: user.name,
      action: AUDIT_ACTIONS.OUTGOING_CANCELLED,
      entity: 'OutgoingPayment',
      entityId: payment.id,
      after: { number: payment.number },
    })
    refresh()
    return { id: payment.id }
  }, 'Payment cancelled.')
}

export async function decidePaymentAction(input: unknown): Promise<ActionResult<{ id: string; status: string }>> {
  return runAction(decidePaymentSchema, input, async (data) => {
    const user = await requirePermission(PERMISSIONS.ACCOUNTING_PAYMENT_APPROVE)
    await assertBranchAccess(user, (await paymentBranch(user.restaurantId, data.paymentId)).branchId)

    const payment = await decide({
      restaurantId: user.restaurantId,
      paymentId: data.paymentId,
      approve: data.approve,
      note: data.note || null,
      actor: actorFor(user),
    })

    await audit({
      restaurantId: user.restaurantId,
      branchId: payment.branchId,
      userId: user.id,
      actorName: user.name,
      action: data.approve ? AUDIT_ACTIONS.OUTGOING_APPROVED : AUDIT_ACTIONS.OUTGOING_REJECTED,
      entity: 'OutgoingPayment',
      entityId: payment.id,
      after: { number: payment.number, amount: payment.amount, note: payment.decisionNote },
    })
    refresh()
    return { id: payment.id, status: payment.status }
  })
}

export async function sendBackPaymentAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction(sendBackSchema, input, async (data) => {
    const user = await requirePermission(PERMISSIONS.ACCOUNTING_PAYMENT_APPROVE)
    await assertBranchAccess(user, (await paymentBranch(user.restaurantId, data.paymentId)).branchId)

    const payment = await sendBack({
      restaurantId: user.restaurantId,
      paymentId: data.paymentId,
      note: data.note,
      actor: actorFor(user),
    })

    await audit({
      restaurantId: user.restaurantId,
      branchId: payment.branchId,
      userId: user.id,
      actorName: user.name,
      action: AUDIT_ACTIONS.OUTGOING_SENT_BACK,
      entity: 'OutgoingPayment',
      entityId: payment.id,
      after: { number: payment.number, note: data.note },
    })
    refresh()
    return { id: payment.id }
  }, 'Sent back for changes.')
}

export async function markPaidAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction(paymentIdSchema, input, async (data) => {
    const user = await requirePermission(PERMISSIONS.ACCOUNTING_PAYMENT_PAY)
    await assertBranchAccess(user, (await paymentBranch(user.restaurantId, data.paymentId)).branchId)

    const payment = await markPaid({
      restaurantId: user.restaurantId,
      paymentId: data.paymentId,
      actor: actorFor(user),
    })

    await audit({
      restaurantId: user.restaurantId,
      branchId: payment.branchId,
      userId: user.id,
      actorName: user.name,
      action: AUDIT_ACTIONS.OUTGOING_PAID,
      entity: 'OutgoingPayment',
      entityId: payment.id,
      after: {
        number: payment.number,
        amount: payment.amount,
        method: payment.method,
        supplierPaymentId: payment.supplierPaymentId,
      },
    })
    refresh()
    revalidatePath('/dashboard/suppliers')
    return { id: payment.id }
  }, 'Paid and on the record.')
}

export async function reversePaymentAction(input: unknown): Promise<ActionResult<{ id: string; number: string }>> {
  return runAction(reversePaymentSchema, input, async (data) => {
    const user = await requirePermission(PERMISSIONS.ACCOUNTING_PAYMENT_APPROVE)
    await assertBranchAccess(user, (await paymentBranch(user.restaurantId, data.paymentId)).branchId)

    const reversal = await reverse({
      restaurantId: user.restaurantId,
      paymentId: data.paymentId,
      reason: data.reason,
      actor: actorFor(user),
    })

    await audit({
      restaurantId: user.restaurantId,
      branchId: reversal.branchId,
      userId: user.id,
      actorName: user.name,
      action: AUDIT_ACTIONS.OUTGOING_REVERSED,
      entity: 'OutgoingPayment',
      entityId: data.paymentId,
      after: { reversalNumber: reversal.number, reason: data.reason },
    })
    refresh()
    revalidatePath('/dashboard/suppliers')
    return { id: reversal.id, number: reversal.number }
  }, 'Payment reversed — the correction is its own transaction.')
}

export async function saveExpenseCategoryAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction(expenseCategorySchema, input, async (data) => {
    const user = await requirePermission(PERMISSIONS.ACCOUNTING_EXPENSE_MANAGE)

    const before = data.id
      ? await prisma.expenseCategory.findFirst({
          where: { id: data.id, restaurantId: user.restaurantId },
          select: { name: true, isActive: true },
        })
      : null
    if (data.id && !before) throw new NotFoundError('Expense category')

    let category
    try {
      category = data.id
        ? await prisma.expenseCategory.update({
            where: { id: data.id },
            data: { name: data.name, isActive: data.isActive },
          })
        : await prisma.expenseCategory.create({
            data: { restaurantId: user.restaurantId, name: data.name, isActive: data.isActive },
          })
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictError('A category with that name already exists')
      throw error
    }

    await audit({
      restaurantId: user.restaurantId,
      userId: user.id,
      actorName: user.name,
      action: AUDIT_ACTIONS.EXPENSE_CATEGORY_SAVED,
      entity: 'ExpenseCategory',
      entityId: category.id,
      before: before ?? undefined,
      after: { name: category.name, isActive: category.isActive },
    })
    revalidatePath('/dashboard/accounting/expenses')
    return { id: category.id }
  }, 'Category saved.')
}
