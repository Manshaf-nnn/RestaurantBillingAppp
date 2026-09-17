import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'

import { AutoRefresh } from '@/components/auto-refresh'
import { PageHeader } from '@/features/dashboard/components/page-header'
import { scopeToOne, selectedBranch } from '@/features/dashboard/selected-branch'
import { PreparedItemPage } from '@/features/production/components/prepared-item-page'
import { getPreparedItemPage, listProductionBranches } from '@/features/production/queries'
import { UNIT_LABELS } from '@/features/inventory/units'
import { localeForCurrency } from '@/lib/money'
import { PERMISSIONS, can } from '@/lib/rbac'
import { requirePagePermission } from '@/server/auth/guard'
import { requireRestaurant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Prepared item' }

/**
 * One prepared item (aO.md §5).
 *
 * Where Create lands, and where "Make More" happens afterwards. The location
 * is resolved exactly as the Kitchen Production screen resolves it — the
 * switcher's choice, else this person's own branch, else the first they can
 * reach — because a page that asked again would be the location selector the
 * spec took off the form.
 */
export default async function PreparedItemRoute({
  params,
  searchParams,
}: {
  params: Promise<{ itemId: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { itemId } = await params
  const user = await requirePagePermission(
    PERMISSIONS.PRODUCTION_VIEW,
    `/dashboard/production/items/${itemId}`,
  )

  const selection = await selectedBranch(user, await searchParams)
  const scoped = scopeToOne(selection)
  const [restaurant, branches] = await Promise.all([
    requireRestaurant(user.restaurantId),
    listProductionBranches(user),
  ])
  const fromSwitcher = Boolean(scoped && scoped !== '__none__' && branches.some((b) => b.id === scoped))
  const branchId = fromSwitcher
    ? scoped
    : branches.find((b) => b.id === user.branchId)?.id ?? branches[0]?.id ?? null

  const data = await getPreparedItemPage({ restaurantId: user.restaurantId, branchId, itemId })
  // Not this restaurant's, or not a prepared item: the same answer either way.
  if (!data) notFound()

  return (
    <>
      <Link
        href="/dashboard/production"
        className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        Kitchen Production
      </Link>

      <PageHeader
        title={data.item.name}
        description={`Prepared item · stocked in ${UNIT_LABELS[data.item.unit]}${data.branch ? ` · ${data.branch.name}` : ''}`}
      />

      <PreparedItemPage
        data={data}
        branchId={branchId}
        currency={restaurant.currency}
        locale={restaurant.locale === 'en' ? localeForCurrency(restaurant.currency) : restaurant.locale}
        canManage={can(user, PERMISSIONS.PRODUCTION_MANAGE)}
      />

      <AutoRefresh scope="catalog" intervalMs={10000} />
    </>
  )
}
