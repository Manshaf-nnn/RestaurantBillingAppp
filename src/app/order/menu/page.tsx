import { notFound, redirect } from 'next/navigation'

import { guestPath } from '@/features/orders/guest-path'
import { orderableBranches, resolvePublicBranch } from '@/features/branches/public-branch'
import { resolvePublicTenant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'

/**
 * The old branch-less menu URL. Kept as a redirect, not a page.
 *
 * Anything still pointing here — a bookmark, a browser's back stack, a link in
 * an old email — is sent to the canonical `/order/<slug>/<branch>/menu`. Where
 * the branch cannot be established and there is more than one, it goes to the
 * chooser rather than guessing, which is what this URL used to do.
 */
export default async function LegacyMenuPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const restaurant = await resolvePublicTenant()
  if (!restaurant) notFound()

  const params = await searchParams
  const asked = typeof params.b === 'string' ? params.b.trim() : ''

  const branch = asked
    ? await resolvePublicBranch(restaurant.id, asked).catch(() => null)
    : await (async () => {
        const all = await orderableBranches(restaurant.id)
        if (all.length === 1) return all[0]
        // More than one and nothing to go on: the cookie is the only hint left,
        // and it is exactly what used to be wrong. Ask instead.
        return null
      })()

  if (!branch) redirect(`/order?r=${encodeURIComponent(restaurant.slug)}`)
  redirect(guestPath(restaurant.slug, branch.code, 'menu'))
}
