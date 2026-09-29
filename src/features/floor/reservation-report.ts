import 'server-only'

import type { ReservationStatus } from '@prisma/client'

import { prisma } from '@/server/db/prisma'

/**
 * The reservations report: how many bookings, for how many people, how many
 * were honoured, cancelled or never arrived — and where and when they fall.
 *
 * Read by `reservedAt` (the booking's own time), not by when it was taken:
 * "last week's bookings" means the tables that were held last week. A
 * cancelled booking stays in its slot and counts as cancelled; nothing is
 * counted twice.
 */

export interface ReservationReportData {
  bookings: number
  bookingsChange: number | null
  covers: number
  honoured: number
  /** Honoured over everything that was not cancelled; null with nothing to judge. */
  honouredRate: number | null
  cancelled: number
  noShows: number
  upcoming: number
  trend: Array<{ date: string; bookings: number; covers: number; cancelled: number }>
  byStatus: Array<{ status: ReservationStatus; count: number; share: number }>
  byTable: Array<{ table: string; branch: string | null; bookings: number; covers: number; noShows: number }>
  byHour: Array<{ hour: number; bookings: number; covers: number }>
  cancellations: Array<{
    id: string
    guest: string
    reservedAt: string
    table: string | null
    partySize: number
    status: 'CANCELLED' | 'NO_SHOW'
    reason: string | null
    by: string | null
    cancelledAt: string | null
  }>
}

function dayKey(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date)
}

function hourOf(date: Date, timeZone: string): number {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hourCycle: 'h23' }).format(date))
}

function daysBetween(from: Date, to: Date, timeZone: string): string[] {
  const days: string[] = []
  const seen = new Set<string>()
  for (let t = from.getTime(); t <= to.getTime(); t += 6 * 3_600_000) {
    const key = dayKey(new Date(t), timeZone)
    if (!seen.has(key)) {
      seen.add(key)
      days.push(key)
    }
  }
  const last = dayKey(to, timeZone)
  if (!seen.has(last)) days.push(last)
  return days
}

export async function getReservationReport(params: {
  restaurantId: string
  branchIds: string[] | null
  from: Date
  to: Date
  previous: { from: Date; to: Date }
  timeZone: string
  now?: Date
}): Promise<ReservationReportData> {
  const { restaurantId, from, to, timeZone } = params
  const now = params.now ?? new Date()
  const branch = params.branchIds ? { branchId: { in: params.branchIds } } : {}

  const [rows, previousCount, upcoming] = await Promise.all([
    prisma.reservation.findMany({
      where: { restaurantId, ...branch, reservedAt: { gte: from, lte: to } },
      orderBy: { reservedAt: 'asc' },
      select: {
        id: true, customerName: true, partySize: true, reservedAt: true, status: true,
        cancelledAt: true, cancelReason: true, cancelledByName: true,
        table: { select: { number: true } },
        branch: { select: { name: true } },
      },
    }),
    prisma.reservation.count({
      where: { restaurantId, ...branch, reservedAt: { gte: params.previous.from, lte: params.previous.to } },
    }),
    prisma.reservation.count({
      where: { restaurantId, ...branch, reservedAt: { gt: now }, status: { in: ['PENDING', 'CONFIRMED'] } },
    }),
  ])

  const honouredStatuses: ReservationStatus[] = ['SEATED', 'COMPLETED']
  const bookings = rows.length
  const covers = rows.reduce((sum, row) => sum + row.partySize, 0)
  const honoured = rows.filter((row) => honouredStatuses.includes(row.status)).length
  const cancelled = rows.filter((row) => row.status === 'CANCELLED').length
  const noShows = rows.filter((row) => row.status === 'NO_SHOW').length
  const judged = bookings - cancelled

  const perDay = new Map<string, { bookings: number; covers: number; cancelled: number }>()
  for (const day of daysBetween(from, to, timeZone)) perDay.set(day, { bookings: 0, covers: 0, cancelled: 0 })
  const perStatus = new Map<ReservationStatus, number>()
  const perTable = new Map<string, { table: string; branch: string | null; bookings: number; covers: number; noShows: number }>()
  const perHour = new Map<number, { bookings: number; covers: number }>()

  for (const row of rows) {
    const day = perDay.get(dayKey(row.reservedAt, timeZone)) ?? { bookings: 0, covers: 0, cancelled: 0 }
    day.bookings += 1
    day.covers += row.partySize
    if (row.status === 'CANCELLED') day.cancelled += 1
    perDay.set(dayKey(row.reservedAt, timeZone), day)

    perStatus.set(row.status, (perStatus.get(row.status) ?? 0) + 1)

    if (row.table) {
      const key = `${row.branch?.name ?? ''}:${row.table.number}`
      const entry = perTable.get(key) ?? { table: row.table.number, branch: row.branch?.name ?? null, bookings: 0, covers: 0, noShows: 0 }
      entry.bookings += 1
      entry.covers += row.partySize
      if (row.status === 'NO_SHOW') entry.noShows += 1
      perTable.set(key, entry)
    }

    if (row.status !== 'CANCELLED') {
      const hour = hourOf(row.reservedAt, timeZone)
      const entry = perHour.get(hour) ?? { bookings: 0, covers: 0 }
      entry.bookings += 1
      entry.covers += row.partySize
      perHour.set(hour, entry)
    }
  }

  return {
    bookings,
    bookingsChange: previousCount > 0 ? (bookings - previousCount) / previousCount : null,
    covers,
    honoured,
    honouredRate: judged > 0 ? honoured / judged : null,
    cancelled,
    noShows,
    upcoming,
    trend: [...perDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, v]) => ({ date, ...v })),
    byStatus: [...perStatus.entries()]
      .map(([status, count]) => ({ status, count, share: bookings ? count / bookings : 0 }))
      .sort((a, b) => b.count - a.count),
    byTable: [...perTable.values()].sort((a, b) => b.bookings - a.bookings).slice(0, 10),
    byHour: [...perHour.entries()].map(([hour, v]) => ({ hour, ...v })).sort((a, b) => b.bookings - a.bookings).slice(0, 8),
    cancellations: rows
      .filter((row) => row.status === 'CANCELLED' || row.status === 'NO_SHOW')
      .sort((a, b) => b.reservedAt.getTime() - a.reservedAt.getTime())
      .slice(0, 12)
      .map((row) => ({
        id: row.id,
        guest: row.customerName,
        reservedAt: row.reservedAt.toISOString(),
        table: row.table?.number ?? null,
        partySize: row.partySize,
        status: row.status as 'CANCELLED' | 'NO_SHOW',
        reason: row.cancelReason,
        by: row.cancelledByName,
        cancelledAt: row.cancelledAt?.toISOString() ?? null,
      })),
  }
}
