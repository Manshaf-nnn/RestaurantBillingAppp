import 'server-only'

import { listShiftHandovers } from '@/features/handover/shift-service'
import type { ExportColumn } from '@/features/reports/export'
import { formatDateTime } from '@/lib/datetime'
import { listShiftAssignments, listShiftHistory } from './queries'
import { dateKeyIn } from './service'

/**
 * The shift exports (shifthandover.md "Admin must be able to export …").
 *
 * Three files, one shape: the rows are the same rows the screen shows, with
 * the same filters, so a download is never a way to see what the screen
 * would not show. Times are written in the restaurant's own zone; money in
 * major units through the caller's formatter, like every other export.
 */

export type ShiftExportType = 'shift-assignments' | 'shift-sessions' | 'shift-handovers'

export const SHIFT_EXPORT_TYPES: ShiftExportType[] = ['shift-assignments', 'shift-sessions', 'shift-handovers']

export function isShiftExportType(type: string): type is ShiftExportType {
  return (SHIFT_EXPORT_TYPES as string[]).includes(type)
}

export async function buildShiftExport(params: {
  type: ShiftExportType
  restaurantId: string
  timeZone: string
  from: Date
  to: Date
  branchIds: string[] | null
  staffId?: string
  templateId?: string
  status?: string
  q?: string
  money: (minor: number) => string
}): Promise<{ name: string; columns: ExportColumn[]; rows: Array<Record<string, unknown>> }> {
  const when = (value: string | null | undefined) =>
    value ? formatDateTime(value, { timeZone: params.timeZone }) : ''

  if (params.type === 'shift-assignments') {
    const rows = await listShiftAssignments({
      restaurantId: params.restaurantId,
      branchIds: params.branchIds,
      from: dateKeyIn(params.from, params.timeZone),
      to: dateKeyIn(params.to, params.timeZone),
      userId: params.staffId,
      templateId: params.templateId,
      status: ['PLANNED', 'STARTED', 'COMPLETED', 'CANCELLED'].includes(params.status ?? '')
        ? (params.status as 'PLANNED')
        : undefined,
      q: params.q,
      limit: 10_000,
    })
    return {
      name: 'Shift assignments',
      columns: [
        { header: 'Date', key: 'date' },
        { header: 'Location', key: 'branch' },
        { header: 'Staff', key: 'staff' },
        { header: 'Role', key: 'role' },
        { header: 'Shift', key: 'shift' },
        { header: 'Scheduled start', key: 'scheduledStart' },
        { header: 'Scheduled end', key: 'scheduledEnd' },
        { header: 'Actual start', key: 'actualStart' },
        { header: 'Actual end', key: 'actualEnd' },
        { header: 'Status', key: 'status' },
        { header: 'Notes', key: 'notes' },
      ],
      rows: rows.map((row) => ({
        date: row.date,
        branch: row.branchName,
        staff: row.userName,
        role: row.roleLabel,
        shift: row.templateName,
        scheduledStart: when(row.scheduledStartAt),
        scheduledEnd: when(row.scheduledEndAt),
        actualStart: when(row.actualStartAt),
        actualEnd: when(row.actualEndAt),
        status: row.status,
        notes: row.notes ?? '',
      })),
    }
  }

  if (params.type === 'shift-sessions') {
    const rows = await listShiftHistory({
      restaurantId: params.restaurantId,
      branchIds: params.branchIds,
      userId: params.staffId,
      templateId: params.templateId,
      from: params.from,
      to: params.to,
      q: params.q,
      limit: 10_000,
    })
    return {
      name: 'Shift sessions',
      columns: [
        { header: 'Date', key: 'date' },
        { header: 'Staff', key: 'staff' },
        { header: 'Role', key: 'role' },
        { header: 'Location', key: 'branch' },
        { header: 'Shift', key: 'shift' },
        { header: 'Scheduled start', key: 'scheduledStart' },
        { header: 'Scheduled end', key: 'scheduledEnd' },
        { header: 'Actual start', key: 'start' },
        { header: 'Actual end', key: 'end' },
        { header: 'Minutes', key: 'minutes' },
        { header: 'Source', key: 'source' },
        { header: 'Ended by', key: 'closedBy' },
        { header: 'Corrected', key: 'corrected' },
      ],
      rows: rows.map((row) => ({
        date: row.date,
        staff: row.userName,
        role: row.roleLabel,
        branch: row.branchName,
        shift: row.templateName ?? 'Unscheduled',
        scheduledStart: when(row.scheduledStartAt),
        scheduledEnd: when(row.scheduledEndAt),
        start: when(row.startedAt),
        end: row.endedAt ? when(row.endedAt) : row.onShift ? 'on shift' : '',
        minutes: row.minutes,
        source: row.source,
        closedBy: row.closedBy ?? '',
        corrected: row.corrected ? 'yes' : '',
      })),
    }
  }

  const rows = await listShiftHandovers({
    restaurantId: params.restaurantId,
    branchIds: params.branchIds,
    participantId: params.staffId,
    templateId: params.templateId,
    status: ['PENDING_ACCEPTANCE', 'COMPLETED', 'REJECTED', 'CANCELLED'].includes(params.status ?? '')
      ? (params.status as 'COMPLETED')
      : undefined,
    from: params.from,
    to: params.to,
    q: params.q,
    limit: 10_000,
  })
  return {
    name: 'Shift handovers',
    columns: [
      { header: 'Date', key: 'date' },
      { header: 'Location', key: 'branch' },
      { header: 'Outgoing', key: 'from' },
      { header: 'Receiving', key: 'to' },
      { header: 'Shift', key: 'shift' },
      { header: 'Status', key: 'status' },
      { header: 'Decided at', key: 'decidedAt' },
      { header: 'Decided by', key: 'decidedBy' },
      { header: 'Opening cash', key: 'openingFloat' },
      { header: 'Cash sales', key: 'cashSales' },
      { header: 'Counted', key: 'counted' },
      { header: 'Expected', key: 'expected' },
      { header: 'Variance', key: 'variance' },
      { header: 'Till status', key: 'tillStatus' },
      { header: 'Open orders', key: 'openOrders' },
      { header: 'Open tasks', key: 'openTasks' },
      { header: 'Reject reason', key: 'rejectReason' },
      { header: 'Notes', key: 'notes' },
    ],
    rows: rows.map((row) => ({
      date: when(row.createdAt),
      branch: row.branchName,
      from: row.fromName,
      to: row.toName,
      shift: row.templateName ?? '',
      status: row.status,
      decidedAt: when(row.decidedAt),
      decidedBy: row.decidedByName ?? '',
      openingFloat: row.summary.drawer ? params.money(row.summary.drawer.openingFloat) : '',
      cashSales: row.summary.drawer?.cashSales !== undefined ? params.money(row.summary.drawer.cashSales) : '',
      counted: row.cash ? params.money(row.cash.countedAmount) : '',
      expected: row.cash ? params.money(row.cash.expectedAmount) : '',
      variance: row.cash ? params.money(row.cash.variance) : '',
      tillStatus: row.cash?.status ?? '',
      openOrders: row.summary.orders.open,
      openTasks: row.summary.tasks.length,
      rejectReason: row.rejectReason ?? '',
      notes: row.notes ?? '',
    })),
  }
}
