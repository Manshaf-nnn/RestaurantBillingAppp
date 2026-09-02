import 'server-only'

import type { OutgoingPayment, OutgoingPaymentKind, PaymentMethod } from '@prisma/client'

import { assertPeriodOpen } from '@/features/accounting/service'
import { recordExpenseAgainstOpenDrawer } from '@/features/cashdrawer/service'
import { AppError, NotFoundError } from '@/lib/errors'
import { nextCounterValue, yearIn } from '@/server/db/counters'
import { prisma } from '@/server/db/prisma'

/**
 * Money leaving the business, with a life:
 *
 *   DRAFT → SUBMITTED → APPROVED | REJECTED (→ DRAFT via send-back)
 *                         APPROVED → PAID → possibly REVERSED
 *
 * Its own model and its own service, by house precedent — a request with a
 * life after approval does not fit ApprovalRequest, a lesson this codebase
 * has recorded three times (see PettyCashRequest). What IS borrowed is the
 * one rule worth borrowing: the approver is never the submitter.
 *
 * Every transition is a compare-and-swap (`updateMany` filtered on the
 * status being left) so two owners approving at once, or a double-tapped
 * "mark paid", produce exactly one winner and one clear refusal — the same
 * discipline `payRequest` in petty cash uses, because `decideApproval`'s
 * read-then-update shape loses that race.
 *
 * A PAID row is immutable. kind SUPPLIER projects an ordinary
 * SupplierPayment ledger row at payment time — the supplier balance math in
 * features/suppliers/ledger.ts never changed and its pinned test still holds.
 * Corrections are reversal rows (one per payment, enforced by a unique
 * constraint), and a supplier reversal is a NEGATING SupplierPayment row,
 * never a deletion: the ledger keeps both the payment and its undoing.
 */

export interface OutgoingActor {
  id: string
  name: string
  /** Derived in the action via can() — the service never reads permissions. */
  canApprove: boolean
}

export interface DraftInput {
  restaurantId: string
  branchId: string
  kind: OutgoingPaymentKind
  supplierId?: string | null
  purchaseId?: string | null
  expenseCategoryId?: string | null
  amount: number
  method: PaymentMethod
  reference?: string | null
  description: string
  paymentDate: Date
  actor: OutgoingActor
}

/** The default book, written lazily so brand-new restaurants have one too. */
export const DEFAULT_EXPENSE_CATEGORIES = [
  'Rent', 'Utilities', 'Salaries & wages', 'Maintenance', 'Cleaning',
  'Transport', 'Marketing', 'Software', 'Bank charges', 'Miscellaneous',
] as const

export async function ensureDefaultCategories(restaurantId: string): Promise<void> {
  const existing = await prisma.expenseCategory.count({ where: { restaurantId } })
  if (existing > 0) return
  await prisma.expenseCategory.createMany({
    data: DEFAULT_EXPENSE_CATEGORIES.map((name, index) => ({
      restaurantId,
      name,
      sortOrder: index,
    })),
    skipDuplicates: true,
  })
}

/**
 * Validate the references a payment names, inside the caller's tenant.
 * A supplier payment needs its supplier; an expense needs its category; a
 * purchase link must belong to the same supplier — the exact rule the
 * direct supplier-payment action already enforces (PAYMENT_WRONG_SUPPLIER).
 */
async function validateReferences(input: {
  restaurantId: string
  kind: OutgoingPaymentKind
  supplierId?: string | null
  purchaseId?: string | null
  expenseCategoryId?: string | null
}): Promise<void> {
  if (input.kind === 'SUPPLIER') {
    if (!input.supplierId) {
      throw new AppError('Choose the supplier being paid', 400, 'OUTGOING_NO_SUPPLIER')
    }
    const supplier = await prisma.supplier.findFirst({
      where: { id: input.supplierId, restaurantId: input.restaurantId },
      select: { id: true },
    })
    if (!supplier) throw new NotFoundError('Supplier')

    if (input.purchaseId) {
      const purchase = await prisma.purchase.findFirst({
        where: { id: input.purchaseId, restaurantId: input.restaurantId },
        select: { supplierId: true },
      })
      if (!purchase) throw new NotFoundError('Purchase order')
      if (purchase.supplierId !== input.supplierId) {
        throw new AppError(
          'That purchase order belongs to a different supplier',
          400,
          'PAYMENT_WRONG_SUPPLIER',
        )
      }
    }
  } else {
    if (!input.expenseCategoryId) {
      throw new AppError('Choose an expense category', 400, 'OUTGOING_NO_CATEGORY')
    }
    const category = await prisma.expenseCategory.findFirst({
      where: { id: input.expenseCategoryId, restaurantId: input.restaurantId, isActive: true },
      select: { id: true },
    })
    if (!category) throw new NotFoundError('Expense category')
  }
}

