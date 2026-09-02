import 'server-only'
import ExcelJS from 'exceljs'

import { formatMoney } from '@/lib/money'
import type { ReportSummary } from '@/features/analytics/queries'

export interface ExportColumn {
  header: string
  key: string
  width?: number
  money?: boolean
}

/** Escapes a value for CSV, guarding against formula-injection. */
function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value)
  // A leading =, +, - or @ can be interpreted as a formula by spreadsheets.
  const guarded = /^[=+\-@]/.test(text) ? `'${text}` : text
  return /[",\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded
}

export function toCsv(columns: ExportColumn[], rows: Array<Record<string, unknown>>): string {
  const header = columns.map((column) => csvCell(column.header)).join(',')
  const body = rows
    .map((row) => columns.map((column) => csvCell(row[column.key])).join(','))
    .join('\n')
  return `${header}\n${body}`
}

export async function toExcel(
  sheetName: string,
  columns: ExportColumn[],
  rows: Array<Record<string, unknown>>,
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'TableFlow'
  workbook.created = new Date()

  const sheet = workbook.addWorksheet(sheetName.slice(0, 30))
  sheet.columns = columns.map((column) => ({
    header: column.header,
    key: column.key,
    width: column.width ?? 18,
  }))

  sheet.getRow(1).font = { bold: true }
  sheet.getRow(1).fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFF3F4F6' },
  }

  rows.forEach((row) => sheet.addRow(row))
  sheet.views = [{ state: 'frozen', ySplit: 1 }]

  const arrayBuffer = await workbook.xlsx.writeBuffer()
  return Buffer.from(arrayBuffer)
}

/** Builds a multi-section sales report as an Excel workbook. */
export async function buildReportWorkbook(
  summary: ReportSummary,
  currency: string,
  restaurantName: string,
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'TableFlow'
  workbook.created = new Date()

  const money = (value: number) => formatMoney(value, currency)

  // ── overview ──
  const overview = workbook.addWorksheet('Summary')
  overview.columns = [
    { header: 'Metric', key: 'metric', width: 28 },
    { header: 'Value', key: 'value', width: 24 },
  ]
  overview.getRow(1).font = { bold: true }
  const rows: Array<[string, string]> = [
    ['Restaurant', restaurantName],
    ['From', summary.range.from.toLocaleDateString()],
    ['To', summary.range.to.toLocaleDateString()],
    ['Orders', String(summary.orderCount)],
    ['Cancelled', String(summary.cancelledCount)],
    ['Gross sales (before discounts)', money(summary.grossSales)],
    ['Refunds', money(summary.refunds)],
    ['Net sales', money(summary.netSales)],
    ['Collected (payments − refunds)', money(summary.collected)],
    ['Tax collected', money(summary.tax)],
    ['Service charge', money(summary.serviceCharge)],
    ['Discounts', money(summary.discounts)],
    ['Tips', money(summary.tips)],
    ['Food cost', money(summary.foodCost)],
    ['Gross profit', money(summary.grossProfit)],
    ['Average order', money(summary.averageOrderValue)],
    ['Unique customers', String(summary.uniqueCustomers)],
  ]
  rows.forEach(([metric, value]) => overview.addRow({ metric, value }))

  // ── payments ──
  const payments = workbook.addWorksheet('Payments')
  payments.columns = [
    { header: 'Method', key: 'method', width: 18 },
    { header: 'Count', key: 'count', width: 12 },
    { header: 'Amount', key: 'amount', width: 20 },
  ]
  payments.getRow(1).font = { bold: true }
  summary.payments.forEach((row) =>
    payments.addRow({ method: row.method, count: row.count, amount: money(row.amount) }),
  )

  // ── top items ──
  const items = workbook.addWorksheet('Top items')
  items.columns = [
    { header: 'Item', key: 'name', width: 32 },
    { header: 'Quantity', key: 'quantity', width: 14 },
    { header: 'Revenue', key: 'revenue', width: 20 },
  ]
  items.getRow(1).font = { bold: true }
  summary.topItems.forEach((row) =>
    items.addRow({ name: row.name, quantity: row.quantity, revenue: money(row.revenue) }),
  )

  const arrayBuffer = await workbook.xlsx.writeBuffer()
  return Buffer.from(arrayBuffer)
}
