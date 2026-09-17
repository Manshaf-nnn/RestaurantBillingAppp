import type { Metadata } from 'next'

import { PageHeader } from '@/features/dashboard/components/page-header'
import { OrdersTable } from '@/features/orders/components/orders-table'
import { ORDER_LIST_MAX_ROWS, listOrders } from '@/features/orders/queries'
import { ReportFilters } from '@/features/reports/components/report-filters'
import { resolveRange, type RangePreset } from '@/features/reports/range'
import { listSwitchableLocations } from '@/features/transfers/queries'
import { PERMISSIONS, can, visibleBranchIds } from '@/lib/rbac'
import { scopeToOne, selectedBranch } from '@/features/dashboard/selected-branch'
import { requirePagePermission } from '@/server/auth/guard'
import { requireRestaurant } from '@/server/db/tenant'
import { localeForCurrency } from '@/lib/money'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Orders' }

/**
 * Rows per page, as the reader asked for it (aO.md §6).
 *
 * Any whole number from one up, clamped to the list's ceiling; anything that
 * is not a number — including the old 'ALL', which a bookmark may still
 * carry — falls back to fifty. The clamp is here as well as in the query
 * because a hand-typed address is not a screen.
 */
function readPerPage(raw: string | undefined): number {
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 1) return 50
  return Math.min(ORDER_LIST_MAX_ROWS, Math.trunc(parsed))
}

export default async function OrdersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const user = await requirePagePermission(PERMISSIONS.ORDER_VIEW, '/dashboard/orders')
  const params = await searchParams
  const restaurant = await requireRestaurant(user.restaurantId)
  const selection = await selectedBranch(user, params)
  const branchId = scopeToOne(selection)

  /*
   * A period (abc.md §1), in the one vocabulary every report screen uses —
   * `?preset=`, `?from=`, `?to=` — in the restaurant's own timezone. The
   * list opens on Today: what is on the floor now is what the office asks
   * about most; last month is one click away.
   */
  const range = resolveRange({
    preset: (params.preset ?? 'TODAY') as RangePreset,
    from: params.from,
    to: params.to,
    timeZone: restaurant.timezone,
  })
  const perPage = readPerPage(params.perPage)

  const [result, locations] = await Promise.all([
    listOrders(user.restaurantId, {
      branchId,
      search: params.search,
      status: params.status ?? 'ALL',
      paymentStatus: params.paymentStatus ?? 'ALL',
      type: params.type ?? 'ALL',
      channel: params.channel ?? 'ALL',
      from: range.from.toISOString(),
      to: range.to.toISOString(),
      page: params.page ? Number(params.page) : 1,
      perPage,
    }),
    listSwitchableLocations(user.restaurantId, visibleBranchIds(user)),
  ])

  const locale = restaurant.locale === 'en' ? localeForCurrency(restaurant.currency) : restaurant.locale

  return (
    <>
      <PageHeader title="Orders" description={`${result.total} orders · ${range.label}`} />
      <ReportFilters
        preset={range.preset}
        from={range.from.toISOString().slice(0, 10)}
        to={range.to.toISOString().slice(0, 10)}
        locations={locations.map((l) => ({ id: l.id, name: l.name }))}
        branchId={branchId ?? ''}
      />
      <OrdersTable
        branchIds={selection.branchIds}
        currency={restaurant.currency}
        locale={locale}
        // Times read in the restaurant's own clock, not the server's or the
        // viewer's — which is also what stops the hydration mismatch.
        timeZone={restaurant.timezone}
        total={result.total}
        page={result.page}
        pageCount={result.pageCount}
        perPage={perPage}
        totals={result.totals}
        range={{ from: range.from.toISOString(), to: range.to.toISOString() }}
        canCollect={can(user, PERMISSIONS.PAYMENT_COLLECT)}
        filters={{
          search: params.search ?? '',
          status: params.status ?? 'ALL',
          paymentStatus: params.paymentStatus ?? 'ALL',
          type: params.type ?? 'ALL',
          channel: params.channel ?? 'ALL',
        }}
        orders={result.orders.map((order) => ({
          id: order.id,
          orderNumber: order.orderNumber,
          status: order.status,
          paymentStatus: order.paymentStatus,
          type: order.type,
          channel: order.channel,
          tableNumber: order.tableNumber ?? order.table?.number ?? null,
          customerName: order.customerName,
          customerPhone: order.customerPhone,
          itemCount: order.items.reduce((total, item) => total + item.quantity, 0),
          grandTotal: order.grandTotal,
          tipAmount: order.tipAmount,
          paidTotal: order.paidTotal,
          placedAt: order.placedAt.toISOString(),
        }))}
      />
    </>
  )
}