export async function createDraft(input: DraftInput): Promise<OutgoingPayment> {
  if (input.amount <= 0) {
    throw new AppError('The amount must be above zero', 400, 'OUTGOING_BAD_AMOUNT')
  }
  await validateReferences(input)

  return prisma.$transaction(async (tx) => {
    const year = yearIn(
      (await tx.restaurant.findUniqueOrThrow({
        where: { id: input.restaurantId },
        select: { timezone: true },
      })).timezone,
    )
    const sequence = await nextCounterValue(tx, input.restaurantId, `outgoingPayment:${year}`)
    return tx.outgoingPayment.create({
      data: {
        restaurantId: input.restaurantId,
        branchId: input.branchId,
        number: `OP-${year}-${String(sequence).padStart(5, '0')}`,
        kind: input.kind,
        supplierId: input.kind === 'SUPPLIER' ? input.supplierId : null,
        purchaseId: input.kind === 'SUPPLIER' ? (input.purchaseId ?? null) : null,
        expenseCategoryId: input.kind === 'EXPENSE' ? input.expenseCategoryId : null,
        amount: input.amount,
        method: input.method,
        reference: input.reference?.trim() || null,
        description: input.description.trim(),
        paymentDate: input.paymentDate,
        createdById: input.actor.id,
        createdByName: input.actor.name,
      },
    })
  })
}

async function load(restaurantId: string, paymentId: string) {
  const payment = await prisma.outgoingPayment.findFirst({
    where: { id: paymentId, restaurantId },
  })
  if (!payment) throw new NotFoundError('Payment')
  return payment
}

/** Only the person who raised it (or an approver) may steer a draft. */
function assertMayHandle(payment: OutgoingPayment, actor: OutgoingActor): void {
  if (payment.createdById !== actor.id && !actor.canApprove) {
    throw new AppError('Only the person who raised this payment can change it', 403, 'OUTGOING_NOT_YOURS')
  }
}

export async function updateDraft(params: {
  restaurantId: string
  paymentId: string
  patch: Partial<Omit<DraftInput, 'restaurantId' | 'actor'>>
  actor: OutgoingActor
}): Promise<OutgoingPayment> {
  const payment = await load(params.restaurantId, params.paymentId)
  assertMayHandle(payment, params.actor)

  const kind = params.patch.kind ?? payment.kind
  if (params.patch.amount !== undefined && params.patch.amount <= 0) {
    throw new AppError('The amount must be above zero', 400, 'OUTGOING_BAD_AMOUNT')
  }
  await validateReferences({
    restaurantId: params.restaurantId,
    kind,
    supplierId: params.patch.supplierId ?? payment.supplierId,
    purchaseId: params.patch.purchaseId ?? payment.purchaseId,
    expenseCategoryId: params.patch.expenseCategoryId ?? payment.expenseCategoryId,
  })

  /*
   * The CAS that makes "amount immutable after submission" true: only a row
   * still in DRAFT takes the edit. A submit racing this edit means one of
   * the two loses, loudly — never a submitted amount quietly rewritten.
   */
  const touched = await prisma.outgoingPayment.updateMany({
    where: { id: payment.id, restaurantId: params.restaurantId, status: 'DRAFT' },
    data: {
      kind,
      supplierId: kind === 'SUPPLIER' ? (params.patch.supplierId ?? payment.supplierId) : null,
      purchaseId: kind === 'SUPPLIER' ? (params.patch.purchaseId ?? payment.purchaseId) : null,
      expenseCategoryId:
        kind === 'EXPENSE' ? (params.patch.expenseCategoryId ?? payment.expenseCategoryId) : null,
      ...(params.patch.amount !== undefined ? { amount: params.patch.amount } : {}),
      ...(params.patch.method !== undefined ? { method: params.patch.method } : {}),
      ...(params.patch.reference !== undefined
        ? { reference: params.patch.reference?.trim() || null }
        : {}),
      ...(params.patch.description !== undefined
        ? { description: params.patch.description.trim() }
        : {}),
      ...(params.patch.paymentDate !== undefined ? { paymentDate: params.patch.paymentDate } : {}),
    },
  })
  if (touched.count === 0) {
    throw new AppError(
      'This payment has been submitted — its details are locked. Ask for it to be sent back to change anything.',
      409,
      'OUTGOING_LOCKED',
    )
  }
  return load(params.restaurantId, params.paymentId)
}

