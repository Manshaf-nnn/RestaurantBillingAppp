'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'

import { type ActionResult, runAction } from '@/lib/action'
import { AppError } from '@/lib/errors'
import { prisma } from '@/server/db/prisma'
import { requireSuperAdmin } from '@/server/auth/guard'
import { AUDIT_ACTIONS, audit } from '@/server/audit'
import { resolveError } from '@/server/errors'
import { retryJob, runJobs, enqueueDailyWork } from '@/server/jobs/runner'
// Not re-exported: a 'use server' module may export only async functions, and a
// stray constant makes every action in the file fail at runtime with a bare digest.
import { MAINTENANCE_KEY } from '@/features/platform/maintenance'

/**
 * What the platform operator may DO (production.md §8–§14).
 *
 * ── The shape of every action here ──────────────────────────────────────────
 *
 * `requireSuperAdmin()` first, an audit row last, and nothing in between that
 * production.md forbids. §10 and §11 are explicit — no dangerous database
 * deletion controls, no arbitrary database editing — so this file contains no
 * delete of tenant data, no raw SQL surface and no way to edit a business
 * record. The reversible operational controls are all there is: change a plan,
 * extend a trial, deactivate an account, retry a job, resolve an error, put the
 * platform into maintenance.
 *
 * Every one of them is audited, including the ones that only read differently
 * afterwards, because an operator acting across every tenant is exactly the
 * actor whose actions most need a trail.
 */

// ── Subscriptions ───────────────────────────────────────────────────────────

const planSchema = z.object({
  restaurantId: z.string().cuid(),
  plan: z.enum(['TRIAL', 'STARTER', 'GROWTH', 'ENTERPRISE']),
  /** Days to extend a trial by; only meaningful with plan TRIAL. */
  trialDays: z.coerce.number().int().min(0).max(365).optional(),
})

/**
 * Move a restaurant between plans, or extend its trial.
 *
 * This did not exist. `SubscriptionPlan` and `trialEndsAt` were in the schema
 * and `approveRestaurant` set a 14-day trial, but no action anywhere could move
 * a restaurant off TRIAL — so every approved restaurant reached `/trial-ended`
 * after a fortnight and the only route onward was a `mailto:` link. The
 * platform could sell a plan and had no way to grant it.
 */
export async function setRestaurantPlanAction(
  input: unknown,
): Promise<ActionResult<{ plan: string; trialEndsAt: string | null }>> {
  return runAction(
    planSchema,
    input,
    async (data) => {
      const admin = await requireSuperAdmin()

      const before = await prisma.restaurant.findUnique({
        where: { id: data.restaurantId },
        select: { plan: true, trialEndsAt: true, name: true },
      })
      if (!before) throw new AppError('Restaurant not found', 404, 'NOT_FOUND')

      /*
       * A paid plan clears the trial deadline rather than leaving a date in the
       * past. Leaving it would send a paying customer to /trial-ended, which is
       * the exact failure this action exists to end.
       */
      const trialEndsAt =
        data.plan === 'TRIAL'
          ? new Date(Date.now() + (data.trialDays ?? 14) * 86_400_000)
          : null

      const after = await prisma.restaurant.update({
        where: { id: data.restaurantId },
        data: { plan: data.plan, trialEndsAt },
        select: { plan: true, trialEndsAt: true },
      })

      await audit({
        restaurantId: data.restaurantId,
        userId: admin.id,
        actorName: admin.name,
        action: AUDIT_ACTIONS.PLATFORM_PLAN_CHANGED,
        entity: 'Restaurant',
        entityId: data.restaurantId,
        before: { plan: before.plan, trialEndsAt: before.trialEndsAt?.toISOString() ?? null },
        after: { plan: after.plan, trialEndsAt: after.trialEndsAt?.toISOString() ?? null },
      })

      revalidatePath('/admin/subscriptions')
      revalidatePath('/admin')
      return {
        plan: after.plan,
        trialEndsAt: after.trialEndsAt?.toISOString() ?? null,
      }
    },
    'Plan updated.',
    'setRestaurantPlan',
  )
}

// ── Users ───────────────────────────────────────────────────────────────────

const userStateSchema = z.object({
  userId: z.string().cuid(),
  isActive: z.boolean(),
})

