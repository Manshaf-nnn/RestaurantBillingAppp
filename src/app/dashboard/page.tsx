import Link from 'next/link'
import type { Metadata } from 'next'
import {
  AlertTriangle,
  ArrowRight,
  ClipboardList,
  LayoutGrid,
  Package,
  Receipt,
  ShoppingBag,
  Store,
  Truck,
  TrendingUp,
  Users,
  Wallet,
} from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/feedback'
import {
  CategoryShareChart,
  PaymentMixChart,
  RevenueTrendChart,
} from '@/features/analytics/components/charts'
import {
  getCachedCategoryBreakdown,
  getCachedPaymentMix,
  getCachedPopularItems,
  getCachedRevenueSeries,
  getDashboardStats,
} from '@/features/analytics/queries'
import { getFloorSummary } from '@/features/analytics/floor-summary'
import { getPurchaseSummary } from '@/features/analytics/purchase-summary'
import { comparisonLabel, describeRange, resolveRange } from '@/features/reports/range'
import { PageHeader, SectionCard, StatCard } from '@/features/dashboard/components/page-header'
import { PeriodPicker } from '@/features/dashboard/components/period-picker'
import { LiveOrderFeed } from '@/features/dashboard/components/live-order-feed'
import { formatMoney } from '@/lib/money'
import { can, PERMISSIONS } from '@/lib/rbac'
import { scopeToOne, selectedBranch } from '@/features/dashboard/selected-branch'
import { requirePagePermission } from '@/server/auth/guard'
import { prisma } from '@/server/db/prisma'
import { requireRestaurant } from '@/server/db/tenant'
import { flagForgottenDrawers } from '@/features/cashdrawer/service'
import { AutoRefresh } from '@/components/auto-refresh'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Dashboard' }

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const user = await requirePagePermission(PERMISSIONS.DASHBOARD_VIEW, '/dashboard')

  /*
   * One switcher for the whole app, in the top bar, read here through the shared
   * helper. This page used to carry a second dropdown of its own whose only
   * effect was to change its own value — every figure below it was
   * restaurant-wide. Two controls that disagree is worse than one that works.
   */
  const params = await searchParams
  const selection = await selectedBranch(user, params)
  const branchId = scopeToOne(selection)
  const restaurant = await requireRestaurant(user.restaurantId)

  /*
   * A drawer nobody closed yesterday raises its notification the moment a
   * manager looks at anything — and the home dashboard is the screen every
   * morning starts on. Deduplicated inside, so this costs one indexed query
   * when there is nothing to say.
   */
  if (can(user, PERMISSIONS.CASH_DRAWER_MANAGE)) {
    await flagForgottenDrawers({
      restaurantId: user.restaurantId,
      timezone: restaurant.timezone,
    }).catch(() => {})
  }
  const locale = restaurant.locale === 'en' ? 'en-IN' : restaurant.locale

  /*
   * One period for the whole page, resolved once, in the restaurant's own
   * timezone.
   *
   * Every card below used to carry its own hardcoded window — 14 days on the
   * trend, 30 on three others, today on the hero row, none at all on the feed —
   * so the page answered four questions at once and let you change none of
   * them. They now all read this.
   *
   * `?preset=&from=&to=`, the same parameters the reports use, so the dashboard
   * adds no fifth convention for the same idea.
   */
  const str = (k: string) => (typeof params[k] === 'string' ? (params[k] as string) : '')
  const range = resolveRange({
    preset: str('preset') || 'TODAY',
    from: str('from'),
    to: str('to'),
    timeZone: restaurant.timezone,
  })
  const periodLabel = describeRange(range, locale)
  const versus = comparisonLabel(range)
  const branchIds = selection.branchIds

  // Name the location in the greeting, so nobody reads one branch's takings as
  // the whole group's.
  const branch = selection.branchId
    ? await prisma.branch.findFirst({
        where: { id: selection.branchId, restaurantId: user.restaurantId },
        select: { name: true },
      })
    : null

  // Smart alert: orders still not ready after 20 minutes.
  const waitCutoff = new Date(Date.now() - 20 * 60 * 1000)

  const [
    stats,
    series,
    popular,
    categories,
    paymentMix,
    purchases,
    floor,
    recentOrders,
    longWaiting,
  ] = await Promise.all([
    getDashboardStats({ restaurantId: user.restaurantId, range, branchIds }),
    getCachedRevenueSeries({ restaurantId: user.restaurantId, range, branchIds }),
    getCachedPopularItems({ restaurantId: user.restaurantId, range, limit: 6, branchIds }),
    getCachedCategoryBreakdown({ restaurantId: user.restaurantId, range, branchIds }),
    getCachedPaymentMix({ restaurantId: user.restaurantId, range, branchIds }),
    getPurchaseSummary({ restaurantId: user.restaurantId, range, branchIds }),
    getFloorSummary({ restaurantId: user.restaurantId, range, branchIds }),
    prisma.order.findMany({
      where: { restaurantId: user.restaurantId, ...(branchId ? { branchId } : {}) },
      orderBy: { placedAt: 'desc' },
      take: 8,
      include: { table: { select: { number: true } }, items: { select: { quantity: true } } },
    }),
    prisma.order.count({
      where: {
        restaurantId: user.restaurantId,
        ...(branchId ? { branchId } : {}),
        status: { in: ['PENDING', 'ACCEPTED', 'PREPARING'] },
        placedAt: { lt: waitCutoff },
      },
    }),
  ])

  const money = (value: number) => formatMoney(value, restaurant.currency, locale)

  return (
    <>
      <AutoRefresh intervalMs={10000} />
      <PageHeader
        title={`Good ${greeting()}, ${user.name.split(' ')[0]}`}
        description={`${branch ? branch.name : restaurant.name} · ${periodLabel}`}
        actions={
          <>
            {/*
              Names the location on the page itself, not only in the top bar.
              The complaint that started this was "I picked another branch and
              it still shows the main one" — so when a branch IS selected, the
              screen should say so somewhere the eye lands, and every figure
              below this line is that branch's.
            */}
            {branch ? (
              <Badge variant="secondary" className="mr-1">
                <Store className="mr-1 h-3 w-3" />
                {branch.name}
              </Badge>
            ) : null}
            <Button variant="outline" asChild>
              <Link href="/dashboard/reports">
                <TrendingUp /> Reports
              </Link>
            </Button>
            <Button asChild>
              <Link href="/dashboard/orders">
                <ClipboardList /> All orders
              </Link>
            </Button>
          </>
        }
      />

      {/*
        The period control sits above everything it governs, so the scope of
        the page is read before the numbers are. Every card below it moves
        together — the alerts and the live feed excepted, which are about this
        minute and say so.
      */}
      <div className="mb-5">
        <PeriodPicker
          preset={range.preset}
          from={str('from')}
          to={str('to')}
          label={periodLabel}
        />
      </div>

      {/* ── smart alerts ────────────────────────────────────────── */}
      {stats.lowStockCount > 0 || stats.unpaidTotal > 0 || longWaiting > 0 ? (
        <div className="mb-5 grid gap-3 sm:grid-cols-2">
          {longWaiting > 0 ? (
            <Link
              href="/kitchen"
              className="flex items-center gap-3 rounded-xl border border-destructive/40 bg-destructive/5 px-4 py-3 transition-colors hover:bg-destructive/10"
            >
              <AlertTriangle className="size-5 shrink-0 text-destructive" />
              <span className="min-w-0 flex-1 text-sm">
                <strong>{longWaiting}</strong> order{longWaiting === 1 ? ' has' : 's have'} been waiting
                over 20 minutes — check the kitchen.
              </span>
              <ArrowRight className="size-4 shrink-0 text-muted-foreground" />
            </Link>
          ) : null}

          {stats.lowStockCount > 0 ? (
            <Link
              href="/dashboard/inventory"
              className="flex items-center gap-3 rounded-xl border border-warning/40 bg-warning/5 px-4 py-3 transition-colors hover:bg-warning/10"
            >
              <AlertTriangle className="size-5 shrink-0 text-warning" />
              <span className="min-w-0 flex-1 text-sm">
                <strong>{stats.lowStockCount}</strong> ingredient
                {stats.lowStockCount === 1 ? ' is' : 's are'} at or below the reorder level.
              </span>
              <ArrowRight className="size-4 shrink-0 text-muted-foreground" />
            </Link>
          ) : null}

          {stats.unpaidTotal > 0 ? (
            <Link
              href="/cashier"
              className="flex items-center gap-3 rounded-xl border border-primary/30 bg-primary/5 px-4 py-3 transition-colors hover:bg-primary/10"
            >
              <Receipt className="size-5 shrink-0 text-primary" />
              <span className="min-w-0 flex-1 text-sm">
                <strong>{money(stats.unpaidTotal)}</strong> outstanding across open bills.
              </span>
              <ArrowRight className="size-4 shrink-0 text-muted-foreground" />
            </Link>
          ) : null}
        </div>
      ) : null}

      {/* ── headline stats ──────────────────────────────────────── */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label={range.preset === 'TODAY' ? 'Net sales today' : 'Net sales'}
          value={money(stats.revenue)}
          change={stats.revenueChange}
          hint={`collected ${money(stats.collected)} · ${versus}`}
          icon={<Wallet />}
          tone="primary"
          href="/dashboard/reports/sales"
        />
        <StatCard
          label={range.preset === 'TODAY' ? 'Orders today' : 'Orders'}
          value={stats.orders}
          change={stats.ordersChange}
          hint={versus}
          icon={<ShoppingBag />}
          tone="success"
          href="/dashboard/orders"
        />
        <StatCard
          label="Average order"
          value={money(stats.averageOrderValue)}
          change={stats.aovChange}
          hint={versus}
          icon={<TrendingUp />}
          href="/dashboard/reports/sales"
        />
        {/*
          Live, not periodic. `tablesOccupied` is a count of a status column,
          which only ever holds what is true now — so this tile keeps no window
          while the three beside it follow the period. The hint carries the
          period's guests, which is why it names them.
        */}
        <StatCard
          label="Tables occupied"
          value={`${stats.tablesOccupied}/${stats.tablesTotal}`}
          hint={`now · ${stats.customers} guests served in period`}
          icon={<Users />}
          tone="warning"
        />
      </div>

      {/* ── charts ──────────────────────────────────────────────── */}
      <div className="mt-5 grid gap-4 lg:grid-cols-3">
        <SectionCard
          title="Revenue trend"
          description={`${periodLabel} · by ${range.granularity}`}
          className="lg:col-span-2"
          bodyClassName="p-3 pt-5"
        >
          <RevenueTrendChart data={series} currency={restaurant.currency} locale={locale} />
        </SectionCard>

        <SectionCard title="Sales by category" description={periodLabel} bodyClassName="p-3 pt-5">
          <CategoryShareChart data={categories} currency={restaurant.currency} locale={locale} />
        </SectionCard>
      </div>

      <div className="mt-5 grid gap-4 lg:grid-cols-3">
        {/* ── live feed ─────────────────────────────────────────── */}
        <SectionCard
          title="Live orders"
          description={`${stats.pendingOrders} in progress`}
          className="lg:col-span-2"
          bodyClassName="p-0"
          actions={
            <Button variant="ghost" size="sm" asChild>
              <Link href="/dashboard/orders">
                View all <ArrowRight />
              </Link>
            </Button>
          }
        >
          {recentOrders.length === 0 ? (
            <EmptyState
              className="m-5 border-none"
              icon={<ShoppingBag />}
              title="No orders yet"
              description="Once guests scan the QR code and order, everything shows up here in real time."
              action={
                <Button asChild variant="outline">
                  <Link href="/dashboard/qr">Get your QR code</Link>
                </Button>
              }
            />
          ) : (
            <LiveOrderFeed
              branchIds={selection.branchIds}
              currency={restaurant.currency}
              locale={locale}
              initialOrders={recentOrders.map((order) => ({
                id: order.id,
                orderNumber: order.orderNumber,
                status: order.status,
                paymentStatus: order.paymentStatus,
                tableNumber: order.tableNumber ?? order.table?.number ?? null,
                customerName: order.customerName,
                itemCount: order.items.reduce((total, item) => total + item.quantity, 0),
                grandTotal: order.grandTotal,
                placedAt: order.placedAt.toISOString(),
              }))}
            />
          )}
        </SectionCard>

        {/* ── best sellers ──────────────────────────────────────── */}
        <SectionCard title="Best sellers" description={periodLabel} bodyClassName="p-0">
          {popular.length === 0 ? (
            <p className="px-5 py-10 text-center text-sm text-muted-foreground">
              Not enough data yet.
            </p>
          ) : (
            <ol className="divide-y">
              {popular.map((item, index) => (
                <li key={`${item.foodId}-${index}`} className="flex items-center gap-3 px-5 py-3">
                  <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted text-xs font-bold">
                    {index + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{item.name}</p>
                    <p className="text-xs text-muted-foreground">{item.quantity} sold</p>
                  </div>
                  <span className="shrink-0 text-sm font-semibold tabular-nums">
                    {money(item.revenue)}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </SectionCard>
      </div>

      <div className="mt-5 grid gap-4 lg:grid-cols-2">
        <SectionCard title="Payment mix" description={periodLabel} bodyClassName="p-3 pt-5">
          <PaymentMixChart data={paymentMix} currency={restaurant.currency} locale={locale} />
        </SectionCard>

        {/*
          Mixed clocks, labelled. Three of these are live and two are the
          period's; leaving them all captioned "today" — as this card was —
          made two of the five quietly wrong the moment the period could move.
        */}
        <SectionCard title="At a glance" description={`Live · ${periodLabel} where noted`} bodyClassName="p-0">
          <dl className="divide-y">
            <Row label="Orders in progress" value={String(stats.pendingOrders)} />
            <Row label="Unique guests (period)" value={String(stats.customers)} />
            <Row label="New guests (period)" value={String(stats.newCustomers)} />
            {/* Earned, landed, and still out — three different numbers, shown
                as three rows precisely so nobody averages them into one (§46). */}
            <Row label="Collected in period" value={money(stats.collected)} />
            <Row label="Outstanding bills" value={money(stats.unpaidTotal)} />
            <Row
              label="Low stock items"
              value={String(stats.lowStockCount)}
              badge={
                stats.lowStockCount > 0 ? (
                  <Badge variant="warning">
                    <Package /> Reorder
                  </Badge>
                ) : null
              }
            />
          </dl>
        </SectionCard>
      </div>

      {/* ── purchasing and the floor ────────────────────────────── */}
      <div className="mt-5 grid gap-4 lg:grid-cols-2">
        {/*
          Spend is the period's; what is outstanding is not, and the card says
          so. Money owed to a supplier does not stop being owed because you
          changed the dropdown to last week.
        */}
        <SectionCard
          title="Purchasing"
          description={periodLabel}
          bodyClassName="p-0"
          actions={
            <Button variant="ghost" size="sm" asChild>
              <Link href="/dashboard/reports/purchasing">
                Report <ArrowRight />
              </Link>
            </Button>
          }
        >
          {purchases.ordersPlaced === 0 && purchases.outstandingCount === 0 ? (
            <EmptyState
              className="m-5 border-none"
              icon={<Truck />}
              title="No purchase orders in this period"
              description="Raise one when you order stock from a supplier, and spend, deliveries and what is still owed appear here."
              action={
                <Button asChild variant="outline">
                  <Link href="/dashboard/purchases">Go to purchasing</Link>
                </Button>
              }
            />
          ) : (
            <>
              <dl className="divide-y">
                <Row label="Spend" value={money(purchases.spend)} />
                <Row label="Orders placed" value={String(purchases.ordersPlaced)} />
                <Row label="Received in full" value={String(purchases.received)} />
                <Row
                  label="Awaiting delivery"
                  value={money(purchases.outstandingValue)}
                  badge={
                    purchases.outstandingCount > 0 ? (
                      <Badge variant="secondary">{purchases.outstandingCount} open</Badge>
                    ) : null
                  }
                />
                <Row
                  label="Overdue"
                  value={money(purchases.overdueValue)}
                  badge={
                    purchases.overdueCount > 0 ? (
                      <Badge variant="warning">
                        <AlertTriangle /> {purchases.overdueCount} late
                      </Badge>
                    ) : null
                  }
                />
              </dl>

              {purchases.topSuppliers.length > 0 ? (
                <div className="border-t px-5 py-3">
                  <p className="mb-2 text-xs font-medium text-muted-foreground">Top suppliers</p>
                  <ul className="space-y-1.5">
                    {purchases.topSuppliers.map((supplier) => (
                      <li key={supplier.name} className="flex items-center gap-3 text-sm">
                        <span className="min-w-0 flex-1 truncate">{supplier.name}</span>
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {supplier.orders} order{supplier.orders === 1 ? '' : 's'}
                        </span>
                        <span className="shrink-0 font-semibold tabular-nums">
                          {money(supplier.spend)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </>
          )}
        </SectionCard>

        {/*
          The status strip is now; the table below it is the period. "In use"
          counts the four statuses that mean a guest is sitting there, not just
          OCCUPIED — see `getFloorSummary`.
        */}
        <SectionCard
          title="Tables"
          description={`Live floor · takings ${periodLabel}`}
          bodyClassName="p-0"
          actions={
            <Button variant="ghost" size="sm" asChild>
              <Link href="/dashboard/tables">
                Floor plan <ArrowRight />
              </Link>
            </Button>
          }
        >
          {floor.total === 0 ? (
            <EmptyState
              className="m-5 border-none"
              icon={<LayoutGrid />}
              title="No tables set up"
              description="Add your tables and each one gets its own QR code."
              action={
                <Button asChild variant="outline">
                  <Link href="/dashboard/tables">Add tables</Link>
                </Button>
              }
            />
          ) : (
            <>
              <div className="grid grid-cols-2 gap-px border-b bg-border sm:grid-cols-4">
                <FloorTile label="In use" value={floor.inUse} tone="text-warning" />
                <FloorTile label="Free" value={floor.free} tone="text-success" />
                <FloorTile label="Cleaning" value={floor.cleaning} />
                <FloorTile label="Reserved" value={floor.reserved} />
              </div>

              {floor.topTables.length === 0 ? (
                <p className="px-5 py-10 text-center text-sm text-muted-foreground">
                  No table orders in this period.
                </p>
              ) : (
                <ol className="divide-y">
                  {floor.topTables.map((table) => (
                    <li key={table.id} className="flex items-center gap-3 px-5 py-3">
                      <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted text-xs font-bold">
                        {table.number}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">
                          {table.area ?? 'Main'}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {table.orders} order{table.orders === 1 ? '' : 's'}
                          {table.covers > 0 ? ` · ${table.covers} covers` : ''}
                        </p>
                      </div>
                      <span className="shrink-0 text-sm font-semibold tabular-nums">
                        {money(table.revenue)}
                      </span>
                    </li>
                  ))}
                </ol>
              )}

              <div className="border-t px-5 py-3 text-xs text-muted-foreground">
                {floor.seatedOrders} table order{floor.seatedOrders === 1 ? '' : 's'} ·{' '}
                {money(floor.averageTableSpend)} average
                {floor.outOfService > 0 ? ` · ${floor.outOfService} out of service` : ''}
              </div>
            </>
          )}
        </SectionCard>
      </div>
    </>
  )
}

function FloorTile({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div className="bg-card px-4 py-3">
      <p className={`text-xl font-semibold tabular-nums ${tone ?? ''}`}>{value}</p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  )
}

function Row({
  label,
  value,
  badge,
}: {
  label: string
  value: string
  badge?: React.ReactNode
}) {
  return (
    <div className="flex items-center justify-between gap-3 px-5 py-3">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="flex items-center gap-2 text-sm font-semibold tabular-nums">
        {badge}
        {value}
      </dd>
    </div>
  )
}

function greeting(): string {
  const hour = new Date().getHours()
  if (hour < 12) return 'morning'
  if (hour < 17) return 'afternoon'
  return 'evening'
}
