'use server'

import { revalidatePath } from 'next/cache'

import { runAction, runSafe, type ActionResult } from '@/lib/action'
import { ConflictError, NotFoundError } from '@/lib/errors'
import { PERMISSIONS } from '@/lib/rbac'
import { AUDIT_ACTIONS, audit } from '@/server/audit'
import { assertBranchAccess, requirePermission } from '@/server/auth/guard'
import { resolveStockLocation } from '@/features/branches/service'
import { resolveCategory } from '@/features/catalog/service'
import { actingBranchId } from '@/features/dashboard/selected-branch'
import { postMovement } from './ledger'
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
      await assertBranchAccess(user, data.branchId)

      /*
       * `quantity` is deliberately absent from this payload.
       *
       * Editing an item used to write the balance straight onto the row, with no
       * ledger entry and no location delta — so the cached number and the sum of
       * its movements silently disagreed from then on, and every reconciliation
       * for that item was wrong for ever after. A balance is the *result* of
       * movements; the only ways to change one are an opening balance, an
       * adjustment with a reason, or a stock count.
       */
      /*
       * The category is resolved into BOTH columns: the new FK and the legacy
       * string every existing reader still uses (the count sheet, the search
       * filter, the reports). Writing one and not the other is how two sources
       * of truth start disagreeing, which is the bug class that has cost this
       * project the most time.
       */
      const category = await resolveCategory({
        restaurantId: user.restaurantId,
        categoryName: data.category || null,
      })

      /*
       * Turning expiry tracking ON is a plain write. Turning it OFF is not.
       *
       * `postMovement` only draws stock out of batches while `trackBatches` is
       * set, so switching it off strands every `StockBatch` for this item at
       * whatever `remainingQty` it happened to hold — the expiry board then
       * warns for ever about crates that were eaten weeks ago, and FEFO offers
       * lots that are gone. Unticking the box stops deliveries ASKING for a
       * date, which is what the owner means by it; the batch machinery stays on
       * so the lots already recorded keep draining correctly.
       */
      const existing = data.id
        ? await prisma.inventoryItem.findFirst({
            where: { id: data.id, restaurantId: user.restaurantId },
            select: { trackBatches: true },
          })
        : null

      const payload = {
        name: data.name,
        sku: data.sku || null,
        category: category.category,
        categoryId: category.categoryId,
        unit: data.unit,
        // The same number in both columns — see `alertBelow` in the schema.
        reorderLevel: data.alertBelow,
        minStock: data.alertBelow,
        maxStock: data.maxStock && data.maxStock > 0 ? data.maxStock : null,
        costPerUnit: data.costPerUnit,
        supplierId: data.supplierId || null,
        storageArea: data.storageArea || null,
        purchaseUnit: data.purchaseUnit || null,
        unitsPerPurchaseUnit: data.unitsPerPurchaseUnit > 0 ? data.unitsPerPurchaseUnit : null,
        trackExpiry: data.tracksExpiry,
        trackBatches: data.tracksExpiry || existing?.trackBatches || false,
        useFefo: data.tracksExpiry || existing?.trackBatches || false,
      }

      try {
        if (data.id) {
          /*
           * `updateMany`, for the reason `saveSupplier` above spells out: a
           * bare primary-key `where` let an id from another restaurant through.
           * Prisma will not take a non-unique `where` on `update`, so the
           * tenant-scoped form is the many-variant plus a count check.
           */
          const result = await prisma.inventoryItem.updateMany({
            where: { id: data.id, restaurantId: user.restaurantId },
            data: payload,
          })
          if (result.count === 0) throw new NotFoundError('Inventory item')
          return { id: data.id }
        }

        /*
         * Where the opening quantity lands — the branch the form chose, and
         * failing that the one on screen.
         *
         * This is the "every new item reads 0" bug. It used to resolve
         * `data.branchId`, which the form never sent, then `user.branchId`,
         * which is null for an owner — so it fell all the way through to the
         * restaurant's DEFAULT branch. Meanwhile the stock list shows the
         * SELECTED branch's `InventoryStock`. Type 10 in while looking at
         * Branch 02 and the 10 was posted to Main, so Branch 02 read 0 for
         * ever, and the item looked broken the moment it was created.
         *
         * Every other stock action in this codebase already used
         * `actingBranchId`; this path and `recordStockMovement` were the two
         * that did not. The form now also asks outright, because guessing where
         * stock is turned out to be the whole problem.
         */
        const branchId = data.branchId || (await actingBranchId(user))

        /*
         * One transaction, so an item cannot exist without its opening stock.
         *
         * These were two calls. If the balance failed, the item row survived at
         * zero — and retrying the same name hit the unique constraint below, so
         * the owner was left with a broken item they could not re-create.
         */
        const record = await prisma.$transaction(async (tx) => {
          const created = await tx.inventoryItem.create({
            data: { ...payload, quantity: 0, restaurantId: user.restaurantId },
          })

          // A starting quantity on a brand-new item is legitimate — but it goes
          // in as an opening balance so it has a date, an author and a ledger
          // row.
          if (data.quantity > 0) {
            await postMovement(tx, {
              restaurantId: user.restaurantId,
              itemId: created.id,
              type: 'OPENING_BALANCE',
              quantity: data.quantity,
              unitCost: data.costPerUnit,
              userId: user.id,
              branchId,
            })
          }
          return created
        })

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
      // Posting stock into a location you have nothing to do with is exactly
      // what this guard exists for; the module never imported it.
      await assertBranchAccess(user, data.branchId)

      const item = await prisma.inventoryItem.findFirst({
        where: { id: data.itemId, restaurantId: user.restaurantId },
      })
      if (!item) throw new NotFoundError('Inventory item')

      /*
       * Posted through the ledger rather than written by hand.
       *
       * This used to compute the sign itself, update `quantity` directly and
       * hand-write the movement — with no `balanceAfter`, no unit conversion and
       * no `applyLocationDelta`, so branch stock never moved. Worse, it clamped
       * the new balance with `Math.max(0, …)`, so any withdrawal that would have
       * gone negative wrote a movement of the full amount while the cached
       * balance stopped at zero. The two could never agree again.
       *
       * `postMovement` owns all of that: the type decides the sign, the item row
       * is locked, `balanceAfter` is recorded, and the location delta is applied
       * in the same transaction.
       */
      const MOVEMENT_TYPES = {
        PURCHASE: 'PURCHASE',
        RETURN: 'CUSTOMER_RETURN',
        WASTE: 'WASTAGE',
        EXPIRY: 'WASTAGE',
        CONSUMPTION: 'ADJUSTMENT_OUT',
        ADJUSTMENT_IN: 'ADJUSTMENT_IN',
        ADJUSTMENT_OUT: 'ADJUSTMENT_OUT',
      } as const

      // A signed ADJUSTMENT is two different movements; everything else is fixed.
      const resolved =
        data.type === 'ADJUSTMENT'
          ? data.quantity >= 0 ? 'ADJUSTMENT_IN' : 'ADJUSTMENT_OUT'
          : MOVEMENT_TYPES[data.type]

      // Resolved before the transaction opens, so the lookup does not run while
      // the item row is locked. `actingBranchId` — the location on screen —
      // rather than the restaurant's default, for the reason spelt out in
      // `saveInventoryItem`: stock typed in while looking at one branch used to
      // land on another.
      const branchId = data.branchId || (await actingBranchId(user))

      const posted = await prisma.$transaction((tx) =>
        postMovement(tx, {
          restaurantId: user.restaurantId,
          itemId: item.id,
          type: resolved,
          quantity: Math.abs(data.quantity),
          reason: data.reason || null,
          userId: user.id,
          branchId,
          locationId: data.storageLocationId || null,
        }),
      )
      const nextQuantity = posted.balanceAfter

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
        if (data.id) {
          /*
           * `updateMany`, not `update`, and the reason is not style.
           *
           * This was `update({ where: { id: data.id } })` — a primary-key
           * lookup with no tenant predicate, so the id decided everything.
           * Anyone holding SUPPLIER_MANAGE in any restaurant could overwrite
           * ANOTHER restaurant's supplier by posting its id: name, phone,
           * email, and `isActive` to hide it. That is a tenancy breach, not a
           * branch one, and it is the only one the audit found.
           *
           * Prisma's `update` cannot take a non-unique `where`, so the fix is
           * the shape `deleteSupplier` twelve lines below already uses: match
           * on id AND restaurant, then read the count. A mismatched id updates
           * nothing and is reported as not-found, which is also what it should
           * look like from outside — an id belonging to another tenant must
           * not be distinguishable from an id that does not exist.
           */
          const result = await prisma.supplier.updateMany({
            where: { id: data.id, restaurantId: user.restaurantId },
            data: payload,
          })
          if (result.count === 0) throw new NotFoundError('Supplier')
          revalidatePath('/dashboard/suppliers')
          return { id: data.id }
        }

        const record = await prisma.supplier.create({
          data: { ...payload, restaurantId: user.restaurantId },
        })
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
      // The posted location has to be one this user may reach. `resolveStockLocation`
      // only checks that the branch belongs to the restaurant, which is a
      // tenancy check, not a permission one.
      await assertBranchAccess(user, data.branchId)
      const destination = await resolveStockLocation({
        restaurantId: user.restaurantId,
        requestedBranchId: data.branchId,
        userBranchId: user.branchId,
      })

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
            /*
             * The branch was resolved above and then used only for the stock
             * movement — the purchase row itself carried none. So the goods
             * landed at a location while the order that bought them was
             * invisible to every branch-filtered purchase list, and the spend
             * could not be attributed to the site that spent it.
             */
            branchId: destination,
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

        /*
         * Receiving a purchase increases stock, through the ledger.
         *
         * This used to increment `quantity` directly and — worse — set
         * `costPerUnit = line.unitCost`, overwriting the weighted average with
         * the price of the newest delivery. One cheap sack of flour would
         * re-price the whole shelf and every margin derived from it.
         * `postMovement` blends the new cost in by quantity instead, and records
         * `balanceAfter` and the location delta.
         */
        for (const line of lines) {
          await postMovement(tx, {
            restaurantId: user.restaurantId,
            itemId: line.itemId,
            type: 'PURCHASE',
            quantity: line.quantity,
            unitCost: line.unitCost,
            reason: `Purchase ${number}`,
            referenceType: 'Purchase',
            referenceId: created.id,
            purchaseId: created.id,
            userId: user.id,
            branchId: destination,
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