/**
 * Deactivate or restore an account, platform-wide.
 *
 * Deliberately NOT a delete, and deliberately not a password reset: an operator
 * who can set somebody's password can sign in as them, and a support tool that
 * can impersonate a restaurant owner is a tool that can move their money. The
 * owner resets passwords for their own staff; the platform can only stop an
 * account, which is the control an incident actually calls for.
 */
export async function setUserActiveAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction(
    userStateSchema,
    input,
    async (data) => {
      const admin = await requireSuperAdmin()

      const user = await prisma.user.findUnique({
        where: { id: data.userId },
        select: { id: true, name: true, email: true, isActive: true, role: true, restaurantId: true },
      })
      if (!user) throw new AppError('User not found', 404, 'NOT_FOUND')
      if (user.id === admin.id) {
        throw new AppError(
          'You cannot deactivate your own platform account — you would be locked out of the console you are standing in.',
          400,
          'SELF_DEACTIVATE',
        )
      }

      await prisma.user.update({
        where: { id: data.userId },
        data: { isActive: data.isActive },
      })

      /*
       * Deactivating has to end the sessions the account already holds, or the
       * user carries on working on a valid access token until it expires — for
       * up to an hour, which is precisely the window an operator is trying to
       * close.
       */
      if (!data.isActive) {
        await prisma.session.updateMany({
          where: { userId: data.userId, revokedAt: null },
          data: { revokedAt: new Date() },
        })
      }

      await audit({
        restaurantId: user.restaurantId,
        userId: admin.id,
        actorName: admin.name,
        action: data.isActive ? AUDIT_ACTIONS.USER_REACTIVATED : AUDIT_ACTIONS.USER_DISABLED,
        entity: 'User',
        entityId: user.id,
        before: { isActive: user.isActive },
        after: { isActive: data.isActive },
      })

      revalidatePath('/admin/users')
      return { id: user.id }
    },
    'Account updated.',
    'setUserActive',
  )
}

/** End every live session for one account, without disabling it. */
export async function revokeUserSessionsAction(
  input: unknown,
): Promise<ActionResult<{ revoked: number }>> {
  return runAction(
    z.object({ userId: z.string().cuid() }),
    input,
    async (data) => {
      const admin = await requireSuperAdmin()
      const { count } = await prisma.session.updateMany({
        where: { userId: data.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      })

      await audit({
        userId: admin.id,
        actorName: admin.name,
        action: AUDIT_ACTIONS.SESSIONS_REVOKED,
        entity: 'User',
        entityId: data.userId,
        after: { revoked: count },
      })

      revalidatePath('/admin/security')
      revalidatePath('/admin/users')
      return { revoked: count }
    },
    'Sessions ended.',
    'revokeUserSessions',
  )
}

// ── §13 Jobs ────────────────────────────────────────────────────────────────

export async function retryJobAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction(
    z.object({ jobId: z.string().cuid() }),
    input,
    async (data) => {
      const admin = await requireSuperAdmin()
      await retryJob(data.jobId)
      await audit({
        userId: admin.id,
        actorName: admin.name,
        action: AUDIT_ACTIONS.JOB_RETRIED,
        entity: 'Job',
        entityId: data.jobId,
      })
      revalidatePath('/admin/jobs')
      return { id: data.jobId }
    },
    'Job queued to run again.',
    'retryJob',
  )
}

/**
 * Drain the queue now, rather than waiting for the scheduler.
 *
 * The scheduled function is the normal path; this is for an operator who has
 * just fixed the cause of a failure and wants to see whether it worked, and for
 * the case where the scheduler itself is what is broken.
 */
export async function runJobsNowAction(): Promise<ActionResult<{ done: number; failed: number }>> {
  return runAction(
    z.object({}),
    {},
    async () => {
      const admin = await requireSuperAdmin()
      await enqueueDailyWork()
      const summary = await runJobs(10)
      await audit({
        userId: admin.id,
        actorName: admin.name,
        action: AUDIT_ACTIONS.JOBS_RUN,
        entity: 'Job',
        after: { claimed: summary.claimed, done: summary.done, failed: summary.failed },
      })
      revalidatePath('/admin/jobs')
      return { done: summary.done, failed: summary.failed }
    },
    'Queue drained.',
    'runJobsNow',
  )
}

