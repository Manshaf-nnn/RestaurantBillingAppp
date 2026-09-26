'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'

import { runAction, type ActionResult } from '@/lib/action'
import { ForbiddenError, NotFoundError } from '@/lib/errors'
import { minorUnitFactor } from '@/lib/money'
import { PERMISSIONS, can, visibleBranchIds } from '@/lib/rbac'
import { resolveStockLocation } from '@/features/branches/service'
import { decideApproval, requestApproval } from '@/features/approvals/service'
import { AUDIT_ACTIONS, audit } from '@/server/audit'
import {
  assertBranchAccess,
  assertRecordBranch,
  requirePermission,
  type TenantUser,
} from '@/server/auth/guard'
import { prisma } from '@/server/db/prisma'
import { requireRestaurant } from '@/server/db/tenant'
import {
  applyPurchaseDecision,
  createPurchaseOrder,
  requirePurchase,
  setPurchaseStatus,
  updatePurchaseOrder,
  upsertSupplierItem,
  type PurchaseDecision,
} from './service'
import { getItemPriceInsight, type ItemPriceInsight } from './queries'
import { createPurchaseReturn, receiveGoods } from './receiving'

const UNITS = ['KG', 'GRAM', 'LITRE', 'ML', 'PIECE', 'PACK', 'BOTTLE', 'DOZEN', 'BOX'] as const
const PRIORITIES = ['LOW', 'NORMAL', 'URGENT'] as const

/** Costs are typed in major units; everything downstream stores minor. */
async function factor(restaurantId: string) {
  const restaurant = await requireRestaurant(restaurantId)
  return minorUnitFactor(restaurant.currency)
}

const createSchema = z.object({
  supplierId: z.string().min(1).optional().or(z.literal('')),
  branchId: z.string().min(1).optional().or(z.literal('')),
  /** The shelf within that location. The column existed and nothing ever set it. */
  locationId: z.string().min(1).optional().or(z.literal('')),
  /** When the site needs it — "required date" on the request. */
  expectedAt: z.string().optional().or(z.literal('')),
  priority: z.enum(PRIORITIES).optional(),
  notes: z.string().trim().max(500).optional().or(z.literal('')),
  discount: z.coerce.number().min(0).default(0),
  taxTotal: z.coerce.number().min(0).default(0),
  lines: z.array(z.object({
    itemId: z.string().min(1),
    quantity: z.coerce.number().positive().max(1_000_000),
    unit: z.enum(UNITS).optional(),
    unitCost: z.coerce.number().min(0).max(100_000_000),
  })).min(1, 'Add at least one item'),
  /**
   * "Submit for approval" rather than "Save draft". One form, two buttons,
   * one action: saving and then submitting as two round trips would leave a
   * request that the first succeeded on and the second did not, and the
   * person none the wiser.
   */
  submit: z.boolean().optional(),
})

/**
 * The branch a purchase order belongs to.
 *
 * Read from the record before acting, never taken from the payload — omitting
 * an optional `branchId` used to slip straight past `assertBranchAccess`'s
 * `if (!branchId) return`, so the guard ran and checked nothing. Mirrors
 * `houseOf()` in the production actions, which already had this right.
 */
async function purchaseBranch(restaurantId: string, purchaseId: string) {
  return prisma.purchase.findFirst({
    where: { id: purchaseId, restaurantId },
    select: { branchId: true },
  })
}

/**
 * Send a request to be decided.
 *
 * Two things happen and both matter: the row becomes PENDING_APPROVAL, and a
 * request lands on the approvals desk (kind PURCHASE_ORDER, the same desk
 * that rules on transfers and refunds), so the people who approve things find
 * it where they find everything else. `requestApproval` keeps one open request
 * per order, so a double click cannot raise two.
 *
 * Not exported: a 'use server' module may only export async functions that
 * are meant to be callable from a browser, and this is a step two of them share.
 */
