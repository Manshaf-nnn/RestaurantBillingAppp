import 'server-only'

import type { Prisma, ShiftCloseReason, StaffShift } from '@prisma/client'

import { prisma } from '@/server/db/prisma'
import { resolveBranchId } from '@/features/branches/service'

/**
 * Attendance — who was working, where, and for how long.
 *
 * ── The rule ────────────────────────────────────────────────────────────────
 *
 * Signing in opens a shift. The shift ends at the last thing the person
 * actually DID, not when their browser stopped being open and not when they
 * remembered to sign out — because almost nobody signs out, and a session lives
 * for thirty days.
 *
 *     hours = (clockOutAt ?? lastActionAt ?? clockInAt) − clockInAt
 *
 * `lastActionAt` is stamped by `requirePermission`, which every server action
 * passes through and no page render or `/api/pulse` poll does. That split is the
 * whole design: a kitchen display left switched on overnight polls continuously
 * and never once calls `requirePermission`, so it cannot claim twelve hours.
 * Presence is not work.
 *
 * ── Segments, not days ──────────────────────────────────────────────────────
 *
 * One shift belongs to one location. Signing in somewhere else closes the open
 * one (`BRANCH_CHANGE`) and starts another, so somebody covering an evening at a
 * second site produces two rows and each branch's figures are genuinely its
 * own. The database enforces one open shift per person through the unique
 * `activeShiftKey`, the same way `CashDrawerSession` enforces one open drawer.
 *
 * ── Nothing here may break anything else ────────────────────────────────────
 *
 * Attendance is a record of work, not a precondition for it. Every function
 * below is safe to fail: the callers wrap them so that a failed stamp costs a
 * line in the log and never an order, a sign-in, or somebody's shift.
 */

/** No activity for this long and the shift is treated as over. */
export const SHIFT_IDLE_MINUTES = 90

/** Nobody works longer than this in one stretch; past it, a manager must look. */
export const SHIFT_MAX_HOURS = 16

/**
 * Under this, with nothing done, a shift is not a shift.
 *
 * Somebody checking the rota from home at breakfast signs in and opens one.
 * Without this the tab fills with nought-minute rows that mean nothing and
 * bury the real ones.
 */
export const MIN_SHIFT_MINUTES = 5

/** How often a working person's `lastActionAt` is allowed to move. */
export const TOUCH_EVERY_MS = 60 * 1000

/**
 * Accounts that are not a person.
 *
 * A SHARED_DEVICE link creates one user — `device+<inviteId>@invites.local`,
 * named "Kitchen (shared screen)" — which every human who touches that tablet
 * then shares, for ever. Attendance for it would clock in once when the tablet
 * was switched on and never again, while quietly asserting that one employee
 * worked every hour the restaurant has been open. Better to record nothing and
 * say why on the screen.
 */
export function isSharedDevice(email: string | null | undefined): boolean {
  return typeof email === 'string' && email.startsWith('device+') && email.endsWith('@invites.local')
}

