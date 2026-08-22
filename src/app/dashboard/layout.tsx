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

  // Computed before the queries, because the notification filter below needs
  // it too. The switcher only offers what this user is allowed to see, so a
  // branch manager cannot reach another site's figures by picking it from a
  // menu.
  const reach = visibleBranchIds({ role: user.role, branchId: user.branchId })

  const [restaurant, notifications, openTasks, allLocations] = await Promise.all([
    requireRestaurant(user.restaurantId),
    prisma.notification.findMany({
      where: {
        restaurantId: user.restaurantId,
        /*
         * Two independent conditions, so they go in an AND rather than
         * competing for the same `OR` key: who it is for, and where it is
         * about.
         *
         * A null branch is included deliberately — it marks a business-wide
         * announcement, and the whole point of keeping that column nullable is
         * that "everyone" stays sayable. What is excluded is another branch's
         * operational noise, which is what used to fill this bell.
         */
        AND: [
          { OR: [{ userId: user.id }, { userId: null }] },
          ...(reach ? [{ OR: [{ branchId: null }, { branchId: { in: reach } }] }] : []),
        ],
      },
      orderBy: { createdAt: 'desc' },
      take: 30,
      select: { id: true, title: true, body: true, createdAt: true, readAt: true },
    }),
    countOpenInstructions({ restaurantId: user.restaurantId, user }),
    // In the same batch, not after it. This was awaited on its own line, adding
    // a fourth serial round trip to a layout that runs on every refresh.
    listSwitchableLocations(user.restaurantId),
  ])

  const allowedBranchIds = reach
  const locations = allLocations
    .filter((l) => allowedBranchIds === null || allowedBranchIds.includes(l.id))
    .map((l) => ({
      id: l.id,
      name: l.name,
      type: l.type as 'BRANCH' | 'PRODUCTION_HOUSE' | 'CENTRAL_WAREHOUSE',
      managerName: l.managerName,
      staffCount: l.staffCount,
    }))


  return (
    <DashboardShell
locations={locations}
            restaurantName={restaurant.name}
      /*
       * Deliberately branch-less, and safe now.
       *
       * This "Guest menu" shortcut has no branch in it, and until now that
       * meant it silently opened the DEFAULT location — pinning the owner's
       * `ros_b` cookie to Main for twelve hours and making every subsequent
       * scan of another branch's card behave as though it were Main. It is the
       * likeliest way this bug was being reproduced.
       *
       * `/order` is a branch chooser now: one location goes straight through,
       * more than one asks. So this link can stay honest about not knowing.
       */
      orderUrl={`${appUrl()}/order?r=${restaurant.slug}`}
      trialDaysLeft={trialDaysLeft}
      // An empty allow-list means "confined, with nowhere to look" — the one
      // case where a blank dashboard is correct and needs saying out loud.
      unassignedToLocation={reach !== null && reach.length === 0}
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
