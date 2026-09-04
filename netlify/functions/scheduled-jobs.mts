import type { Config } from '@netlify/functions'

/**
 * The only scheduled execution surface on this platform (production.md §13).
 *
 * ── Why a function and not a worker ─────────────────────────────────────────
 *
 * ARCHITECTURE.md's rule is no queues, no cron, no workers, and it is right for
 * almost everything here. What it cannot cover is work belonging to nobody's
 * request: a nightly integrity sweep across every tenant, retention trimming,
 * backup verification. Computing those lazily on read means running them while
 * a guest waits for a menu, and in practice means never running them at all.
 *
 * So there is exactly one scheduled trigger, it does nothing itself, and it
 * calls one endpoint. All the logic lives in `src/server/jobs/runner.ts` where
 * it is testable without a scheduler.
 *
 * ── Why it calls an endpoint instead of importing the runner ────────────────
 *
 * A Netlify function is a separate bundle from the Next.js server. Importing
 * Prisma and the whole service layer here would build a second copy of the
 * application into the function, with its own connection pool competing for the
 * same database. One HTTP call to the app that is already running is smaller,
 * simpler, and fails in a way that is visible in the same place as everything
 * else.
 */
export default async function scheduledJobs(request: Request) {
  const base = process.env.URL ?? process.env.DEPLOY_URL ?? 'http://localhost:3000'
  const secret = process.env.JOBS_SECRET

  if (!secret) {
    // Loud, and not fatal. A misconfigured scheduler that silently does nothing
    // is the failure mode that leaves integrity unchecked for months.
    console.error('[jobs] JOBS_SECRET is not set — the job endpoint will refuse this call.')
  }

  const response = await fetch(`${base}/api/jobs/run`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${secret ?? ''}`,
    },
    body: JSON.stringify({ source: 'netlify-scheduled', at: new Date().toISOString() }),
  })

  const body = await response.text()
  console.log(`[jobs] ${response.status} ${body.slice(0, 500)}`)

  return new Response(body, { status: response.ok ? 200 : 500 })
}

/**
 * Every fifteen minutes.
 *
 * Frequent enough that a failed job's backoff retries land the same day, and
 * infrequent enough to be nearly free. The daily work is guarded by dedupe
 * keys carrying the date, so 96 invocations enqueue each night's sweep once.
 */
export const config: Config = {
  schedule: '*/15 * * * *',
}
