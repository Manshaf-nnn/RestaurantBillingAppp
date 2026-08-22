import { notFound } from 'next/navigation'

import { resolvePublicBranch } from '@/features/branches/public-branch'
import { resolvePublicTenant } from '@/server/db/tenant'

/**
 * One branch's ordering screens.
 *
 * Both the restaurant and the branch come from the PATH and are validated here,
 * once, for every screen below. That is the whole change: the branch used to
 * live in a query parameter that existed only on the first page, propped up by
 * a 12-hour cookie, and every internal link dropped it. When the cookie was
 * missing `resolvePublicBranch` did not fail — it quietly returned the default
 * branch, so a guest at Branch 02 was shown Main's tables, Main's menu and
 * Main's prices with nothing on screen to say so.
 *
 * A path segment cannot be dropped by a navigation, cannot expire, and cannot
 * be silently absent: a wrong one is a 404 and a missing one is a different
 * route entirely.
 */
export default async function BranchLayout({
  children,
  params,
}: {
  children: React.ReactNode
  params: Promise<{ slug: string; branch: string }>
}) {
  const { slug, branch } = await params

  const restaurant = await resolvePublicTenant(slug)
  if (!restaurant) notFound()

  /*
   * `resolvePublicBranch` throws on a code that was supplied and matched
   * nothing. Here the code is always supplied, so any failure is a 404 — a
   * mistyped or retired link should look like a page that does not exist, not
   * like the software falling over in front of a customer.
   */
  const resolved = await resolvePublicBranch(restaurant.id, branch).catch(() => null)
  if (!resolved) notFound()

  return <>{children}</>
}
