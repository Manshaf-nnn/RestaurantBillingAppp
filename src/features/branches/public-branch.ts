import 'server-only'
import { cookies } from 'next/headers'

import { NotFoundError } from '@/lib/errors'
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
  /*
   * "Supplied" means supplied — not "supplied and non-blank".
   *
   * This was `const wanted = (code ?? fromCookie)?.trim().toUpperCase() || null`,
   * and that `|| null` quietly undid the guarantee two paragraphs below. A
   * `?b=` with an empty value, or one that trimmed to nothing, collapsed to
   * `null` and skipped the refusal entirely — falling through to the DEFAULT
   * branch while looking, to every caller, exactly like "no code given".
   *
   * The checkout could reach it too: the cart sends `branchCode ?? ''`, and the
   * schema permits the empty string. So a guest whose cart had lost its branch
   * was priced at Main's prices with no error at any layer.
   *
   * Asked-and-blank is now asked-and-wrong, which is what it is.
   */
  const asked = typeof code === 'string'
  const supplied = asked ? code.trim().toUpperCase() : null
  const fromCookie = asked ? null : (await cookies()).get(BRANCH_COOKIE)?.value?.trim().toUpperCase() || null
  const wanted = supplied || fromCookie

  if (asked && !supplied) {
    throw new NotFoundError('That code does not match a location here')
  }

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

    /*
     * A code that was SUPPLIED and matched nothing is an error, not a shrug.
     *
     * Everything used to fall through to the default branch, so `?b=GARBAGE`
     * served Main's menu at Main's prices to someone who believed they were
     * looking at Kandy's — and an attacker probing codes got a 200 either way,
     * which is what made the enumeration silent.
     *
     * Only an EXPLICIT code is refused. No code at all still falls through
     * below: that is the smudged-QR and the single-site case, and a guest with
     * a damaged sticker should get a menu rather than an error page.
     */
    if (asked) {
      throw new NotFoundError('That code does not match a location here')
    }
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
      // Shown on the "which branch are you at?" screen, where two locations of
      // the same chain are otherwise told apart only by name.
      address: true,
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