export async function submit(params: {
  restaurantId: string
  paymentId: string
  actor: OutgoingActor
}): Promise<OutgoingPayment> {
  const payment = await load(params.restaurantId, params.paymentId)
  assertMayHandle(payment, params.actor)

  // Nothing dates itself into a sealed accounting period (§12).
  await assertPeriodOpen(prisma, params.restaurantId, payment.paymentDate)

  const touched = await prisma.outgoingPayment.updateMany({
    where: { id: payment.id, restaurantId: params.restaurantId, status: 'DRAFT' },
    data: { status: 'SUBMITTED', submittedById: params.actor.id, submittedAt: new Date() },
  })
  if (touched.count === 0) {
    throw new AppError('Only a draft can be submitted', 409, 'OUTGOING_NOT_DRAFT')
  }
  return load(params.restaurantId, params.paymentId)
}

export async function cancelOwn(params: {
  restaurantId: string
  paymentId: string
  actor: OutgoingActor
}): Promise<OutgoingPayment> {
  const payment = await load(params.restaurantId, params.paymentId)
  assertMayHandle(payment, params.actor)

  const touched = await prisma.outgoingPayment.updateMany({
    where: {
      id: payment.id,
      restaurantId: params.restaurantId,
      status: { in: ['DRAFT', 'SUBMITTED'] },
    },
    data: { status: 'CANCELLED' },
  })
  if (touched.count === 0) {
    throw new AppError(
      'This payment has already been decided — it can no longer be cancelled',
      409,
      'OUTGOING_DECIDED',
    )
  }
  return load(params.restaurantId, params.paymentId)
}

export async function decide(params: {
  restaurantId: string
  paymentId: string
  approve: boolean
  note?: string | null
  actor: OutgoingActor
}): Promise<OutgoingPayment> {
  const payment = await load(params.restaurantId, params.paymentId)

  /*
   * The two-person control, and the whole reason this workflow exists: the
   * person asking for money to leave is never the person who says yes.
   */
  if (payment.submittedById === params.actor.id || payment.createdById === params.actor.id) {
    throw new AppError('You cannot approve a payment you raised', 403, 'OUTGOING_SELF_APPROVAL')
  }
  if (!params.approve && !params.note?.trim()) {
    throw new AppError('Give a reason for rejecting this payment', 400, 'OUTGOING_NO_REASON')
  }

  const touched = await prisma.outgoingPayment.updateMany({
    where: { id: payment.id, restaurantId: params.restaurantId, status: 'SUBMITTED' },
    data: {
      status: params.approve ? 'APPROVED' : 'REJECTED',
      decidedById: params.actor.id,
      decidedAt: new Date(),
      decisionNote: params.note?.trim() || null,
    },
  })
  if (touched.count === 0) {
    throw new AppError('That payment has already been decided', 409, 'OUTGOING_DECIDED')
  }
  return load(params.restaurantId, params.paymentId)
}

/** Return a submitted payment to its author for changes, without deleting it. */
export async function sendBack(params: {
  restaurantId: string
  paymentId: string
  note: string
  actor: OutgoingActor
}): Promise<OutgoingPayment> {
  const payment = await load(params.restaurantId, params.paymentId)
  if (payment.submittedById === params.actor.id || payment.createdById === params.actor.id) {
    throw new AppError('You cannot rule on a payment you raised', 403, 'OUTGOING_SELF_APPROVAL')
  }
  if (!params.note.trim()) {
    throw new AppError('Say what needs changing', 400, 'OUTGOING_NO_REASON')
  }

  const touched = await prisma.outgoingPayment.updateMany({
    where: { id: payment.id, restaurantId: params.restaurantId, status: 'SUBMITTED' },
    data: {
      status: 'DRAFT',
      decisionNote: params.note.trim(),
      // The submission stamps clear so the resubmit is a fresh ask; the
      // audit log keeps the full back-and-forth.
      submittedById: null,
      submittedAt: null,
    },
  })
  if (touched.count === 0) {
    throw new AppError('Only a submitted payment can be sent back', 409, 'OUTGOING_DECIDED')
  }
  return load(params.restaurantId, params.paymentId)
}

/**
 * Execute an APPROVED payment: the money actually moves.
 *
 * kind SUPPLIER projects the ordinary SupplierPayment ledger row — the same
 * shape the direct action writes, createdByName included — so every supplier
 * balance, statement and pinned test reads it exactly as before. Cash-method
 * payments post their drawer movement; a missing drawer never blocks the
 * money and is visible afterwards as the absent link.
 */