// ── §12 Errors ──────────────────────────────────────────────────────────────

export async function resolveErrorAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction(
    z.object({
      errorId: z.string().cuid(),
      resolution: z.string().trim().min(3, 'Say what was done about it').max(1000),
    }),
    input,
    async (data) => {
      const admin = await requireSuperAdmin()
      await resolveError({ id: data.errorId, userId: admin.id, resolution: data.resolution })
      await audit({
        userId: admin.id,
        actorName: admin.name,
        action: AUDIT_ACTIONS.ERROR_RESOLVED,
        entity: 'ErrorLog',
        entityId: data.errorId,
        after: { resolution: data.resolution },
      })
      revalidatePath('/admin/errors')
      return { id: data.errorId }
    },
    'Marked resolved.',
    'resolveError',
  )
}

// ── §8 Maintenance ──────────────────────────────────────────────────────────

const maintenanceSchema = z.object({
  enabled: z.boolean(),
  message: z.string().trim().max(300).optional(),
})

/**
 * Put a banner in front of every tenant, or take it down.
 *
 * A banner and nothing more. It does not stop trading, refuse writes or take
 * the site down: a restaurant mid-service that suddenly cannot settle a bill is
 * a worse outcome than whatever maintenance was being announced, and an
 * operator who wants the site down has the hosting platform for that.
 */
export async function setMaintenanceAction(
  input: unknown,
): Promise<ActionResult<{ enabled: boolean }>> {
  return runAction(
    maintenanceSchema,
    input,
    async (data) => {
      const admin = await requireSuperAdmin()

      await prisma.platformSetting.upsert({
        where: { key: MAINTENANCE_KEY },
        create: {
          key: MAINTENANCE_KEY,
          value: JSON.stringify({ enabled: data.enabled, message: data.message ?? '' }),
          updatedById: admin.id,
        },
        update: {
          value: JSON.stringify({ enabled: data.enabled, message: data.message ?? '' }),
          updatedById: admin.id,
        },
      })

      await audit({
        userId: admin.id,
        actorName: admin.name,
        action: AUDIT_ACTIONS.MAINTENANCE_TOGGLED,
        entity: 'PlatformSetting',
        entityId: MAINTENANCE_KEY,
        after: { enabled: data.enabled, message: data.message ?? '' },
      })

      revalidatePath('/admin/maintenance', 'layout')
      return { enabled: data.enabled }
    },
    'Maintenance notice updated.',
    'setMaintenance',
  )
}

// ── §10 Backups ─────────────────────────────────────────────────────────────

/**
 * Record that somebody restored a backup and what happened.
 *
 * The application cannot perform the restore — Neon owns the backups and the
 * PITR window, and §10 forbids pretending otherwise. What it can own is the
 * record: who tested, when, against what, and whether it worked. A backup
 * nobody has ever restored is a belief, not a backup, and this is the only
 * place that belief gets checked.
 */
export async function recordRestoreTestAction(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  return runAction(
    z.object({
      target: z.string().trim().min(1, 'Name what was restored').max(200),
      outcome: z.enum(['PASSED', 'FAILED', 'PARTIAL']),
      restoredTo: z.string().datetime().optional(),
      durationSec: z.coerce.number().int().min(0).max(86_400).optional(),
      notes: z.string().trim().max(2000).optional(),
    }),
    input,
    async (data) => {
      const admin = await requireSuperAdmin()
      const row = await prisma.restoreTest.create({
        data: {
          target: data.target,
          outcome: data.outcome,
          restoredTo: data.restoredTo ? new Date(data.restoredTo) : null,
          durationSec: data.durationSec ?? null,
          notes: data.notes ?? null,
          testedById: admin.id,
          testedByName: admin.name,
        },
      })
      await audit({
        userId: admin.id,
        actorName: admin.name,
        action: AUDIT_ACTIONS.RESTORE_TESTED,
        entity: 'RestoreTest',
        entityId: row.id,
        after: { target: data.target, outcome: data.outcome },
      })
      revalidatePath('/admin/backups')
      return { id: row.id }
    },
    'Restore test recorded.',
    'recordRestoreTest',
  )
}
