import 'server-only'

import { prisma, type TxClient } from '@/server/db/prisma'

/**
 * Sending an order's dishes to the sections that cook them.
 *
 * ── All of it, or none of it ────────────────────────────────────────────────
 *
 * Routing is all-or-nothing per order. If a single dish that needs cooking has
 * no section, nothing is routed and the order stays in the mode it has always
 * been in — one rail, whole orders, cascaded down from the order status.
 *
 * The alternative is worse than it sounds. Routing the mappable items and
 * leaving one behind would put that item on no screen at all: it is not on a
 * section board because it has no section, and it is no longer driven by the
 * order cascade because the order is now in station mode. It would sit QUEUED
 * for ever and hold the whole order short of READY. Half-routed is the one
 * state this feature must never reach.
 *
 * The kitchen action refuses to accept an order with an unmapped dish and names
 * it, so the ordinary path never gets this far. This is the backstop for the
 * paths that do not go through it — chiefly the old board's straight
 * PENDING→PREPARING jump, which degrades to exactly today's behaviour instead
 * of creating tickets nobody can see.
 *
 * ── It never throws ─────────────────────────────────────────────────────────
 *
 * It runs inside `updateOrderStatus`, which has no user, no permission layer
 * and no way to put a message in front of anybody. A refusal there would surface
 * as a failed status change with no explanation. §16's refusal belongs in the
 * action, where there is somebody to tell.
 */

export interface RoutingPlan {
  /** Whether this branch routes to sections at all. */
  configured: boolean
  /** Dishes that need cooking and have no section here. Blocks acceptance. */
  unmapped: Array<{ itemId: string; name: string }>
  /** Items that would be routed, with the section each would go to. */
  assignments: Array<{ itemId: string; stationId: string; stationName: string }>
  /** Items that skip the kitchen entirely — bottled water and the like. */
  noKitchen: string[]
}

/**
 * What routing this order WOULD do. A pure read.
 *
 * Called by the accept action before it writes anything, and by the kitchen
 * queue so a ticket can carry its own warning — an unmapped dish is far better
 * found while somebody is looking at the queue than by a button failing in the
 * middle of service.
 */
export async function planRouting(
  db: TxClient | typeof prisma,
  params: { restaurantId: string; orderId: string },
): Promise<RoutingPlan> {
  const order = await db.order.findFirst({
    where: { id: params.orderId, restaurantId: params.restaurantId },
    select: {
      branchId: true,
      items: {
        where: { status: { not: 'CANCELLED' } },
        select: { id: true, foodId: true, name: true, routedAt: true },
      },
    },
  })

  const empty: RoutingPlan = { configured: false, unmapped: [], assignments: [], noKitchen: [] }
  if (!order) return empty

  const stationCount = await db.kitchenStation.count({
    where: { restaurantId: params.restaurantId, branchId: order.branchId, isActive: true },
  })
  if (stationCount === 0) return empty

  const foodIds = order.items.map((item) => item.foodId).filter((id): id is string => Boolean(id))
  const mappings = foodIds.length
    ? await db.foodBranch.findMany({
        where: {
          restaurantId: params.restaurantId,
          branchId: order.branchId,
          foodId: { in: foodIds },
        },
        select: {
          foodId: true,
          noKitchenRequired: true,
          station: { select: { id: true, name: true, isActive: true } },
        },
      })
    : []
  const byFood = new Map(mappings.map((row) => [row.foodId, row]))

  const plan: RoutingPlan = {
    configured: true,
    unmapped: [],
    assignments: [],
    noKitchen: [],
  }

  for (const item of order.items) {
    // Already routed — a second pass must not move it. That is what makes this
    // safe to run again on the ACCEPTED→PREPARING edge.
    if (item.routedAt !== null) continue

    /*
     * A line with no dish behind it — a deleted menu item, since `foodId` is
     * SET NULL — cannot be routed and cannot be mapped either. Treated as
     * needing no kitchen rather than blocking the order for ever over
     * something nobody can fix.
     */
    const mapping = item.foodId ? byFood.get(item.foodId) : undefined
    if (!item.foodId || mapping?.noKitchenRequired) {
      plan.noKitchen.push(item.id)
      continue
    }

    // An inactive section is not a section. §17 asks for a controlled
    // exception, never a silent reroute to whatever else is nearby.
    if (!mapping?.station || !mapping.station.isActive) {
      plan.unmapped.push({ itemId: item.id, name: item.name })
      continue
    }

    plan.assignments.push({
      itemId: item.id,
      stationId: mapping.station.id,
      stationName: mapping.station.name,
    })
  }

  return plan
}

/**
 * Route an order's items, if every one of them can be routed.
 *
 * Idempotent: it only touches rows whose `routedAt` is null, so running it
 * again on a later status change is a no-op. Returns how many items it routed,
 * which is zero whenever the branch uses no sections or a dish is unmapped.
 */
export async function routeOrderItems(
  tx: TxClient,
  params: { restaurantId: string; orderId: string },
): Promise<number> {
  const plan = await planRouting(tx, params)
  if (!plan.configured || plan.unmapped.length > 0) return 0
  if (plan.assignments.length === 0 && plan.noKitchen.length === 0) return 0

  const now = new Date()

  for (const assignment of plan.assignments) {
    await tx.orderItem.update({
      where: { id: assignment.itemId },
      data: {
        stationId: assignment.stationId,
        // Snapshotted so the section reports stay readable after a rename.
        stationName: assignment.stationName,
        routedAt: now,
      },
    })
  }

  if (plan.noKitchen.length > 0) {
    /*
     * Bottled water is ready the moment the order exists.
     *
     * Leaving these QUEUED would deadlock the whole order: no section ever
     * advances them, so "every item is ready" could never become true, the
     * order would sit at PREPARING with every plate up, and the
     * ready-but-not-served alarm would never fire. They come off a shelf. The
     * waiter still marks them served.
     */
    await tx.orderItem.updateMany({
      where: { id: { in: plan.noKitchen }, status: 'QUEUED' },
      data: { status: 'READY', routedAt: now, readyAt: now },
    })
    // Anything already past QUEUED keeps its status but still counts as routed.
    await tx.orderItem.updateMany({
      where: { id: { in: plan.noKitchen }, routedAt: null },
      data: { routedAt: now },
    })
  }

  return plan.assignments.length + plan.noKitchen.length
}

/**
 * Is this order driven by its items, or cascaded down from the order?
 *
 * Fixed for the order's whole life by whether routing ever touched it. Per
 * order and not per branch on purpose: an order accepted before the owner made
 * their first section must keep its original behaviour to the end, or its next
 * status change would stop cascading items that nothing else will ever advance.
 */
export async function orderIsRouted(
  db: TxClient | typeof prisma,
  orderId: string,
): Promise<boolean> {
  const routed = await db.orderItem.count({
    where: { orderId, routedAt: { not: null } },
  })
  return routed > 0
}