async function submitForApproval(user: TenantUser, purchaseId: string) {
  const po = await setPurchaseStatus({
    restaurantId: user.restaurantId,
    purchaseId,
    status: 'PENDING_APPROVAL',
    userId: user.id,
  })
  const supplier = po.supplierId
    ? await prisma.supplier.findFirst({ where: { id: po.supplierId }, select: { name: true } })
    : null
  const lineCount = await prisma.purchaseItem.count({ where: { purchaseId: po.id } })

  await requestApproval({
    restaurantId: user.restaurantId,
    branchId: po.branchId,
    kind: 'PURCHASE_ORDER',
    entity: 'Purchase',
    entityId: po.id,
    amount: po.total,
    reason: po.notes?.trim() || `Purchase request ${po.number}`,
    payload: {
      number: po.number,
      supplier: supplier?.name ?? null,
      items: lineCount,
      priority: po.priority,
      requiredBy: po.expectedAt?.toISOString().slice(0, 10) ?? null,
    },
    userId: user.id,
  })

  await audit({
    restaurantId: user.restaurantId, branchId: po.branchId, userId: user.id, actorName: user.name,
    action: AUDIT_ACTIONS.PO_SUBMITTED, entity: 'Purchase', entityId: po.id,
    after: { number: po.number, total: po.total, priority: po.priority },
  })

  revalidatePath('/dashboard/approvals')
  return po
}

export async function createPurchaseOrderAction(
  input: unknown,
): Promise<ActionResult<{ id: string; number: string; status: string }>> {
  return runAction(createSchema, input, async (data) => {
    const user = await requirePermission(PERMISSIONS.PURCHASE_CREATE)
    await assertBranchAccess(user, data.branchId || null)
    const f = await factor(user.restaurantId)

    const po = await createPurchaseOrder({
      restaurantId: user.restaurantId,
      supplierId: data.supplierId || null,
      branchId: await resolveStockLocation({
        restaurantId: user.restaurantId,
        requestedBranchId: data.branchId,
        userBranchId: user.branchId,
      }),
      locationId: data.locationId || null,
      userId: user.id,
      discount: Math.round(data.discount * f),
      taxTotal: Math.round(data.taxTotal * f),
      expectedAt: data.expectedAt ? new Date(data.expectedAt) : null,
      priority: data.priority ?? 'NORMAL',
      notes: data.notes || null,
      lines: data.lines.map((l) => ({
        itemId: l.itemId,
        quantity: l.quantity,
        unit: l.unit,
        unitCost: Math.round(l.unitCost * f),
      })),
    })

    await audit({
      restaurantId: user.restaurantId, branchId: po.branchId, userId: user.id, actorName: user.name,
      action: AUDIT_ACTIONS.PO_CREATED, entity: 'Purchase', entityId: po.id,
      after: { number: po.number, total: po.total, lines: data.lines.length, priority: po.priority },
    })

    const final = data.submit ? await submitForApproval(user, po.id) : po

    revalidatePath('/dashboard/purchases')
    return { id: final.id, number: final.number, status: final.status }
  }, 'Purchase request saved.')
}

/**
 * Change a request that is still the requester's to change.
 *
 * `updatePurchaseOrder` has existed in the service since purchasing was built,
 * complete with the rule about which statuses may be edited — and nothing ever
 * called it. There was no action, no route and no button, so a draft with a
 * wrong quantity could only be cancelled and re-raised, losing its number and
 * its history.
 *
 * The status rule is the service's, not this action's: once an order is
 * approved it is a commitment someone signed, and once anything has been
 * received it is also a stock history. Editing either would rewrite a decision
 * or a fact. A request an approver sent back is editable again — that is what
 * sending it back is for.
 */
export async function updatePurchaseOrderAction(
  input: unknown,
): Promise<ActionResult<{ id: string; status: string }>> {
  return runAction(
    z.object({ purchaseId: z.string().min(1), ...createSchema.shape }),
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.PURCHASE_CREATE)
      // Two checks, for two different things: the order you are editing, and
      // the branch you are moving it to.
      await assertRecordBranch(
        user,
        await purchaseBranch(user.restaurantId, data.purchaseId),
        'purchase order',
      )
      await assertBranchAccess(user, data.branchId || null)
      const f = await factor(user.restaurantId)

      const po = await updatePurchaseOrder({
        restaurantId: user.restaurantId,
        purchaseId: data.purchaseId,
        supplierId: data.supplierId || null,
        branchId: data.branchId
          ? await resolveStockLocation({
              restaurantId: user.restaurantId,
              requestedBranchId: data.branchId,
              userBranchId: user.branchId,
            })
          : null,
        locationId: data.locationId || null,
        discount: Math.round(data.discount * f),
        taxTotal: Math.round(data.taxTotal * f),
        expectedAt: data.expectedAt ? new Date(data.expectedAt) : null,
        priority: data.priority ?? null,
        notes: data.notes || null,
        lines: data.lines.map((l) => ({
          itemId: l.itemId,
          quantity: l.quantity,
          unit: l.unit,
          unitCost: Math.round(l.unitCost * f),
        })),
      })

      await audit({
        restaurantId: user.restaurantId, branchId: po.branchId, userId: user.id, actorName: user.name,
        action: AUDIT_ACTIONS.PO_UPDATED, entity: 'Purchase', entityId: po.id,
        after: { number: po.number, lines: data.lines.length, total: po.total },
      })

      /*
       * Submitting from the edit form. A request already pending stays
       * pending — its desk request is still open and the edit is what the
       * approver will now read. A draft or a returned request goes up.
       */
      const final =
        data.submit && po.status !== 'PENDING_APPROVAL'
          ? await submitForApproval(user, po.id)
          : po

      revalidatePath('/dashboard/purchases')
      revalidatePath(`/dashboard/purchases/${po.id}`)
      return { id: po.id, status: final.status }
    },
    'Purchase request saved.',
  )
}

