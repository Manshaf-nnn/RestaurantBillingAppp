import 'server-only'

import type { Prisma } from '@prisma/client'

import { prisma } from '@/server/db/prisma'
import { trimOutbox } from '@/server/realtime/outbox'
import { runIntegrityChecks } from '@/features/accounting/integrity'
import { captureError } from '@/server/errors'

/**
 * The one background job runner (production.md §4, §13).
 *
 * ── The house rule, and why this is the exception to it ─────────────────────
 *
 * ARCHITECTURE.md says this system has no queues, no cron and no workers by
 * design: deferred effects are computed lazily on read. That rule is right for
 * almost everything here and is not being abandoned. What it cannot cover is
 * work that belongs to nobody's request — a nightly integrity sweep across
 * every tenant, retention trimming, backup verification. Computing those lazily
 * means they run while a guest waits for a menu, and in practice means the
 * expensive ones never run at all.
 *
 * So: one table, one scheduled function, no worker process and no queue
 * library. That is the smallest thing that answers §13 honestly.
 *
 * ── Claiming ────────────────────────────────────────────────────────────────
 *
 * `FOR UPDATE SKIP LOCKED` is the whole concurrency design. Two overlapping
 * scheduler invocations — which will happen, because a run that takes longer
 * than the interval overlaps the next one — each lock a different set of rows
 * and neither waits for the other. Without SKIP LOCKED the second run blocks on
 * the first, and on a serverless host it blocks until it is killed.
 *
 * ── Failure ─────────────────────────────────────────────────────────────────
 *
 * A failed job is retried with exponential backoff until `maxAttempts`, then
 * left FAILED for a human. It is never deleted: the Job Center exists so that
 * somebody can see what did not happen, and a queue that tidies away its own
 * failures is a queue that lies about its health.
 */

export type JobHandler = (job: {
  id: string
  kind: string
  restaurantId: string | null
  payload: Prisma.JsonValue | null
}) => Promise<string | void>

/**
 * Everything that can run in the background.
 *
 * Adding a handler here is the only way to add a job kind: a job whose kind has
 * no handler fails loudly on its first attempt rather than sitting QUEUED for
 * ever looking like it is about to happen.
 */
export const HANDLERS: Record<string, JobHandler> = {
  /**
   * §115–116 integrity, swept nightly across every tenant.
   *
   * The checker already exists and is already run when somebody opens the
   * accounting screens — which means a restaurant nobody looks at is never
   * checked, and those are exactly the ones where a quiet corruption has time
   * to spread. Anything not OK is captured as a CRITICAL error so it reaches
   * the error centre and the alerting, rather than waiting to be noticed.
   */
  'integrity-check': async (job) => {
    const restaurants = job.restaurantId
      ? [{ id: job.restaurantId, name: '' }]
      : await prisma.restaurant.findMany({
          where: { status: 'ACTIVE' },
          select: { id: true, name: true },
        })

    let checked = 0
    let problems = 0
    for (const restaurant of restaurants) {
      const report = await runIntegrityChecks(restaurant.id)
      checked += 1
      if (report.status === 'OK') continue
      problems += 1

      const failing = report.checks.filter((check) => check.status !== 'OK')
      await captureError({
        severity: report.status === 'ERROR' ? 'CRITICAL' : 'WARNING',
        kind: 'integrity',
        operation: 'integrity-check',
        restaurantId: restaurant.id,
        message:
          `Integrity ${report.status}: ` +
          failing.map((check) => `${check.key} (${check.count})`).join(', '),
      })
    }
    return `${checked} restaurants checked, ${problems} with findings`
  },

  /**
   * Error-log retention.
   *
   * Kept longer than the outbox because an error is evidence and a delivered
   * event is not; 90 days is long enough to see a seasonal pattern and short
   * enough that the table stays cheap to query.
   */
  'errorlog-trim': async () => {
    const cutoff = new Date(Date.now() - 90 * 86_400_000)
    const { count } = await prisma.errorLog.deleteMany({
      where: { createdAt: { lt: cutoff }, resolvedAt: { not: null } },
    })
    return `${count} resolved errors older than 90 days removed`
  },

  /** Outbox retention — see `trimOutbox` for why a week is enough. */
  'outbox-trim': async () => {
    const removed = await trimOutbox(7)
    return `${removed} delivered events older than 7 days removed`
  },

  /**
   * Finished jobs, cleared out.
   *
   * DONE rows only. FAILED rows are never swept — somebody has to have seen
   * them, and a queue that deletes its own failures reports perfect health.
   */
  'job-trim': async () => {
    const cutoff = new Date(Date.now() - 14 * 86_400_000)
    const { count } = await prisma.job.deleteMany({
      where: { status: 'DONE', finishedAt: { lt: cutoff } },
    })
    return `${count} completed jobs older than 14 days removed`
  },
}

/** Backoff before the next attempt: 1m, 4m, 9m, 16m, 25m. */
function backoffMs(attempts: number): number {
  return Math.min(attempts * attempts * 60_000, 3_600_000)
}

