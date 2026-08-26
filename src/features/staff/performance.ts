import 'server-only'

import type { Prisma } from '@prisma/client'

import { prisma } from '@/server/db/prisma'
import type { DateRange } from '@/features/reports/range'
import { effectiveShift, listShifts, autoCloseStale } from '@/features/attendance/service'

/**
 * What each person did at one location, over one period.
 *
 * ── Three groups, never one league table ────────────────────────────────────
 *
 * Attendance, sales and cash accountability are reported separately and never
 * added into a single score. A cook rings up nothing and a cashier serves no
 * tables; ranking them against each other produces a number that is confidently
 * wrong about both. The screen shows each group to the people it means something
 * for, and says plainly where a figure cannot be earned.
 *
 * ── Who appears ─────────────────────────────────────────────────────────────
 *
 * Whoever worked HERE, not whoever is rostered here. Somebody covering an
 * evening at a second site appears under that site for that evening, with those
 * sales — which is the only reading under which a branch's figures are its own.
 *
 * ── Two attribution columns, kept apart ─────────────────────────────────────
 *
 * `Order.servedById` is whose table it is; `Order.createdById` is who keyed it
 * in. The schema warns that collapsing them "would credit the till instead of
 * the person serving", and it is right — a cashier ringing up a waiter's table
 * is the normal case, not an edge one. They are reported as two different
 * numbers with two different names.
 */

export interface StaffSalesRow {
  userId: string
  name: string
  role: string
  staffCode: string | null
  /** Orders whose table this was. Counter sales are excluded — see below. */
  ordersServed: number
  servedRevenue: number
  /** Orders this person keyed in, wherever the credit for serving went. */
  ordersRung: number
  rungRevenue: number
  paymentsTaken: number
  paymentTotal: number
}

export interface BranchStaffPerformance {
  rows: StaffSalesRow[]
  /**
   * Orders that name nobody.
   *
   * A guest scanning the QR code and ordering from their phone has no server
   * and no cashier, so the money is real and the person is not. Reported
   * explicitly, because per-person figures that quietly omit 60% of a branch's
   * revenue invite exactly the wrong conclusion about the staff who are listed.
   * Same idea as `getUnattributedCash` for the till.
   */
  unattributed: { orders: number; revenue: number }
  /** Every order at this branch in the period, so the parts can be checked. */
  total: { orders: number; revenue: number }
}

/**
 * Counter sales credit the person at the till as the "server".
 *
 * `createStaffOrder` writes `servedById: data.servedById || user.id`, which is
 * deliberate and right — somebody has to own a walk-in. But it means a cashier
 * on a busy counter would top a "tables served" ranking without ever having
 * been near a table. Fixed at the reporting layer, not at the write: they are
 * counted under orders RUNG, which is what actually happened.
 */
const SERVED_CHANNELS: Prisma.EnumOrderChannelFilter = { notIn: ['COUNTER', 'QR'] }

export async function getBranchStaffPerformance(params: {
  restaurantId: string
  /**
   * Which locations count. `null` is every one of them — the analytics page
   * looking at the whole business — and `[]` is none, which is what a person
   * confined to no location can see. The two are not the same, and reading an
   * empty list as "no filter" is the bug that leaked a branch's figures before.
   */
  branchIds: string[] | null
  range: DateRange
}): Promise<BranchStaffPerformance> {
  const window = { gte: params.range.from, lte: params.range.to }
  const scope = params.branchIds ? { branchId: { in: params.branchIds } } : {}
  const atBranch = { restaurantId: params.restaurantId, ...scope }

  const [served, rung, payments, unattributed, total, people] = await Promise.all([
    prisma.order.groupBy({
      by: ['servedById'],
      where: { ...atBranch, placedAt: window, servedById: { not: null }, channel: SERVED_CHANNELS },
      _sum: { grandTotal: true },
      _count: true,
    }),
    prisma.order.groupBy({
      by: ['createdById'],
      where: { ...atBranch, placedAt: window, createdById: { not: null } },
      _sum: { grandTotal: true },
      _count: true,
    }),
    /*
     * `Payment` has no branch of its own — it reaches one through its order,
     * which is the documented shape for this model rather than an omission.
     */
    prisma.payment.groupBy({
      by: ['receivedById'],
      where: {
        restaurantId: params.restaurantId,
        paidAt: window,
        status: 'PAID',
        receivedById: { not: null },
        ...(params.branchIds ? { order: { branchId: { in: params.branchIds } } } : {}),
      },
      _sum: { amount: true },
      _count: true,
    }),
    prisma.order.aggregate({
      where: { ...atBranch, placedAt: window, createdById: null, servedById: null },
      _sum: { grandTotal: true },
      _count: true,
    }),
    prisma.order.aggregate({
      where: { ...atBranch, placedAt: window },
      _sum: { grandTotal: true },
      _count: true,
    }),
    prisma.user.findMany({
      where: { restaurantId: params.restaurantId, deletedAt: null },
      select: { id: true, name: true, role: true, staffCode: true },
    }),
  ])

  const byId = new Map(people.map((p) => [p.id, p]))
  const ids = new Set<string>()
  for (const row of served) if (row.servedById) ids.add(row.servedById)
  for (const row of rung) if (row.createdById) ids.add(row.createdById)
  for (const row of payments) if (row.receivedById) ids.add(row.receivedById)

  const rows: StaffSalesRow[] = [...ids].map((id) => {
    const person = byId.get(id)
    const s = served.find((r) => r.servedById === id)
    const c = rung.find((r) => r.createdById === id)
    const p = payments.find((r) => r.receivedById === id)
    return {
      userId: id,
      // A deleted account keeps its work: the money happened, and hiding it
      // would leave the parts not adding up to the total.
      name: person?.name ?? 'Removed account',
      role: person?.role ?? '—',
      staffCode: person?.staffCode ?? null,
      ordersServed: s?._count ?? 0,
      servedRevenue: s?._sum.grandTotal ?? 0,
      ordersRung: c?._count ?? 0,
      rungRevenue: c?._sum.grandTotal ?? 0,
      paymentsTaken: p?._count ?? 0,
      paymentTotal: p?._sum.amount ?? 0,
    }
  })

  rows.sort((a, b) => b.paymentTotal + b.rungRevenue - (a.paymentTotal + a.rungRevenue))

  return {
    rows,
    unattributed: {
      orders: unattributed._count,
      revenue: unattributed._sum.grandTotal ?? 0,
    },
    total: { orders: total._count, revenue: total._sum.grandTotal ?? 0 },
  }
}