/** `YYYY-MM-DD` in a given zone, as a UTC-midnight Date for a `@db.Date` column. */
export function businessDateFor(when: Date, timeZone: string): Date {
  // `en-CA` is the locale whose short date format is already ISO, which makes
  // this one call instead of assembling parts.
  const key = new Intl.DateTimeFormat('en-CA', {
    timeZone: timeZone || 'UTC',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(when)
  return new Date(`${key}T00:00:00.000Z`)
}

export interface EffectiveShift {
  id: string
  userId: string
  branchId: string
  /** What the system observed, never rewritten. */
  clockInAt: Date
  clockOutAt: Date | null
  lastActionAt: Date | null
  /** What the timesheet should use — a manager's correction if there is one. */
  startedAt: Date
  endedAt: Date | null
  minutes: number
  /** Still working: nothing has closed it and the last action was recent. */
  onShift: boolean
  /** Opened, did nothing, and is over. Shown greyed rather than counted. */
  idleOnly: boolean
  corrected: boolean
}

/**
 * A shift as a timesheet should read it.
 *
 * `adjusted*` beats observed, and an unclosed shift ends at its last action —
 * so a forgotten sign-out costs nothing, and a manager's correction is visible
 * without the original ever being overwritten.
 */
export function effectiveShift(
  shift: Pick<
    StaffShift,
    | 'id' | 'userId' | 'branchId' | 'clockInAt' | 'clockOutAt' | 'lastActionAt'
    | 'adjustedClockInAt' | 'adjustedClockOutAt'
  >,
  now: Date = new Date(),
): EffectiveShift {
  const startedAt = shift.adjustedClockInAt ?? shift.clockInAt
  const observedEnd = shift.clockOutAt ?? shift.lastActionAt
  const endedAt = shift.adjustedClockOutAt ?? observedEnd

  /*
   * An open shift with no recorded action has run for zero minutes, not for
   * however long ago somebody signed in. Counting wall-clock time from a
   * sign-in nobody followed up on is exactly the overstatement this whole
   * module exists to avoid.
   */
  const until = endedAt ?? startedAt
  const minutes = Math.max(0, Math.round((until.getTime() - startedAt.getTime()) / 60_000))

  const stillOpen = shift.clockOutAt === null
  const idleFor = now.getTime() - (shift.lastActionAt ?? shift.clockInAt).getTime()

  return {
    id: shift.id,
    userId: shift.userId,
    branchId: shift.branchId,
    clockInAt: shift.clockInAt,
    clockOutAt: shift.clockOutAt,
    lastActionAt: shift.lastActionAt,
    startedAt,
    endedAt,
    minutes,
    onShift: stillOpen && idleFor < SHIFT_IDLE_MINUTES * 60_000,
    idleOnly: shift.lastActionAt === null && minutes < MIN_SHIFT_MINUTES,
    corrected: shift.adjustedClockInAt !== null || shift.adjustedClockOutAt !== null,
  }
}

/**
 * Open a shift for somebody who has just signed in.
 *
 * Returns null when attendance does not apply — a shared screen, a platform
 * operator with no restaurant — rather than throwing, because the caller is the
 * sign-in path and nothing here is worth refusing a login over.
 */
export async function openShift(userId: string): Promise<StaffShift | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      branchId: true,
      restaurantId: true,
      restaurant: { select: { timezone: true } },
    },
  })

  // A platform operator belongs to no restaurant, so there is no location to
  // record and no rota they are on. Structural, not a role check.
  if (!user?.restaurantId) return null
  if (isSharedDevice(user.email)) return null

  const branchId = await resolveBranchId({
    restaurantId: user.restaurantId,
    userBranchId: user.branchId,
  })

  // Yesterday's forgotten shift is closed by their own next sign-in, so a
  // person who never signs out still gets clean days without anything having to
  // run overnight.
  await autoCloseStale({ restaurantId: user.restaurantId, userId })

  const open = await prisma.staffShift.findUnique({ where: { activeShiftKey: userId } })

  if (open) {
    /*
     * Already on shift here — the same person opening a second browser tab, or
     * signing in again after being timed out. Reuse it. Opening a second row
     * would double the day's hours for somebody who did nothing but log in
     * twice.
     */
    if (open.branchId === branchId) return open

    /*
     * Signed in at a different location. The morning's shift belongs to the
     * morning's branch and must not swallow the evening's sales — this is the
     * case per-branch isolation exists for.
     */
    await closeShift(open.id, 'BRANCH_CHANGE')
  }

  const now = new Date()
  try {
    return await prisma.staffShift.create({
      data: {
        restaurantId: user.restaurantId,
        userId,
        branchId,
        clockInAt: now,
        businessDate: businessDateFor(now, user.restaurant?.timezone ?? 'UTC'),
        activeShiftKey: userId,
        source: 'LOGIN',
      },
    })
  } catch (error) {
    /*
     * Two sign-ins landing together: the unique `activeShiftKey` lets exactly
     * one create a row and the other finds it. Being on shift once is the
     * correct outcome for both, so this is not an error.
     */
    if ((error as { code?: string }).code === 'P2002') {
      return prisma.staffShift.findUnique({ where: { activeShiftKey: userId } })
    }
    throw error
  }
}

/**
 * End a shift.
 *
 * Closed at the last recorded action rather than at this moment, because
 * signing out is not work and neither is a manager tidying up at midnight. A
 * shift with no action at all closes at its start, which is the honest reading
 * of "signed in and did nothing".
 */
