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
 * Recipe → check stock → production order → issue (FIFO) → complete → stock
 * (pro.b.md). Any branch may produce; the branch switcher picks where. The
 * recipe is the restaurant's — every branch sees it — and what a run makes
 * is stocked only where it was made.
 */
export default async function ProductionPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const user = await requirePagePermission(PERMISSIONS.PRODUCTION_VIEW, '/dashboard/production')
  const params = await searchParams
  const selection = await selectedBranch(user, params)
  const scoped = scopeToOne(selection)

  const [restaurant, branches] = await Promise.all([
    requireRestaurant(user.restaurantId),
    listProductionBranches(user),
  ])
  // The switcher's choice when it names one location; otherwise this person's
  // own branch, or the first they can reach. The form says which it was
  // (recorrection.md §3): a location nobody chose has to be visible as such.
  const fromSwitcher = Boolean(scoped && scoped !== '__none__' && branches.some((b) => b.id === scoped))
  const branchId = fromSwitcher
    ? scoped
    : branches.find((b) => b.id === user.branchId)?.id ?? branches[0]?.id ?? null
  const branchName = branches.find((b) => b.id === branchId)?.name ?? null
  const branchIsFallback = !fromSwitcher && branches.length > 1

  const data = await getProductionWorkspace({
    restaurantId: user.restaurantId,
    branchId,
    timeZone: restaurant.timezone,
  })
  const money = (m: number) => formatMoney(m, restaurant.currency)
  const canManage = can(user, PERMISSIONS.PRODUCTION_MANAGE)

  /*
   * "Make more" from an item's page lands on step 3 with its recipe (pro.b.md
   * §12) — another batch of the same item, never a duplicate item. `recipe`
   * opens step 1 to edit how it is made.
   */
  const makeId = typeof params.make === 'string' ? params.make : typeof params.recipe === 'string' ? params.recipe : null
  const makeItem = makeId ? data.items.find((item) => item.id === makeId) ?? null : null
  const prefill = makeItem
    ? { itemId: makeItem.id, name: makeItem.name, step: (typeof params.make === 'string' ? 3 : 1) as 1 | 3 }
    : null

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
        branchId={branchId}
        branchName={branchName}
        branchIsFallback={branchIsFallback}
        currency={restaurant.currency}
        locale={restaurant.locale === 'en' ? localeForCurrency(restaurant.currency) : restaurant.locale}
        canManage={canManage}
        prefill={prefill}
      />

      <AutoRefresh scope="catalog" intervalMs={10000} />
    </>
  )
}
