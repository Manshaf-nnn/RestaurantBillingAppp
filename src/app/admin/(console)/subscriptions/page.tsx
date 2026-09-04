import type { Metadata } from 'next'

import { PageHeader } from '@/features/dashboard/components/page-header'
import { OpsTable, Stat, StatRow, StatusPill } from '@/features/platform/components/ops-ui'
import { PlanControl } from '@/features/platform/components/ops-controls'
import { prisma } from '@/server/db/prisma'
import { requirePageSuperAdmin } from '@/server/auth/guard'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Subscriptions' }

/**
 * What each restaurant is on, and how long they have.
 *
 * ── The gap this closes ─────────────────────────────────────────────────────
 *
 * `SubscriptionPlan` and `trialEndsAt` have been in the schema all along, and
 * `approveRestaurant` starts every new restaurant on a 14-day trial. Nothing
 * anywhere could move a restaurant off it. So every approved restaurant reached
 * `/trial-ended` after a fortnight, where the only route onward was a `mailto:`
 * link to the operator — who had no button to press either. The platform could
 * sell a plan and had no way to grant one.
 *
 * Billing is deliberately not here. There is no payment gateway in this system
 * (production.md §2 forbids introducing one), so a plan is a record of what was
 * agreed, and money changes hands somewhere else.
 */
export default async function SubscriptionsPage() {
  await requirePageSuperAdmin('/admin/subscriptions')

  const restaurants = await prisma.restaurant.findMany({
    where: { status: { in: ['ACTIVE', 'SUSPENDED'] } },
    select: {
      id: true, name: true, slug: true, plan: true, status: true,
      trialEndsAt: true, createdAt: true,
      _count: { select: { users: true, orders: true } },
    },
    orderBy: [{ plan: 'asc' }, { name: 'asc' }],
    take: 300,
  })

  const now = Date.now()
  const expiring = restaurants.filter(
    (r) => r.plan === 'TRIAL' && r.trialEndsAt && r.trialEndsAt.getTime() > now &&
      r.trialEndsAt.getTime() - now < 7 * 86_400_000,
  )
  const expired = restaurants.filter(
    (r) => r.plan === 'TRIAL' && r.trialEndsAt && r.trialEndsAt.getTime() <= now,
  )

  const days = (date: Date | null) =>
    date ? Math.round((date.getTime() - now) / 86_400_000) : null

  return (
    <>
      <PageHeader
        title="Subscriptions"
        description="What each restaurant is on. Changing a plan takes effect immediately; billing happens elsewhere."
      />

      <StatRow>
        <Stat label="Restaurants" value={restaurants.length} />
        <Stat label="On trial" value={restaurants.filter((r) => r.plan === 'TRIAL').length} />
        <Stat
          label="Trial ending this week"
          value={expiring.length}
          tone={expiring.length > 0 ? 'warn' : 'idle'}
        />
        <Stat
          label="Trial expired"
          value={expired.length}
          tone={expired.length > 0 ? 'bad' : 'idle'}
          hint={expired.length > 0 ? 'These restaurants are locked out right now' : undefined}
        />
      </StatRow>

      <OpsTable
        title="Plans"
        columns={['Restaurant', 'Plan', 'Trial', 'Staff', 'Orders', 'Change to']}
        rows={restaurants.map((restaurant) => {
          const left = days(restaurant.trialEndsAt)
          return [
            <span key={restaurant.id}>
              {restaurant.name}
              {restaurant.status === 'SUSPENDED' ? (
                <span className="ml-2 text-xs text-red-600">suspended</span>
              ) : null}
            </span>,
            <StatusPill key={`${restaurant.id}-p`} tone={restaurant.plan === 'TRIAL' ? 'warn' : 'ok'}>
              {String(restaurant.plan).toLowerCase()}
            </StatusPill>,
            restaurant.plan !== 'TRIAL'
              ? '—'
              : left === null
                ? 'no deadline'
                : left <= 0
                  ? <span key={`${restaurant.id}-t`} className="text-red-600">expired</span>
                  : `${left} days left`,
            String(restaurant._count.users),
            restaurant._count.orders.toLocaleString(),
            <PlanControl key={`${restaurant.id}-c`} restaurantId={restaurant.id} plan={String(restaurant.plan)} />,
          ]
        })}
        empty="No active restaurants yet."
        footer="Moving a restaurant to a paid plan clears its trial deadline, so a paying customer is never sent to the trial-ended screen."
      />
    </>
  )
}
