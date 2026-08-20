import Link from 'next/link'
import type { Metadata } from 'next'
import {
  AlertTriangle,
  ArrowRight,
  ClipboardList,
  Package,
  Receipt,
  ShoppingBag,
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
  getCachedSalesSeries,
  getDashboardStats,
} from '@/features/analytics/queries'
import { PageHeader, SectionCard, StatCard } from '@/features/dashboard/components/page-header'
import { LiveOrderFeed } from '@/features/dashboard/components/live-order-feed'
import { formatMoney } from '@/lib/money'
import { PERMISSIONS, visibleBranchIds } from '@/lib/rbac'
import { LocationSwitcher } from '@/features/dashboard/components/location-switcher'
import { listLocations } from '@/features/transfers/queries'
import { requirePagePermission } from '@/server/auth/guard'
import { prisma } from '@/server/db/prisma'
import { requireRestaurant } from '@/server/db/tenant'
import { AutoRefresh } from '@/components/auto-refresh'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Dashboard' }

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const user = await requirePagePermission(PERMISSIONS.DASHBOARD_VIEW, '/dashboard')

  // The chosen location comes from the URL, and is checked against what this
  // user may actually see — a branch id typed into the address bar must not
  // widen anyone's access.
  const params = await searchParams
  const requested = typeof params.branch === 'string' ? params.branch : null
  const allowed = visibleBranchIds({ role: user.role, branchId: user.branchId })
  const locations = (await listLocations(user.restaurantId)).filter(
    (l) => allowed === null || allowed.includes(l.id),
  )
  const activeBranchId =
    requested && locations.some((l) => l.id === requested) ? requested : null
  const restaurant = await requireRestaurant(user.restaurantId)
  const locale = restaurant.locale === 'en' ? 'en-IN' : restaurant.locale

  // Smart alert: orders still not ready after 20 minutes.
  const waitCutoff = new Date(Date.now() - 20 * 60 * 1000)

  const [stats, series, popular, categories, paymentMix, recentOrders, longWaiting] = await Promise.all([
    getDashboardStats(user.restaurantId),
    getCachedSalesSeries(user.restaurantId, 14),
    getCachedPopularItems(user.restaurantId, 30, 6),
    getCachedCategoryBreakdown(user.restaurantId, 30),
    getCachedPaymentMix(user.restaurantId, 30),
    prisma.order.findMany({
      where: { restaurantId: user.restaurantId },
      orderBy: { placedAt: 'desc' },
      take: 8,
      include: { table: { select: { number: true } }, items: { select: { quantity: true } } },
    }),
    prisma.order.count({
      where: {
        restaurantId: user.restaurantId,
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
        description={`Here is how ${restaurant.name} is doing today.`}
        actions={
          <>
            <LocationSwitcher locations={locations} current={activeBranchId} />
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
          label="Revenue today"
          value={money(stats.revenueToday)}
          change={stats.revenueChange}
          hint="vs yesterday"
          icon={<Wallet />}
          tone="primary"
        />
        <StatCard
          label="Orders today"
          value={stats.ordersToday}
          change={stats.ordersChange}
          hint="vs yesterday"
          icon={<ShoppingBag />}
          tone="success"
        />
        <StatCard
          label="Average order"
          value={money(stats.averageOrderValue)}
          change={stats.aovChange}
          hint="vs yesterday"
          icon={<TrendingUp />}
        />
        <StatCard
          label="Tables occupied"
          value={`${stats.tablesOccupied}/${stats.tablesTotal}`}
          hint={`${stats.customersToday} guests served · ${stats.newCustomersToday} new`}
          icon={<Users />}
          tone="warning"
        />
      </div>

      {/* ── charts ──────────────────────────────────────────────── */}
      <div className="mt-5 grid gap-4 lg:grid-cols-3">
        <SectionCard
          title="Revenue trend"
          description="Last 14 days"
          className="lg:col-span-2"
          bodyClassName="p-3 pt-5"
        >
          <RevenueTrendChart data={series} currency={restaurant.currency} locale={locale} />
        </SectionCard>

        <SectionCard title="Sales by category" description="Last 30 days" bodyClassName="p-3 pt-5">
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
              currency={restaurant.currency}
              locale={locale}
              initialOrders={recentOrders.map((order) => ({
                id: order.id,
                orderNumber: order.orderNumber,
                status: order.status,
                paymentStatus: order.paymentStatus,
                tableNumber: order.table?.number ?? null,
                customerName: order.customerName,
                itemCount: order.items.reduce((total, item) => total + item.quantity, 0),
                grandTotal: order.grandTotal,
                placedAt: order.placedAt.toISOString(),
              }))}
            />
          )}
        </SectionCard>

        {/* ── best sellers ──────────────────────────────────────── */}
        <SectionCard title="Best sellers" description="Last 30 days" bodyClassName="p-0">
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
        <SectionCard title="Payment mix" description="Last 30 days" bodyClassName="p-3 pt-5">
          <PaymentMixChart data={paymentMix} currency={restaurant.currency} locale={locale} />
        </SectionCard>

        <SectionCard title="Today at a glance" bodyClassName="p-0">
          <dl className="divide-y">
            <Row label="Orders in progress" value={String(stats.pendingOrders)} />
            <Row label="Unique guests today" value={String(stats.customersToday)} />
            <Row label="New guests today" value={String(stats.newCustomersToday)} />
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
    </>
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
