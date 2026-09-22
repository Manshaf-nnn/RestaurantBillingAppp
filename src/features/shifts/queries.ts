import 'server-only'

import type { Prisma, ShiftAssignmentStatus, UserRole } from '@prisma/client'

import { ROLE_LABELS } from '@/lib/rbac'
import { prisma } from '@/server/db/prisma'
import { effectiveShift } from '@/features/attendance/service'
import { listTransfers } from '@/features/transfers/queries'
import { listAwaitingDelivery } from '@/features/purchasing/queries'
import { dateKeyIn, dateKeyOf, isOvernight, zonedToUtc } from './service'
import type {
  CurrentShiftView,
  RotaStaffOption,
  ShiftAssignmentView,
  ShiftHistoryRow,
  ShiftTemplateView,
} from './types'

/**
 * Reads for the shift screens (shifthandover.md). Every one takes the
 * branches the caller may see — `null` for all, `[]` for none — and never
 * decides that itself: whether somebody may see a site is a permission
 * question, and queries do not read permissions.
 */

const OPEN_ORDER_STATUSES = ['PENDING', 'ACCEPTED', 'PREPARING', 'READY', 'SERVED'] as const

function branchClause(branchIds: string[] | null): Prisma.StringFilter | undefined {
  return branchIds ? { in: branchIds } : undefined
}

/* ── templates ──────────────────────────────────────────────────────────── */

export async function listShiftTemplates(params: {
  restaurantId: string
  branchIds: string[] | null
  includeInactive?: boolean
}): Promise<ShiftTemplateView[]> {
  const rows = await prisma.shiftTemplate.findMany({
    where: {
      restaurantId: params.restaurantId,
      ...(params.includeInactive ? {} : { isActive: true }),
      // Group-wide templates belong to every site; site ones only to theirs.
      ...(params.branchIds ? { OR: [{ branchId: null }, { branchId: { in: params.branchIds } }] } : {}),
    },
    orderBy: [{ sortOrder: 'asc' }, { startTime: 'asc' }, { name: 'asc' }],
    include: { branch: { select: { name: true } } },
  })
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    startTime: row.startTime,
    endTime: row.endTime,
    overnight: isOvernight(row),
    roles: row.roles,
    branchId: row.branchId,
    branchName: row.branch?.name ?? null,
    isActive: row.isActive,
    sortOrder: row.sortOrder,
  }))
}

/* ── the rota ───────────────────────────────────────────────────────────── */

export async function listShiftAssignments(params: {
  restaurantId: string
  branchIds: string[] | null
  /** "YYYY-MM-DD" inclusive. */
  from: string
  to: string
  userId?: string
  templateId?: string
  status?: ShiftAssignmentStatus
  q?: string
  limit?: number
}): Promise<ShiftAssignmentView[]> {
  const term = params.q?.trim()
  const rows = await prisma.shiftAssignment.findMany({
    where: {
      restaurantId: params.restaurantId,
      branchId: branchClause(params.branchIds),
      date: { gte: new Date(`${params.from}T00:00:00.000Z`), lte: new Date(`${params.to}T00:00:00.000Z`) },
      ...(params.userId ? { userId: params.userId } : {}),
      ...(params.templateId ? { templateId: params.templateId } : {}),
      ...(params.status ? { status: params.status } : {}),
      ...(term ? { user: { name: { contains: term, mode: 'insensitive' } } } : {}),
    },
    orderBy: [{ date: 'asc' }, { scheduledStartAt: 'asc' }],
    take: params.limit ?? 500,
    include: {
      user: { select: { name: true } },
      branch: { select: { name: true } },
      template: { select: { name: true } },
      staffShift: { select: { clockInAt: true, clockOutAt: true, adjustedClockInAt: true, adjustedClockOutAt: true } },
    },
  })
  return rows.map(toAssignmentView)
}

function toAssignmentView(row: {
  id: string
  userId: string
  user: { name: string }
  role: UserRole
  branchId: string
  branch: { name: string }
  templateId: string
  template: { name: string }
  date: Date
  scheduledStartAt: Date
  scheduledEndAt: Date
  status: ShiftAssignmentStatus
  notes: string | null
  staffShift: { clockInAt: Date; clockOutAt: Date | null; adjustedClockInAt: Date | null; adjustedClockOutAt: Date | null } | null
}): ShiftAssignmentView {
  return {
    id: row.id,
    userId: row.userId,
    userName: row.user.name,
    role: row.role,
    roleLabel: ROLE_LABELS[row.role] ?? row.role,
    branchId: row.branchId,
    branchName: row.branch.name,
    templateId: row.templateId,
    templateName: row.template.name,
    date: dateKeyOf(row.date),
    scheduledStartAt: row.scheduledStartAt.toISOString(),
    scheduledEndAt: row.scheduledEndAt.toISOString(),
    status: row.status,
    notes: row.notes,
    actualStartAt: row.staffShift ? (row.staffShift.adjustedClockInAt ?? row.staffShift.clockInAt).toISOString() : null,
    actualEndAt: row.staffShift ? (row.staffShift.adjustedClockOutAt ?? row.staffShift.clockOutAt)?.toISOString() ?? null : null,
  }
}

