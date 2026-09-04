import { NextResponse, type NextRequest } from 'next/server'
import { timingSafeEqual } from 'node:crypto'

import { enqueueDailyWork, runJobs } from '@/server/jobs/runner'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Drain the job queue. Called by the scheduled function, and by nobody else.
 *
 * ── The guard ───────────────────────────────────────────────────────────────
 *
 * A shared secret rather than a session, because the caller is a scheduler with
 * no user. Compared with `timingSafeEqual` so the comparison does not leak the
 * secret's length or prefix a byte at a time.
 *
 * With no `JOBS_SECRET` configured the endpoint refuses everything. That is the
 * safe direction: an unauthenticated endpoint that runs background work across
 * every tenant is worth more to an attacker than it is to an operator, and a
 * platform whose jobs are not running is visible on the Jobs page, while one
 * whose job endpoint is open to the world is not visible anywhere.
 */
function authorised(request: NextRequest): boolean {
  const secret = process.env.JOBS_SECRET
  if (!secret) return false

  const header = request.headers.get('authorization') ?? ''
  const given = header.startsWith('Bearer ') ? header.slice(7) : ''
  const a = Buffer.from(given)
  const b = Buffer.from(secret)
  return a.length === b.length && timingSafeEqual(a, b)
}

export async function POST(request: NextRequest) {
  if (!authorised(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const enqueued = await enqueueDailyWork()
    const summary = await runJobs(10)
    return NextResponse.json({
      enqueued,
      claimed: summary.claimed,
      done: summary.done,
      failed: summary.failed,
      results: summary.results,
    })
  } catch (error) {
    // Returning 500 matters: the scheduler logs it, and a run that failed
    // silently would look identical to a run with nothing to do.
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Job run failed' },
      { status: 500 },
    )
  }
}
