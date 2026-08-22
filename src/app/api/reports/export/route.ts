import { NextResponse, type NextRequest } from 'next/server'

import { AUDIT_ACTIONS, audit } from '@/server/audit'
import { requirePermission } from '@/server/auth/guard'
import { PERMISSIONS } from '@/lib/rbac'
import { toAppError } from '@/lib/errors'
import { formatMoney } from '@/lib/money'
import { getReportSummary, resolveRange } from '@/features/analytics/queries'
import { listOrders } from '@/features/orders/queries'
import { selectedBranch } from '@/features/dashboard/selected-branch'
import { buildReportWorkbook, toCsv, toExcel } from '@/features/reports/export'
import { requireRestaurant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'

/**
 * Report export endpoint.
 *   /api/reports/export?type=summary|orders&format=csv|xlsx&range=week
 */
export async function GET(request: NextRequest) {
  try {
    const user = await requirePermission(PERMISSIONS.REPORT_EXPORT)
    const restaurant = await requireRestaurant(user.restaurantId)

    const params = request.nextUrl.searchParams
    const type = params.get('type') ?? 'summary'
    const format = params.get('format') ?? 'csv'
    const range = resolveRange(
      params.get('range') ?? 'week',
      params.get('from') ?? undefined,
      params.get('to') ?? undefined,
    )

    const stamp = new Date().toISOString().slice(0, 10)
    const money = (value: number) => formatMoney(value, restaurant.currency)

    await audit({
      restaurantId: user.restaurantId,
      userId: user.id,
      actorName: user.name,
      action: AUDIT_ACTIONS.REPORT_EXPORTED,
      entity: 'Report',
      after: { type, format, range: params.get('range') },
    })

    /*
     * An export is a download, not a screen, and it was neither scoped nor
     * complete: no branch filter, and `page: 1, perPage: 100`, so a confined
     * manager could pull the whole group's orders and everyone got only the
     * first hundred rows of their own.
     *
     * The branch comes from the same `?branch=` the reports screen uses, and is
     * validated against what this user may see.
     */
    const { branchIds } = await selectedBranch(user, Object.fromEntries(params))

    if (type === 'orders') {
      // Paged through rather than truncated. The cap is a safety limit on the
      // size of a single download, not a silent horizon.
      const EXPORT_LIMIT = 10_000
      const PER_PAGE = 500
      const collected: Awaited<ReturnType<typeof listOrders>>['orders'] = []
      let result = await listOrders(user.restaurantId, {
        from: range.from.toISOString(),
        to: range.to.toISOString(),
        branchId: branchIds && branchIds.length === 1 ? branchIds[0] : undefined,
        perPage: PER_PAGE,
        page: 1,
      })
      collected.push(...result.orders)
      for (let page = 2; page <= result.pageCount && collected.length < EXPORT_LIMIT; page += 1) {
        const next = await listOrders(user.restaurantId, {
          from: range.from.toISOString(),
          to: range.to.toISOString(),
          branchId: branchIds && branchIds.length === 1 ? branchIds[0] : undefined,
          perPage: PER_PAGE,
          page,
        })
        collected.push(...next.orders)
      }
      if (collected.length >= EXPORT_LIMIT) {
        console.warn(
          `[export] orders export truncated at ${EXPORT_LIMIT} rows for restaurant ${user.restaurantId}`,
        )
      }
      result = { ...result, orders: collected.slice(0, EXPORT_LIMIT) }

      const columns = [
        { header: 'Order #', key: 'orderNumber' },
        { header: 'Date', key: 'date' },
        { header: 'Customer', key: 'customer' },
        { header: 'Phone', key: 'phone' },
        { header: 'Table', key: 'table' },
        { header: 'Status', key: 'status' },
        { header: 'Payment', key: 'payment' },
        { header: 'Total', key: 'total' },
      ]
      const rows = result.orders.map((order) => ({
        orderNumber: order.orderNumber,
        date: order.placedAt.toISOString(),
        customer: order.customerName,
        phone: order.customerPhone,
        table: order.table?.number ?? '',
        status: order.status,
        payment: order.paymentStatus,
        total: money(order.grandTotal),
      }))

      if (format === 'xlsx') {
        const buffer = await toExcel('Orders', columns, rows)
        return fileResponse(buffer, `orders-${stamp}.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      }
      return fileResponse(Buffer.from(toCsv(columns, rows)), `orders-${stamp}.csv`, 'text/csv')
    }

    // summary
    const summary = await getReportSummary(user.restaurantId, range, branchIds)

    if (format === 'xlsx') {
      const buffer = await buildReportWorkbook(summary, restaurant.currency, restaurant.name)
      return fileResponse(buffer, `report-${stamp}.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    }

    const columns = [
      { header: 'Metric', key: 'metric' },
      { header: 'Value', key: 'value' },
    ]
    const rows = [
      { metric: 'Orders', value: summary.orderCount },
      { metric: 'Gross revenue', value: money(summary.revenue) },
      { metric: 'Net sales', value: money(summary.netSales) },
      { metric: 'Tax', value: money(summary.tax) },
      { metric: 'Discounts', value: money(summary.discounts) },
      { metric: 'Food cost', value: money(summary.foodCost) },
      { metric: 'Gross profit', value: money(summary.grossProfit) },
      { metric: 'Average order', value: money(summary.averageOrderValue) },
      { metric: 'Unique customers', value: summary.uniqueCustomers },
    ]
    return fileResponse(Buffer.from(toCsv(columns, rows)), `report-${stamp}.csv`, 'text/csv')
  } catch (error) {
    const app = toAppError(error)
    return NextResponse.json({ error: app.message, code: app.code }, { status: app.status })
  }
}

function fileResponse(buffer: Buffer, filename: string, contentType: string) {
  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      'Content-Type': contentType,
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  })
}
