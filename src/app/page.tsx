import { redirect } from 'next/navigation'

import { guestEntryPath } from '@/features/orders/guest-path'
import { ROLE_HOME } from '@/lib/rbac'
import { getAdminUser, getCurrentUser } from '@/server/auth/session'
import { getRestaurantByDomain, requestHost } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'

/**
 * Where the bare address goes.
 *
 * There is no marketing page — the platform's own address starts at the login
 * screen, and signed-in visitors are sent to the right place for their session.
 *
 * ── A restaurant's own domain is different ──────────────────────────────────
 *
 * On `nilaza.lk`, whoever typed it is almost certainly hungry. Sending them to
 * a staff sign-in box would be the wrong answer to a question they did not ask,
 * and it is what happened before this: the root redirected to `/login` on every
 * hostname, so pointing a client's domain at the app greeted their diners with
 * an employee login.
 *
 * Staff still get their workspace, because a signed-in session is a clearer
 * statement of intent than a hostname. The order below says exactly that:
 * platform operator, then signed-in staff, then the domain's own menu, then
 * the login screen.
 */
export default async function Home() {
  const admin = await getAdminUser()
  if (admin) redirect('/admin')

  const user = await getCurrentUser()
  if (user) redirect(ROLE_HOME[user.role])

  const host = await requestHost()
  if (host) {
    const restaurant = await getRestaurantByDomain(host)
    // `/order` rather than a branch path: the entry page picks the branch, or
    // asks when there is more than one. That logic already exists and knows
    // more about branches than this page should.
    if (restaurant) redirect(guestEntryPath(restaurant.slug))
  }

  redirect('/login')
}
