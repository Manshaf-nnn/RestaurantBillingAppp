'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'

import { runAction, type ActionResult } from '@/lib/action'
import { minorUnitFactor } from '@/lib/money'
import { PERMISSIONS } from '@/lib/rbac'
import { AUDIT_ACTIONS, audit } from '@/server/audit'
import { requirePermission } from '@/server/auth/guard'
import { requireRestaurant } from '@/server/db/tenant'
import { createPurchaseOrder, setPurchaseStatus, upsertSupplierItem } from './service'
import { createPurchaseReturn, receiveGoods } from './receiving'

const UNITS = ['KG', 'GRAM', 'LITRE', 'ML', 'PIECE', 'PACK', 'BOTTLE', 'DOZEN', 'BOX'] as const

/** Costs are typed in major units; everything downstream stores minor. */
async function factor(restaurantId: string) {
  const restaurant = await requireRestaurant(restaurantId)
  return minorUnitFactor(restaurant.currency)
}

const createSchema = z.object({
  supplierId: z.string().min(1).optional().or(z.literal('')),
  branchId: z.string().min(1).optional().or(z.literal('')),
  expectedAt: z.string().optional().or(z.literal('')),
  notes: z.string().trim().max(500).optional().or(z.literal('')),
  discount: z.coerce.number().min(0).default(0),
  taxTotal: z.coerce.number().min(0).default(0),
  lines: z.array(z.object({
    itemId: z.string().min(1),
    quantity: z.coerce.number().positive().max(1_000_000),
    unit: z.enum(UNITS).optional(),
    unitCost: z.coerce.number().min(0).max(100_000_000),
  })).min(1, 'Add at least one item'),
})

export async function createPurchaseOrderAction(
  input: unknown,
): Promise<ActionResult<{ id: string; number: string }>> {
  return runAction(createSchema, input, async (data) => {
    const user = await requirePermission(PERMISSIONS.PURCHASE_CREATE)
    const f = await factor(user.restaurantId)

    const po = await createPurchaseOrder({
      restaurantId: user.restaurantId,
      supplierId: data.supplierId || null,
      branchId: data.branchId || user.branchId || null,
      userId: user.id,
      discount: Math.round(data.discount * f),
      taxTotal: Math.round(data.taxTotal * f),
      expectedAt: data.expectedAt ? new Date(data.expectedAt) : null,
      notes: data.notes || null,
      lines: data.lines.map((l) => ({
        itemId: l.itemId,
        quantity: l.quantity,
        unit: l.unit,
        unitCost: Math.round(l.unitCost * f),
      })),
    })

    await audit({
      restaurantId: user.restaurantId, userId: user.id, actorName: user.name,
      action: AUDIT_ACTIONS.PO_CREATED, entity: 'Purchase', entityId: po.id,
      after: { number: po.number, total: po.total, lines: data.lines.length },
    })

    revalidatePath('/dashboard/purchases')
    return { id: po.id, number: po.number }
  }, 'Purchase order created.')
}

const statusSchema = z.object({
  purchaseId: z.string().min(1),
  status: z.enum(['PENDING_APPROVAL', 'APPROVED', 'ORDERED', 'CANCELLED', 'DRAFT']),
  reason: z.string().trim().max(200).optional().or(z.literal('')),
})

/**
 * Move an order through its workflow.
 *
 * Approving is gated separately from creating: committing the restaurant's
 * money is a different act from proposing that it be spent, and a cashier holds
 * neither permission.
 */
export async function setPurchaseStatusAction(
  input: unknown,
): Promise<ActionResult<{ status: string }>> {
  return runAction(statusSchema, input, async (data) => {
    const needsApproval = data.status === 'APPROVED' || data.status === 'ORDERED'
    const user = await requirePermission(
      needsApproval ? PERMISSIONS.PURCHASE_APPROVE : PERMISSIONS.PURCHASE_CREATE,
    )

    const po = await setPurchaseStatus({
      restaurantId: user.restaurantId,
      purchaseId: data.purchaseId,
      status: data.status,
      userId: user.id,
      reason: data.reason || null,
    })

    const action =
      data.status === 'APPROVED' ? AUDIT_ACTIONS.PO_APPROVED
        : data.status === 'ORDERED' ? AUDIT_ACTIONS.PO_ORDERED
          : data.status === 'CANCELLED' ? AUDIT_ACTIONS.PO_CANCELLED
            : AUDIT_ACTIONS.UPDATE

    await audit({
      restaurantId: user.restaurantId, userId: user.id, actorName: user.name,
      action, entity: 'Purchase', entityId: po.id,
      after: { number: po.number, status: po.status, reason: data.reason || null },
    })

    revalidatePath('/dashboard/purchases')
    revalidatePath(`/dashboard/purchases/${data.purchaseId}`)
    return { status: po.status }
  }, 'Order updated.')
}

const receiveSchema = z.object({
  purchaseId: z.string().min(1),
  supplierRef: z.string().trim().max(80).optional().or(z.literal('')),
  notes: z.string().trim().max(300).optional().or(z.literal('')),
  lines: z.array(z.object({
    purchaseItemId: z.string().min(1),
    acceptedQty: z.coerce.number().min(0).max(1_000_000),
    rejectedQty: z.coerce.number().min(0).max(1_000_000).default(0),
    unitCost: z.coerce.number().min(0).max(100_000_000).optional(),
    rejectReason: z.string().trim().max(200).optional().or(z.literal('')),
    batchNo: z.string().trim().max(60).optional().or(z.literal('')),
  })).min(1),
})

export async function receiveGoodsAction(
  input: unknown,
): Promise<ActionResult<{ number: string; status: string; posted: number }>> {
  return runAction(receiveSchema, input, async (data) => {
    const user = await requirePermission(PERMISSIONS.PURCHASE_RECEIVE)
    const f = await factor(user.restaurantId)

    const result = await receiveGoods({
      restaurantId: user.restaurantId,
      purchaseId: data.purchaseId,
      supplierRef: data.supplierRef || null,
      notes: data.notes || null,
      userId: user.id,
      lines: data.lines
        .filter((l) => l.acceptedQty > 0 || l.rejectedQty > 0)
        .map((l) => ({
          purchaseItemId: l.purchaseItemId,
          acceptedQty: l.acceptedQty,
          rejectedQty: l.rejectedQty,
          unitCost: l.unitCost === undefined ? undefined : Math.round(l.unitCost * f),
          rejectReason: l.rejectReason || null,
          batchNo: l.batchNo || null,
        })),
    })

    await audit({
      restaurantId: user.restaurantId, userId: user.id, actorName: user.name,
      action: AUDIT_ACTIONS.PO_RECEIVED, entity: 'GoodsReceipt', entityId: result.receipt.id,
      after: { number: result.receipt.number, orderStatus: result.status, itemsPosted: result.posted },
    })

    revalidatePath('/dashboard/purchases')
    revalidatePath(`/dashboard/purchases/${data.purchaseId}`)
    revalidatePath('/dashboard/inventory')
    return { number: result.receipt.number, status: result.status, posted: result.posted }
  }, 'Goods received and stock updated.')
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

    const record = await createPurchaseReturn({
      restaurantId: user.restaurantId,
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