/** Who may be put on the rota at these sites. */
export async function listRotaStaff(params: {
  restaurantId: string
  branchIds: string[] | null
}): Promise<RotaStaffOption[]> {
  const rows = await prisma.user.findMany({
    where: {
      restaurantId: params.restaurantId,
      isActive: true,
      deletedAt: null,
      role: { not: 'SUPER_ADMIN' },
      // Somebody with no home site works everywhere; everybody else only at theirs.
      ...(params.branchIds ? { OR: [{ branchId: null }, { branchId: { in: params.branchIds } }] } : {}),
    },
    orderBy: { name: 'asc' },
    select: { id: true, name: true, role: true, branchId: true },
  })
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    role: row.role,
    roleLabel: ROLE_LABELS[row.role] ?? row.role,
    branchId: row.branchId,
  }))
}

/* ── the Shift tab's top card ───────────────────────────────────────────── */

export async function getCurrentShift(params: {
  restaurantId: string
  user: { id: string; role: UserRole; branchId: string | null }
  branchId: string
  timeZone: string
  now?: Date
}): Promise<CurrentShiftView> {
  const now = params.now ?? new Date()
  const todayKey = dateKeyIn(now, params.timeZone)
  const today = new Date(`${todayKey}T00:00:00.000Z`)
  const dayStart = zonedToUtc(todayKey, '00:00', params.timeZone)
  const dayEnd = new Date(dayStart.getTime() + 24 * 3600_000)

  const [branch, session, toStart, rostered, drawer, handover, openOrders, openTasks, transfers, deliveries, notes] =
    await Promise.all([
      prisma.branch.findFirst({ where: { id: params.branchId, restaurantId: params.restaurantId }, select: { name: true } }),
      prisma.staffShift.findUnique({
        where: { activeShiftKey: params.user.id },
        include: { template: { select: { name: true } } },
      }),
      prisma.shiftAssignment.findMany({
        where: {
          restaurantId: params.restaurantId,
          userId: params.user.id,
          status: 'PLANNED',
          OR: [
            { date: today },
            // An overnight shift from yesterday that is still running, or one
            // starting within the next couple of hours.
            { scheduledStartAt: { lte: new Date(now.getTime() + 2 * 3600_000) }, scheduledEndAt: { gte: now } },
          ],
        },
        orderBy: { scheduledStartAt: 'asc' },
        include: { template: { select: { name: true } }, branch: { select: { name: true } } },
      }),
      prisma.shiftAssignment.findMany({
        where: {
          restaurantId: params.restaurantId,
          branchId: params.branchId,
          status: { in: ['PLANNED', 'STARTED', 'COMPLETED'] },
          scheduledStartAt: { lt: dayEnd },
          scheduledEndAt: { gt: dayStart },
        },
        orderBy: { scheduledStartAt: 'asc' },
        include: {
          user: { select: { name: true } },
          template: { select: { name: true } },
          staffShift: { select: { activeShiftKey: true } },
        },
      }),
      prisma.cashDrawerSession.findFirst({
        where: { restaurantId: params.restaurantId, openedById: params.user.id, status: { in: ['OPEN', 'PENDING_REVIEW'] } },
        orderBy: { openedAt: 'desc' },
        select: { status: true, sessionNumber: true, register: { select: { name: true } } },
      }),
      prisma.shiftHandover.findFirst({
        where: {
          restaurantId: params.restaurantId,
          status: 'PENDING_ACCEPTANCE',
          OR: [{ fromUserId: params.user.id }, { toUserId: params.user.id }],
        },
        select: { id: true, fromUserId: true, fromUser: { select: { name: true } }, toUser: { select: { name: true } } },
      }),
      prisma.order.count({
        where: { restaurantId: params.restaurantId, branchId: params.branchId, status: { in: [...OPEN_ORDER_STATUSES] } },
      }),
      prisma.branchInstruction.count({
        where: { restaurantId: params.restaurantId, status: 'OPEN', OR: [{ branchId: params.branchId }, { branchId: null }] },
      }),
      listTransfers({ restaurantId: params.restaurantId, branchId: params.branchId, limit: 200 }),
      listAwaitingDelivery({ restaurantId: params.restaurantId, branchId: params.branchId }),
      prisma.shiftNote.count({ where: { restaurantId: params.restaurantId, branchId: params.branchId, resolved: false } }),
    ])

  const own = session && session.restaurantId === params.restaurantId ? session : null

  return {
    branchId: params.branchId,
    branchName: branch?.name ?? '',
    status: own?.assignmentId ? 'ON_SHIFT' : toStart.length > 0 ? 'NOT_STARTED' : own ? 'UNSCHEDULED' : 'OFF',
    session: own
      ? {
          id: own.id,
          clockInAt: own.clockInAt.toISOString(),
          templateName: own.template?.name ?? null,
          scheduledStartAt: own.scheduledStartAt?.toISOString() ?? null,
          scheduledEndAt: own.scheduledEndAt?.toISOString() ?? null,
          source: own.source,
        }
      : null,
    toStart: toStart.map((row) => ({
      id: row.id,
      templateName: row.template.name,
      scheduledStartAt: row.scheduledStartAt.toISOString(),
      scheduledEndAt: row.scheduledEndAt.toISOString(),
      branchName: row.branch.name,
    })),
    assignedStaff: rostered.map((row) => ({
      id: row.id,
      userId: row.userId,
      name: row.user.name,
      roleLabel: ROLE_LABELS[row.role] ?? row.role,
      templateName: row.template.name,
      scheduledStartAt: row.scheduledStartAt.toISOString(),
      scheduledEndAt: row.scheduledEndAt.toISOString(),
      status: row.status,
      working: row.status === 'STARTED' && row.staffShift?.activeShiftKey !== null && row.staffShift !== null,
    })),
    drawer: {
      status: drawer ? (drawer.status === 'OPEN' ? 'OPEN' : 'PENDING_REVIEW') : 'NONE',
      sessionNumber: drawer?.sessionNumber ?? null,
      registerName: drawer?.register?.name ?? null,
    },
    handover: handover
      ? {
          status: handover.fromUserId === params.user.id ? 'WAITING_ON_THEM' : 'WAITING_ON_YOU',
          withName: handover.fromUserId === params.user.id ? handover.toUser.name : handover.fromUser.name,
          handoverId: handover.id,
        }
      : { status: 'NONE', withName: null, handoverId: null },
    pending: {
      openOrders,
      openTasks,
      transfersToDispatch: transfers.filter((t) => t.status === 'APPROVED' && t.fromBranchId === params.branchId).length,
      transfersToReceive: transfers.filter(
        (t) => ['DISPATCHED', 'IN_TRANSIT', 'RECEIVED'].includes(t.status) && t.toBranchId === params.branchId,
      ).length,
      deliveriesToReceive: deliveries.length,
      notes,
    },
  }
}

