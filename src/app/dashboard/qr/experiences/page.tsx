import type { Metadata } from 'next'

import { PageHeader } from '@/features/dashboard/components/page-header'
import { scopeToOne, selectedBranch } from '@/features/dashboard/selected-branch'
import { orderableBranches } from '@/features/branches/public-branch'
import { ExperienceList } from '@/features/qr/components/experience-list'
import { listExperiences } from '@/features/qr/queries'
import { formatMoney, localeForCurrency } from '@/lib/money'
import { PERMISSIONS, can, visibleBranchIds } from '@/lib/rbac'
import { requirePagePermission } from '@/server/auth/guard'
import { printableOrigin, } from '@/lib/tenant-url'
import { requireRestaurant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'QR menus' }

/**
 * QR menus (ar.md §1, §18).
 *
 * The printed codes on `/dashboard/qr` answer "where do guests scan". These
 * answer "and what do they get when they do" — which menu, what they are
 * asked, which offers apply.
 *
 * A restaurant with none of these is a restaurant behaving exactly as it did
 * before: the ordinary `/order/<slug>/<branch>` codes are untouched by every
 * line of this feature.
 */
export default async function QrExperiencesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const user = await requirePagePermission(PERMISSIONS.QR_VIEW, '/dashboard/qr/experiences')
  const params = await searchParams
  const selection = await selectedBranch(user, params)
  const scoped = scopeToOne(selection)

  const [restaurant, branches] = await Promise.all([
    requireRestaurant(user.restaurantId),
    orderableBranches(user.restaurantId),
  ])

  const allowed = visibleBranchIds(user)
  const reachable = branches.filter((branch) => allowed === null || allowed.includes(branch.id))

  /*
   * The switcher narrows the list when it names one location; otherwise this
   * person sees every branch they can reach. A code belongs to one place, so
   * "all locations" genuinely means all of them, not the default one.
   */
  const branchIds =
    scoped && scoped !== '__none__'
      ? [scoped]
      : allowed === null
        ? null
        : allowed

  const rows = await listExperiences({ restaurantId: user.restaurantId, branchIds })
  const origin = await printableOrigin(restaurant)

  return (
    <>
      <PageHeader
        title="QR menus"
        description="What a guest sees when they scan. Create one, choose what it shows and what it asks, then print the code."
      />
      <ExperienceList
        rows={rows}
        branches={reachable.map((branch) => ({ id: branch.id, name: branch.name }))}
        origin={origin}
        currency={restaurant.currency}
        locale={restaurant.locale === 'en' ? localeForCurrency(restaurant.currency) : restaurant.locale}
        canManage={can(user, PERMISSIONS.QR_MANAGE)}
      />
    </>
  )
}
