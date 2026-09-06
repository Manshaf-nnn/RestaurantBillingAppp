import type { Metadata } from 'next'
import { redirect } from 'next/navigation'

import { AutoRefresh } from '@/components/auto-refresh'
import { PageHeader } from '@/features/dashboard/components/page-header'
import { StationBranchPicker } from '@/features/dashboard/components/station-branch-picker'
import {
  listStationBranches,
  scopeToOne,
  selectedBranch,
} from '@/features/dashboard/selected-branch'
import { LiveBoard } from '@/features/live/components/live-board'
import { getLiveBoardPolicy } from '@/features/live/policy'
import { getLiveBoard } from '@/features/live/queries'
import { getKitchenStats } from '@/features/orders/queries'
import { PERMISSIONS, can } from '@/lib/rbac'
import { requirePagePermission } from '@/server/auth/guard'
import { prisma } from '@/server/db/prisma'
import { requireRestaurant } from '@/server/db/tenant'
import { localeForCurrency } from '@/lib/money'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Live floor' }

/**
 * The floor, as it is right now.
 *
 * ── What this page does, and what it deliberately does not ──────────────────
 *
 * It fetches. Every figure that depends on the clock — waiting times, bands,
 * which tables are delayed, which need somebody — is worked out in the browser
 * by `<LiveBoard>` from one shared clock ticking once a second. A server that
 * decided those would leave a badge frozen for ten seconds while the digits
 * beside it counted on.
 *
 * ── One floor at a time ─────────────────────────────────────────────────────
 *
 * Table numbers restart per branch, so an "all locations" board would show two
 * "Table 4"s with nothing to tell them apart. An owner picks; a manager
 * confined to one site never sees the question.
 *
 * ── How it stays live without a websocket ───────────────────────────────────
 *
 * Realtime push is off in production, so `<AutoRefresh scope="live">` polls a
 * small change-token and re-renders only when something has actually happened.
 * Ten seconds is the worst case for a real change reaching the screen; the
 * counters move every second regardless, because they count locally.
 */
export default async function LiveFloorPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const user = await requirePagePermission(PERMISSIONS.DASHBOARD_LIVE, '/dashboard/live')
  const restaurant = await requireRestaurant(user.restaurantId)

  const selection = await selectedBranch(user, await searchParams)
  const branchId = scopeToOne(selection)

  if (!branchId || branchId === '__none__') {
    const choices = await listStationBranches(user)
    if (choices.length > 1) {
      return (
        <StationBranchPicker
          title="Live floor"
          description="Which floor are you watching? Table numbers start again at each location."
          branches={choices}
          basePath="/dashboard/live"
        />
      )
    }
    if (choices.length === 1) redirect(`/dashboard/live?branch=${choices[0].id}`)

    return (
      <>
        <PageHeader
          title="Live floor"
          description="Tables, waiting times and who is sitting at them."
        />
        <p className="rounded-xl border border-border p-6 text-center text-sm text-muted-foreground">
          You are not assigned to a location, so there is no floor to show.
        </p>
      </>
    )
  }

  const [branch, board, policy, kitchen] = await Promise.all([
    prisma.branch.findFirst({
      where: { id: branchId, restaurantId: user.restaurantId, deletedAt: null },
      select: { name: true },
    }),
    getLiveBoard({ restaurantId: user.restaurantId, branchId }),
    getLiveBoardPolicy(user.restaurantId),
    /*
     * `[branchId]`, never `null` — `getKitchenStats` reads a null branch list as
     * "every location", which would put the whole chain's kitchen beside one
     * restaurant's floor.
     */
    getKitchenStats(user.restaurantId, [branchId]),
  ])

  return (
    <>
      <AutoRefresh scope="live" intervalMs={10000} />
      <PageHeader
        title="Live floor"
        description={`${branch?.name ?? 'This location'} — updates by itself; the counters tick every second.`}
      />
      <LiveBoard
        orders={board.orders}
        history={board.history}
        calls={board.calls}
        floor={board.tables}
        avgCookMinutes={kitchen.averageCookMinutes}
        policy={policy}
        currency={restaurant.currency}
        locale={restaurant.locale === 'en' ? localeForCurrency(restaurant.currency) : restaurant.locale}
        timeZone={restaurant.timezone}
        branchName={branch?.name ?? 'this location'}
        /*
         * Names and visit history are customer data, so they answer to the
         * customer permission rather than to this screen's. A shift lead can
         * watch the floor without being handed the guest book.
         */
        canSeeCustomers={can(user, PERMISSIONS.CUSTOMER_VIEW)}
      />
    </>
  )
}
