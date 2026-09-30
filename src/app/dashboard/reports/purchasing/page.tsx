import type { Metadata } from 'next'
import Link from 'next/link'

import { PageHeader } from '@/features/dashboard/components/page-header'
import { ReportFilters } from '@/features/reports/components/report-filters'
import { ReportTable } from '@/features/reports/components/report-table'
import { DrillDown, DrillTable, Pager } from '@/features/reports/components/drill-down'
import { resolveRange } from '@/features/reports/range'
import { listAwaitingDelivery, listPriceMoves } from '@/features/purchasing/queries'
import { getReorderSuggestions } from '@/features/purchasing/suggestions'
import { getPurchasingReport } from '@/features/purchasing/report'
import { getPurchasingDrill } from '@/features/purchasing/report-drill'
import { listPurchasedItems, type PurchasedItemRow } from '@/features/purchasing/purchased-items'
import { PurchasingReportView } from '@/features/purchasing/components/purchasing-report-view'
import { ExportMenu } from '@/features/reports/components/export-menu'
import { listLocations } from '@/features/transfers/queries'
import { formatMoney, localeForCurrency } from '@/lib/money'
import { roundQty } from '@/lib/quantity'
import { formatDate } from '@/lib/datetime'
import { PERMISSIONS, can } from '@/lib/rbac'
import { scopeToOne, selectedBranch } from '@/features/dashboard/selected-branch'
import { requirePagePermission } from '@/server/auth/guard'
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
/** The "Purchased items" section on the overview pages by itself, a longer page. */
const ITEMS_PER_PAGE = 25

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
  const [report, drill, purchased, awaiting, suggestions, priceMoves] = await Promise.all([
    view === 'overview'
      ? getPurchasingReport({
          restaurantId: user.restaurantId,
          range,
          branchIds,
          timeZone: restaurant.timezone,
        })
      : Promise.resolve(null),
    view === 'orders' || view === 'supplier'
      ? getPurchasingDrill({ restaurantId: user.restaurantId, range, branchIds })
      : Promise.resolve(null),
    // The overview's own section, and the "item" drill is the same list in full.
    view === 'overview' || view === 'item'
      ? listPurchasedItems({ restaurantId: user.restaurantId, range, branchIds })
      : Promise.resolve(null),
    view === 'overview'
      ? listAwaitingDelivery({ restaurantId: user.restaurantId, branchId: chosen })
      : Promise.resolve([]),
    view === 'overview'
      ? getReorderSuggestions({ restaurantId: user.restaurantId, branchId: chosen })
      : Promise.resolve([]),
    view === 'overview'
      ? listPriceMoves({
          restaurantId: user.restaurantId,
          from: range.from,
          to: range.to,
          branchId: chosen,
        })
      : Promise.resolve([]),
  ])

  const canExport = can(user, PERMISSIONS.REPORT_EXPORT)
  const showLocations = locations.length > 1 && !chosen

  /* ── The three drill-downs ───────────────────────────────────────────── */

  if (view === 'item' && purchased) {
    const parent = { href: hrefFor({ view: 'overview' }), label: 'Purchasing Reports' }
    const rows = purchased.rows
    return (
      <DrillDown
        title="Purchased items"
        description="Every item bought in this period, what it cost and who supplied it."
        parent={parent}
        filters={filters}
        actions={canExport ? <ExportMenu type="purchased-items" disabled={rows.length === 0} /> : null}
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
        <PurchasedItemsTable
          rows={rows}
          page={page}
          perPage={PER_PAGE}
          money={money}
          locale={locale}
          timeZone={restaurant.timezone}
          showLocations={showLocations}
        />
      </DrillDown>
    )
  }

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
        What actually came in, item by item (the owner's ask, Sep 2026).

        The panels above count ORDERS — committed money, by the day the order
        was placed. This reads the stock ledger instead: what was booked into
        stock, in the item's own unit, at the price actually paid, including
        stock recorded without an order. See `purchased-items.ts` for why the
        two are kept apart. Same period and location as everything else on
        the page; the export downloads the whole list with those filters.
      */}
      {purchased ? (
        <section
          id="purchased-items"
          className="mt-6 overflow-hidden rounded-xl border bg-card shadow-soft scroll-mt-20"
        >
          <header className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-4">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold">Purchased items</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Every item bought in this period — what came in, what it cost and who supplied
                it. Biggest spend first.
              </p>
            </div>
            <div className="flex items-center gap-2">
              {canExport ? (
                <ExportMenu type="purchased-items" disabled={purchased.rows.length === 0} />
              ) : null}
            </div>
          </header>
          {purchased.rows.length > 0 ? (
            <div className="flex flex-wrap gap-x-6 gap-y-1 border-b bg-muted/30 px-5 py-2.5 text-xs text-muted-foreground">
              <span>
                <strong className="font-semibold text-foreground">{purchased.totals.items}</strong>{' '}
                {purchased.totals.items === 1 ? 'item' : 'items'}
              </span>
              <span>
                <strong className="font-semibold text-foreground">{purchased.totals.deliveries}</strong>{' '}
                {purchased.totals.deliveries === 1 ? 'delivery' : 'deliveries'}
              </span>
              <span>
                Spent{' '}
                <strong className="font-semibold text-foreground">{money(purchased.totals.value)}</strong>
              </span>
              {purchased.totals.returnedValue > 0 ? (
                <span>
                  Returned to suppliers{' '}
                  <strong className="font-semibold text-foreground">
                    {money(purchased.totals.returnedValue)}
                  </strong>
                </span>
              ) : null}
            </div>
          ) : null}
          <div className="overflow-x-auto">
            <PurchasedItemsTable
              rows={purchased.rows}
              page={page}
              perPage={ITEMS_PER_PAGE}
              money={money}
              locale={locale}
              timeZone={restaurant.timezone}
              showLocations={showLocations}
            />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3 text-sm text-muted-foreground">
            <Pager
              page={page}
              pageCount={Math.max(1, Math.ceil(purchased.rows.length / ITEMS_PER_PAGE))}
              hrefFor={(n) => `${hrefFor({ page: n })}#purchased-items`}
              total={purchased.rows.length}
              perPage={ITEMS_PER_PAGE}
            />
          </div>
        </section>
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

/**
 * The purchased-items rows, shared by the overview section and its drill.
 *
 * One component so the two can never show different columns for the same
 * fact. The caller slices — see `Pager`'s contract — and passes the page so
 * the row numbers carry on across pages.
 */
function PurchasedItemsTable({
  rows,
  page,
  perPage,
  money,
  locale,
  timeZone,
  showLocations,
}: {
  rows: PurchasedItemRow[]
  page: number
  perPage: number
  money: (m: number) => string
  locale: string
  timeZone: string
  /** Only when the page is not already narrowed to one location. */
  showLocations: boolean
}) {
  const slice = rows.slice((page - 1) * perPage, page * perPage)
  return (
    <DrillTable
      isEmpty={rows.length === 0}
      empty="Nothing was booked into stock in this period."
      columns={[
        { label: '#' },
        { label: 'Item' },
        { label: 'Category' },
        { label: 'Qty bought', align: 'right' },
        { label: 'Spend', align: 'right' },
        { label: 'Avg / unit', align: 'right' },
        { label: 'Last paid', align: 'right' },
        { label: 'Last bought' },
        { label: 'Supplier' },
        ...(showLocations ? [{ label: 'Location' }] : []),
        { label: 'Returned', align: 'right' as const },
      ]}
    >
      {slice.map((row, i) => (
        <tr key={row.key} className="hover:bg-muted/40">
          <td className="px-4 py-2.5 text-muted-foreground tabular-nums">
            {(page - 1) * perPage + i + 1}
          </td>
          <td className="px-4 py-2.5 font-medium">
            <Link href={`/dashboard/inventory/${row.key}`} className="hover:underline">
              {row.name}
            </Link>
            <span className="block text-xs font-normal text-muted-foreground">
              {row.deliveries} {row.deliveries === 1 ? 'delivery' : 'deliveries'}
              {row.sku ? ` · ${row.sku}` : ''}
            </span>
          </td>
          <td className="px-4 py-2.5 text-muted-foreground">{row.category}</td>
          <td className="px-4 py-2.5 text-right tabular-nums">{qty(row.quantity, row.unit)}</td>
          <td className="px-4 py-2.5 text-right tabular-nums">{money(row.value)}</td>
          <td className="px-4 py-2.5 text-right tabular-nums">{money(row.averageUnitCost)}</td>
          <td className="px-4 py-2.5 text-right tabular-nums">{money(row.lastUnitCost)}</td>
          <td className="whitespace-nowrap px-4 py-2.5 text-muted-foreground">
            {row.lastBoughtAt ? formatDate(row.lastBoughtAt, { locale, timeZone }) : '—'}
          </td>
          <td className="max-w-[14rem] truncate px-4 py-2.5">{row.suppliers.join(', ') || '—'}</td>
          {showLocations ? (
            <td className="max-w-[12rem] truncate px-4 py-2.5 text-muted-foreground">
              {row.locations.join(', ')}
            </td>
          ) : null}
          <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">
            {row.returnedQuantity > 0 ? qty(row.returnedQuantity, row.unit) : '—'}
          </td>
        </tr>
      ))}
    </DrillTable>
  )
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
