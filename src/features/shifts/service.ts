import 'server-only'

import type { Prisma, ShiftAssignment, ShiftTemplate, StaffShift, UserRole } from '@prisma/client'

import { AppError, ForbiddenError, NotFoundError } from '@/lib/errors'
import { canAccessBranch } from '@/lib/rbac'
import { prisma } from '@/server/db/prisma'
import { businessDateFor } from '@/features/attendance/service'
import { DATE_KEY_RE, TIME_RE } from './schema'

/**
 * Shift management (shifthandover.md §1–3): the kinds of shift, the rota,
 * and the moment a person starts the one they were rostered on.
 *
 * ── What already existed, and is reused ─────────────────────────────────────
 *
 * Attendance (`StaffShift`) is the shift session. Signing in opens one, the
 * last action ends it, and `activeShiftKey` makes "on shift twice" impossible
 * at the database. This module never opens a second kind of session: starting
 * a rostered shift LINKS the session to the assignment, or opens one the same
 * way sign-in would when there is none. One row per stretch of work, whatever
 * put the person there.
 *
 * ── Times ───────────────────────────────────────────────────────────────────
 *
 * A template says "18:00 to 02:00" on the restaurant's own clock. That is
 * turned into two instants when somebody is put on it for a date, in the
 * restaurant's zone, with the end rolled to the next day when it is not after
 * the start. Stored on the assignment as a snapshot: editing the template
 * later changes tomorrow's rota, never last week's.
 *
 * ── Who checks what ─────────────────────────────────────────────────────────
 *
 * Actions check permissions. This module checks facts: the branch exists and
 * belongs to the restaurant, the person works there, the role fits the shift,
 * the day is not already taken. Both, always, because a posted id is a claim.
 */

export interface ShiftActor {
  id: string
  role: UserRole
  branchId: string | null
  /** staff.A.md §4 — extra sites, so somebody covering two shops may roster both. */
  branchIds?: string[] | null
}

/* ── time ───────────────────────────────────────────────────────────────── */

function offsetMinutes(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(at)
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0)
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'))
  return Math.round((asUtc - at.getTime()) / 60_000)
}

function safeZone(timeZone: string): string {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date())
    return timeZone
  } catch {
    return 'UTC'
  }
}

/** The instant at which a wall-clock time falls on a calendar day in a zone. */
export function zonedToUtc(dateKey: string, time: string, timeZone: string): Date {
  if (!DATE_KEY_RE.test(dateKey)) throw new AppError('Bad date', 400, 'SHIFT_BAD_DATE')
  if (!TIME_RE.test(time)) throw new AppError('Bad time', 400, 'SHIFT_BAD_TIME')
  const zone = safeZone(timeZone)
  const [y, m, d] = dateKey.split('-').map(Number)
  const [h, mi] = time.split(':').map(Number)
  const guess = Date.UTC(y, m - 1, d, h, mi)
  // Two passes: the offset at the guess, then the offset at the corrected
  // instant, which is what lands a time on the right side of a clock change.
  let utc = guess - offsetMinutes(new Date(guess), zone) * 60_000
  utc = guess - offsetMinutes(new Date(utc), zone) * 60_000
  return new Date(utc)
}

/** "YYYY-MM-DD" of an instant in a zone. */
export function dateKeyIn(when: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: safeZone(timeZone), year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(when)
}

/** "YYYY-MM-DD" of a `@db.Date` value (stored as UTC midnight). */
export function dateKeyOf(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function nextDateKey(dateKey: string): string {
  const [y, m, d] = dateKey.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10)
}

/** When a template's shift runs on a given day. End rolls over when needed. */
export function scheduledWindow(
  template: { startTime: string; endTime: string },
  dateKey: string,
  timeZone: string,
): { start: Date; end: Date } {
  const start = zonedToUtc(dateKey, template.startTime, timeZone)
  let end = zonedToUtc(dateKey, template.endTime, timeZone)
  if (end.getTime() <= start.getTime()) end = zonedToUtc(nextDateKey(dateKey), template.endTime, timeZone)
  return { start, end }
}

export function isOvernight(template: { startTime: string; endTime: string }): boolean {
  return template.endTime <= template.startTime
}

/* ── §1 templates ───────────────────────────────────────────────────────── */

const SUPER = 'SUPER_ADMIN' as UserRole