/** Send a saved draft, or a returned request, for approval. */
export async function submitPurchaseAction(
  input: unknown,
): Promise<ActionResult<{ status: string }>> {
  return runAction(
    z.object({ purchaseId: z.string().min(1) }),
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.PURCHASE_CREATE)
      await assertRecordBranch(
        user,
        await purchaseBranch(user.restaurantId, data.purchaseId),
        'purchase order',
      )
      const po = await submitForApproval(user, data.purchaseId)
      revalidatePath('/dashboard/purchases')
      revalidatePath(`/dashboard/purchases/${po.id}`)
      return { status: po.status }
    },
    'Sent for approval.',
  )
}

const decideSchema = z
  .object({
    purchaseId: z.string().min(1),
    decision: z.enum(['APPROVE', 'REJECT', 'RETURN']),
    reason: z.string().trim().max(300).optional().or(z.literal('')),
    /** Break the two-person rule, on the record (correctionA.md §9). */
    force: z.boolean().optional(),
  })
  // Said on the field, so the person sees it beside the box. The service
  // insists on it too, for callers that never see this form.
  .superRefine((value, ctx) => {
    if (value.decision !== 'APPROVE' && !value.reason?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reason'],
        message:
          value.decision === 'REJECT'
            ? 'Give a reason for rejecting this request'
            : 'Say what needs changing before sending it back',
      })
    }
  })

/**
 * Approve, reject or return a request — from the order's own page.
 *
 * ── One decision, wherever it is made ───────────────────────────────────────
 *
 * A submitted request has a row on the approvals desk. Deciding it here goes
 * THROUGH that row (`decideApproval`), so everything the desk enforces —
 * nobody signs their own request, the location's approver list, the recorded
 * override, compare-and-swap against a second approver — holds on this page
 * too, and the desk shows the same ruling afterwards. The consequence
 * (`applyPurchaseDecision`) runs inside the desk's transaction, so a request
 * cannot read APPROVED while the order still reads PENDING.
 *
 * A request with no desk row — an approver looking at a draft, the "owner
 * buying vegetables" case the transition table allows — is decided directly.
 */
