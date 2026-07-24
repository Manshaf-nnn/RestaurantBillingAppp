import { redirect } from 'next/navigation'

import { ROLE_HOME } from '@/lib/rbac'
import { getAdminUser, getCurrentUser } from '@/server/auth/session'

export const dynamic = 'force-dynamic'

/**
 * There is no marketing landing page — the app starts at the login screen.
 * Signed-in visitors are sent to the right place for their session.
 */
export default async function Home() {
  const admin = await getAdminUser()
  if (admin) redirect('/admin')

  const user = await getCurrentUser()
  if (user) redirect(ROLE_HOME[user.role])

  redirect('/login')
}
