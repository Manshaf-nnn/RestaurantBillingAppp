import 'server-only'

import { prisma, type TxClient, guardLocks} from '@/server/db/prisma'
import { postMovement } from './ledger'
import { resolveOrderConsumption, resolveRecipe } from './recipe-resolver'

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
  // Serialise reconciliation per order. Without this, ten concurrent calls all
  // read the same applied quantities, all compute the same delta, and all post
  // it — measured before this fix: ten calls produced ten SALE rows and took
  // sixty buns instead of six. The lock makes the "run twice, change nothing"
  // guarantee hold under concurrency as well as in sequence.
  await guardLocks(tx)
  const locked = await tx.$queryRaw<Array<{ id: string; branchId: string | null }>>`
    SELECT id, "branchId" FROM orders
    WHERE id = ${params.orderId} AND "restaurantId" = ${params.restaurantId}
    FOR UPDATE
  `

  /*
   * Where the sale happened, so the ledger can take the stock off the right
   * shelf.
   *
   * These postings used to carry no branch at all. `applyLocationDelta` returns
   * early without one (`location-stock.ts`), so per-branch `InventoryStock`
   * never went down: receipts and transfers added to it, sales took nothing
   * away. Restaurant-wide totals stayed correct, which is why it went unnoticed,
   * but every per-branch figure drifted upward for ever — and `assertSufficient`
   * reads exactly that number, so transfers were being approved against stock
   * that had already been eaten.
   *
   * A single-location restaurant leaves `Order.branchId` null, so fall back to
   * the default branch rather than to nothing; otherwise the same bug simply
   * moves to the restaurants least likely to spot it.
   */
  const branchId =
    locked[0]?.branchId ??
    (
      await tx.branch.findFirst({
        where: { restaurantId: params.restaurantId, deletedAt: null, isDefault: true },
        select: { id: true },
      })
    )?.id ??
    null

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
        branchId,
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
        branchId,
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

/**
 * Record what each line's ingredients actually cost, at the moment it is sold.
 *
 * COGS used to come from `Food.costPrice` — a number the owner types into the
 * menu dialog, defaulting to zero. A restaurant that never filled it in reported
 * cost of nil and a gross margin of 100%, and the "recipe fallback" meant to
 * cover that was unreachable: `costPrice ?? recipeCost` never fires, because the
 * column is not nullable. So the headline profit figure on the reports screen
 * was, for most restaurants, arithmetic on a zero.
 *
 * The real number is already in the system. `resolveRecipe` explodes the pinned
 * recipe — sub-recipes, yields and wastage percentages included — and prices it
 * at the weighted average cost then in force. Writing that onto the line makes it
 * a snapshot: tomorrow's price rise cannot rewrite what today's plate cost.
 *
 * Runs beside `pinRecipeVersions`, so the cost recorded belongs to the same
 * recipe version the stock was drawn against.
 */
export async function snapshotLineCosts(
  tx: TxClient,
  params: { restaurantId: string; orderId: string },
): Promise<number> {
  const lines = await tx.orderItem.findMany({
    where: { orderId: params.orderId, recipeId: { not: null } },
    select: { id: true, recipeId: true, costPrice: true },
  })
  if (lines.length === 0) return 0

  const costByRecipe = new Map<string, number>()
  let written = 0

  for (const line of lines) {
    const recipeId = line.recipeId!
    if (!costByRecipe.has(recipeId)) {
      const resolved = await resolveRecipe(tx, { restaurantId: params.restaurantId, recipeId, portions: 1 })
      costByRecipe.set(recipeId, resolved ? Math.round(resolved.totalCost) : 0)
    }
    const cost = costByRecipe.get(recipeId) ?? 0

    // Only overwrite a zero. A line already carrying a cost was either priced by
    // an earlier snapshot or set deliberately, and re-pricing it later would
    // change history.
    if (cost > 0 && line.costPrice === 0) {
      await tx.orderItem.update({ where: { id: line.id }, data: { costPrice: cost } })
      written += 1
    }
  }
  return written
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
