import type { Metadata } from 'next'

import { PageHeader } from '@/features/dashboard/components/page-header'
import { DrawerConsole } from '@/features/cashdrawer/components/drawer-console'
import { getDrawerPageData } from '@/features/cashdrawer/queries'
import { PERMISSIONS, can} from '@/lib/rbac'
import { scopeToOne, selectedBranch } from '@/features/dashboard/selected-branch'
import { requirePageAnyPermission } from '@/server/auth/guard'
import { requireRestaurant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Cash drawer' }

export default async function CashDrawerPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  /*
   * Either permission opens this page, and the second one is not decoration.
   *
   * The review queue for over-threshold variances lives here, and it is the
   * one thing CASH_DRAWER_MANAGE exists for. Guarding on OPERATE alone locked a
   * role built as "reconciles the floor, never works a till" — which is what a
   * head office role looks like — out of the only screen its permission is for.
   * A SPLIT_FROM entry could not fix it either: a saved custom role's list
   * REPLACES the defaults, so an owner unticking OPERATE while leaving MANAGE
   * ticked reaches exactly that state.
   */
  const user = await requirePageAnyPermission(
    [PERMISSIONS.CASH_DRAWER_OPERATE, PERMISSIONS.CASH_DRAWER_MANAGE],
    '/dashboard/cash-drawer',
  )
  const restaurant = await requireRestaurant(user.restaurantId)

  const selection = await selectedBranch(user, await searchParams)

  const data = await getDrawerPageData({
    restaurantId: user.restaurantId,
    branchId: scopeToOne(selection),
    // The wider reach as well, so a manager viewing "all locations" still only
    // sees the ones they may reach. `[]` means confined with nowhere to look
    // and must match nothing.
    branchIds: selection.branchIds,
    userId: user.id,
    currency: restaurant.currency,
    // A manager reconciling the day needs everyone's drawers; a cashier only
    // ever sees their own, so one till's shortfall is not floor gossip.
    canSeeAll: can(user, PERMISSIONS.CASH_DRAWER_MANAGE),
    canApprovePetty: can(user, PERMISSIONS.PETTY_CASH_APPROVE),
  })

  return (
    <>
      <PageHeader
        title="Cash drawer"
        description="Open with a float, log cash in and out, and close against a physical count."
      />
      <DrawerConsole data={data} />
    </>
  )
}