export async function decidePurchaseAction(
  input: unknown,
): Promise<ActionResult<{ status: string; forced: boolean }>> {
  return runAction(decideSchema, input, async (data) => {
    const user = await requirePermission(PERMISSIONS.PURCHASE_APPROVE)
    const po = await requirePurchase(user.restaurantId, data.purchaseId)
    await assertRecordBranch(user, po, 'purchase order')

    const decision = data.decision as PurchaseDecision
    const reason = data.reason?.trim() || null
    const pending = await prisma.approvalRequest.findFirst({
      where: {
        restaurantId: user.restaurantId,
        entity: 'Purchase',
        entityId: po.id,
        kind: 'PURCHASE_ORDER',
        status: 'PENDING',
      },
      select: { id: true },
    })

    let forced = false
    let after: Awaited<ReturnType<typeof applyPurchaseDecision>> | null = null

    if (pending) {
      const ruling = await decideApproval({
        restaurantId: user.restaurantId,
        approvalId: pending.id,
        approve: decision === 'APPROVE',
        userId: user.id,
        // The desk has two answers; the order has three. "Returned" is
        // recorded there as a refusal whose note says it was sent back.
        note: decision === 'RETURN' ? `Returned for edit — ${reason}` : reason,
        mayForce: can(user, PERMISSIONS.APPROVALS_FORCE),
        force: data.force,
        unconfined: visibleBranchIds(user) === null,
        apply: async (tx) => {
          after = await applyPurchaseDecision({
            restaurantId: user.restaurantId,
            purchaseId: po.id,
            decision,
            userId: user.id,
            reason,
            tx,
          })
        },
      })
      forced = ruling.forced
    } else {
      /*
       * No desk row means nobody submitted it — so the two-person rule has
       * nothing to bind. Except the one case that would make the rule a
       * formality: the person who RAISED the draft approving it themselves
       * while confined to a site. An unconfined owner may (recorded as the
       * desk would record it, via `forced`); anybody else submits it.
       */
      if (
        decision === 'APPROVE' &&
        po.createdById === user.id &&
        visibleBranchIds(user) !== null &&
        !(data.force && can(user, PERMISSIONS.APPROVALS_FORCE))
      ) {
        throw new ForbiddenError('You cannot approve your own request — submit it for approval instead')
      }
      forced = decision === 'APPROVE' && po.createdById === user.id
      after = await applyPurchaseDecision({
        restaurantId: user.restaurantId,
        purchaseId: po.id,
        decision,
        userId: user.id,
        reason,
      })
    }

    const settled = after as Awaited<ReturnType<typeof applyPurchaseDecision>> | null
    if (!settled) throw new NotFoundError('Purchase order')

    await audit({
      restaurantId: user.restaurantId, branchId: po.branchId, userId: user.id, actorName: user.name,
      action:
        decision === 'APPROVE'
          ? AUDIT_ACTIONS.PO_APPROVED
          : decision === 'REJECT'
            ? AUDIT_ACTIONS.PO_REJECTED
            : AUDIT_ACTIONS.PO_RETURNED_FOR_EDIT,
      entity: 'Purchase', entityId: po.id,
      before: { status: po.status },
      after: { number: po.number, status: settled.status, reason, ...(forced ? { forced: true } : {}) },
    })

    revalidatePath('/dashboard/purchases')
    revalidatePath(`/dashboard/purchases/${po.id}`)
    revalidatePath('/dashboard/approvals')
    return { status: settled.status, forced }
  }, 'Decision recorded.')
}

const statusSchema = z.object({
  purchaseId: z.string().min(1),
  /*
   * The requester's and the buyer's own moves. Approving, rejecting and
   * returning go through `decidePurchaseAction`, which is what keeps them in
   * step with the approvals desk; receiving statuses are derived by the
   * receiving module and never set by hand.
   */
  status: z.enum(['PENDING_APPROVAL', 'ORDERED', 'CLOSED', 'CANCELLED', 'DRAFT']),
  reason: z.string().trim().max(200).optional().or(z.literal('')),
})

/**
 * Move an order through its workflow.
 *
 * Marking as ordered and closing are gated like approving — they are about
 * money that has been committed — while cancelling or withdrawing a request
 * is the requester's own act.
 */
export async function setPurchaseStatusAction(
  input: unknown,
): Promise<ActionResult<{ status: string }>> {
  return runAction(statusSchema, input, async (data) => {
    const needsApproval = data.status === 'ORDERED' || data.status === 'CLOSED'
    const user = await requirePermission(
      needsApproval ? PERMISSIONS.PURCHASE_APPROVE : PERMISSIONS.PURCHASE_CREATE,
    )
    // Cancelling another branch's spend was possible until now.
    await assertRecordBranch(
      user,
      await purchaseBranch(user.restaurantId, data.purchaseId),
      'purchase order',
    )

    // Submitting is its own step, because it also raises the desk request.
    if (data.status === 'PENDING_APPROVAL') {
      const po = await submitForApproval(user, data.purchaseId)
      revalidatePath('/dashboard/purchases')
      revalidatePath(`/dashboard/purchases/${po.id}`)
      return { status: po.status }
    }

    const po = await setPurchaseStatus({
      restaurantId: user.restaurantId,
      purchaseId: data.purchaseId,
      status: data.status,
      userId: user.id,
      reason: data.reason || null,
    })

    /*
     * A request withdrawn or cancelled while it sat on the desk takes its
     * desk row with it, or the approver rules on something that no longer
     * asks to be ruled on.
     */
    if (data.status === 'CANCELLED' || data.status === 'DRAFT') {
      await prisma.approvalRequest.updateMany({
        where: {
          restaurantId: user.restaurantId,
          entity: 'Purchase',
          entityId: po.id,
          kind: 'PURCHASE_ORDER',
          status: 'PENDING',
        },
        data: { status: 'WITHDRAWN' },
      })
    }

    const action =
      data.status === 'ORDERED' ? AUDIT_ACTIONS.PO_ORDERED
        : data.status === 'CLOSED' ? AUDIT_ACTIONS.PO_CLOSED
          : data.status === 'CANCELLED' ? AUDIT_ACTIONS.PO_CANCELLED
            : AUDIT_ACTIONS.UPDATE

    await audit({
      restaurantId: user.restaurantId, branchId: po.branchId, userId: user.id, actorName: user.name,
      action, entity: 'Purchase', entityId: po.id,
      after: { number: po.number, status: po.status, reason: data.reason || null },
    })

    revalidatePath('/dashboard/purchases')
    revalidatePath(`/dashboard/purchases/${data.purchaseId}`)
    revalidatePath('/dashboard/approvals')
    return { status: po.status }
  }, 'Order updated.')
}

