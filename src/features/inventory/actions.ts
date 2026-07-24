'use server'

import { revalidatePath } from 'next/cache'

import { runAction, runSafe, type ActionResult } from '@/lib/action'
import { ConflictError, NotFoundError } from '@/lib/errors'
import { PERMISSIONS } from '@/lib/rbac'
import { AUDIT_ACTIONS, audit } from '@/server/audit'
import { requirePermission } from '@/server/auth/guard'
import { isUniqueViolation, prisma } from '@/server/db/prisma'
import { realtime } from '@/server/realtime/emitter'
import {
  inventoryItemSchema,
  purchaseSchema,
  stockMovementSchema,
  supplierSchema,
} from './schema'

// ── items ────────────────────────────────────────────────────────────────────

export async function saveInventoryItem(input: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction(
    inventoryItemSchema,
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.INVENTORY_MANAGE)

      const payload = {
        name: data.name,
        sku: data.sku || null,
        category: data.category || null,
        unit: data.unit,
        quantity: data.quantity,
        reorderLevel: data.reorderLevel,
        costPerUnit: data.costPerUnit,
        supplierId: data.supplierId || null,
        storageArea: data.storageArea || null,
        expiryDate: data.expiryDate ? new Date(data.expiryDate) : null,
      }

      try {
        const record = data.id
          ? await prisma.inventoryItem.update({ where: { id: data.id }, data: payload })
          : await prisma.inventoryItem.create({ data: { ...payload, restaurantId: user.restaurantId } })

        revalidatePath('/dashboard/inventory')
        return { id: record.id }
      } catch (error) {
        if (isUniqueViolation(error)) throw new ConflictError('An item with that name already exists')
        throw error
      }
    },
    'Inventory item saved.',
  )
}

export async function recordStockMovement(input: unknown): Promise<ActionResult<{ quantity: number }>> {
  return runAction(
    stockMovementSchema,
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.INVENTORY_MANAGE)

      const item = await prisma.inventoryItem.findFirst({
        where: { id: data.itemId, restaurantId: user.restaurantId },
      })
      if (!item) throw new NotFoundError('Inventory item')

      // PURCHASE/RETURN add; WASTE/CONSUMPTION/EXPIRY remove; ADJUSTMENT is signed.
      const signed =
        data.type === 'PURCHASE' || data.type === 'RETURN'
          ? Math.abs(data.quantity)
          : data.type === 'ADJUSTMENT'
            ? data.quantity
            : -Math.abs(data.quantity)

      const nextQuantity = Math.max(0, item.quantity + signed)

      const updated = await prisma.$transaction(async (tx) => {
        const next = await tx.inventoryItem.update({
          where: { id: item.id },
          data: { quantity: nextQuantity },
        })
        await tx.stockMovement.create({
          data: {
            restaurantId: user.restaurantId,
            itemId: item.id,
            type: data.type,
            quantity: signed,
            unitCost: item.costPerUnit,
            reason: data.reason || null,
            userId: user.id,
          },
        })
        return next
      })

      await audit({
        restaurantId: user.restaurantId,
        userId: user.id,
        actorName: user.name,
        action: AUDIT_ACTIONS.STOCK_ADJUSTED,
        entity: 'InventoryItem',
        entityId: item.id,
        before: { quantity: item.quantity },
        after: { quantity: nextQuantity, type: data.type },
      })

      if (nextQuantity <= item.reorderLevel) {
        realtime.lowStock(user.restaurantId, {
          itemId: item.id,
          name: item.name,
          quantity: nextQuantity,
          reorderLevel: item.reorderLevel,
          unit: item.unit,
        })
      }

      revalidatePath('/dashboard/inventory')
      return { quantity: nextQuantity }
    },
    'Stock updated.',
  )
}

