import type { Metadata } from 'next'

import { PageHeader } from '@/features/dashboard/components/page-header'
import { DrawerConsole } from '@/features/cashdrawer/components/drawer-console'
import { getDrawerPageData } from '@/features/cashdrawer/queries'
import { flagForgottenDrawers } from '@/features/cashdrawer/service'
import Link from 'next/link'

import { getApprovalPolicy } from '@/features/approvals/service'
import { PettyCashConsole } from '@/features/pettycash/components/petty-cash-console'
import { getPettyCashPageData } from '@/features/pettycash/queries'
import { resolveRange } from '@/features/reports/range'
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

  /*
   * The forgotten-drawer check runs here, on read, because this deployment has
   * no scheduler — see the function's own comment. Awaited (it is one indexed
   * query when nothing is forgotten) so the bell the layout already rendered
   * this request reflects it next load; failure is swallowed because a broken
   * notification must never cost anybody the drawer screen.
   */
  if (can(user, PERMISSIONS.CASH_DRAWER_MANAGE)) {
    await flagForgottenDrawers({
      restaurantId: user.restaurantId,
      timezone: restaurant.timezone,
    }).catch(() => {})
  }

  const data = await getDrawerPageData({
    restaurantId: user.restaurantId,
    branchId: scopeToOne(selection),
    // The wider reach as well, so a manager viewing "all locations" still only
    // sees the ones they may reach. `[]` means confined with nowhere to look
    // and must match nothing.
    branchIds: selection.branchIds,
    userId: user.id,
    currency: restaurant.currency,
    canReview: can(user, PERMISSIONS.CASH_VARIANCE_REVIEW),
    // A manager reconciling the day needs everyone's drawers; a cashier only
    // ever sees their own, so one till's shortfall is not floor gossip.
    canSeeAll: can(user, PERMISSIONS.CASH_DRAWER_MANAGE),
    canApprovePetty: can(user, PERMISSIONS.PETTY_CASH_APPROVE),
  })

  /*
   * Petty cash lives HERE now, not in the sidebar.
   *
   * The tin's whole existence is a field on the drawer row — its opening
   * balance is typed into the drawer's open form, and it is paid out of the
   * drawer or its own float. Two sidebar entries for one till's worth of cash
   * meant learning where the boundary ran; one screen means the money that
   * lives in the drawer is managed at the drawer. The old page remains as a
   * deep link with date filters, for going back through history.
   */
  const canSeePetty = can(user, PERMISSIONS.PETTY_CASH_VIEW)
  // The restaurant's own month, not the server's — the same range every report
  // screen uses.
  const thisMonth = resolveRange({ preset: 'THIS_MONTH', timeZone: restaurant.timezone })
  const pettyData = canSeePetty
    ? await getPettyCashPageData({
        restaurantId: user.restaurantId,
        userId: user.id,
        currency: restaurant.currency,
        approvalThreshold: (await getApprovalPolicy(user.restaurantId)).pettyCashApprovalAbove,
        canRequest: can(user, PERMISSIONS.PETTY_CASH_REQUEST),
        canApprove: can(user, PERMISSIONS.PETTY_CASH_APPROVE),
        branchId: scopeToOne(selection),
        branchIds: selection.branchIds,
        status: null,
        from: thisMonth.from,
        to: thisMonth.to,
      })
    : null

  return (
    <>
      <PageHeader
        title="Cash drawer"
        description="Open with a float, log cash in and out, and close against a physical count."
      />
      <DrawerConsole data={data} />

      {pettyData ? (
        <div className="mt-8 space-y-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <div>
              <h2 className="text-lg font-semibold tracking-tight">Petty cash</h2>
              <p className="text-sm text-muted-foreground">
                The small-expenses tin — raise, approve and pay from right here. Showing this
                month.
              </p>
            </div>
            <Link
              href="/dashboard/petty-cash"
              className="text-sm text-primary hover:underline"
            >
              Full history &amp; filters →
            </Link>
          </div>
          <PettyCashConsole data={pettyData} />
        </div>
      ) : null}
    </>
  )
}