function validateTemplate(input: { name: string; startTime: string; endTime: string; roles: UserRole[] }) {
  const name = input.name.trim()
  if (name.length < 2) throw new AppError('Give the shift a name', 400, 'SHIFT_TEMPLATE_NAME')
  if (!TIME_RE.test(input.startTime) || !TIME_RE.test(input.endTime)) {
    throw new AppError('Times must be HH:mm', 400, 'SHIFT_BAD_TIME')
  }
  const roles = [...new Set(input.roles)].filter((r) => r !== SUPER)
  if (roles.length === 0) throw new AppError('Pick at least one role for the shift', 400, 'SHIFT_TEMPLATE_ROLES')
  return { name, roles }
}

async function requireBranch(restaurantId: string, branchId: string) {
  const branch = await prisma.branch.findFirst({ where: { id: branchId, restaurantId }, select: { id: true, name: true } })
  if (!branch) throw new NotFoundError('Location')
  return branch
}

async function templateNameTaken(params: {
  restaurantId: string
  branchId: string | null
  name: string
  exceptId?: string
}): Promise<boolean> {
  const clash = await prisma.shiftTemplate.findFirst({
    where: {
      restaurantId: params.restaurantId,
      branchId: params.branchId,
      name: { equals: params.name, mode: 'insensitive' },
      ...(params.exceptId ? { id: { not: params.exceptId } } : {}),
    },
    select: { id: true },
  })
  return Boolean(clash)
}

export async function createShiftTemplate(params: {
  restaurantId: string
  actor: ShiftActor
  name: string
  startTime: string
  endTime: string
  roles: UserRole[]
  branchId: string | null
  sortOrder?: number
}): Promise<ShiftTemplate> {
  const { name, roles } = validateTemplate(params)
  if (params.branchId) {
    await requireBranch(params.restaurantId, params.branchId)
    if (!canAccessBranch(params.actor, params.branchId)) throw new ForbiddenError('That location is not yours to set shifts for')
  }
  // The unique index does not see two NULL branches as a clash; this does.
  if (await templateNameTaken({ restaurantId: params.restaurantId, branchId: params.branchId, name })) {
    throw new AppError(`There is already a shift called “${name}” here`, 409, 'SHIFT_TEMPLATE_EXISTS')
  }
  try {
    return await prisma.shiftTemplate.create({
      data: {
        restaurantId: params.restaurantId,
        branchId: params.branchId,
        name,
        startTime: params.startTime,
        endTime: params.endTime,
        roles,
        sortOrder: params.sortOrder ?? 0,
      },
    })
  } catch (error) {
    if ((error as { code?: string }).code === 'P2002') {
      throw new AppError(`There is already a shift called “${name}” here`, 409, 'SHIFT_TEMPLATE_EXISTS')
    }
    throw error
  }
}

export async function updateShiftTemplate(params: {
  restaurantId: string
  actor: ShiftActor
  templateId: string
  name: string
  startTime: string
  endTime: string
  roles: UserRole[]
  branchId: string | null
  sortOrder?: number
}): Promise<{ before: ShiftTemplate; after: ShiftTemplate }> {
  const before = await prisma.shiftTemplate.findFirst({ where: { id: params.templateId, restaurantId: params.restaurantId } })
  if (!before) throw new NotFoundError('Shift')
  if (before.branchId && !canAccessBranch(params.actor, before.branchId)) throw new ForbiddenError('That shift belongs to another location')

  const { name, roles } = validateTemplate(params)
  if (params.branchId) {
    await requireBranch(params.restaurantId, params.branchId)
    if (!canAccessBranch(params.actor, params.branchId)) throw new ForbiddenError('That location is not yours to set shifts for')
  }
  if (await templateNameTaken({ restaurantId: params.restaurantId, branchId: params.branchId, name, exceptId: before.id })) {
    throw new AppError(`There is already a shift called “${name}” here`, 409, 'SHIFT_TEMPLATE_EXISTS')
  }
  try {
    const after = await prisma.shiftTemplate.update({
      where: { id: before.id },
      data: {
        name,
        startTime: params.startTime,
        endTime: params.endTime,
        roles,
        branchId: params.branchId,
        ...(params.sortOrder !== undefined ? { sortOrder: params.sortOrder } : {}),
      },
    })
    return { before, after }
  } catch (error) {
    if ((error as { code?: string }).code === 'P2002') {
      throw new AppError(`There is already a shift called “${name}” here`, 409, 'SHIFT_TEMPLATE_EXISTS')
    }
    throw error
  }
}

/** Retire or revive. Never delete: assignments and sessions point at it. */
export async function setShiftTemplateActive(params: {
  restaurantId: string
  actor: ShiftActor
  templateId: string
  isActive: boolean
}): Promise<ShiftTemplate> {
  const row = await prisma.shiftTemplate.findFirst({ where: { id: params.templateId, restaurantId: params.restaurantId } })
  if (!row) throw new NotFoundError('Shift')
  if (row.branchId && !canAccessBranch(params.actor, row.branchId)) throw new ForbiddenError('That shift belongs to another location')
  return prisma.shiftTemplate.update({ where: { id: row.id }, data: { isActive: params.isActive } })
}

