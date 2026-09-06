import type { Metadata } from 'next'

import { AutoRefresh } from '@/components/auto-refresh'
import { PageHeader, StatCard } from '@/features/dashboard/components/page-header'
import { scopeToOne, selectedBranch } from '@/features/dashboard/selected-branch'
import { ProductionWorkspace } from '@/features/production/components/production-workspace'
import { getProductionWorkspace, listProductionBranches } from '@/features/production/queries'
import { formatMoney, localeForCurrency } from '@/lib/money'
import { PERMISSIONS, can } from '@/lib/rbac'
import { requirePagePermission } from '@/server/auth/guard'
import { requireRestaurant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Kitchen Production' }

/**
 * Kitchen Production (redesignkitchenjob.md).
 *
 * Make a prepared item from stock, see what has been made, see the runs. Any
 * branch may produce; the branch switcher picks where, and the form offers a
 * choice only when this person can act at more than one location.
 */
export default async function ProductionPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const user = await requirePagePermission(PERMISSIONS.PRODUCTION_VIEW, '/dashboard/production')
  const selection = await selectedBranch(user, await searchParams)
  const scoped = scopeToOne(selection)

  const [restaurant, branches] = await Promise.all([
    requireRestaurant(user.restaurantId),
    listProductionBranches(user),
  ])
  // The switcher's choice when it names one location; otherwise this person's
  // own branch, or the first they can reach.
  const branchId =
    scoped && scoped !== '__none__' && branches.some((b) => b.id === scoped)
      ? scoped
      : branches.find((b) => b.id === user.branchId)?.id ?? branches[0]?.id ?? null

  const data = await getProductionWorkspace({
    restaurantId: user.restaurantId,
    branchId,
    timeZone: restaurant.timezone,
  })
  const money = (m: number) => formatMoney(m, restaurant.currency)
  const canManage = can(user, PERMISSIONS.PRODUCTION_MANAGE)

  return (
    <>
      <PageHeader
        title="Kitchen Production"
        description="Make prepared items — sauces, pastes, dough, prepped vegetables — out of stock. What goes in leaves the ledger; what comes out is stock, worth exactly what it took."
      />

      <div className="mb-6 grid gap-3 sm:grid-cols-3">
        <StatCard label="Runs today" value={String(data.stats.runsToday)} />
        <StatCard label="Into prepared stock today" value={money(data.stats.valueToday)} hint="Raw value moved, not cost of sales" />
        <StatCard label="Prepared items" value={String(data.stats.preparedCount)} />
      </div>

      <ProductionWorkspace
        data={data}
        branches={branches}
        branchId={branchId}
        currency={restaurant.currency}
        locale={restaurant.locale === 'en' ? localeForCurrency(restaurant.currency) : restaurant.locale}
        canManage={canManage}
      />

      <AutoRefresh scope="catalog" intervalMs={10000} />
    </>
  )
}
