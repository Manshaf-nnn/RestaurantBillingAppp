import type { Metadata } from 'next'
import { redirect } from 'next/navigation'

import { WaiterBoard, type WaiterOrder } from '@/features/waiter/components/waiter-board'
import { WaiterOrderPad } from '@/features/waiter/components/waiter-order-pad'
import { resolveWaiterTab, waiterHref } from '@/features/waiter/tabs'
import { getWaiterBoard } from '@/features/orders/queries'
import { getPublicMenu } from '@/features/menu/queries'
import { OpsShell } from '@/components/ops-shell'
import { PERMISSIONS, ROLE_LABELS, can } from '@/lib/rbac'
import { StationExit } from '@/features/dashboard/components/station-exit'
import {
  listStationBranches,
  branchNameFor,
  scopeToOne,
  selectedBranch,
} from '@/features/dashboard/selected-branch'
import { StationBranchPicker } from '@/features/dashboard/components/station-branch-picker'
import { requirePagePermission } from '@/server/auth/guard'
import { requireRestaurant } from '@/server/db/tenant'
import { localeForCurrency } from '@/lib/money'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Waiter station' }

type BoardOrder = Awaited<ReturnType<typeof getWaiterBoard>>['ready'][number]

function toWaiterOrder(order: BoardOrder): WaiterOrder {
  return {
    id: order.id,
    orderNumber: order.orderNumber,
    status: order.status as WaiterOrder['status'],
    tableNumber: order.tableNumber ?? order.table?.number ?? null,
    customerName: order.customerName,
    grandTotal: order.grandTotal,
    readyAt: order.readyAt?.toISOString() ?? null,
    placedAt: order.placedAt.toISOString(),
    items: order.items
      .filter((item) => item.status !== 'CANCELLED')
      .map((item) => ({
        id: item.id,
        name: item.name,
        quantity: item.quantity,
        isVeg: item.isVeg,
        notes: item.notes,
        status: item.status,
        preparedQty: item.preparedQty,
        servedQty: item.servedQty,
      })),
  }
}

export default async function WaiterPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const user = await requirePagePermission(PERMISSIONS.WAITER_VIEW, '/waiter')

  /*
   * Which locations this screen shows — see the note on the kitchen page. A
   * floor screen belongs to the room it is standing in.
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
  const params = await searchParams
  const selection = await selectedBranch(user, params)
  const branchId = scopeToOne(selection)

  if (!branchId) {
    const choices = await listStationBranches(user)
    if (choices.length > 1) {
      return (
        <StationBranchPicker
          title="Waiter station"
          description="Which floor is this screen for? It will show that location&rsquo;s tables and calls."
          branches={choices}
          basePath="/waiter"
        />
      )
    }
    if (choices.length === 1) redirect(`/waiter?branch=${choices[0].id}`)
  }

  const branchIds = branchId ? [branchId] : selection.branchIds

  const [restaurant, branchName, board] = await Promise.all([
    requireRestaurant(user.restaurantId),
    // correctionA.md §6 — the station says which floor it is serving.
    branchNameFor(user.restaurantId, branchId),
    getWaiterBoard(user.restaurantId, branchIds),
  ])

  const locale =
    restaurant.locale === 'en' ? localeForCurrency(restaurant.currency) : restaurant.locale

  /*
   * ── Taking an order ───────────────────────────────────────────────────────
   *
   * A separate mode, reached at `?tab=order`, rather than a fourth panel inside
   * `WaiterBoard`. The board mounts `<AutoRefresh intervalMs={3000} />`, and a
   * half-typed cart living inside a component whose server props are replaced
   * every three seconds is a bug waiting to be filed. Branching here means the
   * refresh loop is not mounted at all while somebody is taking an order.
   */
  if (resolveWaiterTab(params.tab) === 'order') {
    if (!can(user, PERMISSIONS.ORDER_CREATE)) redirect(waiterHref('board', branchId))

    const menu = await getPublicMenu(user.restaurantId, restaurant.timezone, branchId)

    return (
      <OpsShell
        title="Take an order"
        subtitle={restaurant.name}
        branch={branchName}
        branchIds={branchIds}
        user={{ name: user.name, role: ROLE_LABELS[user.role] }}
        actions={<StationExit user={user} current="/waiter" />}
      >
        <WaiterOrderPad
          menu={menu}
          currency={restaurant.currency}
          locale={locale}
          branchId={branchId}
          backHref={waiterHref('board', branchId)}
          tables={board.tables.map((table) => ({
            id: table.id,
            number: table.number,
            label: table.label,
            area: table.area,
            capacity: table.capacity,
            status: table.state,
            openOrders: table.orders.map((order) => ({
              id: order.id,
              orderNumber: order.orderNumber,
            })),
            seatedGuests: table.seatedGuests ?? null,
          }))}
        />
      </OpsShell>
    )
  }

  return (
    <WaiterBoard
      // Which locations this screen shows, so live events for another
      // branch are ignored rather than chiming here.
      branchIds={branchIds}
      restaurantName={restaurant.name}
      branchName={branchName}
      currency={restaurant.currency}
      locale={restaurant.locale === 'en' ? localeForCurrency(restaurant.currency) : restaurant.locale}
      user={{ name: user.name, role: ROLE_LABELS[user.role] }}
      exit={<StationExit user={user} current="/waiter" />}
      /*
       * The door to the order pad, and null when this person may not open it.
       * WAITER already holds ORDER_CREATE — what was missing was a screen, not
       * a permission — but a custom role built on Waiter without it must not
       * be offered a button that ends in a 403.
       */
      orderHref={can(user, PERMISSIONS.ORDER_CREATE) ? waiterHref('order', branchId) : null}
      initialReady={board.ready.map(toWaiterOrder)}
      initialServing={board.serving.map(toWaiterOrder)}
      initialRequests={board.requests.map((request) => ({
        id: request.id,
        tableNumber: request.table.number,
        type: request.type,
        note: request.note,
        createdAt: request.createdAt.toISOString(),
        status: request.status === 'ACKNOWLEDGED' ? 'ACKNOWLEDGED' : 'OPEN',
        requestedByName: request.requestedByName,
        acknowledgedAt: request.acknowledgedAt?.toISOString() ?? null,
      }))}
      initialTables={board.tables.map((table) => ({
        id: table.id,
        number: table.number,
        label: table.label,
        area: table.area,
        capacity: table.capacity,
        status: table.state,
        reservedFor: table.reservedFor,
        openOrders: table.orders.map((order) => ({
          id: order.id,
          orderNumber: order.orderNumber,
          status: order.status,
          grandTotal: order.grandTotal,
          paymentStatus: order.paymentStatus,
        })),
      }))}
    />
  )
}
