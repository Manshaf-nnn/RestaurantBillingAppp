import type { Metadata } from 'next'
import Link from 'next/link'

import { PageHeader } from '@/features/dashboard/components/page-header'
import { ReportFilters } from '@/features/reports/components/report-filters'
import { ReportTable } from '@/features/reports/components/report-table'
import { DrillDown, DrillTable, Pager } from '@/features/reports/components/drill-down'
import { resolveRange } from '@/features/reports/range'
import { listAwaitingDelivery } from '@/features/purchasing/queries'
import { getReorderSuggestions } from '@/features/purchasing/suggestions'
import { getPurchasingReport } from '@/features/purchasing/report'
import { getPurchasingDrill } from '@/features/purchasing/report-drill'
import { PurchasingReportView } from '@/features/purchasing/components/purchasing-report-view'
import { listLocations } from '@/features/transfers/queries'
import { formatMoney, localeForCurrency } from '@/lib/money'
import { roundQty } from '@/lib/quantity'
import { formatDate } from '@/lib/datetime'
import { PERMISSIONS } from '@/lib/rbac'
import { scopeToOne, selectedBranch } from '@/features/dashboard/selected-branch'
import { requirePagePermission } from '@/server/auth/guard'
import { prisma } from '@/server/db/prisma'
import { requireRestaurant } from '@/server/db/tenant'
import { cn } from '@/lib/utils'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Purchasing report' }

/**
 * Purchasing.
 *
 * Six figures and five panels, then three tables behind them — the orders
 * themselves, what was bought, and who it was bought from.
 *
 * ── A request is not a purchase ─────────────────────────────────────────────
 *
 * `service.ts` splits request states (DRAFT, PENDING_APPROVAL, RETURNED,
 * REJECTED) from order states (APPROVED onwards) deliberately, and every figure
 * here counts orders. A request an approver refused is not cancelled spending
 * and a draft is not money committed. The status panel names how many requests
 * are waiting, so they are visible rather than merely excluded.
 *
 * ── There is no budget ──────────────────────────────────────────────────────
 *
 * The design this was built to asks for "variance vs budget". Nothing in this
 * system holds a budget, so that tile answers the question the data can
 * support instead: what the orders COMMITTED against what the deliveries were
 * actually invoiced at. See `PurchasingTotals.variance`.
 */

const VIEWS = ['overview', 'orders', 'item', 'supplier'] as const
type View = (typeof VIEWS)[number]

const PER_PAGE = 10

