import 'server-only'
import { cookies } from 'next/headers'

import { prisma } from '@/server/db/prisma'

/**
 * Which branch a guest is standing in.
 *
 * The guest side had no branch at all: one QR for the whole restaurant, a table
 * number typed on the landing screen, and an order saved with `branchId: null`.
 * Scanning the code taped to a table in Kandy gave you the group's menu at the
 * group's prices, and the order belonged to nowhere.
 *
 * ── How the branch is carried ───────────────────────────────────────────────
 *
 * `?b=<branch code>` in the QR, converted to a cookie by the middleware the
 * same way `?r=<slug>` already becomes the tenant cookie. The cookie matters:
 * a guest moves from the landing screen to the menu to the cart, and only the
 * first of those carries the query string.
 *
 * The **code**, not the id. It is already unique per restaurant, it is short
 * enough to print, and it does not leak a database identifier onto a laminated
 * card that will be photographed.
 *
 * ── What a wrong code does ──────────────────────────────────────────────────
 *
 * Falls back to the restaurant's default branch rather than failing. A guest
 * with a smudged QR should get a menu, not an error page — and every route
 * below re-resolves the branch from the TABLE where there is one, which is the
 * more truthful answer anyway.
 */

export const BRANCH_COOKIE = 'ros_b'

export interface PublicBranch {
  id: string
  name: string
  code: string
  isDefault: boolean
}

/**
 * Resolve a guest's branch: the explicit code, then the cookie, then the
 * restaurant's default. Never null — a restaurant always has at least one
 * location, guaranteed by registration and by the branch-isolation migration.
 */
export async function resolvePublicBranch(
  restaurantId: string,
  code?: string | null,
): Promise<PublicBranch | null> {
  const fromCookie = code ? null : (await cookies()).get(BRANCH_COOKIE)?.value ?? null
  const wanted = (code ?? fromCookie)?.trim().toUpperCase() || null

  if (wanted) {
    const match = await prisma.branch.findFirst({
      where: {
        restaurantId,
        code: wanted,
        deletedAt: null,
        isActive: true,
        // Guests order from a branch. A warehouse and a production house have
        // no dining room and no menu, so a code pointing at one is treated as
        // no code at all rather than showing an empty menu.
        type: 'BRANCH',
      },
      select: { id: true, name: true, code: true, isDefault: true },
    })
    if (match) return match
  }

  return prisma.branch.findFirst({
    where: { restaurantId, deletedAt: null, isActive: true, type: 'BRANCH' },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    select: { id: true, name: true, code: true, isDefault: true },
  })
}

/**
 * Every branch a guest could be sent to, for the QR sheet.
 *
 * Warehouses and production houses are excluded for the same reason as above —
 * there is nothing for a guest to do at one.
 */
export async function orderableBranches(restaurantId: string) {
  return prisma.branch.findMany({
    where: { restaurantId, deletedAt: null, isActive: true, type: 'BRANCH' },
    select: {
      id: true,
      name: true,
      code: true,
      isDefault: true,
      tables: {
        where: { isActive: true },
        select: { id: true, number: true, label: true },
        orderBy: [{ sortOrder: 'asc' }, { number: 'asc' }],
      },
    },
    orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
  })
}