export async function deleteInventoryItem(id: string): Promise<ActionResult<{ id: string }>> {
  return runSafe(async () => {
    const user = await requirePermission(PERMISSIONS.INVENTORY_MANAGE)
    const result = await prisma.inventoryItem.updateMany({
      where: { id, restaurantId: user.restaurantId },
      data: { isActive: false },
    })
    if (result.count === 0) throw new NotFoundError('Inventory item')
    revalidatePath('/dashboard/inventory')
    return { id }
  }, 'Item removed.')
}

// ── suppliers ────────────────────────────────────────────────────────────────

export async function saveSupplier(input: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction(
    supplierSchema,
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.SUPPLIER_MANAGE)
      const payload = {
        name: data.name,
        contactName: data.contactName || null,
        phone: data.phone || null,
        email: data.email || null,
        address: data.address || null,
        notes: data.notes || null,
        isActive: data.isActive,
      }

      try {
        const record = data.id
          ? await prisma.supplier.update({ where: { id: data.id }, data: payload })
          : await prisma.supplier.create({ data: { ...payload, restaurantId: user.restaurantId } })
        revalidatePath('/dashboard/suppliers')
        return { id: record.id }
      } catch (error) {
        if (isUniqueViolation(error)) throw new ConflictError('A supplier with that name already exists')
        throw error
      }
    },
    'Supplier saved.',
  )
}

export async function deleteSupplier(id: string): Promise<ActionResult<{ id: string }>> {
  return runSafe(async () => {
    const user = await requirePermission(PERMISSIONS.SUPPLIER_MANAGE)
    const result = await prisma.supplier.updateMany({
      where: { id, restaurantId: user.restaurantId },
      data: { isActive: false },
    })
    if (result.count === 0) throw new NotFoundError('Supplier')
    revalidatePath('/dashboard/suppliers')
    return { id }
  }, 'Supplier removed.')
}

// ── purchases ────────────────────────────────────────────────────────────────

export async function createPurchase(input: unknown): Promise<ActionResult<{ id: string; number: string }>> {
  return runAction(
    purchaseSchema,
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.PURCHASE_MANAGE)

      const items = await prisma.inventoryItem.findMany({
        where: { id: { in: data.items.map((line) => line.itemId) }, restaurantId: user.restaurantId },
        select: { id: true },
      })
      const allowed = new Set(items.map((item) => item.id))
      const lines = data.items.filter((line) => allowed.has(line.itemId))
      if (!lines.length) throw new NotFoundError('Inventory items')

      const total = lines.reduce((sum, line) => sum + Math.round(line.quantity * line.unitCost), 0)

      const purchase = await prisma.$transaction(async (tx) => {
        const count = await tx.purchase.count({ where: { restaurantId: user.restaurantId } })
        const number = `PO-${String(count + 1).padStart(5, '0')}`

        const created = await tx.purchase.create({
          data: {
            restaurantId: user.restaurantId,
            supplierId: data.supplierId || null,
            number,
            status: 'RECEIVED',
            total,
            notes: data.notes || null,
            orderedAt: new Date(),
            receivedAt: new Date(),
            items: {
              create: lines.map((line) => ({
                itemId: line.itemId,
                quantity: line.quantity,
                unitCost: line.unitCost,
                lineTotal: Math.round(line.quantity * line.unitCost),
              })),
            },
          },
        })

        // Receiving a purchase increases stock and logs a movement per line.
        for (const line of lines) {
          await tx.inventoryItem.update({
            where: { id: line.itemId },
            data: { quantity: { increment: line.quantity }, costPerUnit: line.unitCost },
          })
          await tx.stockMovement.create({
            data: {
              restaurantId: user.restaurantId,
              itemId: line.itemId,
              type: 'PURCHASE',
              quantity: line.quantity,
              unitCost: line.unitCost,
              reason: `Purchase ${number}`,
              purchaseId: created.id,
              userId: user.id,
            },
          })
        }

        return created
      })

      revalidatePath('/dashboard/purchases')
      revalidatePath('/dashboard/inventory')
      return { id: purchase.id, number: purchase.number }
    },
    'Purchase recorded and stock updated.',
  )
}
