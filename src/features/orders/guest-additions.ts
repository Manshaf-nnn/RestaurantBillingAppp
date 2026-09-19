import 'server-only'

import type { Order, Prisma } from '@prisma/client'

import { assertPeriodOpen } from '@/features/accounting/service'
import { recalculateOrderTotals } from '@/features/cashier/service'
import { pinRecipeVersions, reconcileIfDepleted, snapshotLineCosts } from '@/features/inventory/depletion'
import { planRouting, routeOrderItems } from '@/features/kitchen/routing'
import { AppError, NotFoundError } from '@/lib/errors'
import { guardLocks, prisma } from '@/server/db/prisma'
import { realtime } from '@/server/realtime/emitter'
import { estimatePrepMinutes } from './pricing'
import { buildDraft, toOrderPayload, type DraftItemInput } from './service'

/**
 * A guest adds NEW dishes from the menu to their existing order (aO.md §3).
 *
 * ── Why this is its own door ────────────────────────────────────────────────
 *
 * `updateGuestOrderItems` changes the quantities of lines the order already
 * has; it cannot add a dish. The tracker's "Order more" used to start a whole
 * new order, which the table rule (§2) now refuses for the same party while
 * their first order is open. So a guest browses the menu as normal, and what
 * they pick joins the order they have.
 *
 * ── What it does, in one transaction ────────────────────────────────────────
 *
 * The same guards as a guest edit: their own session, not served or paid,
 * the books open. The new lines are priced by `buildDraft` at the order's
 * branch — exactly as `placeOrder` prices them — and written QUEUED. If the
 * kitchen already has the order, the lines are routed to their sections at
 * once (a dish with no section is refused, nothing written), the recipe is
 * pinned and costed, and the ingredients leave stock through the same
 * reconciliation placement uses. Totals are re-derived from every live line
 * — coupon and loyalty included — and the order's history says what was
 * added. After commit every board and the guest's own screen hear about it.
 *
 * This module imports both the order and the cashier services (totals), so
 * it lives beside them rather than inside either.
 */

const LOCKED = ['SERVED', 'COMPLETED', 'CANCELLED'] as const

export interface AddedLine {
  id: string
  name: string
  quantity: number
}

/**
 * New dishes joining an order that already exists — the guest's, from their
 * phone, and the till's, from the counter. One core, two doors.
 *
 * The doors differ only in who may open them: a guest proves it is their order
 * by session, a member of staff by permission and branch. Everything after
 * that — pricing at the order's branch, routing to sections, pinning recipe
 * versions, costing, taking stock, re-totalling and telling every board — is
 * the same act and must not be written twice, or the kitchen would hear about
 * one door's additions and not the other's.
 */
