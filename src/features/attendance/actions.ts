'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'

import { runAction, type ActionResult } from '@/lib/action'
import { AppError, NotFoundError } from '@/lib/errors'
import { PERMISSIONS } from '@/lib/rbac'
import { AUDIT_ACTIONS, audit } from '@/server/audit'
import { assertRecordBranch, requirePermission } from '@/server/auth/guard'
import { prisma } from '@/server/db/prisma'

const correctionSchema = z.object({
  shiftId: z.string().cuid(),
  /** ISO datetimes from a `datetime-local` input, or '' to clear a correction. */
  startedAt: z.string().optional().or(z.literal('')),
  endedAt: z.string().optional().or(z.literal('')),
  reason: z.string().trim().min(3, 'Say why — this is somebody’s pay').max(200),
})

/**
 * Correct a shift somebody's sign-in got wrong.
 *
 * ── The original is never overwritten ───────────────────────────────────────
 *
 * `clockInAt` and `clockOutAt` are what the system observed and stay exactly as
 * they were. A correction goes into the `adjusted*` columns, so a timesheet can
 * always be shown both ways — what happened, and what a manager decided it
 * should read. An attendance record that can be silently rewritten is worth very
 * little in the one conversation it exists for.
 *
 * A reason is required for the same reason a stock adjustment needs one: "the
 * hours were wrong" and "she worked the morning and forgot to sign in" are
 * different facts, and only the second is any use later.
 */
export async function correctShift(input: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction(
    correctionSchema,
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.STAFF_MANAGE)

      const shift = await prisma.staffShift.findFirst({
        where: { id: data.shiftId, restaurantId: user.restaurantId },
        select: {
          id: true, branchId: true, userId: true, clockInAt: true, clockOutAt: true,
          adjustedClockInAt: true, adjustedClockOutAt: true,
          user: { select: { name: true } },
        },
      })
      if (!shift) throw new NotFoundError('Shift')

      // A shift belongs to a location, and correcting one changes that
      // location's payroll — so the same check every other branch-owned record
      // gets.
      await assertRecordBranch(user, shift, 'shift')

      const startedAt = data.startedAt ? new Date(data.startedAt) : null
      const endedAt = data.endedAt ? new Date(data.endedAt) : null

      if (startedAt && Number.isNaN(startedAt.getTime())) {
        throw new AppError('That start time is not a date', 400, 'SHIFT_BAD_TIME')
      }
      if (endedAt && Number.isNaN(endedAt.getTime())) {
        throw new AppError('That end time is not a date', 400, 'SHIFT_BAD_TIME')
      }

      const effectiveStart = startedAt ?? shift.clockInAt
      if (endedAt && endedAt < effectiveStart) {
        throw new AppError('A shift cannot end before it starts', 400, 'SHIFT_BACKWARDS')
      }

      await prisma.staffShift.update({
        where: { id: shift.id },
        data: {
          adjustedClockInAt: startedAt,
          adjustedClockOutAt: endedAt,
          adjustedById: user.id,
          adjustedAt: new Date(),
          adjustReason: data.reason,
        },
      })

      await audit({
        restaurantId: user.restaurantId,
        branchId: shift.branchId,
        userId: user.id,
        actorName: user.name,
        action: AUDIT_ACTIONS.SHIFT_CORRECTED,
        entity: 'StaffShift',
        entityId: shift.id,
        before: {
          person: shift.user.name,
          clockInAt: shift.clockInAt.toISOString(),
          clockOutAt: shift.clockOutAt?.toISOString() ?? null,
          adjustedClockInAt: shift.adjustedClockInAt?.toISOString() ?? null,
          adjustedClockOutAt: shift.adjustedClockOutAt?.toISOString() ?? null,
        },
        after: {
          adjustedClockInAt: startedAt?.toISOString() ?? null,
          adjustedClockOutAt: endedAt?.toISOString() ?? null,
          reason: data.reason,
        },
      })

      revalidatePath(`/dashboard/locations/${shift.branchId}/staff`)
      return { id: shift.id }
    },
    'Shift corrected. The original is kept.',
  )
}