/* ── §2 the rota ────────────────────────────────────────────────────────── */

const LIVE_ASSIGNMENT: Prisma.ShiftAssignmentWhereInput = { status: { in: ['PLANNED', 'STARTED'] } }

async function requireTemplateFor(restaurantId: string, templateId: string, branchId: string) {
  const template = await prisma.shiftTemplate.findFirst({ where: { id: templateId, restaurantId } })
  if (!template) throw new NotFoundError('Shift')
  if (!template.isActive) throw new AppError(`The ${template.name} shift is no longer in use`, 409, 'SHIFT_TEMPLATE_INACTIVE')
  if (template.branchId && template.branchId !== branchId) {
    throw new AppError(`The ${template.name} shift is for another location`, 403, 'SHIFT_TEMPLATE_OTHER_BRANCH')
  }
  return template
}

async function requireStaffFor(restaurantId: string, userId: string, branchId: string, roles: UserRole[]) {
  const staff = await prisma.user.findFirst({
    where: { id: userId, restaurantId, isActive: true, deletedAt: null },
    select: { id: true, name: true, role: true, branchId: true },
  })
  if (!staff) throw new NotFoundError('Staff member')
  if (!canAccessBranch(staff, branchId)) {
    throw new AppError(`${staff.name} does not work at this location`, 403, 'SHIFT_CROSSES_BRANCH')
  }
  if (!roles.includes(staff.role)) {
    throw new AppError(`${staff.name} is not a role this shift is for`, 400, 'SHIFT_ROLE_MISMATCH')
  }
  return staff
}

async function assertNoOverlap(params: {
  userId: string
  start: Date
  end: Date
  exceptId?: string
}) {
  const clash = await prisma.shiftAssignment.findFirst({
    where: {
      userId: params.userId,
      ...LIVE_ASSIGNMENT,
      scheduledStartAt: { lt: params.end },
      scheduledEndAt: { gt: params.start },
      ...(params.exceptId ? { id: { not: params.exceptId } } : {}),
    },
    include: { template: { select: { name: true } } },
  })
  if (clash) {
    throw new AppError(
      `They are already on the ${clash.template.name} shift then`,
      409,
      'SHIFT_OVERLAP',
    )
  }
}

export async function assignShift(params: {
  restaurantId: string
  actor: ShiftActor
  userId: string
  templateId: string
  branchId: string
  /** "YYYY-MM-DD" in the restaurant's zone. */
  dateKey: string
  notes?: string | null
  timeZone: string
}): Promise<ShiftAssignment> {
  if (!DATE_KEY_RE.test(params.dateKey)) throw new AppError('Pick a day', 400, 'SHIFT_BAD_DATE')
  await requireBranch(params.restaurantId, params.branchId)
  if (!canAccessBranch(params.actor, params.branchId)) throw new ForbiddenError('That location is not yours to roster')

  const template = await requireTemplateFor(params.restaurantId, params.templateId, params.branchId)
  const staff = await requireStaffFor(params.restaurantId, params.userId, params.branchId, template.roles)
  const { start, end } = scheduledWindow(template, params.dateKey, params.timeZone)
  await assertNoOverlap({ userId: staff.id, start, end })

  try {
    return await prisma.shiftAssignment.create({
      data: {
        restaurantId: params.restaurantId,
        branchId: params.branchId,
        userId: staff.id,
        role: staff.role,
        templateId: template.id,
        date: new Date(`${params.dateKey}T00:00:00.000Z`),
        scheduledStartAt: start,
        scheduledEndAt: end,
        notes: params.notes?.trim() || null,
        createdById: params.actor.id,
      },
    })
  } catch (error) {
    if ((error as { code?: string }).code === 'P2002') {
      throw new AppError(`${staff.name} is already on the ${template.name} shift that day`, 409, 'SHIFT_DUPLICATE')
    }
    throw error
  }
}

async function requireAssignment(restaurantId: string, assignmentId: string, actor: ShiftActor) {
  const row = await prisma.shiftAssignment.findFirst({
    where: { id: assignmentId, restaurantId },
    include: { template: { select: { name: true } }, user: { select: { name: true } } },
  })
  if (!row) throw new NotFoundError('Rota entry')
  if (!canAccessBranch(actor, row.branchId)) throw new ForbiddenError('That rota belongs to another location')
  return row
}

