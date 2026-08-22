/**
 * Where the guest app lives, and how the branch travels with it.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 *
 * The branch used to be a query parameter that existed on the FIRST page only,
 * backed up by a 12-hour cookie. Every internal link was a bare path —
 * `router.push('/order/menu')`, `<Link href="/order/cart">`, seventeen of them
 * — so from the second screen onward the branch rested entirely on that cookie.
 * And when the cookie was missing, `resolvePublicBranch` did not fail: it
 * silently returned the restaurant's DEFAULT branch.
 *
 * So any link without `?b=` — an older printed card, a shared link, the
 * dashboard's own "Guest menu" shortcut — landed the guest on Main and said
 * nothing about it. A table number that existed only at Main was then found,
 * and the guest was told it "already has an open bill". Three rounds of fixing
 * the table LOOKUP could not help, because the lookup was never wrong.
 *
 * The branch now lives in the path, on every screen:
 *
 *     /order/<restaurant-slug>/<branch-code>
 *     /order/<restaurant-slug>/<branch-code>/menu
 *     /order/<restaurant-slug>/<branch-code>/cart
 *
 * Collision-free with no schema change: `Restaurant.slug` is globally unique
 * and `Branch.code` is unique within a restaurant. Nothing depends on a cookie
 * surviving a navigation, and a link either names its branch or is asked about.
 */

/**
 * Route segments that are NOT restaurant slugs.
 *
 * `/order/track/<id>` and `/order/bill/<id>` are static routes that sit at the
 * same depth as `/order/<slug>/<branch>`. Next resolves static segments first,
 * so a restaurant slugged `track` would be permanently shadowed by the tracking
 * page. Reserved at registration instead of discovered in production.
 */
export const RESERVED_SLUGS = ['track', 'bill', 'menu', 'cart'] as const

/** A branch code that can survive a URL and the middleware's own validator. */
export const BRANCH_CODE_PATTERN = /^[A-Za-z0-9-]{1,12}$/

/**
 * The canonical link for a guest at one branch.
 *
 * `rest` are further segments — `'menu'`, `'cart'`. Everything is encoded even
 * though slugs and codes are constrained to safe characters, because the cost
 * is nothing and the failure mode of getting it wrong is a broken QR card.
 */
export function guestPath(
  slug: string,
  branchCode: string,
  ...rest: string[]
): string {
  const tail = rest.length ? `/${rest.map(encodeURIComponent).join('/')}` : ''
  return `/order/${encodeURIComponent(slug)}/${encodeURIComponent(branchCode)}${tail}`
}

/**
 * The entry link for a restaurant when the branch is not known yet.
 *
 * On a single-site restaurant this goes straight to the menu. On a chain it
 * reaches the "which branch are you at?" screen — which is the whole point:
 * never guess, because guessing is what sent three months of orders to Main.
 */
export function guestEntryPath(slug: string): string {
  return `/order?r=${encodeURIComponent(slug)}`
}