export default async function PurchasingReportPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const user = await requirePagePermission(PERMISSIONS.REPORT_PURCHASING, '/dashboard/reports/purchasing')
  const restaurant = await requireRestaurant(user.restaurantId)
  const locale =
    restaurant.locale === 'en' ? localeForCurrency(restaurant.currency) : restaurant.locale
  const money = (m: number) => formatMoney(m, restaurant.currency, locale)

  const p = await searchParams
  const str = (k: string) => (typeof p[k] === 'string' ? (p[k] as string) : '')
  const range = resolveRange({
    preset: str('preset') || 'THIS_MONTH',
    from: str('from'),
    to: str('to'),
    timeZone: restaurant.timezone,
  })

  const selection = await selectedBranch(user, p)
  const locations = await listLocations(user.restaurantId, selection.branchIds)
  const chosen = scopeToOne(selection)
  const branchIds = selection.branchIds

  const asked = str('view')
  const view: View = (VIEWS as readonly string[]).includes(asked) ? (asked as View) : 'overview'
  const page = Math.max(1, Number(str('page')) || 1)

  /** This screen, on another view or page, keeping the period and location. */
  const hrefFor = (next: Partial<{ view: string; page: number }>) => {
    const q = new URLSearchParams()
    for (const key of ['preset', 'from', 'to', 'branch']) {
      const value = str(key)
      if (value) q.set(key, value)
    }
    const v = next.view ?? view
    if (v !== 'overview') q.set('view', v)
    if (next.page && next.page > 1) q.set('page', String(next.page))
    const qs = q.toString()
    return `/dashboard/reports/purchasing${qs ? `?${qs}` : ''}`
  }

  const filters = (
    <ReportFilters
      preset={range.preset}
      from={str('from')}
      to={str('to')}
      locations={locations}
      branchId={selection.branchId}
    />
  )

  /* Only what the view needs: the drill tables never load for the overview. */
  const [report, drill, awaiting, suggestions, priceMoves] = await Promise.all([
    view === 'overview'
      ? getPurchasingReport({
          restaurantId: user.restaurantId,
          range,
          branchIds,
          timeZone: restaurant.timezone,
        })
      : Promise.resolve(null),
    view !== 'overview'
      ? getPurchasingDrill({ restaurantId: user.restaurantId, range, branchIds })
      : Promise.resolve(null),
    view === 'overview'
      ? listAwaitingDelivery({ restaurantId: user.restaurantId, branchId: chosen })
      : Promise.resolve([]),
    view === 'overview'
      ? getReorderSuggestions({ restaurantId: user.restaurantId, branchId: chosen })
      : Promise.resolve([]),
    view === 'overview'
      ? prisma.purchasePriceHistory.findMany({
          where: {
            restaurantId: user.restaurantId,
            recordedAt: { gte: range.from, lte: range.to },
            // Price history reaches a branch only through its purchase.
            ...(chosen ? { purchase: { branchId: chosen } } : {}),
          },
          include: {
            item: { select: { name: true, unit: true } },
            supplier: { select: { name: true } },
          },
          orderBy: { recordedAt: 'asc' },
        })
      : Promise.resolve([]),
  ])

  /* ── The three drill-downs ───────────────────────────────────────────── */

  if (view !== 'overview' && drill) {
    const parent = { href: hrefFor({ view: 'overview' }), label: 'Purchasing Reports' }

    if (view === 'orders') {
      const rows = drill.orders
      const slice = rows.slice((page - 1) * PER_PAGE, page * PER_PAGE)
      return (
        <DrillDown
          title="Purchase Order Details"
          description="Detailed list of all purchase orders."
          parent={parent}
          filters={filters}
          footer={
            <Pager
              page={page}
              pageCount={Math.max(1, Math.ceil(rows.length / PER_PAGE))}
              hrefFor={(n) => hrefFor({ page: n })}
              total={rows.length}
              perPage={PER_PAGE}
            />
          }
        >
          <DrillTable
            isEmpty={rows.length === 0}
            empty="No purchase orders in this period."
            columns={[
              { label: '#' },
              { label: 'PO No.' },
              { label: 'Date' },
              { label: 'Supplier' },
              { label: 'Items', align: 'right' },
              { label: 'Total Value', align: 'right' },
              { label: 'Status' },
            ]}
          >
            {slice.map((row, i) => (
              <tr key={row.key} className="hover:bg-muted/40">
                <td className="px-4 py-2.5 text-muted-foreground tabular-nums">
                  {(page - 1) * PER_PAGE + i + 1}
                </td>
                <td className="px-4 py-2.5 font-medium">
                  <Link href={`/dashboard/purchases/${row.key}`} className="hover:underline">
                    {row.number}
                  </Link>
                </td>
                <td className="px-4 py-2.5 text-muted-foreground">
                  {formatDate(row.placedAt, { locale, timeZone: restaurant.timezone })}
                </td>
                <td className="px-4 py-2.5">{row.supplier}</td>
                <td className="px-4 py-2.5 text-right tabular-nums">{row.items}</td>
                <td className="px-4 py-2.5 text-right tabular-nums">{money(row.value)}</td>
                <td className="px-4 py-2.5">
                  <StatusDot status={row.status} label={row.statusLabel} />
                </td>
              </tr>
            ))}
          </DrillTable>
        </DrillDown>
      )
    }

    if (view === 'item') {
      const rows = drill.byItem
      const slice = rows.slice((page - 1) * PER_PAGE, page * PER_PAGE)
      return (
        <DrillDown
          title="Item Purchase Report"
          description="View purchase quantity and cost for each item."
          parent={parent}
          filters={filters}
          footer={
            <Pager
              page={page}
              pageCount={Math.max(1, Math.ceil(rows.length / PER_PAGE))}
              hrefFor={(n) => hrefFor({ page: n })}
              total={rows.length}
              perPage={PER_PAGE}
            />
          }
        >
          <DrillTable
            isEmpty={rows.length === 0}
            empty="Nothing was bought in this period."
            columns={[
              { label: '#' },
              { label: 'Item' },
              { label: 'Category' },
              { label: 'Qty Purchased', align: 'right' },
              { label: 'Purchase Value', align: 'right' },
              { label: 'Avg. Unit Cost', align: 'right' },
            ]}
          >
            {slice.map((row, i) => (
              <tr key={row.key} className="hover:bg-muted/40">
                <td className="px-4 py-2.5 text-muted-foreground tabular-nums">
                  {(page - 1) * PER_PAGE + i + 1}
                </td>
                <td className="px-4 py-2.5 font-medium">
                  <Link href={`/dashboard/inventory/${row.key}`} className="hover:underline">
                    {row.label}
                  </Link>
                </td>
                <td className="px-4 py-2.5 text-muted-foreground">{row.category}</td>
                <td className="px-4 py-2.5 text-right tabular-nums">
                  {qty(row.quantity, row.unit)}
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums">{money(row.value)}</td>
                <td className="px-4 py-2.5 text-right tabular-nums">{money(row.averageUnitCost)}</td>
              </tr>
            ))}
          </DrillTable>
        </DrillDown>
      )
    }

    const rows = drill.bySupplier
    const slice = rows.slice((page - 1) * PER_PAGE, page * PER_PAGE)
    return (
      <DrillDown
        title="Supplier Purchase Report"
        description="Detailed purchase summary for each supplier."
        parent={parent}
        filters={filters}
        footer={
          <Pager
            page={page}
            pageCount={Math.max(1, Math.ceil(rows.length / PER_PAGE))}
            hrefFor={(n) => hrefFor({ page: n })}
            total={rows.length}
            perPage={PER_PAGE}
          />
        }
      >
        <DrillTable
          isEmpty={rows.length === 0}
          empty="No suppliers were bought from in this period."
          columns={[
            { label: '#' },
            { label: 'Supplier' },
            { label: 'PO Count', align: 'right' },
            { label: 'Items', align: 'right' },
            { label: 'Qty Purchased', align: 'right' },
            { label: 'Total Value', align: 'right' },
            { label: '% of Total', align: 'right' },
          ]}
        >
          {slice.map((row, i) => (
            <tr key={row.key} className="hover:bg-muted/40">
              <td className="px-4 py-2.5 text-muted-foreground tabular-nums">
                {(page - 1) * PER_PAGE + i + 1}
              </td>
              <td className="px-4 py-2.5 font-medium">
                {row.key === 'none' ? (
                  row.label
                ) : (
                  <Link href={`/dashboard/suppliers/${row.key}`} className="hover:underline">
                    {row.label}
                  </Link>
                )}
              </td>
              <td className="px-4 py-2.5 text-right tabular-nums">{row.orders}</td>
              <td className="px-4 py-2.5 text-right tabular-nums">{row.items}</td>
              <td className="px-4 py-2.5 text-right tabular-nums">
                {qty(row.quantity)}
              </td>
              <td className="px-4 py-2.5 text-right tabular-nums">{money(row.value)}</td>
              <td className="px-4 py-2.5 text-right tabular-nums">{row.share.toFixed(1)}%</td>
            </tr>
          ))}
        </DrillTable>
      </DrillDown>
    )
  }

  /* ── The overview ────────────────────────────────────────────────────── */

  // First and latest price per item, so the trend is one row not a chart.
  const trend = new Map<
    string,
    { itemId: string; name: string; unit: string; first: number; latest: number; supplier: string | null; buys: number }
  >()
  for (const h of priceMoves) {
    const row = trend.get(h.itemId) ?? {
      itemId: h.itemId,
      name: h.item.name,
      unit: h.item.unit as string,
      first: h.unitCost,
      latest: h.unitCost,
      supplier: h.supplier?.name ?? null,
      buys: 0,
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

  return (
    <>
      <PageHeader
        title="Purchasing Reports"
        description="Analyse your procurement data, supplier performance, and purchasing costs."
      />
      {filters}

      {report ? (
        <PurchasingReportView
          totals={report.totals}
          deltas={report.deltas}
          trend={report.trend}
          byCategory={report.byCategory}
          bySupplier={report.bySupplier}
          byStatus={report.byStatus}
          awaitingApproval={report.awaitingApproval}
          monthly={report.monthly}
          links={{
            orders: hrefFor({ view: 'orders' }),
            item: hrefFor({ view: 'item' }),
            supplier: hrefFor({ view: 'supplier' }),
            category: hrefFor({ view: 'item' }),
          }}
          currency={restaurant.currency}
          locale={locale}
        />
      ) : null}

      {/*
        Kept from what this page was, and deliberately below the panels above:
        none of it is in the design this screen was rebuilt to, and all of it is
        something a buyer uses. Removing working tools to match a picture would
        be the wrong trade.
      */}
      <div className="mt-6 space-y-5">
        <ReportTable
          currency={restaurant.currency}
          title="Price movement"
          description="Items bought more than once in this period, biggest rise first. Prices are per base unit, so a box and a kilo compare fairly."
          columns={[
            { key: 'name', label: 'Item' },
            { key: 'supplier', label: 'Supplier', format: 'text' },
            { key: 'first', label: 'First paid', align: 'right', format: 'money' },
            { key: 'latest', label: 'Last paid', align: 'right', format: 'money' },
            { key: 'change', label: 'Change', align: 'right', format: 'delta' },
          ]}
          rows={priceRows as unknown as Array<Record<string, unknown>>}
          hrefTemplate="/dashboard/inventory/{itemId}"
          filename="price-movement"
          empty="Nothing was bought twice in this period, so there is no trend to show."
        />

        <ReportTable
          currency={restaurant.currency}
          title="Outstanding orders"
          description="Approved or sent, not yet fully received."
          columns={[
            { key: 'number', label: 'Order' },
            { key: 'supplierName', label: 'Supplier', format: 'text' },
            { key: 'status', label: 'Status', format: 'label' },
            { key: 'receivedPercent', label: 'Received', align: 'right', format: 'percent' },
            { key: 'total', label: 'Value', align: 'right', format: 'money' },
          ]}
          rows={
            awaiting.map((po) => ({
              ...po,
              receivedPercent:
                po.orderedQty > 0 ? Math.round((po.receivedQty / po.orderedQty) * 100) : 0,
            })) as unknown as Array<Record<string, unknown>>
          }
          hrefTemplate="/dashboard/purchases/{id}"
          filename="outstanding-purchase-orders"
          empty="Nothing outstanding."
        />

        <ReportTable
          currency={restaurant.currency}
          title="Needs ordering"
          columns={[
            { key: 'name', label: 'Item' },
            { key: 'currentQty', label: 'In stock', align: 'right', format: 'quantity', unitKey: 'unit' },
            { key: 'suggestedQty', label: 'Suggested', align: 'right' },
            { key: 'supplierName', label: 'Supplier', format: 'text' },
            { key: 'estimatedCost', label: 'Est. cost', align: 'right', format: 'money' },
          ]}
          rows={suggestions as unknown as Array<Record<string, unknown>>}
          hrefTemplate="/dashboard/inventory/{itemId}"
          filename="reorder-suggestions"
          empty="Nothing below its reorder level."
        />
      </div>
    </>
  )
}

/**
 * A quantity with its unit.
 *
 * Rounded through `roundQty`, the one place that decides how many decimals a
 * quantity carries, so a purchased 2.5 kg reads the same here as everywhere
 * else. The unit travels per row because items do not share one — 120 kg and
 * 500 pcs are both quantities and neither is a number on its own.
 */
function qty(value: number, unit?: string) {
  const n = roundQty(value).toLocaleString('en-US', { maximumFractionDigits: 3 })
  return unit ? `${n} ${unit.toLowerCase()}` : n
}

/** The coloured dot the design puts beside a purchase order's state. */
function StatusDot({ status, label }: { status: string; label: string }) {
  const tone =
    status === 'RECEIVED' ? 'bg-emerald-500'
    : status === 'PARTIAL' ? 'bg-sky-500'
    : status === 'CANCELLED' ? 'bg-rose-500'
    : 'bg-amber-500'
  return (
    <span className="inline-flex items-center gap-2 whitespace-nowrap">
      <span className={cn('size-2 shrink-0 rounded-full', tone)} />
      {label}
    </span>
  )
}