/** Move or annotate a PLANNED entry. Once started it is history and stays. */
export async function updateShiftAssignment(params: {
  restaurantId: string
  actor: ShiftActor
  assignmentId: string
  templateId?: string
  dateKey?: string
  notes?: string | null
  timeZone: string
}): Promise<{ before: ShiftAssignment; after: ShiftAssignment }> {
  const before = await requireAssignment(params.restaurantId, params.assignmentId, params.actor)
  if (before.status !== 'PLANNED') {
    throw new AppError('That shift has already started — it cannot be changed now', 409, 'SHIFT_NOT_PLANNED')
  }

  const templateId = params.templateId ?? before.templateId
  const dateKey = params.dateKey ?? dateKeyOf(before.date)
  if (!DATE_KEY_RE.test(dateKey)) throw new AppError('Pick a day', 400, 'SHIFT_BAD_DATE')
  const template = await requireTemplateFor(params.restaurantId, templateId, before.branchId)
  await requireStaffFor(params.restaurantId, before.userId, before.branchId, template.roles)
  const { start, end } = scheduledWindow(template, dateKey, params.timeZone)
  await assertNoOverlap({ userId: before.userId, start, end, exceptId: before.id })

  try {
    const after = await prisma.shiftAssignment.update({
      where: { id: before.id },
      data: {
        templateId: template.id,
        date: new Date(`${dateKey}T00:00:00.000Z`),
        scheduledStartAt: start,
        scheduledEndAt: end,
        ...(params.notes !== undefined ? { notes: params.notes?.trim() || null } : {}),
      },
    })
    return { before, after }
  } catch (error) {
    if ((error as { code?: string }).code === 'P2002') {
      throw new AppError(`${before.user.name} is already on the ${template.name} shift that day`, 409, 'SHIFT_DUPLICATE')
    }
    throw error
  }
}

export async function cancelShiftAssignment(params: {
  restaurantId: string
  actor: ShiftActor
  assignmentId: string
  reason: string
}): Promise<ShiftAssignment> {
  const reason = params.reason.trim()
  if (reason.length < 2) throw new AppError('Say why', 400, 'SHIFT_NO_REASON')
  const row = await requireAssignment(params.restaurantId, params.assignmentId, params.actor)
  // Status in the WHERE: a cancel racing a start matches no row.
  const done = await prisma.shiftAssignment.updateMany({
    where: { id: row.id, status: 'PLANNED' },
    data: { status: 'CANCELLED', cancelledById: params.actor.id, cancelReason: reason },
  })
  if (done.count === 0) {
    throw new AppError('That shift has already started or been cancelled', 409, 'SHIFT_NOT_PLANNED')
  }
  return prisma.shiftAssignment.findUniqueOrThrow({ where: { id: row.id } })
}

/* ── §3 starting the shift you were rostered on ─────────────────────────── */

/** How early somebody may start a rostered shift, and how late. */
const START_EARLY_MS = 2 * 3600_000

/**
 * Link the session to the rota.
 *
 * One transaction, the assignment row locked first, and every write a
 * compare-and-swap: two presses of "Start" from two tabs, or a start racing a
 * manager's cancel, end with exactly one session on the shift or a clear
 * refusal — never two rows and never a session on a cancelled shift. The
 * unique `assignmentId` on `staff_shifts` is the last line if all of that
 * were somehow passed.
 */