/* ── history ────────────────────────────────────────────────────────────── */

export async function listShiftHistory(params: {
  restaurantId: string
  branchIds: string[] | null
  userId?: string
  templateId?: string
  from?: Date
  to?: Date
  q?: string
  limit?: number
  now?: Date
}): Promise<ShiftHistoryRow[]> {
  const term = params.q?.trim()
  const rows = await prisma.staffShift.findMany({
    where: {
      restaurantId: params.restaurantId,
      branchId: branchClause(params.branchIds),
      ...(params.userId ? { userId: params.userId } : {}),
      ...(params.templateId ? { templateId: params.templateId } : {}),
      ...(params.from || params.to
        ? { clockInAt: { ...(params.from ? { gte: params.from } : {}), ...(params.to ? { lte: params.to } : {}) } }
        : {}),
      ...(term ? { user: { name: { contains: term, mode: 'insensitive' } } } : {}),
    },
    orderBy: { clockInAt: 'desc' },
    take: params.limit ?? 200,
    include: {
      user: { select: { name: true, role: true } },
      branch: { select: { name: true } },
      template: { select: { name: true } },
    },
  })
  const now = params.now ?? new Date()
  return rows.map((row) => {
    const eff = effectiveShift(row, now)
    const role = row.roleAtStart ?? row.user.role
    return {
      id: row.id,
      userId: row.userId,
      userName: row.user.name,
      role,
      roleLabel: ROLE_LABELS[role] ?? role,
      branchId: row.branchId,
      branchName: row.branch.name,
      templateName: row.template?.name ?? null,
      date: dateKeyOf(row.businessDate),
      scheduledStartAt: row.scheduledStartAt?.toISOString() ?? null,
      scheduledEndAt: row.scheduledEndAt?.toISOString() ?? null,
      startedAt: eff.startedAt.toISOString(),
      endedAt: eff.endedAt?.toISOString() ?? null,
      minutes: eff.minutes,
      onShift: eff.onShift,
      source: row.source,
      closedBy: row.closedBy,
      corrected: eff.corrected,
    }
  })
}
