import { redirect } from 'next/navigation'

import { DashboardShell } from '@/features/dashboard/components/dashboard-shell'
import { appUrl } from '@/lib/env'
import { prisma } from '@/server/db/prisma'
import { requirePageUser } from '@/server/auth/guard'
import { requireRestaurant } from '@/server/db/tenant'

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const user = await requirePageUser('/dashboard')

  // Platform operators belong in the /admin console, not a tenant dashboard.
  if (user.role === 'SUPER_ADMIN') redirect('/admin')
  if (!user.restaurantId) redirect('/onboarding')

  // An owner whose tenant is still pending/suspended waits on a dedicated screen
  // (the restaurant is disabled, so requireRestaurant would 404).
  const tenant = await prisma.restaurant.findUnique({
    where: { id: user.restaurantId },
    select: { status: true, plan: true, trialEndsAt: true },
  })
  if (!tenant || tenant.status !== 'ACTIVE') redirect('/pending-approval')

  // Free trial ran out — send them to the trial-ended screen.
  const onTrial = tenant.plan === 'TRIAL' && tenant.trialEndsAt !== null
  const trialExpired = onTrial && tenant.trialEndsAt!.getTime() < Date.now()
  if (trialExpired) redirect('/trial-ended')

  const trialDaysLeft = onTrial
    ? Math.max(0, Math.ceil((tenant.trialEndsAt!.getTime() - Date.now()) / (24 * 60 * 60 * 1000)))
    : null

  const [restaurant, notifications] = await Promise.all([
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
  ])

  return (
    <DashboardShell
      restaurantName={restaurant.name}
      orderUrl={`${appUrl()}/order?r=${restaurant.slug}`}
      trialDaysLeft={trialDaysLeft}
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