export interface AttendanceRow {
  userId: string
  name: string
  role: string
  staffCode: string | null
  shifts: Array<{
    id: string
    startedAt: string
    endedAt: string | null
    minutes: number
    onShift: boolean
    idleOnly: boolean
    corrected: boolean
    closedBy: string | null
    adjustedByName: string | null
    adjustReason: string | null
  }>
  totalMinutes: number
  days: number
  onShiftNow: boolean
}

/**
 * Who was here, and for how long.
 *
 * Stale shifts are closed on the way in. There is no job runner in this
 * deployment, so the screen that wants correct hours is the thing that makes
 * them correct — idempotent, so it does not matter how often it runs.
 */
export async function getBranchAttendance(params: {
  restaurantId: string
  branchId: string
  range: DateRange
  /** Narrow to one person — somebody looking at their own hours. */
  userId?: string
}): Promise<{ rows: AttendanceRow[]; totalMinutes: number; onShiftNow: number }> {
  await autoCloseStale({ restaurantId: params.restaurantId }).catch(() => 0)

  const shifts = await listShifts({
    restaurantId: params.restaurantId,
    branchId: params.branchId,
    from: params.range.from,
    to: params.range.to,
    userId: params.userId,
  })

  const now = new Date()
  const byUser = new Map<string, AttendanceRow>()

  for (const shift of shifts) {
    const eff = effectiveShift(shift, now)
    let row = byUser.get(shift.userId)
    if (!row) {
      row = {
        userId: shift.userId,
        name: shift.user.name,
        role: shift.user.role,
        staffCode: shift.user.staffCode,
        shifts: [],
        totalMinutes: 0,
        days: 0,
        onShiftNow: false,
      }
      byUser.set(shift.userId, row)
    }

    row.shifts.push({
      id: shift.id,
      startedAt: eff.startedAt.toISOString(),
      endedAt: eff.endedAt?.toISOString() ?? null,
      minutes: eff.minutes,
      onShift: eff.onShift,
      idleOnly: eff.idleOnly,
      corrected: eff.corrected,
      closedBy: shift.closedBy,
      adjustedByName: shift.adjustedBy?.name ?? null,
      adjustReason: shift.adjustReason,
    })
    // A sign-in nobody followed up on is not time worked, so it is listed but
    // contributes nothing to the total.
    if (!eff.idleOnly) row.totalMinutes += eff.minutes
    if (eff.onShift) row.onShiftNow = true
  }

  for (const row of byUser.values()) {
    row.days = new Set(row.shifts.map((s) => s.startedAt.slice(0, 10))).size
  }

  const rows = [...byUser.values()].sort((a, b) => b.totalMinutes - a.totalMinutes)
  return {
    rows,
    totalMinutes: rows.reduce((sum, r) => sum + r.totalMinutes, 0),
    onShiftNow: rows.filter((r) => r.onShiftNow).length,
  }
}

/**
 * What people did here, newest first.
 *
 * The branch filter is the one from the audit screen and for the same reason:
 * `AuditLog.branchId` is nullable and most `audit()` calls never pass one, so
 * filtering on the column alone would hide nearly everything. Who did it is
 * always recorded, so the actor's own location stands in — ORed, and wrapped in
 * an `AND` because a sibling `OR` key would silently replace the first.
 */
export async function getBranchStaffActivity(params: {
  restaurantId: string
  branchId: string
  range: DateRange
  userId?: string
  limit?: number
}) {
  return prisma.auditLog.findMany({
    where: {
      AND: [
        { restaurantId: params.restaurantId },
        { createdAt: { gte: params.range.from, lte: params.range.to } },
        ...(params.userId ? [{ userId: params.userId }] : [{ userId: { not: null } }]),
        {
          OR: [
            { branchId: params.branchId },
            { user: { is: { branchId: params.branchId } } },
          ],
        },
      ],
    },
    orderBy: { createdAt: 'desc' },
    take: params.limit ?? 100,
    select: {
      id: true,
      action: true,
      entity: true,
      entityId: true,
      actorName: true,
      createdAt: true,
      user: { select: { id: true, name: true, role: true } },
    },
  })
}
