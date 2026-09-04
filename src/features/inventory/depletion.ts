import 'server-only'

import { prisma, type TxClient, guardLocks} from '@/server/db/prisma'
import { postMovement } from './ledger'
import { resolveOrderConsumption, resolveRecipe } from './recipe-resolver'
import { roundQty } from '@/lib/quantity'

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
   * `Order.branchId` has been NOT NULL since 20260902090000_branch_isolation,
   * so the first arm answers for every real order. The default-branch lookup
   * stays as the answer for the case where no order row was locked at all, and
   * the throw below replaces what used to be a silent `?? null` — a null here
   * would post a movement with no location, which is the exact bug this whole
   * comment is about.
   */
  const branchId =
    locked[0]?.branchId ??
    (
      await tx.branch.findFirst({
        where: { restaurantId: params.restaurantId, deletedAt: null, isDefault: true },
        select: { id: true },
      })
    )?.id

  if (!branchId) {
    throw new Error('This restaurant has no location — stock cannot be depleted against one')
  }

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
    const want = roundQty(desired.totals.get(itemId) ?? 0)
    const have = roundQty(appliedByItem.get(itemId)?.appliedQty ?? 0)
    const delta = roundQty(want - have)

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
  /*
   * Every line still at zero, with or without a recipe — this is the only thing
   * that writes `OrderItem.costPrice`.
   *
   * It used to be written twice: once by `placeOrder`, which copied the menu's
   * `Food.costPrice` onto the line, and once here. Since this only ever
   * overwrites a zero — correctly, so an earlier snapshot cannot be re-priced —
   * the copy meant any restaurant that HAD typed cost prices into its menu never
   * received the real weighted-average snapshot at all. Their profit report
   * showed the number they had guessed months earlier, for ever, while the
   * ledger recorded what the food actually cost. The two disagreed silently.
   *
   * Nothing copies the menu figure onto the line any more, so a zero here means
   * "not yet costed" and nothing else. The menu figure is still the fallback for
   * a dish with no recipe — but applied at THIS moment, not at order time.
   */
  const lines = await tx.orderItem.findMany({
    where: { orderId: params.orderId, costPrice: 0 },
    select: { id: true, recipeId: true, foodId: true, options: true },
  })
  if (lines.length === 0) return 0

  /*
   * Options cost money too (§29). A line's cost is its dish's recipe PLUS the
   * recipe of every chosen option — "extra chicken" was depleting nothing and
   * costing nothing, and of the two the costing half is what quietly
   * overstated every margin figure.
   */
  const optionIds = [
    ...new Set(
      lines.flatMap((line) =>
        (Array.isArray(line.options) ? (line.options as Array<{ optionId?: string }>) : [])
          .map((option) => option.optionId)
          .filter((id): id is string => Boolean(id)),
      ),
    ),
  ]
  const optionRecipeIds = optionIds.length
    ? new Map(
        (
          await tx.variantOption.findMany({
            where: { id: { in: optionIds }, recipeId: { not: null } },
            select: { id: true, recipeId: true },
          })
        ).map((row) => [row.id, row.recipeId!]),
      )
    : new Map<string, string>()

  const costByRecipe = new Map<string, number>()
  let written = 0

  const foodIds = [...new Set(lines.filter((l) => !l.recipeId && l.foodId).map((l) => l.foodId!))]
  const menuCost = new Map<string, number>(
    foodIds.length
      ? (
          await tx.food.findMany({
            where: { id: { in: foodIds }, restaurantId: params.restaurantId },
            select: { id: true, costPrice: true },
          })
        ).map((f) => [f.id, f.costPrice])
      : [],
  )

  const recipeCost = async (recipeId: string): Promise<number> => {
    if (!costByRecipe.has(recipeId)) {
      const resolved = await resolveRecipe(tx, {
        restaurantId: params.restaurantId,
        recipeId,
        portions: 1,
      })
      costByRecipe.set(recipeId, resolved ? Math.round(resolved.totalCost) : 0)
    }
    return costByRecipe.get(recipeId) ?? 0
  }

  for (const line of lines) {
    let cost = 0

    if (line.recipeId) {
      cost = await recipeCost(line.recipeId)
    } else if (line.foodId) {
      cost = menuCost.get(line.foodId) ?? 0
    }

    for (const option of Array.isArray(line.options)
      ? (line.options as Array<{ optionId?: string }>)
      : []) {
      const optionRecipe = option.optionId ? optionRecipeIds.get(option.optionId) : undefined
      if (optionRecipe) cost += await recipeCost(optionRecipe)
    }

    if (cost > 0) {
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


/**
 * Reconcile only if this order has ever consumed anything.
 *
 * `reconcileOrderDepletion` pays no attention to order status: on a PENDING
 * bill it would happily compute "want everything, have nothing" and take the
 * whole order out of stock hours before the kitchen accepted it. Every caller
 * that runs on a line CHANGE (guest edit, line void, split, merge) wants this
 * guard; acceptance itself is the one caller that must not have it.
 *
 * Extracted from `rebalanceDepletion` in cashier/service.ts so the rule exists
 * once — the guest-edit and void paths used to reconcile unguarded and were
 * two of the ways stock left early.
 */
export async function reconcileIfDepleted(
  tx: TxClient,
  params: { restaurantId: string; orderId: string; userId?: string | null },
): Promise<ReconcileResult | null> {
  const applied = await tx.orderStockDepletion.count({ where: { orderId: params.orderId } })
  if (applied === 0) return null
  return reconcileOrderDepletion(tx, params)
}