export async function startAssignedShift(params: {
  restaurantId: string
  user: ShiftActor
  assignmentId: string
  timeZone: string
  now?: Date
}): Promise<{ shift: StaffShift; assignment: ShiftAssignment }> {
  const now = params.now ?? new Date()

  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "shift_assignments" WHERE "id" = ${params.assignmentId} FOR UPDATE`
      const row = await tx.shiftAssignment.findFirst({
        where: { id: params.assignmentId, restaurantId: params.restaurantId },
        include: { template: { select: { name: true } } },
      })
      if (!row) throw new NotFoundError('Rota entry')
      if (row.userId !== params.user.id) throw new ForbiddenError('That shift is on somebody else’s rota')
      if (!canAccessBranch(params.user, row.branchId)) throw new ForbiddenError('That shift is at another location')
      if (row.status !== 'PLANNED') {
        throw new AppError(
          row.status === 'STARTED'
            ? 'You have already started that shift'
            : row.status === 'CANCELLED'
              ? 'That shift was cancelled'
              : 'That shift is over',
          409,
          'SHIFT_NOT_PLANNED',
        )
      }

      const today = dateKeyIn(now, params.timeZone) === dateKeyOf(row.date)
      const inWindow =
        now.getTime() >= row.scheduledStartAt.getTime() - START_EARLY_MS && now.getTime() <= row.scheduledEndAt.getTime()
      if (!today && !inWindow) {
        throw new AppError(`That shift is on ${dateKeyOf(row.date)}, not today`, 409, 'SHIFT_NOT_TODAY')
      }

      const link = {
        assignmentId: row.id,
        templateId: row.templateId,
        scheduledStartAt: row.scheduledStartAt,
        scheduledEndAt: row.scheduledEndAt,
        roleAtStart: row.role,
      }

      const open = await tx.staffShift.findUnique({ where: { activeShiftKey: params.user.id } })
      let shift: StaffShift

      if (open && open.assignmentId && open.assignmentId !== row.id) {
        const current = await tx.shiftTemplate.findUnique({ where: { id: open.templateId ?? '' }, select: { name: true } })
        throw new AppError(
          `You are already on the ${current?.name ?? 'other'} shift — hand it over before starting another`,
          409,
          'SHIFT_ALREADY_ACTIVE',
        )
      }

      if (open && open.branchId !== row.branchId) {
        /*
         * Signed in at one site, rostered at another. The open segment belongs
         * to where it happened; it ends and a new one starts here — the same
         * rule sign-in applies (`openShift`, BRANCH_CHANGE).
         */
        const endedAt = open.lastActionAt ?? open.clockInAt
        await tx.staffShift.updateMany({
          where: { id: open.id, activeShiftKey: { not: null } },
          data: { clockOutAt: endedAt, closedBy: 'BRANCH_CHANGE', activeShiftKey: null },
        })
        shift = await tx.staffShift.create({
          data: {
            restaurantId: params.restaurantId,
            userId: params.user.id,
            branchId: row.branchId,
            clockInAt: now,
            lastActionAt: now,
            businessDate: businessDateFor(now, params.timeZone),
            activeShiftKey: params.user.id,
            source: 'MANUAL',
            ...link,
          },
        })
      } else if (open) {
        const linked = await tx.staffShift.updateMany({
          where: { id: open.id, activeShiftKey: params.user.id, assignmentId: null },
          data: link,
        })
        if (linked.count === 0) {
          throw new AppError('You are already on a shift — hand it over before starting another', 409, 'SHIFT_ALREADY_ACTIVE')
        }
        shift = await tx.staffShift.findUniqueOrThrow({ where: { id: open.id } })
      } else {
        shift = await tx.staffShift.create({
          data: {
            restaurantId: params.restaurantId,
            userId: params.user.id,
            branchId: row.branchId,
            clockInAt: now,
            lastActionAt: now,
            businessDate: businessDateFor(now, params.timeZone),
            activeShiftKey: params.user.id,
            source: 'MANUAL',
            ...link,
          },
        })
      }

      const started = await tx.shiftAssignment.updateMany({
        where: { id: row.id, status: 'PLANNED' },
        data: { status: 'STARTED' },
      })
      if (started.count === 0) throw new AppError('That shift has already started', 409, 'SHIFT_NOT_PLANNED')

      const assignment = await tx.shiftAssignment.findUniqueOrThrow({ where: { id: row.id } })
      return { shift, assignment }
    })
  } catch (error) {
    if ((error as { code?: string }).code === 'P2002') {
      throw new AppError('You are already on a shift — hand it over before starting another', 409, 'SHIFT_ALREADY_ACTIVE')
    }
    throw error
  }
}

/**
 * Best effort, on accepting a handover: if the receiver has a rostered shift
 * for today at this branch and their session is not yet on any, link them.
 * Responsibility has just transferred; the rota should say so. Never throws
 * — a handover must not fail because the receiver was not rostered.
 */
export async function linkReceiverShift(params: {
  restaurantId: string
  user: ShiftActor
  branchId: string
  timeZone: string
}): Promise<string | null> {
  try {
    const today = new Date(`${dateKeyIn(new Date(), params.timeZone)}T00:00:00.000Z`)
    const planned = await prisma.shiftAssignment.findFirst({
      where: { restaurantId: params.restaurantId, userId: params.user.id, branchId: params.branchId, date: today, status: 'PLANNED' },
      orderBy: { scheduledStartAt: 'asc' },
      select: { id: true },
    })
    if (!planned) return null
    const open = await prisma.staffShift.findUnique({ where: { activeShiftKey: params.user.id }, select: { assignmentId: true } })
    if (open?.assignmentId) return null
    const { assignment } = await startAssignedShift({ ...params, assignmentId: planned.id })
    return assignment.id
  } catch (error) {
    console.error('[shifts] could not link the receiver to their rostered shift', error)
    return null
  }
}
