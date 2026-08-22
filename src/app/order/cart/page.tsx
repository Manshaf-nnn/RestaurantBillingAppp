import { notFound, redirect } from 'next/navigation'

import { guestPath } from '@/features/orders/guest-path'
import { orderableBranches } from '@/features/branches/public-branch'
import { resolvePublicTenant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'

/**
 * The old branch-less cart URL. Kept as a redirect, not a page.
 *
 * See the note on the legacy menu route: anything still pointing here is sent
 * to the canonical URL, and where the branch is unknowable on a multi-branch
 * restaurant it goes to the chooser rather than quietly picking the default.
 */
export default async function LegacyCartPage() {
  const restaurant = await resolvePublicTenant()
  if (!restaurant) notFound()

  const all = await orderableBranches(restaurant.id)
  if (all.length === 1) redirect(guestPath(restaurant.slug, all[0].code, 'cart'))
  redirect(`/order?r=${encodeURIComponent(restaurant.slug)}`)
}