async function addOrderItems(params: {
  restaurantId: string
  orderId: string
  /** Who may reach this order: the guest's session, or nothing extra for staff. */
  owner: Prisma.OrderWhereInput
  items: DraftItemInput[]
  /** Who is adding, for the order's history. */
  addedBy: string
  /** What to say when the bill is already paid. */
  paidMessage: string
}): Promise<{ order: Order; added: AddedLine[] }> {
  if (params.items.length === 0) {
    throw new AppError('Choose something to add first', 400, 'EMPTY_ADDITION')
  }

  const order = await prisma.order.findFirst({
    where: { id: params.orderId, restaurantId: params.restaurantId, ...params.owner },
    select: { id: true, status: true, paymentStatus: true, placedAt: true, branchId: true },
  })
  if (!order) throw new NotFoundError('Order')
  if ((LOCKED as readonly string[]).includes(order.status)) {
    throw new AppError('This order can no longer be changed.', 409, 'ORDER_LOCKED')
  }
  if (order.paymentStatus !== 'UNPAID') {
    throw new AppError(params.paidMessage, 409, 'ORDER_PAID')
  }
  // Signed books do not quietly change (§59).
  await assertPeriodOpen(prisma, params.restaurantId, order.placedAt)

  const { updated, added } = await prisma.$transaction(async (tx) => {
    await guardLocks(tx)
    // Judged again under the lock: the kitchen may have served it meanwhile.
    const locked = await tx.$queryRaw<Array<{ status: string; paymentStatus: string }>>`
      SELECT status::text, "paymentStatus"::text FROM orders WHERE id = ${order.id} FOR UPDATE
    `
    const now = locked[0]
    if (!now) throw new NotFoundError('Order')
    if ((LOCKED as readonly string[]).includes(now.status)) {
      throw new AppError('This order can no longer be changed.', 409, 'ORDER_LOCKED')
    }
    if (now.paymentStatus !== 'UNPAID') {
      throw new AppError(params.paidMessage, 409, 'ORDER_PAID')
    }

    // Priced at the order's own branch, as the original lines were.
    const draft = await buildDraft({
      restaurantId: params.restaurantId,
      branchId: order.branchId,
      items: params.items,
      db: tx,
    })

    const created: AddedLine[] = []
    for (const item of draft.items) {
      const line = await tx.orderItem.create({
        data: {
          orderId: order.id,
          foodId: item.foodId,
          name: item.name,
          imageUrl: item.imageUrl,
          unitPrice: item.unitPrice,
          quantity: item.quantity,
          options: item.options as unknown as Prisma.InputJsonValue,
          optionsTotal: item.optionsTotal,
          lineTotal: item.lineTotal,
          costPrice: item.costPrice,
          notes: item.notes,
          isVeg: item.isVeg,
          prepTimeMinutes: item.prepTimeMinutes,
          status: 'QUEUED',
        },
        select: { id: true, name: true, quantity: true },
      })
      created.push(line)
    }

    /*
     * The kitchen already has this order: the new lines join it now — routed
     * to their sections (only rows with `routedAt` null are touched, so
     * nothing the sections have started moves), pinned to the recipe version
     * in force, costed, and taken off stock. A dish with no section is
     * refused before anything is written, as at placement. An order still
     * waiting at the till stays whole until the cashier accepts it, when the
     * ordinary acceptance does all of this for every line at once.
     */
    if (now.status !== 'PENDING') {
      const plan = await planRouting(tx, { restaurantId: params.restaurantId, orderId: order.id })
      if (plan.unmapped.length > 0) {
        const names = [...new Set(plan.unmapped.map((row) => row.name))]
        throw new AppError(
          `${names.slice(0, 3).join(', ')} cannot be ordered right now — please ask our staff`,
          409,
          'ITEM_NO_STATION',
        )
      }
      await routeOrderItems(tx, { restaurantId: params.restaurantId, orderId: order.id })
      await pinRecipeVersions(tx, { restaurantId: params.restaurantId, orderId: order.id })
      await snapshotLineCosts(tx, { restaurantId: params.restaurantId, orderId: order.id })
      await reconcileIfDepleted(tx, { restaurantId: params.restaurantId, orderId: order.id })
    }

    // Totals from every live line — coupon, loyalty and rounding included.
    const recalculated = await recalculateOrderTotals(tx, order.id)
    const live = await tx.orderItem.findMany({
      where: { orderId: order.id, status: { not: 'CANCELLED' } },
      select: { prepTimeMinutes: true, quantity: true },
    })
    const updatedOrder = await tx.order.update({
      where: { id: order.id },
      data: {
        estimatedMinutes: estimatePrepMinutes(live, 0),
        events: {
          create: {
            status: recalculated.status,
            note: `${params.addedBy} added ${created.map((line) => `${line.quantity} × ${line.name}`).join(', ')}`,
          },
        },
      },
    })
    return { updated: updatedOrder, added: created }
  })

  // Every board — and the guest's own room — hears the order changed.
  const payload = await toOrderPayload(order.id)
  if (payload) realtime.orderUpdated(params.restaurantId, payload)

  return { order: updated, added }
}

/** From the guest's phone: theirs by session, and only theirs. */
export async function addGuestOrderItems(params: {
  restaurantId: string
  orderId: string
  /** The guest's own session; without one nothing here is theirs. */
  guestSessionId: string | null
  items: DraftItemInput[]
}): Promise<{ order: Order; added: AddedLine[] }> {
  if (!params.guestSessionId) throw new NotFoundError('Order')
  return addOrderItems({
    restaurantId: params.restaurantId,
    orderId: params.orderId,
    owner: { guestSessionId: params.guestSessionId },
    items: params.items,
    addedBy: 'Customer',
    paidMessage: 'This bill has been paid — ask a member of staff to add to it.',
  })
}

/**
 * From the till: any unpaid order at a branch the cashier may reach. The
 * permission and the branch are the caller's to check; this only insists on
 * the tenant.
 */
export async function addStaffOrderItems(params: {
  restaurantId: string
  orderId: string
  items: DraftItemInput[]
  staffName: string
}): Promise<{ order: Order; added: AddedLine[] }> {
  return addOrderItems({
    restaurantId: params.restaurantId,
    orderId: params.orderId,
    owner: {},
    items: params.items,
    addedBy: params.staffName,
    paidMessage: 'This bill has been paid — refund it before adding to it.',
  })
}
