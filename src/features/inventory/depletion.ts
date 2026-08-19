import 'server-only'

import { prisma, type TxClient } from '@/server/db/prisma'
import { postMovement } from './ledger'
import { resolveOrderConsumption } from './recipe-resolver'

/**
 * Recipe-driven stock depletion for an order.
 *
 * There is exactly one operation here — `reconcileOrderDepletion` — and it is
 * declarative rather than incremental. It asks two questions:
 *
 *   what *should* this order have consumed, given its lines right now?
 *   what *has* it consumed, according to order_stock_depletions?
 *
 * and posts only the difference. Every case the business needs falls out of
 * that single rule rather than needing its own code path:
 *
 *   • first confirmation   — applied 0, desired 2 → deduct 2
 *   • run again            — applied 2, desired 2 → nothing happens
 *   • 2 burgers → 3        — applied 2, desired 3 → deduct 1
 *   • 3 burgers → 1        — applied 3, desired 1 → return 2
 *   • order cancelled      — desired 0            → return everything
 *
 * Idempotency therefore does not depend on remembering whether the function has
 * run before, which is the part that usually breaks: a retry, a double click or
 * a replayed webhook all converge on the same state.
 *
 * The whole reconciliation runs inside the caller's transaction, so an order can
 * never end up half-deducted.
 */

export interface ReconcileResult {
  /** Items that had stock taken. */
  deducted: number
  /** Items that had stock put back. */
  returned: number
  /** Items already correct. */
  unchanged: number
  /** Items whose balance actually moved — used to raise low-stock alerts. */
  affectedItemIds: string[]
  problems: string[]
}

export async function reconcileOrderDepletion(
  tx: TxClient,
  params: {
    restaurantId: string
    orderId: string
    userId?: string | null
    /** Set when the order is cancelled: everything goes back. */
    releaseAll?: boolean
  },
): Promise<ReconcileResult> {
  const desired = params.releaseAll
    ? { totals: new Map<string, number>(), problems: [] as string[] }
    : await resolveOrderConsumption(tx, {
        restaurantId: params.restaurantId,
        orderId: params.orderId,
      })

  const applied = await tx.orderStockDepletion.findMany({
    where: { orderId: params.orderId, restaurantId: params.restaurantId },
  })
  const appliedByItem = new Map(applied.map((row) => [row.itemId, row]))

  // Every item on either side — an item dropped from the order still has to be
  // put back, so the union matters, not just what is currently wanted.
  const itemIds = new Set<string>([...desired.totals.keys(), ...appliedByItem.keys()])

  let deducted = 0
  let returned = 0
  let unchanged = 0
  const affectedItemIds: string[] = []

  for (const itemId of itemIds) {
    const want = round(desired.totals.get(itemId) ?? 0)
    const have = round(appliedByItem.get(itemId)?.appliedQty ?? 0)
    const delta = round(want - have)

    if (Math.abs(delta) < 1e-6) {
      unchanged += 1
      continue
    }

    if (delta > 0) {
      await postMovement(tx, {
        restaurantId: params.restaurantId,
        itemId,
        type: 'SALE',
        quantity: delta,
        reason: 'Recipe consumption',
        referenceType: 'Order',
        referenceId: params.orderId,
        orderId: params.orderId,
        userId: params.userId,
      })
      deducted += 1
    } else {
      await postMovement(tx, {
        restaurantId: params.restaurantId,
        itemId,
        type: 'SALE_REVERSAL',
        quantity: Math.abs(delta),
        reason: params.releaseAll ? 'Order cancelled' : 'Order quantity reduced',
        referenceType: 'Order',
        referenceId: params.orderId,
        orderId: params.orderId,
        userId: params.userId,
      })
      returned += 1
    }
    affectedItemIds.push(itemId)

    await tx.orderStockDepletion.upsert({
      where: { orderId_itemId: { orderId: params.orderId, itemId } },
      create: {
        restaurantId: params.restaurantId,
        orderId: params.orderId,
        itemId,
        appliedQty: want,
      },
      update: { appliedQty: want },
    })
  }

  return { deducted, returned, unchanged, affectedItemIds, problems: desired.problems }
}

/**
 * Pin each line to the recipe version in force right now.
 *
 * Called once when the kitchen accepts the order. After this the line keeps
 * costing and depleting against that version even if the owner edits the recipe
 * tomorrow, which is what makes historical margin figures meaningful.
 */
export async function pinRecipeVersions(
  tx: TxClient,
  params: { restaurantId: string; orderId: string },
): Promise<number> {
  const lines = await tx.orderItem.findMany({
    where: { orderId: params.orderId, recipeId: null, foodId: { not: null } },
    select: { id: true, foodId: true },
  })
  if (lines.length === 0) return 0

  const foodIds = [...new Set(lines.map((l) => l.foodId!))]
  const recipes = await tx.recipe.findMany({
    where: { restaurantId: params.restaurantId, foodId: { in: foodIds }, isActive: true, archivedAt: null },
    orderBy: { version: 'desc' },
    select: { id: true, foodId: true },
  })
  const byFood = new Map<string, string>()
  for (const recipe of recipes) {
    if (recipe.foodId && !byFood.has(recipe.foodId)) byFood.set(recipe.foodId, recipe.id)
  }

  let pinned = 0
  for (const line of lines) {
    const recipeId = byFood.get(line.foodId!)
    if (!recipeId) continue
    await tx.orderItem.update({ where: { id: line.id }, data: { recipeId } })
    pinned += 1
  }
  return pinned
}

/** Standalone wrapper for callers not already inside a transaction. */
export async function reconcileOrderDepletionStandalone(params: {
  restaurantId: string
  orderId: string
  userId?: string | null
  releaseAll?: boolean
}): Promise<ReconcileResult> {
  return prisma.$transaction((tx) => reconcileOrderDepletion(tx, params))
}

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6
}