export async function markPaid(params: {
  restaurantId: string
  paymentId: string
  actor: OutgoingActor
}): Promise<OutgoingPayment> {
  const payment = await load(params.restaurantId, params.paymentId)
  await assertPeriodOpen(prisma, params.restaurantId, payment.paymentDate)

  return prisma.$transaction(async (tx) => {
    // The duplicate-payment lock: exactly one "mark paid" wins.
    const touched = await tx.outgoingPayment.updateMany({
      where: { id: payment.id, restaurantId: params.restaurantId, status: 'APPROVED' },
      data: { status: 'PAID', paidById: params.actor.id, paidAt: new Date() },
    })
    if (touched.count === 0) {
      throw new AppError(
        'Only an approved payment can be paid — and only once',
        409,
        'OUTGOING_NOT_APPROVED',
      )
    }

    if (payment.kind === 'SUPPLIER' && payment.supplierId) {
      const projected = await tx.supplierPayment.create({
        data: {
          restaurantId: params.restaurantId,
          supplierId: payment.supplierId,
          purchaseId: payment.purchaseId,
          amount: payment.amount,
          method: payment.method,
          reference: payment.reference,
          notes: `${payment.number} — ${payment.description}`,
          paidAt: payment.paymentDate,
          createdById: params.actor.id,
          createdByName: params.actor.name,
        },
      })
      await tx.outgoingPayment.update({
        where: { id: payment.id },
        data: { supplierPaymentId: projected.id },
      })
    }

    if (payment.method === 'CASH') {
      await recordExpenseAgainstOpenDrawer({
        tx,
        restaurantId: params.restaurantId,
        branchId: payment.branchId,
        userId: params.actor.id,
        amount: payment.amount,
        description: `${payment.number} — ${payment.description}`,
        reference: payment.reference,
        outgoingPaymentId: payment.id,
      })
    }

    return tx.outgoingPayment.findUniqueOrThrow({ where: { id: payment.id } })
  })
}

/**
 * Undo a PAID payment — with a new transaction, never an edit.
 *
 * The reversal is its own PAID row dated NOW, so it lands in the current open
 * period (§12: corrections after closing are new transactions). A supplier
 * reversal writes a NEGATING SupplierPayment row — the ledger's sums handle
 * the negative, and the history keeps both the payment and its undoing. One
 * reversal per payment, enforced by the unique constraint on reversalOfId.
 */
export async function reverse(params: {
  restaurantId: string
  paymentId: string
  reason: string
  actor: OutgoingActor
}): Promise<OutgoingPayment> {
  if (!params.reason.trim()) {
    throw new AppError('Give a reason for reversing this payment', 400, 'OUTGOING_NO_REASON')
  }
  const payment = await load(params.restaurantId, params.paymentId)
  const now = new Date()
  await assertPeriodOpen(prisma, params.restaurantId, now)

  return prisma.$transaction(async (tx) => {
    const touched = await tx.outgoingPayment.updateMany({
      where: { id: payment.id, restaurantId: params.restaurantId, status: 'PAID' },
      data: { status: 'REVERSED' },
    })
    if (touched.count === 0) {
      throw new AppError('Only a paid payment can be reversed — and only once', 409, 'OUTGOING_NOT_PAID')
    }

    const year = yearIn(
      (await tx.restaurant.findUniqueOrThrow({
        where: { id: params.restaurantId },
        select: { timezone: true },
      })).timezone,
    )
    const sequence = await nextCounterValue(tx, params.restaurantId, `outgoingPayment:${year}`)

    let projectedId: string | null = null
    if (payment.kind === 'SUPPLIER' && payment.supplierId) {
      const negating = await tx.supplierPayment.create({
        data: {
          restaurantId: params.restaurantId,
          supplierId: payment.supplierId,
          purchaseId: payment.purchaseId,
          amount: -payment.amount,
          method: payment.method,
          reference: payment.reference,
          notes: `Reversal of ${payment.number} — ${params.reason.trim()}`,
          paidAt: now,
          createdById: params.actor.id,
          createdByName: params.actor.name,
        },
      })
      projectedId = negating.id
    }

    const reversal = await tx.outgoingPayment.create({
      data: {
        restaurantId: params.restaurantId,
        branchId: payment.branchId,
        number: `OP-${year}-${String(sequence).padStart(5, '0')}`,
        kind: payment.kind,
        supplierId: payment.supplierId,
        purchaseId: payment.purchaseId,
        expenseCategoryId: payment.expenseCategoryId,
        amount: payment.amount,
        method: payment.method,
        reference: payment.reference,
        description: `Reversal of ${payment.number} — ${params.reason.trim()}`,
        paymentDate: now,
        status: 'PAID',
        reversalOfId: payment.id,
        supplierPaymentId: projectedId,
        decidedById: params.actor.id,
        decidedAt: now,
        decisionNote: params.reason.trim(),
        paidById: params.actor.id,
        paidAt: now,
        createdById: params.actor.id,
        createdByName: params.actor.name,
      },
    })

    if (payment.method === 'CASH') {
      await recordExpenseAgainstOpenDrawer({
        tx,
        restaurantId: params.restaurantId,
        branchId: payment.branchId,
        userId: params.actor.id,
        amount: payment.amount,
        description: `Reversal of ${payment.number}`,
        reference: payment.reference,
        outgoingPaymentId: reversal.id,
        type: 'EXPENSE_REVERSED',
      })
    }

    return reversal
  })
}
