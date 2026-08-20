import type { Metadata } from 'next'

import { PageHeader, StatCard } from '@/features/dashboard/components/page-header'
import { ReportFilters } from '@/features/reports/components/report-filters'
import { ReportTable } from '@/features/reports/components/report-table'
import { resolveRange } from '@/features/reports/range'
import { listPurchaseOrders } from '@/features/purchasing/queries'
import { getReorderSuggestions } from '@/features/purchasing/suggestions'
import { listLocations } from '@/features/transfers/queries'
import { formatMoney } from '@/lib/money'
import { PERMISSIONS, visibleBranchIds } from '@/lib/rbac'
import { requirePagePermission } from '@/server/auth/guard'
import { prisma } from '@/server/db/prisma'
import { requireRestaurant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Purchasing report' }

export default async function PurchasingReportPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const user = await requirePagePermission(PERMISSIONS.REPORT_VIEW, '/dashboard/reports/purchasing')
  const restaurant = await requireRestaurant(user.restaurantId)
  const money = (m: number) => formatMoney(m, restaurant.currency)

  const p = await searchParams
  const str = (k: string) => (typeof p[k] === 'string' ? (p[k] as string) : '')
  const range = resolveRange({ preset: str('preset') || 'THIS_MONTH', from: str('from'), to: str('to') })

  const allowed = visibleBranchIds({ role: user.role, branchId: user.branchId })
  const locations = (await listLocations(user.restaurantId)).filter(
    (l) => allowed === null || allowed.includes(l.id),
  )
  const requested = str('branch')
  const chosen = requested && locations.some((l) => l.id === requested) ? requested : null

  const [orders, suggestions, priceMoves, bySupplier] = await Promise.all([
    listPurchaseOrders({ restaurantId: user.restaurantId, limit: 200 }),
    getReorderSuggestions({ restaurantId: user.restaurantId, branchId: chosen }),
    // Price history over the window, so a supplier raising prices is visible.
    prisma.purchasePriceHistory.findMany({
      where: {
        restaurantId: user.restaurantId,
        recordedAt: { gte: range.from, lte: range.to },
      },
      include: { item: { select: { name: true, unit: true } }, supplier: { select: { name: true } } },
      orderBy: { recordedAt: 'asc' },
    }),
    prisma.purchase.groupBy({
      by: ['supplierId'],
      where: {
        restaurantId: user.restaurantId,
        createdAt: { gte: range.from, lte: range.to },
        status: { notIn: ['CANCELLED', 'DRAFT'] },
      },
      _sum: { total: true },
      _count: true,
    }),
  ])

  const inWindow = orders.filter((o) => {
    const at = new Date(o.createdAt)
    return at >= range.from && at <= range.to
  })
  const outstanding = orders.filter((o) =>
    ['APPROVED', 'ORDERED', 'PARTIALLY_RECEIVED'].includes(o.status),
  )
  const spend = inWindow
    .filter((o) => !['CANCELLED', 'DRAFT'].includes(o.status))
    .reduce((s, o) => s + o.total, 0)

  // First and latest price per item, so the trend is one row not a chart.
  const trend = new Map<string, { name: string; unit: string; first: number; latest: number; supplier: string | null; buys: number }>()
  for (const h of priceMoves) {
    const row = trend.get(h.itemId) ?? {
      name: h.item.name, unit: h.item.unit as string,
      first: h.unitCost, latest: h.unitCost, supplier: h.supplier?.name ?? null, buys: 0,
    }
    row.latest = h.unitCost
    row.supplier = h.supplier?.name ?? row.supplier
    row.buys += 1
    trend.set(h.itemId, row)
  }
  const priceRows = [...trend.values()]
    .map((r) => ({
      ...r,
      change: r.first > 0 ? Math.round(((r.latest - r.first) / r.first) * 10000) / 100 : 0,
    }))
    .filter((r) => r.buys > 1)
    .sort((a, b) => b.change - a.change)

  const supplierNames = await prisma.supplier.findMany({
    where: { restaurantId: user.restaurantId },
    select: { id: true, name: true },
  })
  const nameById = new Map(supplierNames.map((s) => [s.id, s.name]))
  const supplierRows = bySupplier
    .map((s) => ({
      supplier: s.supplierId ? nameById.get(s.supplierId) ?? 'Unknown' : 'No supplier',
      orders: s._count,
      spend: s._sum?.total ?? 0,
    }))
    .sort((a, b) => b.spend - a.spend)

  return (
    <>
      <PageHeader title="Purchasing" description={`${range.label} · ${restaurant.name}`} />
      <ReportFilters
        preset={range.preset}
        from={str('from')}
        to={str('to')}
        locations={locations}
        branchId={chosen}
      />

      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Spend" value={money(spend)} />
        <StatCard label="Orders placed" value={String(inWindow.length)} />
        <StatCard label="Still outstanding" value={String(outstanding.length)} />
        <StatCard label="Needs ordering" value={String(suggestions.length)} />
      </div>

      <div className="space-y-5">
        <ReportTable
          title="Spend by supplier"
          columns={[
            { key: 'supplier', label: 'Supplier' },
            { key: 'orders', label: 'Orders', align: 'right' },
            { key: 'spend', label: 'Spend', align: 'right', format: (r) => money(Number(r.spend)) },
          ]}
          rows={supplierRows as unknown as Array<Record<string, unknown>>}
          filename="spend-by-supplier"
        />

        <ReportTable
          title="Price movement"
          description="Items bought more than once in this period, biggest rise first. Prices are per base unit, so a box and a kilo compare fairly."
          columns={[
            { key: 'name', label: 'Item' },
            { key: 'supplier', label: 'Supplier', format: (r) => String(r.supplier ?? '—') },
            { key: 'first', label: 'First paid', align: 'right', format: (r) => money(Number(r.first)) },
            { key: 'latest', label: 'Last paid', align: 'right', format: (r) => money(Number(r.latest)) },
            { key: 'change', label: 'Change', align: 'right', format: (r) => `${Number(r.change) > 0 ? '+' : ''}${r.change}%` },
          ]}
          rows={priceRows as unknown as Array<Record<string, unknown>>}
          filename="price-movement"
          empty="Nothing was bought twice in this period, so there is no trend to show."
        />

        <ReportTable
          title="Outstanding orders"
          description="Approved or sent, not yet fully received."
          columns={[
            { key: 'number', label: 'Order' },
            { key: 'supplierName', label: 'Supplier', format: (r) => String(r.supplierName ?? '—') },
            { key: 'status', label: 'Status', format: (r) => String(r.status).replace(/_/g, ' ').toLowerCase() },
            { key: 'receivedPercent', label: 'Received', align: 'right', format: (r) => `${r.receivedPercent}%` },
            { key: 'total', label: 'Value', align: 'right', format: (r) => money(Number(r.total)) },
          ]}
          rows={outstanding as unknown as Array<Record<string, unknown>>}
          filename="outstanding-purchase-orders"
          empty="Nothing outstanding."
        />

        <ReportTable
          title="Needs ordering"
          columns={[
            { key: 'name', label: 'Item' },
            { key: 'currentQty', label: 'In stock', align: 'right', format: (r) => `${r.currentQty} ${String(r.unit).toLowerCase()}` },
            { key: 'suggestedQty', label: 'Suggested', align: 'right' },
            { key: 'supplierName', label: 'Supplier', format: (r) => String(r.supplierName ?? '—') },
            { key: 'estimatedCost', label: 'Est. cost', align: 'right', format: (r) => money(Number(r.estimatedCost)) },
          ]}
          rows={suggestions as unknown as Array<Record<string, unknown>>}
          filename="reorder-suggestions"
          empty="Nothing below its reorder level."
        />
      </div>
    </>
  )
}