export async function closeShift(
  shiftId: string,
  reason: ShiftCloseReason,
  at?: Date,
): Promise<void> {
  const shift = await prisma.staffShift.findUnique({
    where: { id: shiftId },
    select: { id: true, clockInAt: true, lastActionAt: true, clockOutAt: true },
  })
  if (!shift || shift.clockOutAt) return

  const endedAt = at ?? shift.lastActionAt ?? shift.clockInAt

  await prisma.staffShift.updateMany({
    // Compare-and-swap on the key rather than the id: a shift closed by another
    // request in between must not be closed twice with a second reason.
    where: { id: shift.id, activeShiftKey: { not: null } },
    data: {
      clockOutAt: endedAt < shift.clockInAt ? shift.clockInAt : endedAt,
      closedBy: reason,
      activeShiftKey: null,
    },
  })
}

/** Close whoever is signed in on this session's account. Used on sign-out. */
export async function closeShiftForUser(
  userId: string,
  reason: ShiftCloseReason = 'SIGN_OUT',
): Promise<void> {
  const open = await prisma.staffShift.findUnique({
    where: { activeShiftKey: userId },
    select: { id: true },
  })
  if (open) await closeShift(open.id, reason)
}

/**
 * Record that somebody is working.
 *
 * A single indexed row, throttled by the caller, and deliberately not awaited by
 * it. `updateMany` rather than `update` so a person with no open shift — an
 * owner who never signed in through this app, a request racing a close — is a
 * no-op instead of a thrown "record not found".
 */
export async function touchShift(userId: string, at: Date = new Date()): Promise<void> {
  await prisma.staffShift.updateMany({
    where: { activeShiftKey: userId },
    data: { lastActionAt: at },
  })
}

/**
 * Close shifts that nobody closed.
 *
 * There is no job runner in this deployment — no cron, no scheduled function —
 * and adding one would work on the PM2 host and silently not exist on Netlify,
 * which is the worst of both. So this runs lazily: on the attendance screen, and
 * on each person's next sign-in. Both are idempotent, so it does not matter how
 * often it runs or which one gets there first.
 *
 * Two cutoffs, and they end the shift at different times on purpose:
 *
 *   idle  — closed at the LAST ACTION. The shift ended when the work did; the
 *           ninety minutes of silence afterwards are not part of it.
 *   cap   — closed at clockInAt + SHIFT_MAX_HOURS and flagged, because sixteen
 *           hours means something went wrong and a person should decide what,
 *           not a default.
 */
export async function autoCloseStale(params: {
  restaurantId: string
  /** Narrow to one person — their own sign-in tidying up after them. */
  userId?: string
  now?: Date
}): Promise<number> {
  const now = params.now ?? new Date()
  const idleBefore = new Date(now.getTime() - SHIFT_IDLE_MINUTES * 60_000)
  const cappedBefore = new Date(now.getTime() - SHIFT_MAX_HOURS * 3600_000)

  const stale = await prisma.staffShift.findMany({
    where: {
      restaurantId: params.restaurantId,
      ...(params.userId ? { userId: params.userId } : {}),
      activeShiftKey: { not: null },
      OR: [
        { clockInAt: { lt: cappedBefore } },
        { lastActionAt: { lt: idleBefore } },
        // Signed in, never did anything, and long enough ago to be over.
        { lastActionAt: null, clockInAt: { lt: idleBefore } },
      ],
    },
    select: { id: true, clockInAt: true, lastActionAt: true },
  })

  for (const shift of stale) {
    const capped = shift.clockInAt.getTime() < cappedBefore.getTime()
    if (capped) {
      await closeShift(
        shift.id,
        'AUTO_CAP',
        new Date(shift.clockInAt.getTime() + SHIFT_MAX_HOURS * 3600_000),
      )
    } else {
      await closeShift(shift.id, 'AUTO_IDLE', shift.lastActionAt ?? shift.clockInAt)
    }
  }

  return stale.length
}

/** Shifts at one location over a period, newest first. */
export async function listShifts(params: {
  restaurantId: string
  /** The location whose tab this is. Never null — a tab is one branch. */
  branchId: string
  from: Date
  to: Date
  userId?: string
  limit?: number
}) {
  const where: Prisma.StaffShiftWhereInput = {
    restaurantId: params.restaurantId,
    branchId: params.branchId,
    clockInAt: { gte: params.from, lte: params.to },
    ...(params.userId ? { userId: params.userId } : {}),
  }

  return prisma.staffShift.findMany({
    where,
    orderBy: { clockInAt: 'desc' },
    take: params.limit ?? 500,
    include: {
      user: { select: { id: true, name: true, role: true, staffCode: true } },
      adjustedBy: { select: { name: true } },
    },
  })
}
