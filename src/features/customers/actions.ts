'use server'

import { z } from 'zod'

import { runAction, type ActionResult } from '@/lib/action'
import { PERMISSIONS, customersAtBranch, visibleBranchIds } from '@/lib/rbac'
import { requirePermission } from '@/server/auth/guard'
import { prisma } from '@/server/db/prisma'

export interface CustomerSuggestion {
  id: string
  name: string
  phone: string
  loyaltyPoints: number
}

/**
 * Regulars, found by the phone number being typed at the till.
 *
 * ── Why it is worth having ──────────────────────────────────────────────────
 *
 * `placeOrder` keys customers on `(restaurantId, phone)` and upserts — and the
 * update branch overwrites the stored NAME with whatever the cashier typed. So
 * a customer saved as "Jonathan Perera" becomes "Jon" the first time somebody
 * is in a hurry. Filling the name from the record is not only a convenience;
 * it is what stops the record being quietly rewritten a character at a time.
 *
 * Nothing downstream changes. The order still carries a name and a phone, and
 * the upsert still resolves it to the same row, so there is no customer id to
 * thread through the POS.
 *
 * ── Why not the global search action ────────────────────────────────────────
 *
 * `globalSearchAction` already searches customers by phone and is scoped
 * correctly, but it fans out to seven `findMany` queries in one `Promise.all`
 * on every keystroke and returns links into `/dashboard`, which a cashier
 * cannot open. This is the narrow version of the same question.
 */
export async function suggestCustomersByPhone(
  input: unknown,
): Promise<ActionResult<{ matches: CustomerSuggestion[] }>> {
  return runAction(
    z.object({ term: z.string().max(20) }),
    input,
    async (data) => {
      // CASHIER and WAITER both hold this already — no role change needed.
      const user = await requirePermission(PERMISSIONS.CUSTOMER_VIEW)

      const term = data.term.trim()
      // Three, not two. A two-digit fragment matches most of the book and the
      // list would be noise.
      if (term.length < 3) return { matches: [] }

      const allowed = visibleBranchIds({ role: user.role, branchId: user.branchId })
      // `[]` is "sees nothing", which is not the same as no restriction.
      if (allowed && allowed.length === 0) return { matches: [] }

      const matches = await prisma.customer.findMany({
        where: {
          restaurantId: user.restaurantId,
          isBlocked: false,
          /*
           * The AND wrapper is load-bearing. `customersAtBranch` returns an
           * `OR` of its own, and a sibling `OR` key would silently replace it
           * — which is the difference between "regulars at this branch" and
           * "every customer in the group". `search/service.ts` carries the
           * longer version of this warning.
           */
          AND: [
            { phone: { contains: term } },
            /*
             * Every anonymous counter sale collapses into one shared row with
             * an empty phone, because the upsert key is `(restaurantId, phone)`
             * and a walk-in sends ''. Excluding it keeps that row — which holds
             * the accumulated totals of every cash sale ever rung up — out of
             * the first thing a cashier sees.
             */
            { phone: { not: '' } },
            customersAtBranch(allowed),
          ],
        },
        select: { id: true, name: true, phone: true, loyaltyPoints: true },
        orderBy: { totalOrders: 'desc' },
        take: 5,
      })

      return { matches }
    },
    // No success message: this runs on a debounce as somebody types.
  )
}
