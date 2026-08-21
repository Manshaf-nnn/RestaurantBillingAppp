import { redirect } from 'next/navigation'

import { DashboardShell } from '@/features/dashboard/components/dashboard-shell'
import { appUrl } from '@/lib/env'
import { prisma } from '@/server/db/prisma'
import { listSwitchableLocations } from '@/features/transfers/queries'
import { countOpenInstructions } from '@/features/instructions/service'
import { visibleBranchIds } from '@/lib/rbac'
import { requirePageUser } from '@/server/auth/guard'
import { requireRestaurant } from '@/server/db/tenant'

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const user = await requirePageUser('/dashboard')

  // Platform operators belong in the /admin console, not a tenant dashboard.
  if (user.role === 'SUPER_ADMIN') redirect('/admin')
  if (!user.restaurantId) redirect('/onboarding')

  /*
   * An owner whose tenant is pending or suspended waits on a dedicated screen.
   *
   * `isActive` is checked as well as `status`, and that is not belt-and-braces:
   * `requireRestaurant` below filters on `isActive` alone and throws
   * "Restaurant was not found" when it misses. Guarding only on `status` left a
   * tenant with status ACTIVE and isActive false passing this line and then
   * throwing four lines later — in a *layout*, so dashboard/error.tsx could not
   * catch it and every single page failed with the same reference code and no
   * message. Both columns must agree with the query that follows.
   */
  const tenant = await prisma.restaurant.findUnique({
    where: { id: user.restaurantId },
    select: { status: true, plan: true, trialEndsAt: true, isActive: true },
  })
  if (!tenant || tenant.status !== 'ACTIVE' || !tenant.isActive) redirect('/pending-approval')

  // Free trial ran out — send them to the trial-ended screen.
  const onTrial = tenant.plan === 'TRIAL' && tenant.trialEndsAt !== null
  const trialExpired = onTrial && tenant.trialEndsAt!.getTime() < Date.now()
  if (trialExpired) redirect('/trial-ended')

  const trialDaysLeft = onTrial
    ? Math.max(0, Math.ceil((tenant.trialEndsAt!.getTime() - Date.now()) / (24 * 60 * 60 * 1000)))
    : null

  const [restaurant, notifications, openTasks] = await Promise.all([
    requireRestaurant(user.restaurantId),
    prisma.notification.findMany({
      where: {
        restaurantId: user.restaurantId,
        OR: [{ userId: user.id }, { userId: null }],
      },
      orderBy: { createdAt: 'desc' },
      take: 30,
      select: { id: true, title: true, body: true, createdAt: true, readAt: true },
    }),
    countOpenInstructions({ restaurantId: user.restaurantId, user }),
  ])

  // The switcher only offers what this user is allowed to see, so a branch
  // manager cannot reach another site's figures by picking it from a menu.
  const allowedBranchIds = visibleBranchIds({ role: user.role, branchId: user.branchId })
  const locations = (await listSwitchableLocations(restaurant.id))
    .filter((l) => allowedBranchIds === null || allowedBranchIds.includes(l.id))
    .map((l) => ({ id: l.id, name: l.name, type: l.type as 'BRANCH' | 'PRODUCTION_HOUSE' | 'CENTRAL_WAREHOUSE' }))


  return (
    <DashboardShell
locations={locations}
            restaurantName={restaurant.name}
      orderUrl={`${appUrl()}/order?r=${restaurant.slug}`}
      trialDaysLeft={trialDaysLeft}
      openTasks={openTasks}
      user={{
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        permissions: user.permissions,
        avatarUrl: user.avatarUrl,
      }}
      initialNotifications={notifications.map((notification) => ({
        id: notification.id,
        title: notification.title,
        body: notification.body,
        createdAt: notification.createdAt.toISOString(),
        readAt: notification.readAt?.toISOString() ?? null,
      }))}
    >
      {children}
    </DashboardShell>
  )
}
