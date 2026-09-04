import type { Metadata } from 'next'

import { PageHeader } from '@/features/dashboard/components/page-header'
import { listJobs } from '@/features/platform/ops-queries'
import { OpsTable, Stat, StatRow, StatusPill, ago } from '@/features/platform/components/ops-ui'
import { RetryJobButton, RunJobsButton } from '@/features/platform/components/ops-controls'
import { requirePageSuperAdmin } from '@/server/auth/guard'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Background jobs' }

/**
 * §13 Job centre: queued, running, completed, failed — and safe retry.
 *
 * ── Why failures are never swept ────────────────────────────────────────────
 *
 * The `job-trim` handler deletes DONE rows and never FAILED ones. A queue that
 * tidies away its own failures reports perfect health for ever, and this page
 * exists precisely so somebody can see what did not happen.
 *
 * Retry is safe because every handler is idempotent by construction — they
 * sweep, recompute or delete-by-age, and none of them moves money or stock.
 */
export default async function JobsPage() {
  await requirePageSuperAdmin('/admin/jobs')
  const { counts, jobs } = await listJobs({ take: 200 })

  return (
    <>
      <PageHeader
        title="Background jobs"
        description="Nightly integrity checks, retention trimming and backup verification."
        actions={<RunJobsButton />}
      />

      <StatRow>
        <Stat label="Queued" value={counts.QUEUED} />
        <Stat label="Running" value={counts.RUNNING} tone={counts.RUNNING > 0 ? 'warn' : 'idle'} />
        <Stat label="Completed" value={counts.DONE} />
        <Stat label="Failed" value={counts.FAILED} tone={counts.FAILED > 0 ? 'bad' : 'idle'} />
      </StatRow>

      <OpsTable
        title="Jobs"
        columns={['Job', 'Status', 'Attempts', 'Due', 'Finished', 'Outcome', '']}
        rows={jobs.map((job) => [
          <span key={job.id} className="font-mono text-xs">{job.kind}</span>,
          <StatusPill
            key={`${job.id}-s`}
            tone={job.status === 'FAILED' ? 'bad' : job.status === 'RUNNING' ? 'warn' : job.status === 'DONE' ? 'ok' : 'idle'}
          >
            {job.status.toLowerCase()}
          </StatusPill>,
          `${job.attempts}/${job.maxAttempts}`,
          <span key={`${job.id}-r`} title={job.runAt}>{ago(job.runAt)}</span>,
          job.finishedAt ? ago(job.finishedAt) : '—',
          <span key={`${job.id}-o`} className="block max-w-sm truncate" title={job.lastError ?? ''}>
            {job.lastError ?? '—'}
          </span>,
          job.status === 'FAILED' ? <RetryJobButton key={`${job.id}-b`} jobId={job.id} /> : null,
        ])}
        empty="Nothing queued. The scheduler enqueues the day's work on its first run after midnight; press “Run due jobs now” to do it immediately."
        footer="Completed jobs are cleared after 14 days. Failed ones are kept until somebody deals with them."
      />
    </>
  )
}