const receiveSchema = z.object({
  purchaseId: z.string().min(1),
  /** The supplier's invoice or delivery-note number. */
  supplierRef: z.string().trim().max(80).optional().or(z.literal('')),
  /** The date on that invoice. */
  invoiceDate: z.string().trim().max(30).optional().or(z.literal('')),
  notes: z.string().trim().max(300).optional().or(z.literal('')),
  /** Where the van actually unloaded. Blank means "where the order said". */
  branchId: z.string().min(1).optional().or(z.literal('')),
  locationId: z.string().min(1).optional().or(z.literal('')),
  lines: z.array(z.object({
    purchaseItemId: z.string().min(1),
    acceptedQty: z.coerce.number().min(0).max(1_000_000),
    rejectedQty: z.coerce.number().min(0).max(1_000_000).default(0),
    /** What was actually charged per unit. The FIFO layer is valued at this. */
    unitCost: z.coerce.number().min(0).max(100_000_000).optional(),
    rejectReason: z.string().trim().max(200).optional().or(z.literal('')),
    batchNo: z.string().trim().max(60).optional().or(z.literal('')),
    expiryDate: z.string().trim().max(30).optional().or(z.literal('')),
  })).min(1),
  /** One id per submission; a retry with the same id is answered, not repeated. */
  clientRequestId: z.string().trim().min(8).max(64).optional().or(z.literal('')),
})

export async function receiveGoodsAction(
  input: unknown,
): Promise<ActionResult<{ number: string; status: string; posted: number; variances: number }>> {
  return runAction(receiveSchema, input, async (data) => {
    const user = await requirePermission(PERMISSIONS.PURCHASE_RECEIVE)
    // The order being received against, and the place it is going.
    await assertRecordBranch(
      user,
      await purchaseBranch(user.restaurantId, data.purchaseId),
      'purchase order',
    )
    await assertBranchAccess(user, data.branchId || null)
    const f = await factor(user.restaurantId)

    const result = await receiveGoods({
      restaurantId: user.restaurantId,
      purchaseId: data.purchaseId,
      supplierRef: data.supplierRef || null,
      invoiceDate: data.invoiceDate ? new Date(data.invoiceDate) : null,
      notes: data.notes || null,
      branchId: data.branchId || null,
      locationId: data.locationId || null,
      userId: user.id,
      clientRequestId: data.clientRequestId || null,
      lines: data.lines
        .filter((l) => l.acceptedQty > 0 || l.rejectedQty > 0)
        .map((l) => ({
          purchaseItemId: l.purchaseItemId,
          acceptedQty: l.acceptedQty,
          rejectedQty: l.rejectedQty,
          unitCost: l.unitCost === undefined ? undefined : Math.round(l.unitCost * f),
          rejectReason: l.rejectReason || null,
          batchNo: l.batchNo || null,
          expiryDate: l.expiryDate ? new Date(l.expiryDate) : null,
        })),
    })

    await audit({
      restaurantId: user.restaurantId, branchId: result.receipt.branchId, userId: user.id, actorName: user.name,
      action: AUDIT_ACTIONS.PO_RECEIVED, entity: 'GoodsReceipt', entityId: result.receipt.id,
      after: {
        number: result.receipt.number,
        orderStatus: result.status,
        itemsPosted: result.posted,
        invoice: data.supplierRef || null,
        // Every price that differed from the order, named. A variance that is
        // only visible on the GRN is a variance nobody searching the log finds.
        priceVariances: result.variances.map((v) => ({
          item: v.name,
          ordered: v.orderedUnitCost,
          paid: v.unitCost,
          percent: Math.round(v.priceVariance * 1000) / 10,
        })),
      },
    })

    revalidatePath('/dashboard/purchases')
    revalidatePath('/dashboard/purchases/receive')
    revalidatePath(`/dashboard/purchases/${data.purchaseId}`)
    revalidatePath('/dashboard/inventory')
    return {
      number: result.receipt.number,
      status: result.status,
      posted: result.posted,
      variances: result.variances.length,
    }
  }, 'Goods received and stock updated.')
}

