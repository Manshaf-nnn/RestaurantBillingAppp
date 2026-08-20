import type { Metadata } from 'next'

import { PageHeader } from '@/features/dashboard/components/page-header'
import { DrawerConsole } from '@/features/cashdrawer/components/drawer-console'
import { getDrawerPageData } from '@/features/cashdrawer/queries'
import { PERMISSIONS, can} from '@/lib/rbac'
import { requirePagePermission } from '@/server/auth/guard'
import { requireRestaurant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Cash drawer' }

export default async function CashDrawerPage() {
  const user = await requirePagePermission(
    PERMISSIONS.CASH_DRAWER_OPERATE,
    '/dashboard/cash-drawer',
  )
  const restaurant = await requireRestaurant(user.restaurantId)

  const data = await getDrawerPageData({
    restaurantId: user.restaurantId,
    userId: user.id,
    currency: restaurant.currency,
    // A manager reconciling the day needs everyone's drawers; a cashier only
    // ever sees their own, so one till's shortfall is not floor gossip.
    canSeeAll: can(user, PERMISSIONS.CASH_DRAWER_MANAGE),
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
