'use server'

import { z } from 'zod'

import { runSafe } from '@/lib/action'
import { PERMISSIONS } from '@/lib/rbac'
import { requirePermission } from '@/server/auth/guard'
import { costDraftLines } from '@/features/inventory/recipe-resolver'
import { scopeToOne, selectedBranch } from '@/features/dashboard/selected-branch'
import { prisma } from '@/server/db/prisma'

const UNITS = ['KG', 'GRAM', 'LITRE', 'ML', 'PIECE', 'PACK', 'BOTTLE', 'DOZEN', 'BOX'] as const

const lineSchema = z.object({
  inventoryItemId: z.string().nullable().optional(),
  subRecipeId: z.string().nullable().optional(),
  quantity: z.coerce.number(),
  unit: z.enum(UNITS),
  wastagePercent: z.coerce.number().optional(),
})

/**
 * What a set of recipe lines costs, before they are saved.
 *
 * ── Why this is on the server ───────────────────────────────────────────────
 *
 * The editor used to work this out in the browser as
 * `quantity × costPerUnit × (1 + wastage)`. That is wrong three ways and it was
 * on the pricing screen, so it was wrong every time somebody looked at it:
 *
 *   · no unit conversion — a 200 g line on a KG item priced at LKR 250/kg read
 *     as LKR 50,000 instead of LKR 50, a thousand times over;
 *   · no division by the recipe's yield;
 *   · make-ahead lines showed a dash, contributing nothing at all.
 *
 * `costDraftLines` is the same code that decides what actually leaves stock, so
 * the number on this screen and the number in the ledger cannot drift apart.
 * `previewRecipeCost` could not be reused: it takes a saved recipe id, and the
 * whole point here is that nothing has been saved yet.
 *
 * ── Which location's cost ───────────────────────────────────────────────────
 *
 * The branch on screen, so the price quoted is what making this dish would
 * actually consume HERE — the next layer off that location's shelf (FIFO.md).
 * A server action has no URL to read it from, hence the same cookie the branch
 * switcher writes. On "all locations" there is no one shelf to price against
 * and the resolver falls back to the item's blended rate, which is the right
 * answer to a question asked about no location in particular.
 */
export async function costRecipeLines(input: unknown) {
  return runSafe(async () => {
    const user = await requirePermission(PERMISSIONS.RECIPE_VIEW)

    const parsed = z
      .object({ yieldQty: z.coerce.number().optional(), lines: z.array(lineSchema).max(60) })
      .parse(input)

    const { totalCost, ingredients, problems } = await costDraftLines(prisma, {
      restaurantId: user.restaurantId,
      yieldQty: parsed.yieldQty ?? 1,
      lines: parsed.lines,
      branchId: scopeToOne(await selectedBranch(user)),
    })

    return {
      totalCost,
      problems,
      /** Per line item, so the editor can show a cost beside each row. */
      byItem: Object.fromEntries(
        ingredients.map((i) => [i.itemId, Math.round(i.quantity * i.costPerUnit)]),
      ),
    }
  })
}
