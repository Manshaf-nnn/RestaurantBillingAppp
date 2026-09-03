import { NextResponse, type NextRequest } from 'next/server'

import { AUDIT_ACTIONS, audit } from '@/server/audit'
import { requirePermission } from '@/server/auth/guard'
import { PERMISSIONS } from '@/lib/rbac'
import { AppError, toAppError } from '@/lib/errors'
import { formatMoney } from '@/lib/money'
import { getReportSummary } from '@/features/analytics/queries'
import { listOrders } from '@/features/orders/queries'
import { selectedBranch } from '@/features/dashboard/selected-branch'
import { buildReportWorkbook, toCsv, toExcel } from '@/features/reports/export'
import { getCashDrawerReport, getPettyCashReport } from '@/features/reports/cash'
import {
  resolveRange as canonicalResolveRange,
  type DateRange as CanonicalRange,
} from '@/features/reports/range'
import { requireRestaurant } from '@/server/db/tenant'

export const dynamic = 'force-dynamic'

/**
 * Report export endpoint.
 *   /api/reports/export?type=summary|orders|drawers|petty&format=csv|xlsx
 *
 * ── Two range vocabularies, and why both are accepted ───────────────────────
 *
 * The old screens speak `?range=week` (lowercase, `features/analytics`); the
 * newer report pages speak `?preset=THIS_WEEK&from=&to=` (the canonical
 * `features/reports/range`). This endpoint understood only the first, so a link
 * built from a filtered report page silently exported a different period than
 * the one on screen — the worst possible failure for an export, because the
 * file looks right.
 *
 * `?preset=` wins when present, resolved through the canonical function with
 * the restaurant's own timezone. Nothing that already worked stops working.
 *
 * ── Filters are honoured, not decorative ────────────────────────────────────
 *
 * Branch, cashier, till, status and category all narrow the export exactly as
 * they narrow the screen. An export that quietly ignores an active filter hands
 * somebody a file containing rows they had deliberately excluded.
 */