/**
 * What an item has cost lately, for the price panel beside a request line.
 *
 * Read on demand rather than shipped with the form: the form already carries
 * every item's last price, and the history behind it is only wanted for the
 * one line somebody is looking at.
 */
export async function itemPriceInsightAction(
  input: unknown,
): Promise<ActionResult<ItemPriceInsight>> {
  return runAction(
    z.object({ itemId: z.string().min(1) }),
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.PURCHASE_VIEW)
      return getItemPriceInsight({ restaurantId: user.restaurantId, itemId: data.itemId })
    },
  )
}

const returnSchema = z.object({
  purchaseId: z.string().min(1).optional().or(z.literal('')),
  supplierId: z.string().min(1).optional().or(z.literal('')),
  reason: z.string().trim().min(2, 'Give a reason').max(200),
  lines: z.array(z.object({
    itemId: z.string().min(1),
    quantity: z.coerce.number().positive().max(1_000_000),
    unit: z.enum(UNITS).optional(),
  })).min(1),
})

export async function createPurchaseReturnAction(
  input: unknown,
): Promise<ActionResult<{ number: string }>> {
  return runAction(returnSchema, input, async (data) => {
    const user = await requirePermission(PERMISSIONS.PURCHASE_RETURN)

    /*
     * This action had neither guard — not `assertBranchAccess` on anything
     * posted, nor `assertRecordBranch` on the order being returned against —
     * so any PURCHASE_RETURN holder could send another location's delivery
     * back to the supplier by pasting its id.
     *
     * The branch comes from the purchase where there is one, because that is
     * where the goods physically are, and falls back to the user's own site
     * for a return with no order behind it.
     */
    const against = data.purchaseId
      ? await prisma.purchase.findFirst({
          where: { id: data.purchaseId, restaurantId: user.restaurantId },
          select: { branchId: true },
        })
      : null
    if (data.purchaseId && !against) throw new NotFoundError('Purchase order')
    await assertRecordBranch(user, against, 'purchase order')

    const branchId = await resolveStockLocation({
      restaurantId: user.restaurantId,
      requestedBranchId: against?.branchId ?? null,
      userBranchId: user.branchId,
    })
    await assertBranchAccess(user, branchId)

    const record = await createPurchaseReturn({
      restaurantId: user.restaurantId,
      branchId,
      purchaseId: data.purchaseId || null,
      supplierId: data.supplierId || null,
      reason: data.reason,
      userId: user.id,
      lines: data.lines,
    })

    await audit({
      restaurantId: user.restaurantId, userId: user.id, actorName: user.name,
      action: AUDIT_ACTIONS.PO_RETURNED, entity: 'PurchaseReturn', entityId: record.id,
      after: { number: record.number, reason: data.reason, lines: data.lines.length },
    })

    revalidatePath('/dashboard/purchases')
    revalidatePath('/dashboard/inventory')
    return { number: record.number }
  }, 'Return recorded.')
}

export async function upsertSupplierItemAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction(
    z.object({
      supplierId: z.string().min(1),
      itemId: z.string().min(1),
      supplierSku: z.string().trim().max(60).optional().or(z.literal('')),
      purchaseUnit: z.enum(UNITS).optional(),
      unitsPerPurchaseUnit: z.coerce.number().positive().optional(),
      price: z.coerce.number().min(0).default(0),
      leadTimeDays: z.coerce.number().int().min(0).max(365).optional(),
      minOrderQty: z.coerce.number().min(0).optional(),
      isPreferred: z.boolean().default(false),
    }),
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.SUPPLIER_MANAGE)
      const f = await factor(user.restaurantId)
      const link = await upsertSupplierItem({
        restaurantId: user.restaurantId,
        ...data,
        supplierSku: data.supplierSku || null,
        price: Math.round(data.price * f),
      })
      await audit({
        restaurantId: user.restaurantId, userId: user.id, actorName: user.name,
        action: AUDIT_ACTIONS.SUPPLIER_UPDATED, entity: 'SupplierItem', entityId: link.id,
        after: { itemId: data.itemId, price: link.price, preferred: link.isPreferred },
      })
      revalidatePath('/dashboard/suppliers')
      return { id: link.id }
    },
    'Supplier pricing saved.',
  )
}
