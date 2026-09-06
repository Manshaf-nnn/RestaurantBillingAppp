import type { Metadata } from 'next'
import { Award, Coins, Sparkles, Users } from 'lucide-react'

import { PageHeader, SectionCard, StatCard } from '@/features/dashboard/components/page-header'
import { EmptyState } from '@/components/ui/feedback'
import { LoyaltyManager } from '@/features/loyalty/components/loyalty-manager'
import { getLoyaltyOverview } from '@/features/loyalty/queries'
import { can, PERMISSIONS, visibleBranchIds } from '@/lib/rbac'
import { formatMoney, localeForCurrency } from '@/lib/money'
import { requirePagePermission } from '@/server/auth/guard'
import { requireRestaurant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Loyalty' }

export default async function LoyaltyPage() {
  const user = await requirePagePermission(PERMISSIONS.LOYALTY_VIEW, '/dashboard/loyalty')
  const [restaurant, overview] = await Promise.all([
    requireRestaurant(user.restaurantId),
    getLoyaltyOverview(user.restaurantId, visibleBranchIds(user)),
  ])

  const locale = restaurant.locale === 'en' ? localeForCurrency(restaurant.currency) : restaurant.locale
  const money = (v: number) => formatMoney(v, restaurant.currency, locale)
  // What all outstanding points would be worth if every guest redeemed them.
  const liability = overview.pointsOutstanding * restaurant.loyaltyPointValue

  return (
    <>
      <PageHeader
        title="Loyalty"
        description="Reward your regulars with points — and watch the programme grow at a glance."
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard
          label="Members collecting points"
          value={overview.members.toLocaleString()}
          icon={<Users className="size-4" />}
        />
        <StatCard
          label="Points outstanding"
          value={overview.pointsOutstanding.toLocaleString()}
          icon={<Coins className="size-4" />}
        />
        <StatCard
          label="Rewards value in play"
          value={money(liability)}
          icon={<Award className="size-4" />}
        />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-5">
        <div className="lg:col-span-3">
          <LoyaltyManager
            currency={restaurant.currency}
            canManage={can(user, PERMISSIONS.SETTINGS_MANAGE)}
            initial={{
              enabled: restaurant.loyaltyEnabled,
              earnRate: restaurant.loyaltyEarnRateX100 / 100,
              pointValue: restaurant.loyaltyPointValue / 100,
            }}
          />
        </div>

        <div className="lg:col-span-2">
          <SectionCard title="Top loyal guests">
            {overview.topMembers.length === 0 ? (
              <EmptyState
                className="border-dashed py-8"
                icon={<Sparkles />}
                title="No members yet"
                description="Points start adding up as soon as guests order with a phone number."
              />
            ) : (
              <ul className="divide-y">
                {overview.topMembers.map((m, index) => (
                  <li key={m.id} className="flex items-center gap-3 py-2.5">
                    <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-bold text-primary">
                      {index + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold">{m.name || m.phone}</p>
                      <p className="text-xs text-muted-foreground">
                        {m.totalOrders} order{m.totalOrders === 1 ? '' : 's'} · {money(m.totalSpent)} spent
                      </p>
                    </div>
                    <span className="shrink-0 text-sm font-bold tabular-nums text-primary">
                      {m.loyaltyPoints.toLocaleString()}
                      <span className="ml-1 text-[11px] font-medium text-muted-foreground">pts</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>
        </div>
      </div>
    </>
  )
}