export interface JobRunSummary {
  claimed: number
  done: number
  failed: number
  results: Array<{ kind: string; status: 'DONE' | 'FAILED'; detail: string }>
}

/**
 * Claim and run up to `limit` due jobs.
 *
 * Each job runs in its own transaction-free scope on purpose: a handler that
 * sweeps every tenant must not hold one transaction open for the whole sweep,
 * which on a pooled connection would occupy it for minutes.
 */
export async function runJobs(limit = 5): Promise<JobRunSummary> {
  const summary: JobRunSummary = { claimed: 0, done: 0, failed: 0, results: [] }

  /*
   * Claim inside a short transaction: SELECT ... FOR UPDATE SKIP LOCKED and
   * flip to RUNNING together, so a second scheduler invocation racing this one
   * sees rows that are already taken and moves past them.
   */
  const claimed = await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM jobs
      WHERE status = 'QUEUED' AND "runAt" <= NOW()
      ORDER BY "runAt" ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    `
    if (rows.length === 0) return []
    const ids = rows.map((row) => row.id)
    await tx.job.updateMany({
      where: { id: { in: ids } },
      data: { status: 'RUNNING', startedAt: new Date(), attempts: { increment: 1 } },
    })
    return tx.job.findMany({ where: { id: { in: ids } } })
  })

  summary.claimed = claimed.length

  for (const job of claimed) {
    const handler = HANDLERS[job.kind]
    try {
      if (!handler) throw new Error(`No handler registered for job kind "${job.kind}"`)
      const detail = (await handler(job)) ?? 'done'
      await prisma.job.update({
        where: { id: job.id },
        data: { status: 'DONE', finishedAt: new Date(), result: String(detail), lastError: null },
      })
      summary.done += 1
      summary.results.push({ kind: job.kind, status: 'DONE', detail: String(detail) })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const exhausted = job.attempts >= job.maxAttempts

      await prisma.job.update({
        where: { id: job.id },
        data: exhausted
          ? { status: 'FAILED', finishedAt: new Date(), lastError: message }
          : {
              status: 'QUEUED',
              startedAt: null,
              runAt: new Date(Date.now() + backoffMs(job.attempts)),
              lastError: message,
            },
      })

      summary.failed += 1
      summary.results.push({ kind: job.kind, status: 'FAILED', detail: message })

      if (exhausted) {
        await captureError({
          severity: 'CRITICAL',
          kind: 'job',
          operation: job.kind,
          restaurantId: job.restaurantId,
          entity: 'Job',
          entityId: job.id,
          message: `Job ${job.kind} failed ${job.attempts} times and has stopped retrying: ${message}`,
        })
      }
    }
  }

  return summary
}

/**
 * Queue a job, or leave the existing one alone.
 *
 * `dedupeKey` is what makes the scheduler idempotent: it fires every few
 * minutes and asks for tonight's integrity check every time, and only the first
 * ask creates a row. Without it, a scheduler running every five minutes would
 * queue 288 identical sweeps a day.
 */
export async function enqueue(params: {
  kind: keyof typeof HANDLERS | string
  restaurantId?: string | null
  payload?: Prisma.InputJsonValue
  runAt?: Date
  dedupeKey?: string
  maxAttempts?: number
}): Promise<{ id: string; created: boolean }> {
  if (params.dedupeKey) {
    const existing = await prisma.job.findUnique({ where: { dedupeKey: params.dedupeKey } })
    if (existing) return { id: existing.id, created: false }
  }

  const job = await prisma.job.create({
    data: {
      kind: params.kind,
      restaurantId: params.restaurantId ?? null,
      payload: params.payload,
      runAt: params.runAt ?? new Date(),
      dedupeKey: params.dedupeKey ?? null,
      ...(params.maxAttempts ? { maxAttempts: params.maxAttempts } : {}),
    },
  })
  return { id: job.id, created: true }
}

/**
 * Put a failed job back in the queue (§13: "allow safe retry of failed jobs").
 *
 * Safe because every handler is idempotent by construction — they sweep,
 * recompute or delete-by-age, none of them move money or stock. Retrying resets
 * the attempt count so an operator who has fixed the underlying cause gets the
 * full retry budget again rather than one last go.
 */
export async function retryJob(id: string): Promise<void> {
  await prisma.job.update({
    where: { id },
    data: { status: 'QUEUED', attempts: 0, runAt: new Date(), startedAt: null, finishedAt: null },
  })
}

/**
 * The recurring work, queued for tonight.
 *
 * Called by the scheduled function on every invocation; the dedupe keys carry
 * the date, so each becomes a no-op after the first invocation of the day.
 */
export async function enqueueDailyWork(): Promise<number> {
  const day = new Date().toISOString().slice(0, 10)
  const kinds = ['integrity-check', 'errorlog-trim', 'outbox-trim', 'job-trim']
  let created = 0
  for (const kind of kinds) {
    const result = await enqueue({ kind, dedupeKey: `${kind}:${day}` })
    if (result.created) created += 1
  }
  return created
}