export async function GET(request: NextRequest) {
  try {
    const user = await requirePermission(PERMISSIONS.REPORT_EXPORT)
    const restaurant = await requireRestaurant(user.restaurantId)

    const params = request.nextUrl.searchParams
    const type = params.get('type') ?? 'summary'
    const format = params.get('format') ?? 'csv'
    /*
     * Both vocabularies land on the ONE canonical resolver, in the
     * restaurant's timezone. The lowercase `?range=` words map onto presets;
     * `?preset=` wins where both are sent.
     */
    const LOWER_TO_PRESET: Record<string, string> = {
      today: 'TODAY', yesterday: 'YESTERDAY', week: 'LAST_7',
      month: 'LAST_30', quarter: 'LAST_90', year: 'THIS_YEAR',
    }
    const preset =
      params.get('preset') ?? LOWER_TO_PRESET[params.get('range') ?? 'week'] ?? 'LAST_7'
    const canonicalRange = canonicalResolveRange({
      preset,
      from: params.get('from'),
      to: params.get('to'),
      timeZone: restaurant.timezone,
    })
    const range = canonicalRange

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
    const selection = await selectedBranch(user, Object.fromEntries(params))
    const { branchIds } = selection

    if (type === 'drawers' || type === 'petty') {
      /*
       * REPORT_EXPORT is not enough to pull these.
       *
       * The route's single up-front permission check means "may export
       * something"; every variance, every cashier's shortfall and the whole
       * petty cash ledger are behind REPORT_CASH on screen, and a download that
       * asked for less would be the way round that page. The type decides the
       * permission, so a new report type cannot inherit somebody else's.
       */
      await requirePermission(PERMISSIONS.REPORT_CASH)

      return exportCash({
        type,
        format,
        stamp,
        money,
        restaurantId: user.restaurantId,
        currency: restaurant.currency,
        range: canonicalRange,
        branchIds,
        branchId: selection.branchId || null,
        params,
      })
    }

    /*
     * The accounting module's exports (accountsds.md §13). Behind the
     * module's own permission, per-type, exactly as the cash reports are —
     * a download must never be the way around a screen's gate.
     */
    if (type === 'outgoing' || type === 'expenses') {
      await requirePermission(PERMISSIONS.ACCOUNTING_VIEW)
      const { listOutgoingPayments } = await import('@/features/outgoing-payments/queries')
      const rows = (
        await listOutgoingPayments({ restaurantId: user.restaurantId, branchIds })
      )
        .filter((row) => (type === 'expenses' ? row.kind === 'EXPENSE' : true))
        .filter((row) => {
          const at = new Date(row.paymentDate).getTime()
          return at >= canonicalRange.from.getTime() && at <= canonicalRange.to.getTime()
        })
      const columns = [
        { header: 'Number', key: 'number' },
        { header: 'Kind', key: 'kind' },
        { header: 'Status', key: 'status' },
        { header: 'Paid to', key: 'target' },
        { header: 'Category', key: 'category' },
        { header: 'Branch', key: 'branch' },
        { header: 'Method', key: 'method' },
        { header: 'Reference', key: 'reference' },
        { header: 'Payment date', key: 'date' },
        { header: 'Amount', key: 'amount' },
        { header: 'Raised by', key: 'by' },
        { header: 'Description', key: 'description' },
      ]
      const data = rows.map((row) => ({
        number: row.number,
        kind: row.kind,
        status: row.status,
        target: row.supplierName ?? '',
        category: row.categoryName ?? '',
        branch: row.branchName,
        method: row.method,
        reference: row.reference ?? '',
        date: row.paymentDate.slice(0, 10),
        amount: money(row.amount),
        by: row.createdByName,
        description: row.description,
      }))
      const name = type === 'expenses' ? 'expenses' : 'outgoing-payments'
      if (format === 'xlsx') {
        const buffer = await toExcel('Payments out', columns, data)
        return fileResponse(buffer, `${name}-${stamp}.xlsx`, XLSX_TYPE)
      }
      return fileResponse(Buffer.from(toCsv(columns, data)), `${name}-${stamp}.csv`, 'text/csv')
    }

    if (type === 'payables') {
      await requirePermission(PERMISSIONS.ACCOUNTING_VIEW)
      const { getPayablesStatement } = await import('@/features/suppliers/payables')
      const statement = await getPayablesStatement({
        restaurantId: user.restaurantId,
        range: canonicalRange,
        branchIds,
      })
      const columns = [
        { header: 'Supplier', key: 'supplier' },
        { header: 'Opening', key: 'opening' },
        { header: 'Received', key: 'received' },
        { header: 'Returned', key: 'returned' },
        { header: 'Paid', key: 'paid' },
        { header: 'Closing', key: 'closing' },
        { header: '0-30 days', key: 'a1' },
        { header: '31-60 days', key: 'a2' },
        { header: '61-90 days', key: 'a3' },
        { header: '90+ days', key: 'a4' },
      ]
      const data = statement.rows.map((row) => ({
        supplier: row.supplierName,
        opening: money(row.opening),
        received: money(row.received),
        returned: money(row.returned),
        paid: money(row.paid),
        closing: money(row.closing),
        a1: money(row.aging.current),
        a2: money(row.aging.d31to60),
        a3: money(row.aging.d61to90),
        a4: money(row.aging.d90plus),
      }))
      if (format === 'xlsx') {
        const buffer = await toExcel('Supplier payables', columns, data)
        return fileResponse(buffer, `payables-${stamp}.xlsx`, XLSX_TYPE)
      }
      return fileResponse(Buffer.from(toCsv(columns, data)), `payables-${stamp}.csv`, 'text/csv')
    }

    if (type === 'profit') {
      await requirePermission(PERMISSIONS.ACCOUNTING_VIEW)
      const { getProfitReport } = await import('@/features/reports/profit')
      const report = await getProfitReport({
        restaurantId: user.restaurantId,
        range: canonicalRange,
        branchIds,
      })
      const columns = [
        { header: 'Item', key: 'item' },
        { header: 'Sold', key: 'quantity' },
        { header: 'Revenue', key: 'revenue' },
        { header: 'Ingredient cost', key: 'cogs' },
        { header: 'Gross profit', key: 'grossProfit' },
        { header: 'Food cost %', key: 'foodCost' },
        { header: 'Margin %', key: 'margin' },
      ]
      const data = report.byItem.map((row) => ({
        item: row.label,
        quantity: row.quantity,
        revenue: money(row.revenue),
        cogs: money(row.cogs),
        grossProfit: money(row.grossProfit),
        foodCost: row.foodCostPercent === null ? '—' : `${row.foodCostPercent}%`,
        margin: row.grossMarginPercent === null ? '—' : `${row.grossMarginPercent}%`,
      }))
      if (format === 'xlsx') {
        const buffer = await toExcel('Menu profitability', columns, data)
        return fileResponse(buffer, `profit-${stamp}.xlsx`, XLSX_TYPE)
      }
      return fileResponse(Buffer.from(toCsv(columns, data)), `profit-${stamp}.csv`, 'text/csv')
    }

    if (type === 'pnl' || type === 'trial-balance' || type === 'journal') {
      await requirePermission(PERMISSIONS.ACCOUNTING_VIEW)
      const { getLedger } = await import('@/features/ledger/queries')
      const ledger = await getLedger({
        restaurantId: user.restaurantId,
        range: canonicalRange,
        branchIds,
      })

      if (type === 'pnl') {
        const pnl = ledger.profitAndLoss
        const columns = [
          { header: 'Line', key: 'line' },
          { header: 'Amount', key: 'amount' },
        ]
        const data = [
          { line: 'Sales', amount: money(pnl.revenue.grossSales) },
          { line: 'Discounts given', amount: money(-pnl.revenue.discounts) },
          { line: 'Refunds', amount: money(-pnl.revenue.refunds) },
          { line: 'Net sales', amount: money(pnl.revenue.netSales) },
          { line: 'Ingredient cost (COGS)', amount: money(-pnl.cogs) },
          { line: 'Gross profit', amount: money(pnl.grossProfit) },
          ...(pnl.revenue.serviceCharge !== 0
            ? [{ line: 'Service charge', amount: money(pnl.revenue.serviceCharge) }]
            : []),
          ...pnl.expenses.map((expense) => ({ line: expense.label, amount: money(-expense.amount) })),
          { line: 'Operating profit', amount: money(pnl.operatingProfit) },
        ]
        if (format === 'xlsx') {
          const buffer = await toExcel('Profit and loss', columns, data)
          return fileResponse(buffer, `pnl-${stamp}.xlsx`, XLSX_TYPE)
        }
        return fileResponse(Buffer.from(toCsv(columns, data)), `pnl-${stamp}.csv`, 'text/csv')
      }

      if (type === 'trial-balance') {
        const columns = [
          { header: 'Code', key: 'code' },
          { header: 'Account', key: 'account' },
          { header: 'Debits', key: 'debits' },
          { header: 'Credits', key: 'credits' },
          { header: 'Balance', key: 'balance' },
        ]
        const data = [
          ...ledger.trialBalance.rows.map((row) => ({
            code: row.code,
            account: row.name,
            debits: money(row.debits),
            credits: money(row.credits),
            balance: money(row.balance),
          })),
          {
            code: '',
            account: 'TOTAL',
            debits: money(ledger.trialBalance.totalDebits),
            credits: money(ledger.trialBalance.totalCredits),
            balance: ledger.trialBalance.balanced ? 'balanced' : 'NOT BALANCED',
          },
        ]
        if (format === 'xlsx') {
          const buffer = await toExcel('Trial balance', columns, data)
          return fileResponse(buffer, `trial-balance-${stamp}.xlsx`, XLSX_TYPE)
        }
        return fileResponse(Buffer.from(toCsv(columns, data)), `trial-balance-${stamp}.csv`, 'text/csv')
      }

      const columns = [
        { header: 'Date', key: 'date' },
        { header: 'Source', key: 'source' },
        { header: 'Reference', key: 'reference' },
        { header: 'Narrative', key: 'narrative' },
        { header: 'Account', key: 'account' },
        { header: 'Account name', key: 'accountName' },
        { header: 'Debit', key: 'debit' },
        { header: 'Credit', key: 'credit' },
      ]
      const data = ledger.entries.flatMap((entry) =>
        entry.lines.map((line) => ({
          date: entry.date.toISOString().slice(0, 10),
          source: entry.sourceType,
          reference: entry.sourceId,
          narrative: entry.narrative,
          account: line.account,
          accountName: line.accountName,
          debit: line.debit > 0 ? money(line.debit) : '',
          credit: line.credit > 0 ? money(line.credit) : '',
        })),
      )
      if (format === 'xlsx') {
        const buffer = await toExcel('Journal', columns, data)
        return fileResponse(buffer, `journal-${stamp}.xlsx`, XLSX_TYPE)
      }
      return fileResponse(Buffer.from(toCsv(columns, data)), `journal-${stamp}.csv`, 'text/csv')
    }

    if (type === 'orders') {
      /*
       * `listOrders` takes one optional branch, so a reach of two or more
       * cannot be expressed and used to fall through as `undefined` — meaning
       * NO filter, i.e. every branch in the business. `[]` fell through the
       * same way, which is the worse case: a user confined with nowhere to look
       * got everybody's orders.
       *
       * Refused rather than silently widened. An export that returns rows the
       * screen would not show is worth stopping, and the person can pick a
       * location and try again.
       */
      if (branchIds !== null && branchIds.length !== 1) {
        throw new AppError(
          branchIds.length === 0
            ? 'You are not assigned to a location, so there is nothing to export.'
            : 'Choose a single location before exporting orders.',
          400,
          'EXPORT_NEEDS_ONE_BRANCH',
        )
      }
      const onlyBranch = branchIds ? branchIds[0] : undefined

      // Paged through rather than truncated. The cap is a safety limit on the
      // size of a single download, not a silent horizon.
      const EXPORT_LIMIT = 10_000
      const PER_PAGE = 500
      const collected: Awaited<ReturnType<typeof listOrders>>['orders'] = []
      let result = await listOrders(user.restaurantId, {
        from: range.from.toISOString(),
        to: range.to.toISOString(),
        branchId: onlyBranch,
        perPage: PER_PAGE,
        page: 1,
      })
      collected.push(...result.orders)
      for (let page = 2; page <= result.pageCount && collected.length < EXPORT_LIMIT; page += 1) {
        const next = await listOrders(user.restaurantId, {
          from: range.from.toISOString(),
          to: range.to.toISOString(),
          branchId: onlyBranch,
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
    // The same vocabulary the screens use (§92): every label names exactly
    // what its number is, and nothing is called revenue that is not.
    const rows = [
      { metric: 'Orders', value: summary.orderCount },
      { metric: 'Gross sales (before discounts)', value: money(summary.grossSales) },
      { metric: 'Discounts', value: money(summary.discounts) },
      { metric: 'Refunds', value: money(summary.refunds) },
      { metric: 'Net sales', value: money(summary.netSales) },
      { metric: 'Tax collected (not revenue)', value: money(summary.tax) },
      { metric: 'Service charge (not revenue)', value: money(summary.serviceCharge) },
      { metric: 'Tips (staff money)', value: money(summary.tips) },
      { metric: 'Collected (payments in − refunds out)', value: money(summary.collected) },
      { metric: 'Food cost (COGS)', value: money(summary.foodCost) },
      { metric: 'Gross profit', value: money(summary.grossProfit) },
      { metric: 'Average order (net)', value: money(summary.averageOrderValue) },
      { metric: 'Unique customers', value: summary.uniqueCustomers },
    ]
    return fileResponse(Buffer.from(toCsv(columns, rows)), `report-${stamp}.csv`, 'text/csv')
  } catch (error) {
    const app = toAppError(error)
    return NextResponse.json({ error: app.message, code: app.code }, { status: app.status })
  }
}

const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

/**
 * The two cash reports, exported with every active filter applied.
 *
 * Both go through the same generic `toCsv` / `toExcel` pair the rest of this
 * route uses — a new report type is a column list and a row mapping, not new
 * machinery. Money is formatted rather than exported as minor units, because
 * the person opening this file is an accountant, not a program.
 */
async function exportCash(args: {
  type: string
  format: string
  stamp: string
  money: (value: number) => string
  restaurantId: string
  currency: string
  range: CanonicalRange
  branchIds: string[] | null
  branchId: string | null
  params: URLSearchParams
}) {
  const { params, money } = args
  const value = (key: string) => params.get(key) || null

  if (args.type === 'petty') {
    const report = await getPettyCashReport({
      restaurantId: args.restaurantId,
      range: args.range,
      branchIds: args.branchIds,
      branchId: args.branchId,
      status: (value('status') as never) ?? null,
      category: value('category'),
    })

    const columns = [
      { header: 'Date', key: 'date' },
      { header: 'Branch', key: 'branch' },
      { header: 'Category', key: 'category' },
      { header: 'Description', key: 'description' },
      { header: 'Amount', key: 'amount' },
      { header: 'Paid from', key: 'source' },
      { header: 'Requested by', key: 'requestedBy' },
      { header: 'Approved by', key: 'approvedBy' },
      { header: 'Paid by', key: 'paidBy' },
      { header: 'Status', key: 'status' },
      { header: 'Reference', key: 'reference' },
    ]
    const rows = report.rows.map((r) => ({
      date: r.requestedAt.toISOString().slice(0, 10),
      branch: r.branchName,
      category: r.category,
      description: r.description,
      amount: money(r.amount),
      source: r.paidFrom === 'PETTY_FUND' ? 'Tin' : 'Drawer',
      requestedBy: r.requestedByName ?? '',
      approvedBy: r.decidedByName ?? '',
      paidBy: r.paidByName ?? '',
      status: r.status,
      reference: r.reference ?? '',
    }))

    if (args.format === 'xlsx') {
      const buffer = await toExcel('Petty cash', columns, rows)
      return fileResponse(buffer, `petty-cash-${args.stamp}.xlsx`, XLSX_TYPE)
    }
    return fileResponse(
      Buffer.from(toCsv(columns, rows)),
      `petty-cash-${args.stamp}.csv`,
      'text/csv',
    )
  }

  const report = await getCashDrawerReport({
    restaurantId: args.restaurantId,
    range: args.range,
    branchIds: args.branchIds,
    branchId: args.branchId,
    registerId: value('register'),
    cashierId: value('cashier'),
    status: (value('status') as never) ?? null,
  })

  const columns = [
    { header: 'Session', key: 'session' },
    { header: 'Branch', key: 'branch' },
    { header: 'Till', key: 'register' },
    { header: 'Cashier', key: 'cashier' },
    { header: 'Opened', key: 'opened' },
    { header: 'Closed', key: 'closed' },
    { header: 'Status', key: 'status' },
    { header: 'Opening float', key: 'opening' },
    { header: 'Opening petty cash', key: 'openingPetty' },
    { header: 'Cash sales', key: 'cashSales' },
    { header: 'Non-cash', key: 'nonCash' },
    { header: 'Cash in', key: 'cashIn' },
    { header: 'Cash out', key: 'cashOut' },
    { header: 'Refunds', key: 'refunds' },
    { header: 'Petty cash paid', key: 'petty' },
    { header: 'Cash drops', key: 'drops' },
    { header: 'Bank deposits', key: 'deposits' },
    { header: 'Expected', key: 'expected' },
    { header: 'Counted', key: 'counted' },
    { header: 'Variance', key: 'variance' },
    { header: 'Reason', key: 'reason' },
    { header: 'Closed by', key: 'closedBy' },
    { header: 'Signed off by', key: 'reviewedBy' },
  ]
  const rows = report.rows.map((r) => ({
    session: r.sessionNumber,
    branch: r.branchName,
    register: r.registerName,
    cashier: r.cashierName,
    opened: r.openedAt.toISOString(),
    closed: r.closedAt?.toISOString() ?? '',
    status: r.status,
    opening: money(r.openingFloat),
    openingPetty: money(r.openingPettyCash),
    cashSales: money(r.cashSales),
    nonCash: money(r.nonCashSales),
    cashIn: money(r.cashIn),
    cashOut: money(r.cashOut),
    refunds: money(r.refunds),
    petty: money(r.pettyCashPaid),
    drops: money(r.drops),
    deposits: money(r.bankDeposits),
    expected: money(r.expectedCash),
    counted: r.countedCash === null ? '' : money(r.countedCash),
    variance: r.variance === null ? '' : money(r.variance),
    reason: r.varianceReason ?? '',
    closedBy: r.closedByName ?? '',
    reviewedBy: r.reviewedByName ?? '',
  }))

  if (args.format === 'xlsx') {
    const buffer = await toExcel('Cash drawers', columns, rows)
    return fileResponse(buffer, `cash-drawers-${args.stamp}.xlsx`, XLSX_TYPE)
  }
  return fileResponse(
    Buffer.from(toCsv(columns, rows)),
    `cash-drawers-${args.stamp}.csv`,
    'text/csv',
  )
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
