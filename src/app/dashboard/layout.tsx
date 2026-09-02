import { redirect } from 'next/navigation'

import { DashboardShell } from '@/features/dashboard/components/dashboard-shell'
import { appUrl } from '@/lib/env'
import { prisma } from '@/server/db/prisma'
import { listSwitchableLocations } from '@/features/transfers/queries'
import { countOpenInstructions } from '@/features/instructions/service'
import { requireCashierSession } from '@/features/cashdrawer/gate'
import { visibleBranchIds } from '@/lib/rbac'
import { requirePageUser } from '@/server/auth/guard'
import { requireRestaurant } from '@/server/db/tenant'

/**
 * Which notification audiences a role belongs to. Management hears
 * everything staff-side — a manager IS the escalation path — while floor
 * roles hear their own room plus what was addressed to nobody in particular.
 */
function audiencesFor(role: string): Array<'KITCHEN' | 'WAITER' | 'CASHIER' | 'MANAGEMENT'> {
  switch (role) {
    case 'KITCHEN':
      return ['KITCHEN']
    case 'WAITER':
      return ['WAITER']
    case 'CASHIER':
      return ['CASHIER']
    default:
      return ['KITCHEN', 'WAITER', 'CASHIER', 'MANAGEMENT']
  }
}

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

  /*
   * A till operator opens their drawer before they get the dashboard.
   *
   * Here rather than on each page, because CASHIER is on the `/dashboard`
   * allow-list in the middleware and typing the URL has always worked — a gate
   * that only covered `/cashier` would be a gate with a door beside it.
   *
   * `/dashboard` rather than the page they asked for: a layout cannot read the
   * pathname, and guessing wrong would land them somewhere they did not choose.
   * Managers, owners and admins hold CASH_DRAWER_MANAGE and pass straight
   * through — see `gate.ts` for why that is the line.
   */
  await requireCashierSession(
    { ...user, restaurantId: user.restaurantId },
    '/dashboard',
  )

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
          /*
           * WHO it is for, at last enforced on read. `audience` has been
           * written on every notification since the column existed and
           * checked by nothing — a waiter's bell carried the cash-variance
           * reviews and low-stock warnings addressed to management. Null
           * stays audible to everyone: it means the sender named nobody.
           */
          {
            OR: [
              { audience: null },
              { audience: { in: audiencesFor(user.role) } },
            ],
          },
        ],
      },
      orderBy: { createdAt: 'desc' },
      take: 30,
      select: { id: true, title: true, body: true, createdAt: true, readAt: true, data: true },
    }),
    countOpenInstructions({ restaurantId: user.restaurantId, user }),
    // In the same batch, not after it. This was awaited on its own line, adding
    // a fourth serial round trip to a layout that runs on every refresh.
    // Narrowed in the query now, not by a `.filter` afterwards.
    listSwitchableLocations(user.restaurantId, reach),
  ])

  const locations = allLocations
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
      /*
       * `reach === null` is the definition of "sees every location", and it is
       * what decides whether the switcher offers a "Main admin" row at all.
       * For anybody else that row would be a second name for the one location
       * they already have.
       */
      seesEverything={reach === null}
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
        rolePermissions: user.rolePermissions,
        avatarUrl: user.avatarUrl,
      }}
      initialNotifications={notifications.map((notification) => ({
        id: notification.id,
        title: notification.title,
        body: notification.body,
        createdAt: notification.createdAt.toISOString(),
        readAt: notification.readAt?.toISOString() ?? null,
        /*
         * Where this notification points. Every producer has been writing an
         * href into `data` since the day it shipped — the bell just never read
         * it, so "Stock requested: TR-0012" was a sentence with no way to the
         * transfer it named.
         */
        href:
          typeof (notification.data as { href?: unknown } | null)?.href === 'string'
            ? ((notification.data as { href: string }).href)
            : null,
      }))}
    >
      {children}
    </DashboardShell>
  )
}
