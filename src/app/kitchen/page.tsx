import type { Metadata } from 'next'
import { redirect } from 'next/navigation'

import { KitchenBoard } from '@/features/kitchen/components/kitchen-board'
import { readPaperWidths } from '@/features/printing/paper'
import { getKitchenQueue, getKitchenStats, readOptions } from '@/features/orders/queries'
import {
  listStationBranches,
  scopeToOne,
  selectedBranch,
} from '@/features/dashboard/selected-branch'
import { StationBranchPicker } from '@/features/dashboard/components/station-branch-picker'
import { PERMISSIONS, ROLE_LABELS } from '@/lib/rbac'
import { StationExit } from '@/features/dashboard/components/station-exit'
import { requirePagePermission } from '@/server/auth/guard'
import { requireRestaurant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Kitchen display' }

export default async function KitchenPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const user = await requirePagePermission(PERMISSIONS.KITCHEN_VIEW, '/kitchen')

/*
 * Which locations this screen shows.
 *
 * A floor screen is a physical thing in a physical room: the person reading it
 * is standing at one site. It used to pass only the restaurant id, so Kandy's
 * tickets appeared on Colombo's rail.
 *
 * The branch comes from `selectedBranch`, which reads the URL then the cookie
 * and validates both against what this user may see. For kitchen, waiter and
 * cashier staff that resolves to their own branch and cannot be widened; for an
 * owner it follows the top-bar switcher, and "All locations" still shows
 * everything — which is the one case where a combined view is meaningful, since
 * the owner is not cooking.
 */

  /*
   * A station shows ONE location, always.
   *
   * `selectedBranch` returns null branchIds for an owner on "All locations",
   * and this page passed that straight into its query — so an order taken at
   * Branch 02 appeared on this rail AND on every other branch's. Reading it as
   * "the order went to both kitchens" is exactly right.
   *
   * `scopeToOne` narrows to a single branch where one is determinable: a
   * confined account gets their own and cannot widen it. Where it is not — an
   * owner who has not chosen — the screen asks rather than showing everything.
   */
  const selection = await selectedBranch(user, await searchParams)
  const branchId = scopeToOne(selection)

  if (!branchId) {
    const choices = await listStationBranches(user)
    if (choices.length > 1) {
      return (
        <StationBranchPicker
          title="Kitchen display"
          description="Which kitchen is this screen for? It will show that location&rsquo;s tickets and no others."
          branches={choices}
          basePath="/kitchen"
        />
      )
    }
    if (choices.length === 1) redirect(`/kitchen?branch=${choices[0].id}`)
  }

  const branchIds = branchId ? [branchId] : selection.branchIds


  const [restaurant, queue, stats] = await Promise.all([
    requireRestaurant(user.restaurantId),
    getKitchenQueue(user.restaurantId, branchIds),
    getKitchenStats(user.restaurantId, branchIds),
  ])

  return (
    <KitchenBoard
      restaurantName={restaurant.name}
      paperWidth={readPaperWidths(restaurant.printerConfig).kitchen}
      branchIds={branchIds}
      user={{ name: user.name, role: ROLE_LABELS[user.role] }}
      exit={<StationExit user={user} current="/kitchen" />}
      initialStats={stats}
      initialTickets={queue.map((order) => ({
        id: order.id,
        orderNumber: order.orderNumber,
        type: order.type as 'DINE_IN' | 'TAKEAWAY' | 'DELIVERY',
        status: order.status,
        tableNumber: order.tableNumber ?? order.table?.number ?? null,
        customerName: order.customerName,
        customerPhone: order.customerPhone,
        notes: order.notes,
        placedAt: order.placedAt.toISOString(),
        estimatedMinutes: order.estimatedMinutes,
        priority: order.priority as string,
        // Dishes on this ticket that no kitchen section is responsible for.
        // Empty for every restaurant that does not use sections.
        unmappedNames: order.unmappedNames,
        items: order.items
          .filter((item) => item.status !== 'CANCELLED')
          .map((item) => ({
            id: item.id,
            name: item.name,
            quantity: item.quantity,
            notes: item.notes,
            isVeg: item.isVeg,
            status: item.status,
            optionsLabel: readOptions(item.options)
              .map((option) => option.name)
              .join(' · '),
          })),
      }))}
    />
  )
}
