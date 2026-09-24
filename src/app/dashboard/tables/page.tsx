import type { Metadata } from 'next'

import { TablesManager } from '@/features/floor/components/tables-manager'
import { can, PERMISSIONS, visibleBranchIds } from '@/lib/rbac'
import { scopeToOne, selectedBranch } from '@/features/dashboard/selected-branch'
import { requirePagePermission } from '@/server/auth/guard'
import { prisma } from '@/server/db/prisma'
import { normalizeTableStatus } from '@/features/floor/table-state'
import { tableStatesFor } from '@/features/floor/table-state-server'
import { AutoRefresh } from '@/components/auto-refresh'
import { ReportFilters } from '@/features/reports/components/report-filters'
import { resolveRange, type RangePreset } from '@/features/reports/range'
import { listSwitchableLocations } from '@/features/transfers/queries'
import { listServiceRequests } from '@/features/floor/service-requests'
import { WaiterCallsHistory } from '@/features/floor/components/waiter-calls-history'
import { requireRestaurant } from '@/server/db/tenant'
import { localeForCurrency } from '@/lib/money'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Tables' }

export default async function TablesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const user = await requirePagePermission(PERMISSIONS.TABLE_VIEW, '/dashboard/tables')

  /*
   * A table stands in one building — table 4 at Kandy and table 4 at Colombo
   * are different tables — so a chosen location narrows the list, strictly.
   *
   * This used to fall back to showing tables with no branch at every location,
   * because the column was nullable and nothing wrote it, so a strict filter
   * would have shown an empty floor to a restaurant that plainly had tables.
   * Every row now has a branch and the column is NOT NULL, so the fallback is
   * not just unnecessary — it would be a lie.
   */
  const params = await searchParams
  const selection = await selectedBranch(user, params)
  const branchId = scopeToOne(selection)
  const restaurant = await requireRestaurant(user.restaurantId)

  /*
   * Waiter calls (abc.md §7) over a period, in the one vocabulary every
   * report screen uses — `?preset=`, `?from=`, `?to=` — opening on today.
   */
  const range = resolveRange({
    preset: (typeof params.preset === 'string' ? params.preset : 'TODAY') as RangePreset,
    from: typeof params.from === 'string' ? params.from : undefined,
    to: typeof params.to === 'string' ? params.to : undefined,
    timeZone: restaurant.timezone,
  })

  /*
   * The form needs to know where it is adding.
   *
   * Reading was already scoped and writing was not: the page passed the client
   * neither the selected branch nor a list of branches, so the add-table form
   * could not name one even in principle. `saveTable` then fell through
   * `resolveBranchId` to the restaurant's DEFAULT branch — which for an owner,
   * who has no home branch, is every time. Every table in this database sits at
   * its restaurant's default branch as a result, and adding one at Branch 01
   * either vanished or came back as "Table 1 already exists at this location"
   * against a floor plan that was visibly empty.
   */
  const reach = visibleBranchIds(user)
  const [tables, allBranches] = await Promise.all([
    prisma.restaurantTable.findMany({
      where: {
        restaurantId: user.restaurantId,
        isActive: true,
        ...(branchId ? { branchId } : {}),
      },
      orderBy: [{ area: 'asc' }, { sortOrder: 'asc' }, { number: 'asc' }],
      include: {
        branch: { select: { name: true } },
        /*
         * What each table is actually waiting for.
         *
         * This was `_count.orders` — a number. "Table 3 has 2 open orders" is
         * not what anybody on the floor needs to know; "table 3 is waiting on a
         * pizza and a burger, and the burger is ready" is. The kitchen has been
         * publishing per-line progress all along (`ORDER_ITEM_STATUS`); the
         * floor screen was the one board that never listened.
         *
         * Open orders only, with their lines. `servedQty` is what makes "still
         * coming" answerable per line rather than per order: half a line served
         * is a real state and the counter is already kept.
         */
        orders: {
          where: { status: { notIn: ['COMPLETED', 'CANCELLED'] } },
          orderBy: { placedAt: 'asc' },
          select: {
            id: true,
            orderNumber: true,
            status: true,
            placedAt: true,
            items: {
              orderBy: { createdAt: 'asc' },
              select: {
                id: true,
                name: true,
                quantity: true,
                servedQty: true,
                preparedQty: true,
                status: true,
              },
            },
          },
        },
      },
    }),
    // Guests sit at branches. A warehouse and a production house have no
    // dining room, so offering one as a home for a table would be offering a
    // mistake — hence the type filter rather than `listBranches`.
    prisma.branch.findMany({
      where: {
        restaurantId: user.restaurantId,
        deletedAt: null,
        isActive: true,
        type: 'BRANCH',
        ...(reach ? { id: { in: reach } } : {}),
      },
      select: { id: true, name: true },
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
    }),
  ])

  const branches = allBranches

  const [calls, locations] = await Promise.all([
    listServiceRequests({
      restaurantId: user.restaurantId,
      branchIds: branchId ? [branchId] : selection.branchIds,
      range: { start: range.from, end: range.to },
    }),
    listSwitchableLocations(user.restaurantId, reach),
  ])

  // The derived three-state value (abc.md §3): Occupied when an order is open
  // or the column says so, Reserved during a booking's window, else Empty.
  const states = await tableStatesFor(prisma, {
    restaurantId: user.restaurantId,
    branchId,
    occupiedIds: tables.filter((t) => t.orders.length > 0).map((t) => t.id),
  })

  return (
    <>
      {/*
        `catalog` watches foods, categories and stock definitions — it would
        never have noticed an order, which is now most of what this screen is
        about. `live` is the orders/items/tables token, and the interval comes
        down to match: the socket carries the change in under a second, and
        this is the fallback for the serverless path where there is no socket.
      */}
      <AutoRefresh scope="live" intervalMs={5000} />
    <ReportFilters
      preset={range.preset}
      from={range.from.toISOString().slice(0, 10)}
      to={range.to.toISOString().slice(0, 10)}
      locations={locations.map((l) => ({ id: l.id, name: l.name }))}
      branchId={branchId ?? ''}
    />
    <TablesManager
      canManage={can(user, PERMISSIONS.TABLE_MANAGE)}
      canSwap={can(user, PERMISSIONS.TABLE_SWAP)}
      canCall={can(user, PERMISSIONS.ORDER_VIEW)}
      branches={branches}
      // What the switcher is showing, so the form opens on the right location.
      // Null means "All locations", and then the form makes the owner choose.
      selectedBranchId={selection.branchId}
      /*
       * Which locations this screen is showing, so a live order from another
       * branch can be dropped on arrival. Socket rooms carry no branch
       * segment, so every board receives every event — without this the card
       * would briefly grow another site's dishes and then lose them on the
       * next render.
       */
      branchIds={branchId ? [branchId] : selection.branchIds}
      tables={tables.map((table) => ({
        id: table.id,
        number: table.number,
        label: table.label,
        area: table.area,
        capacity: table.capacity,
        status: states.get(table.id)?.state ?? normalizeTableStatus(table.status),
        reservedFor: states.get(table.id)?.reservation?.customerName ?? null,
        notes: table.notes,
        branchId: table.branchId,
        branchName: table.branch.name,
        openOrders: table.orders.length,
        orders: table.orders.map((order) => ({
          id: order.id,
          orderNumber: order.orderNumber,
          status: order.status,
          placedAt: order.placedAt.toISOString(),
          items: order.items.map((item) => ({
            id: item.id,
            name: item.name,
            quantity: item.quantity,
            servedQty: item.servedQty,
            preparedQty: item.preparedQty,
            status: item.status,
          })),
        })),
      }))}
    />
    <WaiterCallsHistory
      rows={calls}
      timeZone={restaurant.timezone}
      locale={restaurant.locale === 'en' ? localeForCurrency(restaurant.currency) : restaurant.locale}
      showBranch={branchId === null && allBranches.length > 1}
      branchNames={Object.fromEntries(allBranches.map((b) => [b.id, b.name]))}
    />
    </>
  )
}
