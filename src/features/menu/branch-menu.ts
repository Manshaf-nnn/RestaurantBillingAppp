import 'server-only'

import { prisma } from '@/server/db/prisma'

/**
 * What a branch sells, and for how much.
 *
 * ── The one idea ────────────────────────────────────────────────────────────
 *
 * A dish is one `Food` row. Which branches sell it, and what it costs at each,
 * lives in `FoodBranch`. The **existence of the row is the sharing decision**:
 *
 *   no row      → the branch does not have this dish at all
 *   row, on     → it is on their menu
 *   row, off    → they have it and it is temporarily off (sold out today)
 *
 * That distinction is deliberate. "Not on our menu" and "we've run out" are
 * different sentences, and collapsing them into one boolean would make it
 * impossible to say either.
 *
 * ── Prices are overrides, not copies ────────────────────────────────────────
 *
 * `price: null` means "whatever the dish costs". Only a branch that genuinely
 * charges something else stores a number. Copying the price into every row at
 * share time would look identical on day one and then rot: raising the base
 * price would silently move nothing, and a restaurant that prices the same
 * everywhere would be editing five rows to change one number.
 *
 * ── Why this file exists at all ─────────────────────────────────────────────
 *
 * Both the display path (`getPublicMenu`, which the cashier POS also reads) and
 * the authoritative path (`buildDraft`, which prices real orders) already run
 * every dish through `effectivePrice(food, now, tz)`, and its parameter is a
 * plain shape rather than a Prisma model. So merging the branch's overrides
 * onto the food object *before* that call covers guest ordering, the POS and
 * order pricing at once, and `pricing.ts` — which knows about happy hours and
 * discounts and is the last thing worth destabilising — is not touched.
 */

/** The columns `applyBranchOverrides` reads. */
export interface BranchOverride {
  price: number | null
  discountPrice: number | null
  isAvailable: boolean
  sortOrder: number | null
}

export interface OverridableFood {
  id: string
  price: number
  discountPrice: number | null
  isAvailable: boolean
  sortOrder: number
}

/**
 * Merge a branch's overrides onto a dish.
 *
 * `isAvailable` is an AND, never an OR: a dish switched off restaurant-wide is
 * off everywhere, and a branch cannot switch it back on. Taking something off
 * the menu must not be quietly undone by a branch setting nobody remembers.
 */
export function applyBranchOverrides<T extends OverridableFood>(
  food: T,
  override: BranchOverride | undefined,
): T {
  if (!override) return food

  return {
    ...food,
    price: override.price ?? food.price,
    discountPrice: override.discountPrice ?? food.discountPrice,
    isAvailable: food.isAvailable && override.isAvailable,
    sortOrder: override.sortOrder ?? food.sortOrder,
  }
}

/**
 * The overrides for one branch, keyed by food id.
 *
 * Returns null when no branch is in play — a single-site restaurant, or an
 * owner looking at every location at once. Null means "no branch filter", and
 * callers must treat it differently from an empty map, which means "this
 * branch sells nothing".
 */
export async function branchOverrides(params: {
  restaurantId: string
  branchId: string | null | undefined
}): Promise<Map<string, BranchOverride> | null> {
  if (!params.branchId) return null

  const rows = await prisma.foodBranch.findMany({
    where: { restaurantId: params.restaurantId, branchId: params.branchId },
    select: {
      foodId: true,
      price: true,
      discountPrice: true,
      isAvailable: true,
      sortOrder: true,
    },
  })

  return new Map(rows.map((row) => [row.foodId, row]))
}

/**
 * The ids of every dish a branch may sell.
 *
 * Used as a `where` clause rather than filtering after the fact, so a branch
 * with fifty dishes out of five hundred fetches fifty.
 */
export function branchFoodFilter(branchId: string | null | undefined) {
  return branchId ? { branches: { some: { branchId } } } : {}
}

/**
 * Which branches a dish is on, for the edit form.
 *
 * Includes the override values so the form can show the branch's own price
 * beside its checkbox, and blank where it inherits.
 */
export async function foodBranchRows(params: { restaurantId: string; foodId: string }) {
  return prisma.foodBranch.findMany({
    where: { restaurantId: params.restaurantId, foodId: params.foodId },
    select: {
      branchId: true,
      price: true,
      discountPrice: true,
      isAvailable: true,
      sortOrder: true,
    },
  })
}

/**
 * Replace the branch list for a dish.
 *
 * Wholesale replacement inside the caller's transaction, matching how variant
 * groups and recipe items are already handled by `saveFood`. Diffing would buy
 * nothing here and would risk a stale row surviving an edit — the one failure
 * mode that would leave a dish on a menu somebody had just removed it from.
 *
 * Rows for branches that no longer own the dish are deleted rather than
 * switched off, because "off" is a real state meaning "sold out" and must not
 * be overloaded with "removed".
 */
export async function replaceFoodBranches(
  tx: Pick<typeof prisma, 'foodBranch'>,
  params: {
    restaurantId: string
    foodId: string
    branches: Array<{
      branchId: string
      price?: number | null
      discountPrice?: number | null
      isAvailable?: boolean
      sortOrder?: number | null
    }>
  },
) {
  await tx.foodBranch.deleteMany({
    where: {
      foodId: params.foodId,
      restaurantId: params.restaurantId,
      ...(params.branches.length
        ? { branchId: { notIn: params.branches.map((b) => b.branchId) } }
        : {}),
    },
  })

  for (const branch of params.branches) {
    await tx.foodBranch.upsert({
      where: { foodId_branchId: { foodId: params.foodId, branchId: branch.branchId } },
      create: {
        restaurantId: params.restaurantId,
        foodId: params.foodId,
        branchId: branch.branchId,
        price: branch.price ?? null,
        discountPrice: branch.discountPrice ?? null,
        isAvailable: branch.isAvailable ?? true,
        sortOrder: branch.sortOrder ?? null,
      },
      update: {
        price: branch.price ?? null,
        discountPrice: branch.discountPrice ?? null,
        isAvailable: branch.isAvailable ?? true,
        sortOrder: branch.sortOrder ?? null,
      },
    })
  }
}

/**
 * The branch a new dish belongs to when nothing else says.
 *
 * `ensureDefaultBranch` is deliberately not used here: it would CREATE a branch
 * as a side effect of saving a dish, which is a surprising thing for a menu
 * form to do. Every restaurant is guaranteed one by registration and by the
 * migration, so a plain read is enough — and if somehow there is none, saying
 * so beats inventing a location.
 */
export async function defaultBranchId(restaurantId: string): Promise<string> {
  const branch = await prisma.branch.findFirst({
    where: { restaurantId, deletedAt: null },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    select: { id: true },
  })
  if (!branch) {
    throw new Error('This restaurant has no location — add one before adding dishes')
  }
  return branch.id
}
